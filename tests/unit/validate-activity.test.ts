import { describe, expect, it } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import { createValidationActivities } from "~/activities/validation.activities.js";
import type { UserValidateActivityOutput } from "~/activities/validation.activities.js";
import { createEvidencePersistence } from "~/activities/evidence.activities.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import type { AgentExecutionRecord, RecordAgentExecutionInput } from "~/domain/runs/agent-execution.js";
import type {
  RecordAssertionResultInput,
  ValidationAssertionResultRecord,
  ValidationResultStore,
} from "~/domain/validation/validation-result-store.js";
import type {
  StoredValidationContract,
  ValidationContractStore,
} from "~/domain/validation/validation-contract-store.js";
import type { EvidenceStorage, PutArtifactInput, StoredArtifact } from "~/domain/evidence/evidence-storage.js";
import { hashArtifactBytes } from "~/domain/evidence/evidence-storage.js";
import type { BrowserDriver, BrowserRunResult, BrowserScenario } from "~/domain/validation/browser-driver.js";
import type { HttpValidationFetch } from "~/domain/validation/http-validation.js";
import type { ReadinessProbe } from "~/domain/runs/preview.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { FakeRunner } from "../support/fake-runner.js";
import { FakeEvidenceStore } from "../support/fake-evidence-store.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";

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

const okFetch: HttpValidationFetch = () => Promise.resolve({ status: 200, headers: {}, body: "ok" });
const readyProbe: ReadinessProbe = () => Promise.resolve({ status: 200 });

class FakeResultStore implements ValidationResultStore {
  readonly rows: ValidationAssertionResultRecord[] = [];
  private readonly keys = new Set<string>();

  record(input: RecordAssertionResultInput): Promise<ValidationAssertionResultRecord> {
    const key = `${input.runId}:${input.validationAssertionId}:${input.attempt}`;
    if (this.keys.has(key)) {
      return Promise.resolve(this.rows.find((row) => `${row.runId}:${row.validationAssertionId}:${row.attempt}` === key)!);
    }
    this.keys.add(key);
    const row: ValidationAssertionResultRecord = {
      id: `result-${this.rows.length + 1}`,
      tenantId: input.tenantId,
      runId: input.runId,
      validationAssertionId: input.validationAssertionId,
      assertionKey: input.assertionKey,
      result: input.result,
      reason: input.reason,
      attempt: input.attempt,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  listForRun(tenantId: string, runId: string): Promise<ValidationAssertionResultRecord[]> {
    return Promise.resolve(this.rows.filter((row) => row.tenantId === tenantId && row.runId === runId));
  }
}

class FakeEvidenceStorage implements EvidenceStorage {
  readonly name = "fake-storage";
  readonly puts: PutArtifactInput[] = [];

  put(input: PutArtifactInput): Promise<StoredArtifact> {
    this.puts.push(input);
    return Promise.resolve({
      storageRef: `fake://${input.runId}/${input.name}`,
      sha256: hashArtifactBytes(input.bytes),
      byteLength: input.bytes.byteLength,
    });
  }
}

/**
 * Rejects every `exposeService` call, the way `FlySpriteSandbox` does today (a recorded Phase 2
 * limitation: Fly has no documented publish API). Every other method behaves like `FakeSandbox`.
 */
class NoExposeSandbox extends FakeSandbox {
  override exposeService(): ReturnType<FakeSandbox["exposeService"]> {
    return Promise.reject(new Error("this sandbox adapter cannot expose a service"));
  }
}

const browserAssertion = {
  id: "VAL-UI-001",
  rowId: "row-ui-1",
  requirement: "AC-1",
  statement: "The dashboard shows the user's name after login.",
  method: "browser" as const,
  evidence: ["screenshot" as const],
  preconditions: [],
};

const httpAssertion = {
  id: "VAL-API-001",
  rowId: "row-api-1",
  requirement: "AC-2",
  statement: "GET /health returns 200.",
  method: "http" as const,
  evidence: ["request-response" as const],
  preconditions: [],
};

const storedContract: StoredValidationContract = {
  id: "contract-1",
  tenantId: "tenant-1",
  runId: "run-1",
  version: 1,
  sha256: "deadbeef",
  workItem: "FAC-1",
  goal: "Ship the dashboard.",
  document: "# Validation Contract\n\nVAL-UI-001, VAL-API-001",
  assertions: [browserAssertion, httpAssertion],
  createdAt: new Date(),
};

class FakeContractStore implements ValidationContractStore {
  save(): Promise<StoredValidationContract> {
    return Promise.resolve(storedContract);
  }

