import { describe, expect, it } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import { createReviewActivities } from "~/activities/review.activities.js";
import type { ReviewActivityOutput } from "~/activities/review.activities.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import type { AgentExecutionRecord, RecordAgentExecutionInput } from "~/domain/runs/agent-execution.js";
import type {
  RecordReviewFindingInput,
  ReviewFindingRecord,
  ReviewFindingStore,
} from "~/domain/review/review-finding-store.js";
import type {
  SaveValidationContractInput,
  StoredValidationContract,
  ValidationContractStore,
} from "~/domain/validation/validation-contract-store.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { FakeRunner } from "../support/fake-runner.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";

const storedContract: StoredValidationContract = {
  id: "vc-1",
  tenantId: "tenant-1",
  runId: "run-1",
  version: 7,
  sha256: "a".repeat(64),
  workItem: "ENG-143",
  goal: "A signed-in editor can rename a project.",
  document: "# Validation Contract\n\n### VAL-1\n\n- method: command\n",
  assertions: [
    {
      id: "VAL-1",
      requirement: "AC-1",
      statement: "The rename command succeeds.",
      method: "command",
      evidence: ["command-output"],
      preconditions: [],
      rowId: "assertion-row-1",
    },
  ],
  createdAt: new Date("2026-08-25T10:00:00.000Z"),
};

const contractStore = (contract: StoredValidationContract | null = storedContract): ValidationContractStore => ({
  save(input: SaveValidationContractInput) {
    return Promise.resolve({
      id: "vc-new",
      tenantId: input.tenantId,
      runId: input.runId,
      version: input.contract.version,
      sha256: input.sha256,
      workItem: input.contract.workItem,
      goal: input.contract.goal,
      document: input.document,
      assertions: input.contract.assertions.map((assertion, index) => ({
        ...assertion,
        rowId: `assertion-row-${index}`,
      })),
      createdAt: new Date(),
    });
  },
  findByRun() {
    return Promise.resolve(contract);
  },
});

const findingStore = (): ReviewFindingStore & { rows: RecordReviewFindingInput[] } => {
  const rows: RecordReviewFindingInput[] = [];
  return {
    rows,
    record(input: RecordReviewFindingInput): Promise<ReviewFindingRecord> {
      rows.push(input);
      return Promise.resolve({ ...input, id: `finding-${rows.length}`, createdAt: new Date() });
    },
    listForRun() {
      return Promise.resolve([]);
    },
  };
};

const executionsStub = (): { record: (input: RecordAgentExecutionInput) => Promise<AgentExecutionRecord>; listForRun: () => Promise<AgentExecutionRecord[]>; recorded: RecordAgentExecutionInput[] } => {
  const recorded: RecordAgentExecutionInput[] = [];
  return {
    recorded,
    record(input: RecordAgentExecutionInput) {
      recorded.push(input);
      return Promise.resolve({ ...input, id: "exec-1", createdAt: new Date() });
    },
    listForRun() {
      return Promise.resolve([]);
    },
  };
};

const scriptGitAndReport = (sandbox: FakeSandbox, reportText: string | null, changedFiles: string[] = ["src/foo.ts"]): void => {
  sandbox.scriptExec(/--name-only/, { exitCode: 0, stdout: changedFiles.join("\n") });
  sandbox.scriptExec(/diff --cached [0-9a-f]{40}$/, {
    exitCode: 0,
    stdout: "diff --git a/src/foo.ts b/src/foo.ts\n+changed\n",
  });
  if (reportText === null) {
    sandbox.scriptExec(/^cat /, { exitCode: 1, stdout: "", stderr: "no such file" });
  } else {
    sandbox.scriptExec(/^cat /, { exitCode: 0, stdout: reportText });
  }
};

const build = (options: {
  sandbox?: FakeSandbox;
  runner?: FakeRunner;
  contracts?: ValidationContractStore;
  secrets?: MemorySecretStore;
} = {}) => {
  const sandbox = options.sandbox ?? new FakeSandbox();
  const runner = options.runner ?? new FakeRunner("opencode");
  const executions = executionsStub();
  const findings = findingStore();
  const redactor = new Redactor();
  const activities = createReviewActivities({
    sandbox,
    runners: new AgentRunnerRegistry([runner]),
    executions,
    secrets: options.secrets ?? new MemorySecretStore(),
    redactor,
    contracts: options.contracts ?? contractStore(),
    reviewFindings: findings,
    logger: createLogger({ level: "error", redactor, sink: () => undefined }),
  });
  return { activities, sandbox, runner, executions, findings, redactor };
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
  baseSha: "b".repeat(40),
  goal: "A signed-in editor can rename a project.",
  contextContract: null,
  constraints: [],
  verificationSummary: "All deterministic checks passed.",
  validationEvidence: ["VAL-1: PASS"],
  repositoryInstructions: "Use the existing test idiom.",
  timeoutMs: 60_000,
  attempt: 1,
};

const passReport = JSON.stringify({ version: 1, verdict: "pass", findings: [] });

