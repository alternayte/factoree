import { describe, expect, it } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import { createAgentActivities, LiveSessionNotFoundError } from "~/activities/agent.activities.js";
import type { ImplementActivityOutput } from "~/activities/agent.activities.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import type { AgentExecutionRecord, RecordAgentExecutionInput } from "~/domain/runs/agent-execution.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { FakeRunner } from "../support/fake-runner.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import { FakeEvidenceStore } from "../support/fake-evidence-store.js";
import type { SecretStore } from "~/domain/products/secret-store.js";

const build = (runner: FakeRunner, secrets: SecretStore = new MemorySecretStore()) => {
  const sandbox = new FakeSandbox();
  const recorded: RecordAgentExecutionInput[] = [];
  const executions = {
    record: (recordInput: RecordAgentExecutionInput): Promise<AgentExecutionRecord> => {
      recorded.push(recordInput);
      return Promise.resolve({ ...recordInput, id: "exec-1", createdAt: new Date() });
    },
    listForRun: () => Promise.resolve([]),
  };
  const redactor = new Redactor();
  const evidence = new FakeEvidenceStore();
  const activities = createAgentActivities({
    runners: new AgentRunnerRegistry([runner]),
    sandbox,
    executions,
    secrets,
    redactor,
    logger: createLogger({ level: "error", redactor, sink: () => undefined }),
    evidence,
  });
  return { activities, recorded, redactor, sandbox, evidence };
};

/** Polls until the predicate holds, and names itself when it gives up. */
const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("the test waited five seconds for the condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
  referencePaths: [],
  goal: "Add the health endpoint.",
  contextContract: null,
  validationContract: "# Validation Contract\n\n### VAL-CMD-001\n\n- method: command\n",
  requiredContext: [],
  humanDecisions: [],
  repositoryInstructions: "Use the existing test idiom.",
  skills: [],
  repairFindings: [],
  stagingRead: false,
  timeoutMs: 60_000,
  attempt: 1,
};

describe("the implement activity", () => {
  it("cancels the live Implementer session when Temporal cancels the activity", async () => {
    const runner = new FakeRunner();
    const release = runner.holdRun();
    const { activities, recorded } = build(runner);
    const environment = new MockActivityEnvironment();

    const running: Promise<ImplementActivityOutput> = environment.run(
      (activityInput: typeof input): Promise<ImplementActivityOutput> => activities.implement(activityInput),
      input,
    );
    // Wait until the runner holds a live session, then cancel the activity.
    while (runner.runs.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    environment.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runner.cancelled).toHaveLength(1);
    expect(runner.cancelled[0]?.sessionId).toBe("ses_fake");

    release();
    const result = await running;
    // The evidence of the cancelled run stays. The activity returns the result of the runner.
    expect(result.sessionId).toBe("ses_fake");
    expect(recorded).toHaveLength(1);
  });

  it("cancels the session that registers after the cancellation arrived", async () => {
    const runner = new FakeRunner();
    runner.delayStart(300);
    const release = runner.holdRun();
    const { activities } = build(runner);
    const environment = new MockActivityEnvironment();

    const running: Promise<ImplementActivityOutput> = environment.run(
      (activityInput: typeof input): Promise<ImplementActivityOutput> => activities.implement(activityInput),
      input,
    );
    // The cancellation arrives before the runner has a live session.
    await waitFor(() => runner.runs.length === 1);
    environment.cancel();
    expect(runner.cancelled).toHaveLength(0);

    await waitFor(() => runner.cancelled.length === 1);
    release();
    await running;
    expect(runner.cancelled[0]?.sessionId).toBe("ses_fake");
  });

  it("cancels the session when the activity starts on an already cancelled context", async () => {
    const runner = new FakeRunner();
    runner.delayStart(100);
    const release = runner.holdRun();
    const { activities } = build(runner);
    const environment = new MockActivityEnvironment();
    // The signal is already aborted before the activity begins.
    environment.cancel();

    const running: Promise<ImplementActivityOutput> = environment.run(
      (activityInput: typeof input): Promise<ImplementActivityOutput> => activities.implement(activityInput),
      input,
    );
    await waitFor(() => runner.cancelled.length === 1);
    release();
    await running;
    expect(runner.cancelled[0]?.sessionId).toBe("ses_fake");
  });

  it("records one AgentExecution row and returns the outcome of the runner", async () => {
    const runner = new FakeRunner("opencode", { completed: false, exitCode: 1 });
    const { activities, recorded } = build(runner);
    const environment = new MockActivityEnvironment();
    const result: ImplementActivityOutput = await environment.run(
      (activityInput: typeof input): Promise<ImplementActivityOutput> => activities.implement(activityInput),
      input,
    );
    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(recorded[0]?.idempotencyKey).toBe("run:run-1:implementer:1");
    expect(runner.cancelled).toHaveLength(0);
  });
});

describe("cancelImplementer", () => {
  it("throws and logs at error when the runner reports no-live-session", async () => {
    const runner = new FakeRunner();
    runner.setCancelOutcome("no-live-session");
    const logLines: string[] = [];
    const redactor = new Redactor();
    const activities = createAgentActivities({
      runners: new AgentRunnerRegistry([runner]),
      sandbox: new FakeSandbox(),
      executions: { record: () => Promise.resolve({} as AgentExecutionRecord), listForRun: () => Promise.resolve([]) },
      secrets: new MemorySecretStore(),
      evidence: new FakeEvidenceStore(),
      redactor,
      logger: createLogger({ level: "error", redactor, sink: (line) => logLines.push(line) }),
    });

    const session = { sessionId: "ses_fake", processId: "process-fake", runner: "opencode" };
    await expect(
      activities.cancelImplementer({ runnerName: "opencode", session }),
    ).rejects.toThrow(LiveSessionNotFoundError);

    expect(logLines).toHaveLength(1);
    const entry = JSON.parse(logLines[0] ?? "{}") as Record<string, unknown>;
    expect(entry.level).toBe("error");
    expect(entry.runner).toBe("opencode");
    expect(entry.session_id).toBe("ses_fake");
    expect(entry.process_id).toBe("process-fake");
  });

  it("returns normally and does not throw when the runner reports cancelled", async () => {
    const runner = new FakeRunner();
    runner.setCancelOutcome("cancelled");
    const { activities } = build(runner);
    const session = { sessionId: "ses_fake", processId: "process-fake", runner: "opencode" };
    await expect(
      activities.cancelImplementer({ runnerName: "opencode", session }),
    ).resolves.toBeUndefined();
  });
});

