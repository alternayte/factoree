/* eslint-disable @typescript-eslint/require-await -- test activity doubles intentionally return immediately */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Context } from "@temporalio/activity";
import { Worker } from "@temporalio/worker";
import { agentRunWorkflow, stopSignal, humanInputSignal, runStatusQuery } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { DEFAULT_PROJECT_RUNTIME_CONFIG } from "~/domain/runs/project-runtime-config.js";
import type { PrepareSandboxActivityInput } from "~/activities/sandbox.activities.js";
import type { ImplementActivityInput } from "~/activities/agent.activities.js";

let environment: TestWorkflowEnvironment;
const created: string[] = [];
const acknowledged: string[] = [];
const completions: Array<{ runId: string; status: string; failureReason?: string }> = [];
const statuses: string[] = [];
const failingSessions = new Set<string>();
const prepared: PrepareSandboxActivityInput[] = [];
const implementCalls: ImplementActivityInput[] = [];
const cancelledSessions: Array<{ runnerName: string; session: { sessionId: string } }> = [];
const destroyed: string[] = [];
/** A run id in this map holds preparation open until the test resolves the promise. */
const heldPreparations = new Map<string, Promise<void>>();
/** A run id in this map holds the Implementer open, the same way a real agent run does. */
const heldImplementations = new Map<string, Promise<void>>();
/** The run ids whose Implementer double reports a failed attempt. */
const failingImplementations = new Set<string>();
/** The run ids whose live Implementer session the activity cancelled. */
const cancelledLiveSessions: string[] = [];

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
    if (failingSessions.has(input.sessionId)) throw new Error("Linear is down");
    acknowledged.push(input.sessionId);
  },
  postProgress: async () => undefined,
  postElicitation: async () => undefined,
  postFinalResponse: async () => undefined,
  postError: async () => undefined,
  prepareSandbox: async (activityInput: PrepareSandboxActivityInput) => {
    prepared.push(activityInput);
    await heldPreparations.get(activityInput.runId);
    return {
      spriteId: `sprite-${activityInput.runId}`,
      adapter: "fake",
      workspacePath: "/workspace",
      primaryPath: "/workspace/primary",
      baseSha: "a".repeat(40),
      referencePaths: [],
      baselineCheckpointId: null,
    };
  },
  destroySandbox: async (activityInput: { spriteId: string }) => {
    destroyed.push(activityInput.spriteId);
  },
  reapExpiredSandboxes: async () => 0,
  implement: async (activityInput: ImplementActivityInput) => {
    implementCalls.push(activityInput);
    const held = heldImplementations.get(activityInput.runId);
    if (held !== undefined) {
      // The real activity cancels the live agent session when Temporal cancels the activity.
      // This double records the same event and then returns its evidence.
      Context.current().cancellationSignal.addEventListener(
        "abort",
        () => cancelledLiveSessions.push(activityInput.runId),
        { once: true },
      );
      const heartbeat = setInterval(() => Context.current().heartbeat(), 100);
      try {
        await held;
      } finally {
        clearInterval(heartbeat);
      }
    }
    return {
      sessionId: "ses_fake",
      processId: "process-fake",
      runner: activityInput.runnerName,
      completed: !failingImplementations.has(activityInput.runId),
      exitCode: 0,
      cancelled: false,
      summary: "The change is applied.",
      durationMs: 10,
    };
  },
  cancelImplementer: async (activityInput: { runnerName: string; session: { sessionId: string } }) => {
    cancelledSessions.push(activityInput);
  },
};

