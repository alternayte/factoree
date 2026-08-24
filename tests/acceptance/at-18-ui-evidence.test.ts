import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { PlaywrightBrowserDriver } from "~/adapters/browser/playwright/playwright-browser-driver.js";
import { runUserValidation } from "~/domain/validation/user-validator.js";
import type { UserValidatorDependencies } from "~/domain/validation/user-validator.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import type { BrowserDriver, BrowserRunResult } from "~/domain/validation/browser-driver.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import { writePreviewFixtureApp } from "./support/preview-fixture-app.js";
import { pickPort, realHttpFetch, realProbe } from "./support/preview-fixture-helpers.js";

/** A BrowserDriver double that reports success but returns no artefact, screenshot included. */
class NoArtifactBrowserDriver implements BrowserDriver {
  readonly name = "no-artifact";
  run(): Promise<BrowserRunResult> {
    return Promise.resolve({
      passed: true,
      steps: [{ index: 0, action: "goto", passed: true, detail: "navigated to /" }],
      consoleLines: [],
      network: [],
      artifacts: [],
      failureReason: null,
    });
  }
}

const contract: ValidationContract = {
  version: 1,
  runId: "at18-run",
  workItem: "AT-18",
  goal: "The project page shows the project name.",
  assertions: [
    {
      id: "VAL-UI-001",
      requirement: "AC-1",
      statement: "The project page shows the project name Original Project.",
      method: "browser",
      // SDD section 37. The frozen browser assertion requires exactly these evidence kinds.
      evidence: ["screenshot", "network", "assertion-log"],
      preconditions: [],
    },
  ],
};

const previewConfig = (port: number) => ({
  enabled: true,
  command: "node server.cjs",
  readyUrl: `http://127.0.0.1:${port}/health`,
  timeoutSeconds: 30,
});

const planTextFor = (screenshotStep: boolean) =>
  JSON.stringify({
    version: 1,
    entries: [
      {
        assertionId: "VAL-UI-001",
        kind: "browser",
        steps: [
          { action: "goto", path: "/" },
          { action: "expectText", selector: "#current", text: "Original Project" },
          ...(screenshotStep ? [{ action: "screenshot", name: "final" }] : []),
        ],
      },
    ],
  });

/**
 * AT-18, SDD section 37. A browser assertion produces exactly the evidence kinds its frozen
 * assertion requires. The positive case runs a real browser against a real preview. The
 * negative case proves the required-evidence gate: a driver that reports success but produces
 * no artefact turns the assertion into FAIL, never PASS.
 */
describe("AT-18 — browser evidence matches the frozen assertion's required kinds", () => {
  let root: string;
  let sandboxRoot: string;
  let sandbox: LocalProcessSandbox;

  afterEach(async () => {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("produces exactly the evidence kinds the frozen assertion requires, from a real browser", async () => {
    const port = await pickPort();
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-at18-sandbox-"));
    sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const ref = await sandbox.create({ runId: "at18-run", tenantId: "at18-tenant", projectId: "at18-project" });
    root = ref.workspacePath;
    await writePreviewFixtureApp({ root, persistName: true });

    const dependencies: UserValidatorDependencies = {
      sandbox,
      browser: new PlaywrightBrowserDriver(),
      fetchImpl: realHttpFetch,
      probe: realProbe,
      redactor: new Redactor(),
      logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
    };

    try {
      const outcome = await runUserValidation(dependencies, {
        runId: "at18-run",
        tenantId: "at18-tenant",
        ref,
        primaryPath: root,
        contract,
        preview: previewConfig(port),
        planText: planTextFor(true),
        environment: { PORT: String(port) },
        timeoutMs: 30_000,
      });

      expect(outcome.outcomes).toHaveLength(1);
      const first = outcome.outcomes[0]!;
      const kinds = new Set(first.artifacts.map((artifact) => artifact.kind));
      for (const required of contract.assertions[0]!.evidence) {
        expect(kinds.has(required)).toBe(true);
      }

      const screenshot = first.artifacts.find((artifact) => artifact.kind === "screenshot")!;
      expect(screenshot).toBeDefined();
      // A real PNG, from a real browser, against the real preview.
      expect(Array.from(screenshot.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);

      expect(first.result).toBe("PASS");
      expect(outcome.passed).toBe(true);
    } finally {
      await sandbox.destroy(ref);
      root = "";
    }
  }, 90_000);

  it("does not pass when the required evidence is missing, even though the driver reports success", async () => {
    const port = await pickPort();
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-at18-neg-sandbox-"));
    sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const ref = await sandbox.create({ runId: "at18-neg-run", tenantId: "at18-tenant", projectId: "at18-project" });
    root = ref.workspacePath;
    await writePreviewFixtureApp({ root, persistName: true });

    const dependencies: UserValidatorDependencies = {
      sandbox,
      // The double reports `passed: true` and produces no screenshot artefact.
      browser: new NoArtifactBrowserDriver(),
      fetchImpl: realHttpFetch,
      probe: realProbe,
      redactor: new Redactor(),
      logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
    };

    try {
      const outcome = await runUserValidation(dependencies, {
        runId: "at18-neg-run",
        tenantId: "at18-tenant",
        ref,
        primaryPath: root,
        contract,
        preview: previewConfig(port),
        planText: planTextFor(false),
        environment: { PORT: String(port) },
        timeoutMs: 30_000,
      });

      expect(outcome.outcomes).toHaveLength(1);
      expect(outcome.outcomes[0]!.result).toBe("FAIL");
      expect(outcome.passed).toBe(false);
      const kinds = new Set(outcome.outcomes[0]!.artifacts.map((artifact) => artifact.kind));
      expect(kinds.has("screenshot")).toBe(false);
    } finally {
      await sandbox.destroy(ref);
      root = "";
    }
  }, 30_000);
});
