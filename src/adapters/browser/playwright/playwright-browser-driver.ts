import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import type {
  BrowserArtifact,
  BrowserControlledRequest,
  BrowserDriver,
  BrowserNetworkEntry,
  BrowserRunResult,
  BrowserScenario,
  BrowserSignIn,
  BrowserSignInResult,
  BrowserStepResult,
} from "../../../domain/validation/browser-driver.js";
import {
  HOLD_LIMIT_MS,
  type BrowserStep,
  type FailRequestStatus,
} from "../../../domain/validation/validation-plan.js";
import { resolvePreviewUrl } from "../../../domain/validation/preview-url.js";

const MIN_STEP_TIMEOUT_MS = 1000;

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Keep only the first line of a Playwright error. It drops stack noise from the assertion log. */
const redact = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
};

/**
 * Resolves one goto path against the preview base URL. The plan parser rejects a path that can
 * leave the preview origin. This control repeats the check at the moment of use, because a
 * defence in depth control must not trust the parser.
 */
export const resolveGotoUrl = (scenarioBaseUrl: string, requestedPath: string): string =>
  resolvePreviewUrl(scenarioBaseUrl, requestedPath);

/** The largest number of requests one step detail names. The step result keeps every one. */
const MAX_NAMED_REQUESTS = 10;

const describeRequests = (requests: BrowserControlledRequest[]): string => {
  const named = requests.slice(0, MAX_NAMED_REQUESTS).map((request) => {
    const how =
      request.effect === "held"
        ? request.autoReleased
          ? " (released by the hold limit)"
          : ""
        : ` (${request.failedWith === "network" ? "network error" : String(request.failedWith)})`;
    return `${request.method} ${request.url}${how}`;
  });
  const more = requests.length > MAX_NAMED_REQUESTS ? `, and ${requests.length - MAX_NAMED_REQUESTS} more` : "";
  return `${named.join(", ")}${more}`;
};

/**
 * docs/specs/browser-network-control.md. Holds or fails the requests of one page that match a URL
 * glob. It never invents a response body: a held request goes on to the real backend, and a
 * failed request gets an empty body or a network error.
 */
class NetworkControl {
  private holds: Array<{ pattern: string; handler: (route: Route) => Promise<void> }> = [];
  private readonly pending = new Set<() => void>();

  constructor(
    private readonly page: Page,
    private readonly holdLimitMs: number,
  ) {}

  async hold(pattern: string): Promise<BrowserControlledRequest[]> {
    const requests: BrowserControlledRequest[] = [];
    const handler = async (route: Route): Promise<void> => {
      const request = route.request();
      const record: BrowserControlledRequest = {
        method: request.method(),
        url: request.url(),
        effect: "held",
        autoReleased: false,
        failedWith: null,
      };
      requests.push(record);
      await new Promise<void>((resolve) => {
        const release = (): void => {
          clearTimeout(timer);
          this.pending.delete(release);
          resolve();
        };
        // A plan can never stall a run: a held request releases itself after the hold limit.
        const timer = setTimeout(() => {
          record.autoReleased = true;
          release();
        }, this.holdLimitMs);
        this.pending.add(release);
      });
      // Fallback, not continue: a failRequest registered before this hold still applies.
      await route.fallback().catch(() => undefined);
    };
    await this.page.route(pattern, handler);
    this.holds.push({ pattern, handler });
    return requests;
  }

  /** Stops every hold, then lets each held request go on. Returns the number it released. */
  async release(): Promise<number> {
    const holds = this.holds;
    this.holds = [];
    for (const hold of holds) {
      await this.page.unroute(hold.pattern, hold.handler).catch(() => undefined);
    }
    const releases = [...this.pending];
    for (const release of releases) release();
    return releases.length;
  }

  async fail(pattern: string, status: FailRequestStatus): Promise<BrowserControlledRequest[]> {
    const requests: BrowserControlledRequest[] = [];
    await this.page.route(pattern, async (route) => {
      const request = route.request();
      requests.push({
        method: request.method(),
        url: request.url(),
        effect: "failed",
        autoReleased: false,
        failedWith: status,
      });
      if (status === "network") {
        await route.abort("failed").catch(() => undefined);
      } else {
        await route.fulfill({ status, body: "" }).catch(() => undefined);
      }
    });
    return requests;
  }
}

/**
 * Drives a real Chromium browser against an exposed preview URL. This is
 * the only file in the repository that imports Playwright. SDD section 14
 * keeps the provider SDK out of core workflow policy.
 */
