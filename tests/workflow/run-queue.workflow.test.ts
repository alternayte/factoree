import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow, runStatusQuery, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { createWorkflowHarness, waitFor } from "./support/harness.js";

// docs/specs/release-0-1-0.md part 3. DI-15.13: a Run over its Product's maxConcurrentRuns waits
// in QUEUED before PREPARING. DI-15.14: a full sandbox provider makes the Run wait, not fail.

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const { completions, prepared, postedProgress, runSlotClaims, runSlotCalls, sandboxSlotWaits, statusesOf, implementCalls, input, runWorker } =
  harness;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

const start = (sessionId: string) =>
  environment.client.workflow.start(agentRunWorkflow, {
    taskQueue: "test",
    workflowId: buildWorkflowId("workspace-123", sessionId),
    args: [input(sessionId)],
  });

describe("the Run queue before PREPARING", () => {
  it("waits in QUEUED, shows each new position once, and then moves to PREPARING", async () => {
    const runId = "run-queue-a";
    // Two claims at position 2, one at position 1, then the slot.
    const answers = [2, 2, 1];
    runSlotClaims.set(runId, (call) => {
      const ahead = answers[call - 1];
      return ahead === undefined ? { granted: true } : { granted: false, ahead };
    });

    const result = await runWorker(async () => {
      const handle = await start("queue-a");
      await waitFor(async () => (await handle.query(runStatusQuery)).status === "QUEUED", "the QUEUED state");
      expect(prepared.some((entry) => entry.runId === runId)).toBe(false);
      // The test environment skips the poll timers only while the test waits for the result.
      return handle.result();
    });

    expect(runSlotCalls.filter((entry) => entry === runId)).toHaveLength(4);
    // The position changed once, so Linear got two lines, not one per poll.
    expect(postedProgress.filter((message) => message.startsWith("Queued:"))).toEqual([
      "Queued: 2 runs ahead.",
      "Queued: 1 runs ahead.",
    ]);
    expect(statusesOf(runId)).toContain("PREPARING");
    expect(statusesOf(runId).indexOf("PREPARING")).toBeLessThan(statusesOf(runId).indexOf("IMPLEMENTING"));
    expect(prepared.filter((entry) => entry.runId === runId)).toHaveLength(1);
    expect(result.status).toBe("READY_FOR_HUMAN");
  });

  it("leaves the queue as CANCELLED when a stop arrives, and prepares nothing", async () => {
    const runId = "run-queue-b";
    runSlotClaims.set(runId, () => ({ granted: false, ahead: 1 }));

    const result = await runWorker(async () => {
      const handle = await start("queue-b");
      await waitFor(async () => (await handle.query(runStatusQuery)).status === "QUEUED", "the QUEUED state");
      await handle.signal(stopSignal);
      return handle.result();
    });

    expect(result.status).toBe("CANCELLED");
    expect(completions.filter((entry) => entry.runId === runId)).toEqual([
      expect.objectContaining({ status: "CANCELLED", failureReason: "STOPPED_BY_HUMAN" }),
    ]);
    expect(prepared.some((entry) => entry.runId === runId)).toBe(false);
    expect(statusesOf(runId)).not.toContain("PREPARING");
  });

  it("does not spend the Run budget while it waits in the queue", async () => {
    const runId = "run-queue-c";
    // Twelve polls of 20 seconds wait four minutes, longer than the one-minute budget below.
    runSlotClaims.set(runId, (call) => (call <= 12 ? { granted: false, ahead: 1 } : { granted: true }));

    const result = await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "queue-c"),
        args: [input("queue-c", 1)],
      });
      return handle.result();
    });

    expect(result.status).toBe("READY_FOR_HUMAN");
  });
});

describe("the sandbox provider limit", () => {
  it("waits for a sandbox slot and then prepares, without failing the Run", async () => {
    const runId = "run-sandbox-wait";
    sandboxSlotWaits.set(runId, 2);

    const result = await runWorker(async () => (await start("sandbox-wait")).result());

    expect(prepared.filter((entry) => entry.runId === runId)).toHaveLength(3);
    expect(postedProgress.filter((message) => message.includes("waits for a free sandbox"))).toHaveLength(1);
    expect(implementCalls.some((entry) => entry.runId === runId)).toBe(true);
    expect(result.status).toBe("READY_FOR_HUMAN");
  });

  it("ends RUN_TIMEOUT when the provider stays full for the whole budget", async () => {
    const runId = "run-sandbox-full";
    sandboxSlotWaits.set(runId, Number.MAX_SAFE_INTEGER);

    const result = await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "sandbox-full"),
        args: [input("sandbox-full", 1)],
      });
      return handle.result();
    });

    expect(result.status).toBe("FAILED");
    expect(completions.filter((entry) => entry.runId === runId).map((entry) => entry.failureReason)).toEqual([
      "RUN_TIMEOUT",
    ]);
  });
});