describe("the review activity", () => {
  it("passes when the report holds no finding", async () => {
    const { activities, sandbox, findings } = build();
    scriptGitAndReport(sandbox, passReport);

    const result: ReviewActivityOutput = await new MockActivityEnvironment().run(
      (activityInput: typeof input) => activities.review(activityInput),
      input,
    );

    expect(result.reportUsable).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.verdict).toBe("pass");
    expect(result.findingCount).toBe(0);
    expect(result.blockingCount).toBe(0);
    expect(findings.rows).toHaveLength(0);
  });

  it("blocks when the report holds a valid high finding", async () => {
    const { activities, sandbox, findings } = build();
    const report = JSON.stringify({
      version: 1,
      verdict: "pass",
      findings: [
        {
          id: "RV-1",
          severity: "high",
          category: "correctness",
          requirement: "VAL-1",
          evidence: "src/foo.ts:1",
          description: "The rename command is never invoked.",
        },
      ],
    });
    scriptGitAndReport(sandbox, report);

    const result: ReviewActivityOutput = await new MockActivityEnvironment().run(
      (activityInput: typeof input) => activities.review(activityInput),
      input,
    );

    expect(result.reportUsable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.blockingCount).toBe(1);
    expect(result.findingCount).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(findings.rows).toHaveLength(1);
    expect(findings.rows[0]?.blocking).toBe(true);
  });

  it("does not block a style finding, and still records it", async () => {
    const { activities, sandbox, findings } = build();
    const report = JSON.stringify({
      version: 1,
      verdict: "fail",
      findings: [
        {
          id: "RV-1",
          severity: "high",
          category: "style",
          requirement: "VAL-1",
          evidence: "src/foo.ts:1",
          description: "Prefer const over let.",
        },
      ],
    });
    scriptGitAndReport(sandbox, report);

    const result: ReviewActivityOutput = await new MockActivityEnvironment().run(
      (activityInput: typeof input) => activities.review(activityInput),
      input,
    );

    expect(result.passed).toBe(true);
    expect(findings.rows).toHaveLength(1);
    expect(findings.rows[0]?.blocking).toBe(false);
  });

  it("redacts a secret the Reviewer echoes into a finding, and still blocks it", async () => {
    const { activities, sandbox, findings, redactor } = build();
    const secret = "sekrit-99887766-value";
    redactor.addSecret(secret);
    const report = JSON.stringify({
      version: 1,
      verdict: "fail",
      findings: [
        {
          id: `RV-1-${secret}`,
          severity: "high",
          category: "correctness",
          requirement: "VAL-1",
          evidence: `src/foo.ts:1 ${secret}`,
          description: `The rename command logs the value ${secret} in plain text.`,
        },
      ],
    });
    scriptGitAndReport(sandbox, report);

    const result: ReviewActivityOutput = await new MockActivityEnvironment().run(
      (activityInput: typeof input) => activities.review(activityInput),
      input,
    );

    // The finding still blocks. The evidence still names the changed file `src/foo.ts`, so
    // redacting the secret out of the id, evidence, and description cannot change
    // `decideReview`'s ruling.
    expect(result.passed).toBe(false);
    expect(result.blockingCount).toBe(1);

    expect(findings.rows).toHaveLength(1);
    const row = findings.rows[0];
    expect(row?.blocking).toBe(true);
    expect(row?.findingKey).not.toContain(secret);
    expect(row?.evidence).not.toContain(secret);
    expect(row?.description).not.toContain(secret);
    expect(row?.decisionReason).not.toContain(secret);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).not.toContain(secret);
  });

  it("records one AgentExecution row of role reviewer per attempt", async () => {
    const { activities, sandbox, executions } = build();
    scriptGitAndReport(sandbox, passReport);

    await new MockActivityEnvironment().run(
      (activityInput: typeof input) => activities.review(activityInput),
      input,
    );

    expect(executions.recorded).toHaveLength(1);
    expect(executions.recorded[0]?.role).toBe("reviewer");
    expect(executions.recorded[0]?.idempotencyKey).toBe("run:run-1:reviewer:1");
  });

  it("starts a session whose prompt holds no Implementer summary", async () => {
    const runner = new FakeRunner("opencode");
    const { activities, sandbox } = build({ runner });
    scriptGitAndReport(sandbox, passReport);

    await new MockActivityEnvironment().run(
      (activityInput: typeof input) => activities.review(activityInput),
      input,
    );

    expect(runner.runs).toHaveLength(1);
    const prompt = runner.runs[0]?.prompt ?? "";
    // The prompt states, once, that no Implementer transcript reaches this session. It must not
    // carry an actual transcript excerpt or an actual Implementer summary section.
    expect(prompt.match(/Implementer transcript/gi)).toHaveLength(1);
    expect(prompt).not.toMatch(/## Implementer/i);
    expect(prompt).not.toMatch(/Implementer summary/i);
  });

  it("reports reportUsable false when the report file is absent", async () => {
    const { activities, sandbox, findings } = build();
    scriptGitAndReport(sandbox, null);

    const result: ReviewActivityOutput = await new MockActivityEnvironment().run(
      (activityInput: typeof input) => activities.review(activityInput),
      input,
    );

    expect(result.reportUsable).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.verdict).toBe("fail");
    expect(result.reportProblem).toBe("The Reviewer wrote no report.");
    expect(findings.rows).toHaveLength(0);
  });

  it("reports reportUsable false when the report is not valid JSON", async () => {
    const { activities, sandbox, findings } = build();
    scriptGitAndReport(sandbox, "not json at all");

    const result: ReviewActivityOutput = await new MockActivityEnvironment().run(
      (activityInput: typeof input) => activities.review(activityInput),
      input,
    );

    expect(result.reportUsable).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.reportProblem).toMatch(/not valid JSON/);
    expect(findings.rows).toHaveLength(0);
  });

  it("raises a RunConfigurationError for an unregistered reviewer runner", async () => {
    const { activities, sandbox } = build();
    scriptGitAndReport(sandbox, passReport);

    await expect(
      new MockActivityEnvironment().run(
        (activityInput: typeof input) => activities.review(activityInput),
        { ...input, runnerName: "not-registered" },
      ),
    ).rejects.toThrow(RunConfigurationError);
  });

  it("persists every finding, blocking and non-blocking", async () => {
    const { activities, sandbox, findings } = build();
    const report = JSON.stringify({
      version: 1,
      verdict: "fail",
      findings: [
        {
          id: "RV-1",
          severity: "high",
          category: "correctness",
          requirement: "VAL-1",
          evidence: "src/foo.ts:1",
          description: "The rename command is never invoked.",
        },
        {
          id: "RV-2",
          severity: "low",
          category: "style",
          requirement: "cosmetics",
          evidence: "src/foo.ts:2",
          description: "Prefer const over let.",
        },
      ],
    });
    scriptGitAndReport(sandbox, report);

    const result: ReviewActivityOutput = await new MockActivityEnvironment().run(
      (activityInput: typeof input) => activities.review(activityInput),
      input,
    );

    expect(result.findingCount).toBe(2);
    expect(findings.rows).toHaveLength(2);
    expect(findings.rows.map((row) => row.findingKey).sort()).toEqual(["RV-1", "RV-2"]);
    expect(findings.rows.find((row) => row.findingKey === "RV-1")?.blocking).toBe(true);
    expect(findings.rows.find((row) => row.findingKey === "RV-2")?.blocking).toBe(false);
  });

  // Defect 4 regression tests. A session that did not complete, or that was cancelled, must not
  // decide the Run, even when a report file happens to exist on disk.

  it("reports reportUsable false when the session did not complete, and persists no finding", async () => {
    const runner = new FakeRunner("opencode", { completed: false });
    const { activities, sandbox, findings } = build({ runner });
    scriptGitAndReport(sandbox, passReport);

    const result: ReviewActivityOutput = await new MockActivityEnvironment().run(
      (activityInput: typeof input) => activities.review(activityInput),
      input,
    );

    expect(result.reportUsable).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.reportProblem).toBe("The Reviewer session did not complete.");
    expect(findings.rows).toHaveLength(0);
  });

  it("reports reportUsable false when the session was cancelled, and persists no finding", async () => {
    const runner = new FakeRunner("opencode", { cancelled: true });
    const { activities, sandbox, findings } = build({ runner });
    scriptGitAndReport(sandbox, passReport);

    const result: ReviewActivityOutput = await new MockActivityEnvironment().run(
      (activityInput: typeof input) => activities.review(activityInput),
      input,
    );

    expect(result.reportUsable).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.reportProblem).toBe("The Reviewer session was cancelled.");
    expect(findings.rows).toHaveLength(0);
  });

  // Defect 3 regression test. The report path carries the attempt number, so attempt 2 must
  // never read the report attempt 1 left behind.

  it("does not read attempt 1's report on attempt 2", async () => {
    const { activities, sandbox } = build();
    sandbox.scriptExec(/--name-only/, { exitCode: 0, stdout: "src/foo.ts" });
    sandbox.scriptExec(/diff --cached [0-9a-f]{40}$/, {
      exitCode: 0,
      stdout: "diff --git a/src/foo.ts b/src/foo.ts\n+changed\n",
    });
    // Attempt 1's report is present on disk, exactly as an earlier attempt would leave it.
    sandbox.scriptExec(/^cat .*report-1\.json/, { exitCode: 0, stdout: passReport });
    // Attempt 2's fresh Reviewer session wrote nothing.
    sandbox.scriptExec(/^cat .*report-2\.json/, { exitCode: 1, stdout: "", stderr: "no such file" });

    const result: ReviewActivityOutput = await new MockActivityEnvironment().run(
      (activityInput: typeof input) => activities.review(activityInput),
      { ...input, attempt: 2 },
    );

    expect(result.reportUsable).toBe(false);
    expect(result.reportProblem).toBe("The Reviewer wrote no report.");
  });
});
