import { describe, expect, it } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import { createAgentActivities } from "~/activities/agent.activities.js";
import type { ImplementActivityOutput } from "~/activities/agent.activities.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import type { AgentExecutionRecord, RecordAgentExecutionInput } from "~/domain/runs/agent-execution.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { FakeRunner } from "../support/fake-runner.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";

const build = (runner: FakeRunner, secrets: SecretStore = new MemorySecretStore()) => {
  const recorded: RecordAgentExecutionInput[] = [];
  const executions = {
    record: (recordInput: RecordAgentExecutionInput): Promise<AgentExecutionRecord> => {
      recorded.push(recordInput);
      return Promise.resolve({ ...recordInput, id: "exec-1", createdAt: new Date() });
    },
    listForRun: () => Promise.resolve([]),
  };
  const redactor = new Redactor();
  const activities = createAgentActivities({
    runners: new AgentRunnerRegistry([runner]),
    sandbox: new FakeSandbox(),
    executions,
    secrets,
    redactor,
    logger: createLogger({ level: "error", redactor, sink: () => undefined }),
  });
  return { activities, recorded, redactor };
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
  requiredContext: [],
  humanDecisions: [],
  repositoryInstructions: "Use the existing test idiom.",
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