  findByRun(): Promise<StoredValidationContract | null> {
    return Promise.resolve(storedContract);
  }
}

const planText = JSON.stringify({
  version: 1,
  entries: [
    {
      assertionId: "VAL-UI-001",
      kind: "browser",
      steps: [
        { action: "goto", path: "/" },
        { action: "expectText", selector: "h1", text: "Welcome" },
      ],
    },
    {
      assertionId: "VAL-API-001",
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

/**
 * Models `PrismaAgentExecutionRepository`, which upserts on the unique `idempotencyKey`. A
 * double that always pushes a new row cannot catch a duplicate write on a Temporal retry.
 */
class FakeAgentExecutionRepository {
  readonly rows: AgentExecutionRecord[] = [];
  private readonly keys = new Map<string, AgentExecutionRecord>();

  record(recordInput: RecordAgentExecutionInput): Promise<AgentExecutionRecord> {
    const existing = this.keys.get(recordInput.idempotencyKey);
    if (existing !== undefined) return Promise.resolve(existing);
    const row: AgentExecutionRecord = { ...recordInput, id: `exec-${this.rows.length + 1}`, createdAt: new Date() };
    this.rows.push(row);
    this.keys.set(recordInput.idempotencyKey, row);
    return Promise.resolve(row);
  }

  listForRun(): Promise<AgentExecutionRecord[]> {
    return Promise.resolve(this.rows);
  }
}

const build = (runner: FakeRunner, sandbox: FakeSandbox = new FakeSandbox()) => {
  sandbox.scriptExec(/^cat /, { exitCode: 0, stdout: planText });
  const executions = new FakeAgentExecutionRepository();
  const evidence = new FakeEvidenceStore();
  const results = new FakeResultStore();
  const storage = new FakeEvidenceStorage();
  const redactor = new Redactor();
  const logger = createLogger({ level: "error", redactor, sink: () => undefined });
  const activities = createValidationActivities({
    contracts: new FakeContractStore(),
    runs: { setValidationContractVersion: () => Promise.resolve() } as never,
    logger,
    userValidation: {
      sandbox,
      runners: new AgentRunnerRegistry([runner]),
      executions,
      secrets: new MemorySecretStore(),
      redactor,
      browser: new FakeBrowserDriver(),
      fetchImpl: okFetch,
      probe: readyProbe,
      evidencePersistence: createEvidencePersistence({ evidence, results, storage, logger }),
    },
  });
  return { activities, sandbox, executions, evidence, results, storage };
};

const input = {
  runId: "run-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  runnerName: "opencode",
  spriteId: "sprite-1",
  adapter: "fake",
  workspacePath: "/workspace",
  primaryPath: "/workspace/primary",
  goal: "Add the health endpoint.",
  preview: {
    enabled: true,
    command: "npm run dev -- --port 8080",
    readyUrl: "http://127.0.0.1:8080/health",
    timeoutSeconds: 5,
  },
  timeoutMs: 60_000,
  attempt: 1,
};

describe("the userValidate activity", () => {
  it("runs a fresh validator session and records its prompt version", async () => {
    const runner = new FakeRunner();
    const { activities, executions } = build(runner);
    const environment = new MockActivityEnvironment();

    const output: UserValidateActivityOutput = await environment.run(
      (activityInput: typeof input) => activities.userValidate(activityInput),
      input,
    );

    expect(runner.runs[0]?.role).toBe("validator");
    expect(executions.rows[0]).toMatchObject({ role: "validator", promptVersion: "user-validator@1" });
    expect(output.sessionId).toBe("ses_fake");
  });

  it("never gives the validator an Implementer transcript", async () => {
    const runner = new FakeRunner();
    const { activities } = build(runner);
    const environment = new MockActivityEnvironment();

    await environment.run((activityInput: typeof input) => activities.userValidate(activityInput), input);

    expect(runner.runs[0]?.prompt).not.toContain("The change is applied.");
  });

  it("denies the validator the primary worktree", async () => {
    const runner = new FakeRunner();
    const { activities } = build(runner);
    const environment = new MockActivityEnvironment();

    await environment.run((activityInput: typeof input) => activities.userValidate(activityInput), input);

    expect(runner.runs[0]?.actionPolicy.decide("writePrimaryWorktree")).toBe("deny");
  });

  it("writes one evidence row per artefact and one result row per assertion", async () => {
    const runner = new FakeRunner();
    const { activities, evidence, results } = build(runner);
    const environment = new MockActivityEnvironment();

    await environment.run((activityInput: typeof input) => activities.userValidate(activityInput), input);

    // The browser outcome always carries a console, a network, and an assertion-log artefact
    // beside the required screenshot; the http outcome carries one request-response artefact.
    expect(evidence.rows.filter((row) => row.validationAssertionId !== null)).toHaveLength(5);
    expect(results.rows).toHaveLength(2);
    expect(results.rows[0]).toMatchObject({ result: "PASS", attempt: 1 });
  });

  it("reports hasFailure only when an assertion is FAIL", async () => {
    const passRunner = new FakeRunner();
    const { activities } = build(passRunner);
    const environment = new MockActivityEnvironment();

    const output: UserValidateActivityOutput = await environment.run(
      (activityInput: typeof input) => activities.userValidate(activityInput),
      input,
    );
    expect(output.hasFailure).toBe(false);
    expect(output.passed).toBe(true);
  });

  it("writes nothing new on a second call with the same attempt", async () => {
    const runner = new FakeRunner();
    const { activities, executions, evidence, results } = build(runner);
    const environment = new MockActivityEnvironment();

    await environment.run((activityInput: typeof input) => activities.userValidate(activityInput), input);
    // A second call with the same attempt models a Temporal retry. The idempotency key of every
    // row it writes must stay the same, so every store must still hold the same rows, not a
    // second copy.
    await environment.run((activityInput: typeof input) => activities.userValidate(activityInput), input);

    expect(executions.rows).toHaveLength(1);
    expect(evidence.rows).toHaveLength(5);
    expect(results.rows).toHaveLength(2);
  });

  it("asks the sandbox to expose the preview address without starting a second preview process", async () => {
    const runner = new FakeRunner();
    const { activities, sandbox } = build(runner);
    const environment = new MockActivityEnvironment();

    await environment.run((activityInput: typeof input) => activities.userValidate(activityInput), input);

    // The prompt's own step reads the address through `exposeService` alone, never through
    // `startProcess`. `runUserValidation` is the only caller that starts the preview process,
    // so exactly one `startProcess` call for the preview command exists.
    expect(sandbox.calls.filter((call) => call.startsWith("exposeService")).length).toBeGreaterThan(0);
    expect(sandbox.commands.filter((command) => command.args.includes("npm run dev -- --port 8080"))).toHaveLength(1);
  });

  it("still produces results when the sandbox cannot expose the preview address", async () => {
    const runner = new FakeRunner();
    const { activities } = build(runner, new NoExposeSandbox());
    const environment = new MockActivityEnvironment();

    const output: UserValidateActivityOutput = await environment.run(
      (activityInput: typeof input) => activities.userValidate(activityInput),
      input,
    );

    // No preview URL could be read, so the browser and http assertions cannot run. The activity
    // still returns a plain result instead of throwing, and `runUserValidation` reports the
    // honest outcome for each affected assertion.
    expect(output.hasBlocked).toBe(true);
    expect(output.passed).toBe(false);
  });

  it("reports the exposed preview base URL, so the Proof Pack can name it", async () => {
    const runner = new FakeRunner();
    const { activities } = build(runner);
    const environment = new MockActivityEnvironment();

    const output: UserValidateActivityOutput = await environment.run(
      (activityInput: typeof input) => activities.userValidate(activityInput),
      input,
    );

    // SDD section 47. The Proof Pack names the preview a human can still open while the sandbox
    // lives. It must be the address the validator actually used.
    expect(output.previewUrl).toMatch(/^http/);
  });

  it("reports no preview URL when the sandbox could not expose one", async () => {
    const runner = new FakeRunner();
    const { activities } = build(runner, new NoExposeSandbox());
    const environment = new MockActivityEnvironment();

    const output: UserValidateActivityOutput = await environment.run(
      (activityInput: typeof input) => activities.userValidate(activityInput),
      input,
    );

    // A URL Factoree never exposed must never reach the Proof Pack. Null is the honest report.
    expect(output.previewUrl).toBeNull();
  });

  it("reports an unregistered validator runner as a configuration fault", async () => {
    const runner = new FakeRunner();
    const { activities } = build(runner);
    const environment = new MockActivityEnvironment();

    // SDD section 15 states `claude` as the default validator runner, and SDD section 69 gives
    // `ClaudeCodeRunner` to Phase 11. A stock configuration must fail as a repairable
    // configuration fault, not as an internal error.
    const promise = environment.run(
      (activityInput: typeof input) => activities.userValidate(activityInput),
      { ...input, runnerName: "claude" },
    );

    await expect(promise).rejects.toThrow(RunConfigurationError);
    await expect(promise).rejects.toThrow(/validator runner "claude"/);
    // The message names the registered runners, so an operator can repair the configuration.
    await expect(promise).rejects.toThrow(/opencode/);
  });
});
