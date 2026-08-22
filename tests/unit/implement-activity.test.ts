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

const secrets = {
  put: () => Promise.resolve(),
  get: () => Promise.resolve(null),
  listNames: () => Promise.resolve([]),
  remove: () => Promise.resolve(false),
};

const build = (runner: FakeRunner) => {
  const recorded: RecordAgentExecutionInput[] = [];
  const executions = {
    record: (recordInput: RecordAgentExecutionInput): Promise<AgentExecutionRecord> => {
      recorded.push(recordInput);
      return Promise.resolve({ ...recordInput, id: "exec-1", createdAt: new Date() });
    },
    listForRun: () => Promise.resolve([]),
  };
  const activities = createAgentActivities({
    runners: new AgentRunnerRegistry([runner]),
    sandbox: new FakeSandbox(),
    executions,
    secrets,
    redactor: new Redactor(),
    logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
  });
  return { activities, recorded };
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
