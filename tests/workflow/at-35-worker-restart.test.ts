/* eslint-disable @typescript-eslint/require-await -- stub Activities match the workflow's async activity signatures */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { agentRunWorkflow, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";

let environment: TestWorkflowEnvironment;
const createCalls: string[] = [];
const completions: string[] = [];

const activities = {
  createRun: async (input: { linearAgentSessionId: string }) => {
    // The repository is idempotent, so a repeated call returns the same Run.
    createCalls.push(input.linearAgentSessionId);
    return { runId: `run-${input.linearAgentSessionId}`, created: createCalls.length === 1 };
  },
  setRunStatus: async () => undefined,
  completeRun: async (input: { runId: string }) => {
    completions.push(input.runId);
  },
  acknowledgeSession: async () => undefined,
  postProgress: async () => undefined,
  postElicitation: async () => undefined,
  postFinalResponse: async () => undefined,
  postError: async () => undefined,
};

const newWorker = async (): Promise<Worker> =>
  Worker.create({
    connection: environment.nativeConnection,
    taskQueue: "at-35",
    workflowsPath: new URL("../../src/workflows/agent-run.workflow.ts", import.meta.url).pathname,
    activities,
  });

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
});

afterAll(async () => {
  await environment.teardown();
});

describe("AT-35 worker restart", () => {
  it("does not duplicate a Run when the worker restarts during it", async () => {
    const workflowId = buildWorkflowId("workspace-123", "session-at35");

    const first = await newWorker();
    const firstRun = first.run();
    const handle = await environment.client.workflow.start(agentRunWorkflow, {
      taskQueue: "at-35",
      workflowId,
      args: [
        {
          tenantId: "tenant-1",
          workspaceId: "workspace-123",
          projectId: "project-1",
          linearIssueId: "issue-1",
          agentSessionId: "session-at35",
          autonomyLevel: "L2",
          maxRunMinutes: 90,
        },
      ],
    });

    // Wait until the Run exists, then stop the worker while the workflow is still open.
    for (let attempt = 0; attempt < 40 && createCalls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(createCalls).toHaveLength(1);
    first.shutdown();
    await firstRun;

    const second = await newWorker();
    const secondRun = second.run();
    await handle.signal(stopSignal);
    const result = await handle.result();
    second.shutdown();
    await secondRun;

    expect(result.runId).toBe("run-session-at35");
    expect(createCalls).toHaveLength(1);
    expect(completions).toEqual(["run-session-at35"]);
    const description = await handle.describe();
    expect(description.status.name).toBe("COMPLETED");
  });
});
