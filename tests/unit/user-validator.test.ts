import { describe, expect, it } from "vitest";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import {
  executeBrowserAssertion,
  runUserValidation,
  type UserValidatorDependencies,
  type UserValidationInput,
} from "~/domain/validation/user-validator.js";
import type { ValidationContract, ValidationAssertion } from "~/domain/validation/validation-contract.js";
import type { PreviewConfig } from "~/domain/runs/project-runtime-config.js";
import type { BrowserDriver, BrowserRunResult, BrowserScenario } from "~/domain/validation/browser-driver.js";
import type { HttpValidationFetch } from "~/domain/validation/http-validation.js";
import type { ReadinessProbe } from "~/domain/runs/preview.js";

const ref = { id: "sandbox-1", adapter: "fake", workspacePath: "/workspace" };

const previewConfig: PreviewConfig = {
  enabled: true,
  command: "npm run dev -- --port 8080",
  readyUrl: "http://127.0.0.1:8080/health",
  timeoutSeconds: 5,
};

const browserAssertion: ValidationAssertion = {
  id: "VAL-UI-001",
  requirement: "AC-1",
  statement: "The dashboard shows the user's name after login.",
  method: "browser",
  evidence: ["screenshot", "network", "assertion-log", "console"],
  preconditions: [],
};

const httpAssertion: ValidationAssertion = {
  id: "VAL-API-001",
  requirement: "AC-2",
  statement: "GET /health returns 200.",
  method: "http",
  evidence: ["request-response"],
  preconditions: [],
};

const manualAssertion: ValidationAssertion = {
  id: "VAL-MAN-001",
  requirement: "AC-3",
  statement: "The email arrives in the inbox of a real user.",
  method: "manual",
  evidence: ["human-confirmation"],
  preconditions: [],
};

const contract: ValidationContract = {
  version: 1,
  runId: "run-1",
  workItem: "FAC-1",
  goal: "Ship the dashboard.",
  assertions: [browserAssertion, httpAssertion, manualAssertion],
};

const planFor = (contractRef: ValidationContract): string =>
  JSON.stringify({
    version: 1,
    entries: [
      {
        assertionId: contractRef.assertions[0]!.id,
        kind: "browser",
        steps: [
          { action: "goto", path: "/" },
          { action: "expectText", selector: "h1", text: "Welcome" },
        ],
      },
      {
        assertionId: contractRef.assertions[1]!.id,
        kind: "http",
        request: {
          method: "GET",
          path: "/health",
          headers: {},
          body: null,
          expectStatus: 200,
          expectBodyContains: null,
        },
      },
    ],
  });

const passingBrowserResult: BrowserRunResult = {
  passed: true,
  steps: [{ index: 0, action: "goto", passed: true, detail: "navigated to /" }],
  consoleLines: ["ready"],
  network: [{ method: "GET", url: "/", status: 200 }],
  artifacts: [{ kind: "screenshot", name: "final", contentType: "image/png", bytes: new Uint8Array([1]) }],
  failureReason: null,
};

class FakeBrowserDriver implements BrowserDriver {
  readonly name = "fake-browser";
  readonly calls: BrowserScenario[] = [];
  result: BrowserRunResult = passingBrowserResult;

  run(scenario: BrowserScenario): Promise<BrowserRunResult> {
    this.calls.push(scenario);
    return Promise.resolve(this.result);
  }
}

const okFetch: HttpValidationFetch = () =>
  Promise.resolve({ status: 200, headers: {}, body: "ok" });

const readyProbe: ReadinessProbe = () => Promise.resolve({ status: 200 });

const buildDeps = (overrides: Partial<UserValidatorDependencies> = {}): UserValidatorDependencies & {
  sandbox: FakeSandbox;
  browser: FakeBrowserDriver;
} => {
  const sandbox = overrides.sandbox as FakeSandbox | undefined ?? new FakeSandbox();
  const browser = overrides.browser as FakeBrowserDriver | undefined ?? new FakeBrowserDriver();
  return {
    sandbox,
    browser,
    fetchImpl: overrides.fetchImpl ?? okFetch,
    probe: overrides.probe ?? readyProbe,
    redactor: overrides.redactor ?? new Redactor(),
    logger: overrides.logger ?? createLogger({ level: "error", redactor: new Redactor() }),
  };
};