export class PlaywrightBrowserDriver implements BrowserDriver {
  readonly name = "playwright";

  /** The hold limit is a constructor value only so that a driver test need not wait 30 seconds. */
  constructor(private readonly holdLimitMs: number = HOLD_LIMIT_MS) {}

  async run(scenario: BrowserScenario): Promise<BrowserRunResult> {
    const tempDir = await mkdtemp(path.join(tmpdir(), "factoree-browser-"));
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let contextClosed = false;
    let control: NetworkControl | undefined;

    const consoleLines: string[] = [];
    const network: BrowserNetworkEntry[] = [];
    const artifacts: BrowserArtifact[] = [];
    const steps: BrowserStepResult[] = [];
    let failureReason: string | null = null;

    try {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({
        ...(scenario.captureVideo ? { recordVideo: { dir: tempDir } } : {}),
        // docs/specs/repository-setup-and-services.md. The cookies and the local storage of the
        // account the entry signs in as.
        ...(scenario.storageState === undefined
          ? {}
          : { storageState: JSON.parse(scenario.storageState) as StorageState }),
      });
      if (scenario.captureTrace) {
        await context.tracing.start({ screenshots: true, snapshots: true });
      }

      const page = await context.newPage();
      page.on("console", (message) => {
        consoleLines.push(`${message.type()}: ${message.text()}`);
      });
      page.on("response", (response) => {
        network.push({
          method: response.request().method(),
          url: response.url(),
          status: response.status(),
        });
      });
      // A request that fails as a network error has no response. A failRequest with `network`
      // makes one, and the network evidence must show it.
      page.on("requestfailed", (request) => {
        network.push({ method: request.method(), url: request.url(), status: null });
      });
      control = new NetworkControl(page, this.holdLimitMs);
      const controlledSteps: Array<{ result: BrowserStepResult; url: string }> = [];

      const stepCount = scenario.steps.length;
      const perStepTimeoutMs = Math.max(
        MIN_STEP_TIMEOUT_MS,
        Math.floor(scenario.timeoutMs / Math.max(stepCount, 1)),
      );

      let stopped = false;
      for (let index = 0; index < scenario.steps.length; index += 1) {
        const step = scenario.steps[index]!;
        if (stopped) {
          steps.push({ index, action: step.action, passed: false, detail: "not run" });
          continue;
        }
        try {
          if (step.action === "holdRequest" || step.action === "failRequest") {
            const requests =
              step.action === "holdRequest"
                ? await control.hold(step.url)
                : await control.fail(step.url, step.status);
            const result: BrowserStepResult = { index, action: step.action, passed: true, detail: "", requests };
            steps.push(result);
            controlledSteps.push({ result, url: step.url });
            continue;
          }
          if (step.action === "releaseRequests") {
            const released = await control.release();
            steps.push({
              index,
              action: step.action,
              passed: true,
              detail: `Released ${released} held ${released === 1 ? "request" : "requests"}.`,
            });
            continue;
          }
          const detail = await this.runStep(
            page,
            step,
            scenario.baseUrl,
            perStepTimeoutMs,
            artifacts,
          );
          steps.push({ index, action: step.action, passed: true, detail });
        } catch (error) {
          const message = redact(error);
          steps.push({ index, action: step.action, passed: false, detail: message });
          failureReason = message;
          stopped = true;
        }
      }

      // Rule 7: a failure while capturing the final screenshot must not mask
      // the real failure reason. The scenario result still returns.
      try {
        const finalScreenshotBytes = await page.screenshot();
        artifacts.push({
          kind: "screenshot",
          name: "final",
          contentType: "image/png",
          bytes: finalScreenshotBytes,
        });
      } catch (error) {
        consoleLines.push(`driver: failed to capture the final screenshot: ${redact(error)}`);
      }

      // A hold lasts until a release step or the end of the scenario.
      await control.release();
      for (const { result, url } of controlledSteps) {
        const requests = result.requests ?? [];
        const verb = result.action === "holdRequest" ? "Held" : "Failed";
        result.detail =
          requests.length === 0
            ? `No request matched ${url}.`
            : `${verb} ${requests.length} ${requests.length === 1 ? "request" : "requests"} that match ${url}: ${describeRequests(requests)}.`;
      }

      if (scenario.captureTrace) {
        const tracePath = path.join(tempDir, "trace.zip");
        // Rule 4: a stop failure or a read failure must not reject run(). Every other capture
        // failure is caught here too. Record the loss and continue.
        try {
          await context.tracing.stop({ path: tracePath });
          const traceBytes = await readFile(tracePath);
          artifacts.push({
            kind: "trace",
            name: "trace",
            contentType: "application/zip",
            bytes: new Uint8Array(traceBytes),
          });
        } catch (error) {
          consoleLines.push(`driver: failed to read the trace file: ${redact(error)}`);
        }
      }

      if (scenario.captureVideo) {
        const video = page.video();
        if (video) {
          await context.close();
          contextClosed = true;
          // Rule 4: a read failure must not reject run(). Record the loss and continue.
          try {
            const videoPath = await video.path();
            const videoBytes = await readFile(videoPath);
            artifacts.push({
              kind: "video",
              name: "video",
              contentType: "video/webm",
              bytes: new Uint8Array(videoBytes),
            });
          } catch (error) {
            consoleLines.push(`driver: failed to read the video file: ${redact(error)}`);
          }
        }
      }

      return {
        passed: steps.every((step) => step.passed),
        steps,
        consoleLines,
        network,
        artifacts,
        failureReason,
      };
    } finally {
      await control?.release();
      if (context && !contextClosed) {
        await context.close().catch(() => undefined);
      }
      if (browser) {
        await browser.close().catch(() => undefined);
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async signIn(input: BrowserSignIn): Promise<BrowserSignInResult> {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const perStepTimeoutMs = Math.max(MIN_STEP_TIMEOUT_MS, Math.floor(input.timeoutMs / Math.max(input.steps.length, 1)));
      for (let index = 0; index < input.steps.length; index += 1) {
        try {
          await this.runStep(page, input.steps[index]!, input.baseUrl, perStepTimeoutMs, []);
        } catch (error) {
          return { signedIn: false, failedStep: index + 1, reason: redact(error) };
        }
      }
      return { signedIn: true, storageState: JSON.stringify(await context.storageState()) };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  private async runStep(
    page: Page,
    step: BrowserStep,
    baseUrl: string,
    timeoutMs: number,
    artifacts: BrowserArtifact[],
  ): Promise<string> {
    switch (step.action) {
      case "goto": {
        const url = resolveGotoUrl(baseUrl, step.path);
        await page.goto(url, { timeout: timeoutMs });
        return `Opened ${step.path}.`;
      }
      case "click": {
        await page.locator(step.selector).click({ timeout: timeoutMs });
        return `Clicked ${step.selector}.`;
      }
      case "fill": {
        await page.locator(step.selector).fill(step.value, { timeout: timeoutMs });
        return `Filled ${step.selector} with the given value.`;
      }
      case "reload": {
        await page.reload({ timeout: timeoutMs });
        return "Reloaded the page.";
      }
      case "expectText": {
        const locator = page.locator(step.selector);
        const actual = await locator.textContent({ timeout: timeoutMs });
        // The element must contain the text. An exact match failed the FAC-47 footer, which
        // showed the version beside other text. A plan that needs exact text picks a selector
        // that holds only that text.
        const trimmedActual = (actual ?? "").replace(/\s+/g, " ").trim();
        const trimmedExpected = step.text.replace(/\s+/g, " ").trim();
        if (!trimmedActual.includes(trimmedExpected)) {
          throw new Error(
            `Expected ${step.selector} to contain text "${trimmedExpected}", but it held "${trimmedActual}".`,
          );
        }
        return `Confirmed ${step.selector} holds the expected text.`;
      }
      case "expectVisible": {
        try {
          await page.locator(step.selector).waitFor({ state: "visible", timeout: timeoutMs });
        } catch {
          throw new Error(`Expected ${step.selector} to be visible, but it was not.`);
        }
        return `Confirmed ${step.selector} is visible.`;
      }
      case "screenshot": {
        const bytes = await page.screenshot({ timeout: timeoutMs });
        artifacts.push({
          kind: "screenshot",
          name: step.name,
          contentType: "image/png",
          bytes,
        });
        return `Captured a screenshot named "${step.name}".`;
      }
      case "holdRequest":
      case "releaseRequests":
      case "failRequest":
        throw new Error(`The ${step.action} step runs through the network control, not runStep.`);
      default: {
        const exhaustive: never = step;
        throw new Error(`Unknown browser step action: ${JSON.stringify(exhaustive)}.`);
      }
    }
  }
}