const sandboxInput = {
  primary: { url: "https://example.invalid/primary.git", ref: "main" },
  references: [],
  config: DEFAULT_PROJECT_RUNTIME_CONFIG,
  goal: "Add the health endpoint.",
  repositoryInstructions: "Use the existing test idiom.",
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

/** Polls until the predicate holds. It lets the workflow reach a step before the test signals. */
const waitFor = async (predicate: () => boolean, what = "the condition"): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`the test waited ten seconds for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

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
      expect(statuses).toContain("RECEIVED");
      expect(statuses).not.toContain("WAITING_FOR_INPUT");
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

  it("moves through PREPARING and IMPLEMENTING when the input carries a sandbox", async () => {
    const result = await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "session-f"),
        args: [{ ...input("session-f"), sandbox: sandboxInput }],
      });
      await waitFor(
        () => implementCalls.some((entry) => entry.runId === "run-session-f"),
        "the Implementer of session-f",
      );
      await handle.signal(stopSignal);
      return handle.result();
    });
    expect(statuses.slice(-3)).toEqual(["RECEIVED", "PREPARING", "IMPLEMENTING"]);
    expect(implementCalls.at(-1)?.runnerName).toBe(DEFAULT_PROJECT_RUNTIME_CONFIG.implementerRunner);
    expect(implementCalls.at(-1)?.attempt).toBe(1);
    expect(result.status).toBe("CANCELLED");
  });

  it("keeps the sandbox after the Run reaches a terminal state, so the retention window holds", async () => {
    // SDD sections 32 and 51 order RETAIN before DELETE. SpriteReaper deletes the sandbox later.
    const before = destroyed.length;
    await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "session-g"),
        args: [{ ...input("session-g"), sandbox: sandboxInput }],
      });
      await waitFor(
        () => implementCalls.some((entry) => entry.runId === "run-session-g"),
        "the Implementer of session-g",
      );
      await handle.signal(stopSignal);
      await handle.result();
      const snapshot = await handle.query(runStatusQuery);
      expect(snapshot.spriteId).toBe("sprite-run-session-g");
    });
    expect(destroyed).toHaveLength(before);
  });

  it("cancels the Implementer session when a stop signal arrives", async () => {
    const result = await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "session-h"),
        args: [{ ...input("session-h"), sandbox: sandboxInput }],
      });
      await waitFor(
        () => implementCalls.some((entry) => entry.runId === "run-session-h"),
        "the Implementer of session-h",
      );
      await handle.signal(stopSignal);
      return handle.result();
    });
    expect(cancelledSessions.at(-1)).toMatchObject({
      runnerName: DEFAULT_PROJECT_RUNTIME_CONFIG.implementerRunner,
      session: { sessionId: "ses_fake" },
    });
    expect(result.status).toBe("CANCELLED");
  });

  it("does not start the Implementer when the stop arrives during preparation", async () => {
    let release = (): void => undefined;
    heldPreparations.set(
      "run-session-i",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const before = implementCalls.length;
    const cancelledBefore = cancelledSessions.length;
    const result = await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "session-i"),
        args: [{ ...input("session-i"), sandbox: sandboxInput }],
      });
      // Wait until the workflow has entered PREPARING, then stop it while preparation runs.
      await waitFor(
        () => prepared.some((entry) => entry.runId === "run-session-i"),
        "the preparation of session-i",
      );
      await handle.signal(stopSignal);
      release();
      return handle.result();
    });
    heldPreparations.delete("run-session-i");
    expect(implementCalls).toHaveLength(before);
    expect(cancelledSessions).toHaveLength(cancelledBefore);
    expect(result.status).toBe("CANCELLED");
  });

  it("cancels the live Implementer session when the stop arrives while it still runs", async () => {
    let release = (): void => undefined;
    heldImplementations.set(
      "run-session-j",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const result = await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "session-j"),
        args: [{ ...input("session-j"), sandbox: sandboxInput }],
      });
      await waitFor(
        () => implementCalls.some((entry) => entry.runId === "run-session-j"),
        "the Implementer of session-j",
      );
      await handle.signal(stopSignal);
      // The stop must reach the activity while the Implementer still runs.
      await waitFor(() => cancelledLiveSessions.includes("run-session-j"), "the live cancellation");
      release();
      return handle.result();
    });
    heldImplementations.delete("run-session-j");
    expect(cancelledLiveSessions).toContain("run-session-j");
    expect(result.status).toBe("CANCELLED");
    expect(completions.at(-1)?.failureReason).toBe("STOPPED_BY_HUMAN");
  });

  it("fails with IMPLEMENTATION_FAILED when the Implementer reports a failed attempt", async () => {
    failingImplementations.add("run-session-k");
    try {
      const result = await runWorker(async () => {
        const handle = await environment.client.workflow.start(agentRunWorkflow, {
          taskQueue: "test",
          workflowId: buildWorkflowId("workspace-123", "session-k"),
          args: [{ ...input("session-k"), sandbox: sandboxInput }],
        });
        return handle.result();
      });
      expect(result.status).toBe("FAILED");
      expect(completions.at(-1)?.failureReason).toBe("IMPLEMENTATION_FAILED");
    } finally {
      failingImplementations.delete("run-session-k");
    }
  });

  it("fails with RUN_TIMEOUT when preparation consumes the Run budget", async () => {
    // The Run budget is under one second here, and preparation takes longer than the budget.
    // The Run must end at once, rather than wait a further whole budget after preparation.
    heldPreparations.set("run-session-l", new Promise<void>((resolve) => setTimeout(resolve, 4_000)));
    const before = implementCalls.length;
    const result = await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "session-l"),
        args: [{ ...input("session-l", 0.03), sandbox: sandboxInput }],
      });
      return handle.result();
    });
    heldPreparations.delete("run-session-l");
    expect(implementCalls).toHaveLength(before);
    expect(result.status).toBe("FAILED");
    expect(completions.at(-1)?.failureReason).toBe("RUN_TIMEOUT");
  });

  it("drives the Run to a terminal state when an activity fails permanently", async () => {
    failingSessions.add("session-e");
    try {
      await runWorker(async () => {
        const handle = await environment.client.workflow.start(agentRunWorkflow, {
          taskQueue: "test",
          workflowId: buildWorkflowId("workspace-123", "session-e"),
          args: [input("session-e")],
        });
        await expect(handle.result()).rejects.toThrow();
      });
    } finally {
      failingSessions.delete("session-e");
    }
    expect(completions.at(-1)).toMatchObject({
      runId: "run-session-e",
      status: "FAILED",
      failureReason: "INTERNAL_ERROR",
    });
  });
});