const buildInput = (overrides: Partial<UserValidationInput> = {}): UserValidationInput => ({
  runId: "run-1",
  tenantId: "tenant-1",
  ref,
  primaryPath: "/workspace/primary",
  contract,
  preview: previewConfig,
  planText: planFor(contract),
  environment: {},
  timeoutMs: 5_000,
  ...overrides,
});

describe("runUserValidation", () => {
  it("passes a Run whose browser and HTTP assertions both hold", async () => {
    const deps = buildDeps();
    const input = buildInput();
    const outcome = await runUserValidation(deps, input);

    expect(outcome.outcomes.map((entry) => entry.result)).toEqual(["PASS", "PASS", "MANUAL_REQUIRED"]);
    expect(outcome.passed).toBe(false);
  });

  it("produces the evidence kinds the frozen assertion requires", async () => {
    const deps = buildDeps();
    const input = buildInput();
    const outcome = await runUserValidation(deps, input);

    const browserOutcome = outcome.outcomes.find((entry) => entry.assertionId === "VAL-UI-001")!;
    expect(browserOutcome.artifacts.map((a) => a.kind).sort()).toEqual([
      "assertion-log",
      "console",
      "network",
      "screenshot",
    ]);
  });

  it("fails a passing scenario that produced no required screenshot", async () => {
    const browser = new FakeBrowserDriver();
    browser.result = { ...passingBrowserResult, artifacts: [] };
    const deps = buildDeps({ browser });
    const input = buildInput();
    const outcome = await runUserValidation(deps, input);

    const browserOutcome = outcome.outcomes.find((entry) => entry.assertionId === "VAL-UI-001")!;
    expect(browserOutcome.result).toBe("FAIL");
    expect(browserOutcome.reason).toContain("screenshot");
  });

  it("reports MANUAL_REQUIRED for a manual assertion and runs nothing", async () => {
    const browser = new FakeBrowserDriver();
    const deps = buildDeps({ browser });
    const input = buildInput();
    const outcome = await runUserValidation(deps, input);

    const manual = outcome.outcomes.find((entry) => entry.assertionId === "VAL-MAN-001")!;
    expect(manual.result).toBe("MANUAL_REQUIRED");
    expect(manual.artifacts).toHaveLength(0);
    expect(outcome.passed).toBe(false);
  });

  it("blocks every automated assertion when the plan is absent", async () => {
    const deps = buildDeps();
    const input = buildInput({ planText: null });
    const outcome = await runUserValidation(deps, input);

    expect(outcome.outcomes.map((e) => e.result)).toEqual(["BLOCKED", "BLOCKED", "MANUAL_REQUIRED"]);
  });

  it("blocks every automated assertion when the plan is not valid", async () => {
    const deps = buildDeps();
    const input = buildInput({ planText: "{" });
    const outcome = await runUserValidation(deps, input);

    expect(outcome.outcomes.map((e) => e.result)).toEqual(["BLOCKED", "BLOCKED", "MANUAL_REQUIRED"]);
  });

  it("blocks a browser assertion when the repository configures no preview", async () => {
    const deps = buildDeps();
    const input = buildInput({ preview: null });
    const outcome = await runUserValidation(deps, input);

    expect(outcome.outcomes[0]!.result).toBe("BLOCKED");
    expect(outcome.outcomes[0]!.reason).toContain(".factoree/config.yaml");
  });

  it("blocks the browser and HTTP assertions when the preview never becomes ready", async () => {
    const sandbox = new FakeSandbox();
    const deps = buildDeps({
      sandbox,
      probe: () => Promise.resolve(null),
    });
    const input = buildInput({ timeoutMs: 1_000 });
    // The preview's own timeout is shrunk to zero, so it never becomes ready.
    const outcome = await runUserValidation(deps, {
      ...input,
      preview: { ...previewConfig, timeoutSeconds: 0 },
    });

    expect(outcome.outcomes[0]!.result).toBe("BLOCKED");
    expect(outcome.outcomes[0]!.artifacts.some((a) => a.kind === "console")).toBe(true);
  });

  it("stops the preview even when a step throws", async () => {
    const sandbox = new FakeSandbox();
    const browser = new FakeBrowserDriver();
    browser.run = () => {
      throw new Error("boom");
    };
    const deps = buildDeps({ sandbox, browser });
    const input = buildInput();

    await expect(runUserValidation(deps, input)).rejects.toThrow("boom");

    expect(sandbox.calls.filter((c) => c === "cancelProcess")).toHaveLength(1);
  });

  it("returns the results in the order of the frozen contract", async () => {
    const deps = buildDeps();
    // Plan entries reversed relative to the contract order.
    const reversedPlan = JSON.stringify({
      version: 1,
      entries: [
        {
          assertionId: contract.assertions[1]!.id,
          kind: "http",
          request: {
            method: "GET",
            path: "/health",
            headers: {},
            body: null,
            expectStatus: 200,
            expectBodyContains: null,
          },
        },
        {
          assertionId: contract.assertions[0]!.id,
          kind: "browser",
          steps: [
            { action: "goto", path: "/" },
            { action: "expectText", selector: "h1", text: "Welcome" },
          ],
        },
      ],
    });
    const input = buildInput({ planText: reversedPlan });
    const outcome = await runUserValidation(deps, input);

    expect(outcome.outcomes.map((e) => e.assertionId)).toEqual([
      "VAL-UI-001",
      "VAL-API-001",
      "VAL-MAN-001",
    ]);
  });

  it("reports a failing assertion as a repair finding", async () => {
    const browser = new FakeBrowserDriver();
    browser.result = { ...passingBrowserResult, artifacts: [] };
    const deps = buildDeps({ browser });
    const input = buildInput();
    const outcome = await runUserValidation(deps, input);

    expect(outcome.failures[0]).toContain("VAL-UI-001");
    expect(outcome.failures[0]).toContain(contract.assertions[0]!.statement);
  });

  it("blocks an assertion the plan does not cover", async () => {
    const deps = buildDeps();
    const onlyHttpPlan = JSON.stringify({
      version: 1,
      entries: [
        {
          assertionId: contract.assertions[1]!.id,
          kind: "http",
          request: {
            method: "GET",
            path: "/health",
            headers: {},
            body: null,
            expectStatus: 200,
            expectBodyContains: null,
          },
        },
      ],
    });
    const input = buildInput({ planText: onlyHttpPlan });
    const outcome = await runUserValidation(deps, input);

    const browserOutcome = outcome.outcomes.find((e) => e.assertionId === "VAL-UI-001")!;
    expect(browserOutcome.result).toBe("BLOCKED");
    expect(browserOutcome.reason).toContain("no check");
  });

  it("runs a command assertion against the sandbox and reports the exit code", async () => {
    const commandAssertion: ValidationAssertion = {
      id: "VAL-CMD-001",
      requirement: "AC-4",
      statement: "The lint command exits zero.",
      method: "command",
      evidence: ["command-output"],
      preconditions: [],
    };
    const commandContract: ValidationContract = {
      ...contract,
      assertions: [commandAssertion],
    };
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/npm run lint/, { exitCode: 0, stdout: "ok", stderr: "" });
    const deps = buildDeps({ sandbox });
    const plan = JSON.stringify({
      version: 1,
      entries: [
        {
          assertionId: "VAL-CMD-001",
          kind: "command",
          command: { run: "npm run lint", expectExitCode: 0 },
        },
      ],
    });
    const input = buildInput({ contract: commandContract, planText: plan, preview: null });
    const outcome = await runUserValidation(deps, input);

    expect(outcome.outcomes[0]!.result).toBe("PASS");
    expect(outcome.outcomes[0]!.artifacts[0]!.kind).toBe("command-output");
  });

  it("redacts the browser artefact name before it reaches the persisted metadata", async () => {
    // The name comes from the agent-authored `screenshot` step, and that session holds Project
    // test secrets. SDD section 60 requires redaction before persistence.
    const browser = new FakeBrowserDriver();
    browser.result = {
      ...passingBrowserResult,
      artifacts: [
        {
          kind: "screenshot",
          name: "after-login-with-super-secret-value",
          contentType: "image/png",
          bytes: new Uint8Array([1]),
        },
      ],
    };
    const deps = buildDeps({ browser, redactor: new Redactor(["super-secret-value"]) });
    const outcome = await runUserValidation(deps, buildInput());

    const browserOutcome = outcome.outcomes.find((entry) => entry.assertionId === "VAL-UI-001")!;
    const screenshot = browserOutcome.artifacts.find((artifact) => artifact.kind === "screenshot")!;
    const metadata = screenshot.metadata as { name: string };
    expect(metadata.name).not.toContain("super-secret-value");
    expect(metadata.name).toContain("after-login-with-");
  });

  it("redacts the plan command before it reaches the persisted metadata or the reason", async () => {
    // The command text comes from the agent-authored plan, and that session holds Project test
    // secrets. SDD section 60 requires redaction before persistence.
    const secret = "sk-live-abcdef123456";
    const commandAssertion: ValidationAssertion = {
      id: "VAL-CMD-001",
      requirement: "AC-4",
      statement: "The seed command exits zero.",
      method: "command",
      evidence: ["command-output"],
      preconditions: [],
    };
    const commandContract: ValidationContract = { ...contract, assertions: [commandAssertion] };
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/seed/, { exitCode: 1, stdout: "", stderr: "" });
    const deps = buildDeps({ sandbox, redactor: new Redactor([secret]) });
    const plan = JSON.stringify({
      version: 1,
      entries: [
        {
          assertionId: "VAL-CMD-001",
          kind: "command",
          command: { run: `npm run seed -- --token ${secret}`, expectExitCode: 0 },
        },
      ],
    });
    const input = buildInput({ contract: commandContract, planText: plan, preview: null });
    const outcome = await runUserValidation(deps, input);

    const result = outcome.outcomes[0]!;
    expect(result.result).toBe("FAIL");
    expect(result.reason).not.toContain(secret);
    const artifact = result.artifacts[0]!;
    expect(JSON.stringify(artifact.metadata)).not.toContain(secret);
    expect(new TextDecoder().decode(artifact.bytes)).not.toContain(secret);
  });
});

