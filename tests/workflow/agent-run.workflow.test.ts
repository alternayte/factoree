/* eslint-disable @typescript-eslint/require-await -- test activity doubles intentionally return immediately */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { agentRunWorkflow, stopSignal, humanInputSignal, runStatusQuery } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";

let environment: TestWorkflowEnvironment;
const created: string[] = [];
const acknowledged: string[] = [];
const completions: Array<{ runId: string; status: string; failureReason?: string }> = [];
const statuses: string[] = [];

const activities = {
  createRun: async (input: { linearAgentSessionId: string }) => {
    created.push(input.linearAgentSessionId);
    return { runId: `run-${input.linearAgentSessionId}`, created: created.filter((id) => id === input.linearAgentSessionId).length === 1 };
  },
  setRunStatus: async (input: { status: string }) => {
    statuses.push(input.status);
  },
  completeRun: async (input: { runId: string; status: string; failureReason?: string }) => {
    completions.push(input);
  },
  acknowledgeSession: async (input: { sessionId: string }) => {
    acknowledged.push(input.sessionId);
  },
  postProgress: async () => undefined,
  postElicitation: async () => undefined,
  postFinalResponse: async () => undefined,
  postError: async () => undefined,
};

const input = (sessionId: string, maxRunMinutes = 90) => ({
  tenantId: "tenant-1",
  workspaceId: "workspace-123",
  projectId: "project-1",
  linearIssueId: "issue-1",
  agentSessionId: sessionId,
  autonomyLevel: "L2",
  maxRunMinutes,
});

const runWorker = async <T>(body: () => Promise<T>): Promise<T> => {
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: "test",
    workflowsPath: new URL("../../src/workflows/agent-run.workflow.ts", import.meta.url).pathname,
    activities,
  });
  return worker.runUntil(body());
};

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

describe("agentRunWorkflow", () => {
  it("creates a durable Run and acknowledges the Linear session", async () => {
    const result = await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "session-a"),
        args: [input("session-a")],
      });
      await handle.signal(stopSignal);
      return handle.result();
    });
    expect(created).toContain("session-a");
    expect(acknowledged).toContain("session-a");
    expect(result.runId).toBe("run-session-a");
    expect(result.status).toBe("CANCELLED");
  });

  it("rejects a second workflow with the same workflow ID", async () => {
    await runWorker(async () => {
      const workflowId = buildWorkflowId("workspace-123", "session-b");
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId,
        args: [input("session-b")],
      });
      await expect(
        environment.client.workflow.start(agentRunWorkflow, {
          taskQueue: "test",
          workflowId,
          args: [input("session-b")],
        }),
      ).rejects.toThrow();
      await handle.signal(stopSignal);
      await handle.result();
    });
    expect(created.filter((id) => id === "session-b")).toHaveLength(1);
  });

  it("answers the status query and records human input", async () => {
    await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "session-c"),
        args: [input("session-c")],
      });
      await handle.signal(humanInputSignal, "use Postgres");
      await handle.signal(stopSignal);
      await handle.result();

      const snapshot = await handle.query(runStatusQuery);
      expect(snapshot.runId).toBe("run-session-c");
      expect(snapshot.status).toBe("CANCELLED");
      expect(snapshot.humanInputs).toEqual(["use Postgres"]);
      expect(statuses).toContain("WAITING_FOR_INPUT");
    });
  });

  it("fails with RUN_TIMEOUT after the maximum Run duration", async () => {
    const result = await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "session-d"),
        args: [input("session-d", 1)],
      });
      return handle.result();
    });
    expect(result.status).toBe("FAILED");
    expect(completions.at(-1)?.failureReason).toBe("RUN_TIMEOUT");
  });
});
