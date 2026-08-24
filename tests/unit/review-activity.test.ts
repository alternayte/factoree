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
});
