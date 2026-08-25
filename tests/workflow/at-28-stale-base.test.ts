import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { createWorkflowHarness } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  completions,
  statusesOf,
  postedErrors,
  baseChecks,
  publishCalls,
  activityOrder,
  input,
  runWorker,
} = harness;

/** The SHA the target branch moved to while the Run worked. */
const MOVED_SHA = "9".repeat(40);

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

const startRun = async (sessionId: string) =>
  environment.client.workflow.start(agentRunWorkflow, {
    taskQueue: "test",
    workflowId: buildWorkflowId("workspace-123", sessionId),
    args: [input(sessionId)],
  });

/**
 * AT-28, SDD section 45 and section 48. Version 1 never rebases. A target branch that moved
 * after the Run started ends the Run in `STALE_BASE`, and Factoree publishes nothing.
 */
describe("AT-28 — a moved target branch ends the Run in STALE_BASE", () => {
  it("ends STALE_BASE, carries no failure reason, and never calls publish", async () => {
    const runId = "run-ses-at28";
    baseChecks.set(runId, () => ({ fresh: false, currentTargetSha: MOVED_SHA }));

    // `postedErrors` and `activityOrder` are file-global, so this case records the length of
    // each before it starts. Every assertion below then reads this Run alone.
    const errorsBefore = postedErrors.length;
    const orderBefore = activityOrder.length;

    const result = await runWorker(async () => {
      const handle = await startRun("ses-at28");
      return handle.result();
    });

    expect(result.status).toBe("STALE_BASE");

    // SDD section 48. `STALE_BASE` is a Run status of its own, so it carries no failure reason.
    const completion = completions.filter((entry) => entry.runId === runId).at(-1);
    expect(completion?.status).toBe("STALE_BASE");
    expect(completion?.failureReason).toBeUndefined();

    // Factoree published nothing, so the publication activity never ran.
    expect(publishCalls.filter((entry) => entry.runId === runId)).toEqual([]);
    expect(activityOrder.slice(orderBefore)).not.toContain("publish");
    expect(activityOrder.slice(orderBefore).slice(-2)).toEqual(["review", "checkBase"]);
    expect(statusesOf(runId)).toContain("PUBLISHING");

    // The human learns both SHAs and learns that Factoree did not rebase. The moved SHA belongs
    // to this Run alone, so it names the error of this Run inside the file-global list.
    const messages = postedErrors.slice(errorsBefore).filter((entry) => entry.includes(MOVED_SHA));
    expect(messages).toHaveLength(1);
    const message = messages[0] ?? "";
    expect(message).toContain("a".repeat(40));
    expect(message).toContain(MOVED_SHA);
    expect(message).toContain("did not rebase");
  });
});