describe("executeBrowserAssertion", () => {
  it("blocks a goto path that resolves to another origin, and never drives the browser", async () => {
    // The plan parser rejects such a path. This control repeats the check, because a defence in
    // depth control must not trust the parser. A refusal is BLOCKED, never a PASS.
    const browser = new FakeBrowserDriver();
    const deps = buildDeps({ browser });
    const handle = {
      process: { id: "process-1" },
      baseUrl: "http://127.0.0.1:8080",
      port: 8080,
      readyUrl: "http://127.0.0.1:8080/health",
      startedAt: "1970-01-01T00:00:00.000Z",
      startupLog: "",
    };

    for (const path of ["//example.com", "///example.com", "/\\example.com"]) {
      const outcome = await executeBrowserAssertion(
        deps,
        browserAssertion,
        {
          assertionId: "VAL-UI-001",
          kind: "browser",
          steps: [
            { action: "goto", path },
            { action: "expectText", selector: "h1", text: "Welcome" },
          ],
        },
        handle,
        5_000,
      );

      expect(outcome.result).toBe("BLOCKED");
      expect(outcome.artifacts).toHaveLength(0);
    }
    expect(browser.calls).toHaveLength(0);
  });

  it("drives the browser for a relative goto path", async () => {
    const browser = new FakeBrowserDriver();
    const deps = buildDeps({ browser });
    const outcome = await executeBrowserAssertion(
      deps,
      browserAssertion,
      {
        assertionId: "VAL-UI-001",
        kind: "browser",
        steps: [
          { action: "goto", path: "/projects/1" },
          { action: "expectText", selector: "h1", text: "Welcome" },
        ],
      },
      {
        process: { id: "process-1" },
        baseUrl: "http://127.0.0.1:8080",
        port: 8080,
        readyUrl: "http://127.0.0.1:8080/health",
        startedAt: "1970-01-01T00:00:00.000Z",
        startupLog: "",
      },
      5_000,
    );

    expect(outcome.result).toBe("PASS");
    expect(browser.calls).toHaveLength(1);
  });
});
