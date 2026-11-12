import { createValidationActivities } from "~/activities/validation.activities.js";
import { createEvidencePersistence } from "~/activities/evidence.activities.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
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
import { FakeSandbox } from "./fake-sandbox.js";
import type { FakeRunner } from "./fake-runner.js";
import { FakeEvidenceStore } from "./fake-evidence-store.js";
import { MemorySecretStore } from "./memory-secret-store.js";
import { MemoryAgentSessionStore } from "./memory-agent-session-store.js";

export const passingBrowserResult: BrowserRunResult = {
  passed: true,
  steps: [{ index: 0, action: "goto", passed: true, detail: "navigated to /" }],
  consoleLines: ["ready"],
  network: [{ method: "GET", url: "/", status: 200 }],
  artifacts: [{ kind: "screenshot", name: "final", contentType: "image/png", bytes: new Uint8Array([1]) }],
  failureReason: null,
};

export class FakeBrowserDriver implements BrowserDriver {
  signIn = (): Promise<never> => Promise.reject(new Error("this fake signs in no account"));
  readonly name = "fake-browser";
  readonly calls: BrowserScenario[] = [];
  result: BrowserRunResult = passingBrowserResult;

  /** Runs inside the browser step, so a test can let time pass while the step runs. */
  during: (() => Promise<void>) | null = null;

  async run(scenario: BrowserScenario): Promise<BrowserRunResult> {
    this.calls.push(scenario);
    if (this.during !== null) await this.during();
    // As the real driver: a stop closes the browser, and run rejects with the abort reason.
    scenario.signal?.throwIfAborted();
    return this.result;
  }
}

export const okFetch: HttpValidationFetch = () => Promise.resolve({ status: 200, headers: {}, body: "ok" });
export const readyProbe: ReadinessProbe = () => Promise.resolve({ status: 200 });

export class FakeResultStore implements ValidationResultStore {
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

export class FakeEvidenceStorage implements EvidenceStorage {
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

export const browserAssertion = {
  id: "VAL-UI-001",
  rowId: "row-ui-1",
  requirement: "AC-1",
  statement: "The dashboard shows the user's name after login.",
  method: "browser" as const,
  evidence: ["screenshot" as const],
  preconditions: [],
};

export const httpAssertion = {
  id: "VAL-API-001",
  rowId: "row-api-1",
  requirement: "AC-2",
  statement: "GET /health returns 200.",
  method: "http" as const,
  evidence: ["request-response" as const],
  preconditions: [],
};

export const storedContract: StoredValidationContract = {
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

export class FakeContractStore implements ValidationContractStore {
  save(): Promise<StoredValidationContract> {
    return Promise.resolve(storedContract);
  }

  findByRun(): Promise<StoredValidationContract | null> {
    return Promise.resolve(storedContract);
  }
}

export const planText = JSON.stringify({
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
export class FakeAgentExecutionRepository {
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

/**
 * The real `userValidate` activity over in-memory doubles. `logLines` holds every log line at info
 * level and above, so a test can read what the activity reported.
 */
export const build = (runner: FakeRunner, sandbox: FakeSandbox = new FakeSandbox()) => {
  sandbox.scriptExec(/^cat /, { exitCode: 0, stdout: planText });
  const executions = new FakeAgentExecutionRepository();
  const evidence = new FakeEvidenceStore();
  const results = new FakeResultStore();
  const storage = new FakeEvidenceStorage();
  const browser = new FakeBrowserDriver();
  const redactor = new Redactor();
  const logLines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "info",
    redactor,
    sink: (line) => logLines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const sessions = new MemoryAgentSessionStore();
  const activities = createValidationActivities({
    contracts: new FakeContractStore(),
    runs: { setValidationContractVersion: () => Promise.resolve() } as never,
    logger,
    userValidation: {
      sandbox,
      runners: new AgentRunnerRegistry([runner]),
      sessions,
      executions,
      secrets: new MemorySecretStore(),
      redactor,
      browser,
      fetchImpl: okFetch,
      probe: readyProbe,
      evidencePersistence: createEvidencePersistence({ evidence, results, storage, logger }),
    },
  });
  return { activities, sandbox, executions, sessions, evidence, results, storage, browser, logLines };
};

export const input = {
  runId: "run-1",
  tenantId: "tenant-1",
  productId: "project-1",
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

/**
 * FAC-63. A plan the rules reject twice over: a browser assertion written as a command check, and
 * an http path that leaves the preview origin.
 */
export const rejectedPlan = JSON.stringify({
  version: 1,
  entries: [
    { assertionId: "VAL-UI-001", kind: "command", command: { run: "npm test", expectExitCode: 0 } },
    {
      assertionId: "VAL-API-001",
      kind: "http",
      request: { method: "GET", path: "//evil.example/health", headers: {}, body: null, expectStatus: 200, expectBodyContains: null },
    },
  ],
});

/**
 * A sandbox whose first plan file holds `first`. The corrected plan file holds `corrected` once
 * `written` reports that a correction session ran.
 */
export const planFiles = (first: string, corrected: string | null, written: () => boolean = () => true): FakeSandbox => {
  const sandbox = new FakeSandbox();
  sandbox.onExec = (command) => {
    if (command.file !== "cat") return { exitCode: 0, stdout: "", stderr: "" };
    const path = command.args[0] ?? "";
    if (path.endsWith("/plan.json")) return { exitCode: 0, stdout: first, stderr: "" };
    if (path.endsWith("/plan-corrected.json") && corrected !== null && written()) {
      return { exitCode: 0, stdout: corrected, stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "No such file" };
  };
  return sandbox;
};
