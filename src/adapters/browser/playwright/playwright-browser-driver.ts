import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  BrowserArtifact,
  BrowserDriver,
  BrowserNetworkEntry,
  BrowserRunResult,
  BrowserScenario,
  BrowserStepResult,
} from "../../../domain/validation/browser-driver.js";
import type { BrowserStep } from "../../../domain/validation/validation-plan.js";
import { resolvePreviewUrl } from "../../../domain/validation/preview-url.js";

const MIN_STEP_TIMEOUT_MS = 1000;

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

/**
 * Drives a real Chromium browser against an exposed preview URL. This is
 * the only file in the repository that imports Playwright. SDD section 14
 * keeps the provider SDK out of core workflow policy.
 */
export class PlaywrightBrowserDriver implements BrowserDriver {
  readonly name = "playwright";

  async run(scenario: BrowserScenario): Promise<BrowserRunResult> {
    const tempDir = await mkdtemp(path.join(tmpdir(), "factoree-browser-"));
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let contextClosed = false;

    const consoleLines: string[] = [];
    const network: BrowserNetworkEntry[] = [];
    const artifacts: BrowserArtifact[] = [];
    const steps: BrowserStepResult[] = [];
    let failureReason: string | null = null;

    try {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext(
        scenario.captureVideo ? { recordVideo: { dir: tempDir } } : {},
      );
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
      if (context && !contextClosed) {
        await context.close().catch(() => undefined);
      }
      if (browser) {
        await browser.close().catch(() => undefined);
      }
      await rm(tempDir, { recursive: true, force: true });
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
      default: {
        const exhaustive: never = step;
        throw new Error(`Unknown browser step action: ${JSON.stringify(exhaustive)}.`);
      }
    }
  }
}