describe("the implement activity and the Project secret store", () => {
  it("runs a Project that holds a real credential, redacts it, and never injects it", async () => {
    // SDD section 30: only an explicitly marked secret reaches the Implementer. SDD section 60:
    // every Project secret reaches the redactor, marked or not.
    const runner = new FakeRunner();
    const secrets = new MemorySecretStore({
      GITHUB_TOKEN: { value: "ghp_realcredentialvalue0001", injectIntoImplementer: false },
      TEST_FIXTURE_URL: { value: "http://localhost:9999/fixture", injectIntoImplementer: true },
    });
    const { activities, redactor } = build(runner, secrets);
    const environment = new MockActivityEnvironment();

    const result: ImplementActivityOutput = await environment.run(
      (activityInput: typeof input): Promise<ImplementActivityOutput> => activities.implement(activityInput),
      input,
    );

    expect(result.completed).toBe(true);
    const passed = runner.runs[0]?.environment ?? {};
    expect(passed.GITHUB_TOKEN).toBeUndefined();
    expect(passed.TEST_FIXTURE_URL).toBe("http://localhost:9999/fixture");
    expect(redactor.redact("the log holds ghp_realcredentialvalue0001")).toBe("the log holds [REDACTED]");
  });
});

describe("the implement activity and skills", () => {
  it("carries a skill line into the prompt the runner receives", async () => {
    const runner = new FakeRunner();
    const { activities } = build(runner);
    const environment = new MockActivityEnvironment();
    const withSkill = {
      ...input,
      skills: ["routes — Add a route. (repository skill, /workspace/primary/.agents/skills/routes/SKILL.md)"],
    };
    await environment.run(
      (activityInput: typeof withSkill): Promise<ImplementActivityOutput> =>
        activities.implement(activityInput),
      withSkill,
    );
    expect(runner.runs[0]?.prompt).toContain("routes — Add a route.");
    expect(runner.runs[0]?.prompt).toContain("SDD section 57 ranks a skill ninth");
  });
});

describe("implement activity, the runner credential", () => {
  it("attaches the credential to the sandbox and keeps it out of the prompt", async () => {
    const runner = new FakeRunner();
    const secrets = new MemorySecretStore({
      OPENCODE_API_KEY: { value: "zen-value", injectIntoImplementer: false, kind: "runner_credential" },
    });
    const { activities, sandbox } = build(runner, secrets);

    await new MockActivityEnvironment().run(() => activities.implement(input));

    expect(sandbox.attachedEnvironment).toEqual({ OPENCODE_API_KEY: "zen-value" });
    // SDD section 30. The credential is not implementer material: it reaches the process
    // environment of the agent, and neither the prompt nor the Implementer input.
    expect(runner.runs[0]?.prompt).not.toContain("zen-value");
    expect(runner.runs[0]?.environment).toEqual({});
  });

  it("refuses a runner credential that holds a GitHub token", async () => {
    const runner = new FakeRunner();
    const secrets = new MemorySecretStore({
      MODEL_KEY: {
        value: `ghp_${"a".repeat(36)}`,
        injectIntoImplementer: false,
        kind: "runner_credential",
      },
    });
    const { activities } = build(runner, secrets);

    await expect(new MockActivityEnvironment().run(() => activities.implement(input))).rejects.toThrow(
      /GitHub or a Linear credential/,
    );
  });
});

describe("implement activity, the evidence of a failure", () => {
  it("writes one immutable row that outlives the sandbox", async () => {
    const runner = new FakeRunner("opencode", {
      completed: false,
      exitCode: 1,
      summary: "Insufficient balance.",
      failureLog: "--- stdout ---\nInsufficient balance.\n--- stderr ---\ndisposing instance\n",
    });
    const { activities, evidence } = build(runner);

    await new MockActivityEnvironment().run(() => activities.implement(input));

    expect(evidence.rows).toHaveLength(1);
    const row = evidence.rows[0];
    expect(row?.kind).toBe("command-output");
    expect(row?.source).toBe("implement:opencode");
    expect(row?.metadata).toMatchObject({
      runner: "opencode",
      exitCode: 1,
      summary: "Insufficient balance.",
    });
    expect(String(row?.metadata["log"])).toContain("Insufficient balance.");
  });

  it("writes no row when the implementation finished", async () => {
    const runner = new FakeRunner();
    const { activities, evidence } = build(runner);

    await new MockActivityEnvironment().run(() => activities.implement(input));

    expect(evidence.rows).toEqual([]);
  });

  it("writes one row when Temporal retries the same attempt", async () => {
    const runner = new FakeRunner("opencode", {
      completed: false,
      exitCode: 1,
      summary: "boom",
      failureLog: "log",
    });
    const { activities, evidence } = build(runner);

    await new MockActivityEnvironment().run(() => activities.implement(input));
    await new MockActivityEnvironment().run(() => activities.implement(input));

    expect(evidence.rows).toHaveLength(1);
  });
});
