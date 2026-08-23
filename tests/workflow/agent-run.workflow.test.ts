import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow, stopSignal, humanInputSignal, runStatusQuery } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { DEFAULT_PROJECT_RUNTIME_CONFIG } from "~/domain/runs/project-runtime-config.js";
import { createWorkflowHarness, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  created,
  acknowledged,
  completions,
  statuses,
  statusesOf,
  failingSessions,
  prepared,
  implementCalls,
  cancelledSessions,
  destroyed,
  heldPreparations,
  heldImplementations,
  failingImplementations,
  cancelledLiveSessions,
  postedErrors,
  configurationFaults,
  input,
  runWorker,
} = harness;

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
        args: [input("session-f")],
      });
      await waitFor(
        () => implementCalls.some((entry) => entry.runId === "run-session-f"),
        "the Implementer of session-f",
      );
      await handle.signal(stopSignal);
      return handle.result();
    });
    // Verification now follows the implementation, so the sequence of this Run is longer than
    // it was in Phase 2. Phase 4 puts REFINING and RESOLVING_CONTEXT before PREPARING, per SDD
    // section 49. The first states of this Run are still exactly these, in this order.
    expect(statusesOf("run-session-f").slice(0, 5)).toEqual([
      "RECEIVED",
      "REFINING",
      "RESOLVING_CONTEXT",
      "PREPARING",
      "IMPLEMENTING",
    ]);
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
        args: [input("session-g")],
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
        args: [input("session-h")],
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
        args: [input("session-i")],
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
    const cancelledJBefore = cancelledSessions.length;
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
        args: [input("session-j")],
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
    // The activity cancelled the session itself, so the workflow does not repeat the call.
    expect(cancelledSessions).toHaveLength(cancelledJBefore);
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
          args: [input("session-k")],
        });
        return handle.result();
      });
      expect(result.status).toBe("FAILED");
      expect(completions.at(-1)?.failureReason).toBe("IMPLEMENTATION_FAILED");
      expect(postedErrors.at(-1)).toBe("The Implementer did not complete the change. Factoree ended the Run.");
    } finally {
      failingImplementations.delete("run-session-k");
    }
  });

  it("cuts preparation off at the Run budget, before the preparation itself returns", async () => {
    // The workflow clock, not the wall clock, decides here. The budget is twelve seconds of
    // workflow time, and the clock advances twenty seconds while preparation is still held open.
    // The Run must become terminal while the preparation activity still hangs. Only the
    // schedule-to-close timeout of the activity can produce that, so a per-attempt timeout alone
    // fails this test.
    let release = (): void => undefined;
    let released = false;
    heldPreparations.set(
      "run-session-l",
      new Promise<void>((resolve) => {
        release = () => {
          released = true;
          resolve();
        };
      }),
    );
    const before = implementCalls.length;
    const result = await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "session-l"),
        args: [input("session-l", 0.2)],
      });
      await waitFor(
        () => prepared.some((entry) => entry.runId === "run-session-l"),
        "the preparation of session-l",
      );
      await environment.sleep("20 seconds");
      const terminal = await handle.result();
      // The preparation double still hangs. The Run ended without it.
      expect(released).toBe(false);
      release();
      return terminal;
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

describe("a configuration fault during preparation", () => {
  it("fails fast with FAILED_CONFIGURATION and never retries the activity", async () => {
    configurationFaults.add("run-ses-configuration");
    const before = prepared.filter((entry) => entry.runId === "run-ses-configuration").length;
    const result = await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "ses-configuration"),
        args: [input("ses-configuration")],
      });
      return handle.result();
    });

    expect(result.status).toBe("FAILED_CONFIGURATION");
    const completion = completions.find((entry) => entry.runId === "run-ses-configuration");
    expect(completion?.status).toBe("FAILED_CONFIGURATION");
    expect(completion?.failureReason).toBe("CONFIGURATION_INVALID");
    // SDD section 49: a semantic failure must not consume the infrastructure retry policy.
    const attempts = prepared.filter((entry) => entry.runId === "run-ses-configuration").length - before;
    expect(attempts).toBe(1);
    configurationFaults.delete("run-ses-configuration");
  });
});

describe("an Implementer that ends because the Run budget ended", () => {
  it("fails with RUN_TIMEOUT, not with IMPLEMENTATION_FAILED", async () => {
    // SDD section 50. The runner cancels the agent process at the deadline and reports an
    // incomplete attempt. The Run reached its maximum duration, so the reason is the timeout.
    let release = (): void => undefined;
    heldImplementations.set(
      "run-session-timeout",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    failingImplementations.add("run-session-timeout");
    try {
      const result = await runWorker(async () => {
        const handle = await environment.client.workflow.start(agentRunWorkflow, {
          taskQueue: "test",
          workflowId: buildWorkflowId("workspace-123", "session-timeout"),
          args: [input("session-timeout", 0.2)],
        });
        await waitFor(
          () => implementCalls.some((entry) => entry.runId === "run-session-timeout"),
          "the Implementer of session-timeout",
        );
        // The workflow clock passes the Run budget while the Implementer still runs.
        await environment.sleep("20 seconds");
        release();
        return handle.result();
      });
      expect(result.status).toBe("FAILED");
      expect(completions.at(-1)?.failureReason).toBe("RUN_TIMEOUT");
      expect(postedErrors.at(-1)).toBe(
        "Factoree stopped the Run because it reached the maximum Run duration.",
      );
    } finally {
      heldImplementations.delete("run-session-timeout");
      failingImplementations.delete("run-session-timeout");
    }
  });
});

