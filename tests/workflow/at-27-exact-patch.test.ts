import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { createWorkflowHarness, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  completions,
  statusesOf,
  postedProgress,
  postedFinalResponses,
  publishOutcomes,
  publishCalls,
  activityOrder,
  input,
  runWorker,
} = harness;

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
 * AT-27, SDD section 44 and section 46. Factoree publishes the exact verified patch. A trusted
 * checkout whose patch hash differs from the verified hash publishes nothing.
 */
describe("AT-27 — Factoree publishes the exact verified patch", () => {
  it("fails with PATCH_HASH_MISMATCH and creates no pull request", async () => {
    const runId = "run-ses-at27a";
    publishOutcomes.set(runId, () => {
      throw ApplicationFailure.nonRetryable(
        "the patch of the trusted checkout does not equal the verified patch",
        "PATCH_HASH_MISMATCH",
      );
    });

    // `postedProgress` and `activityOrder` are file-global, so this case records the length of
    // each before it starts. Every assertion below then reads this Run alone, and the case does
    // not depend on the order the cases run in.
    const progressBefore = postedProgress.length;

    const result = await runWorker(async () => {
      const handle = await startRun("ses-at27a");
      return handle.result();
    });

    expect(result.status).toBe("FAILED");
    const completion = completions.filter((entry) => entry.runId === runId).at(-1);
    expect(completion?.status).toBe("FAILED");
    expect(completion?.failureReason).toBe("PATCH_HASH_MISMATCH");

    // The retry policy denies a second attempt on a semantic failure, so exactly one call ran.
    expect(publishCalls.filter((entry) => entry.runId === runId)).toHaveLength(1);
    // No pull request URL reached the human of this Run, so it published nothing.
    expect(
      postedProgress.slice(progressBefore).filter((message) => message.includes("Pull request:")),
    ).toEqual([]);
    expect(statusesOf(runId)).toContain("PUBLISHING");
  });

  it("records the pull request URL and ends the activity order with review, checkBase, publish", async () => {
    const runId = "run-ses-at27b";

    const progressBefore = postedProgress.length;
    const orderBefore = activityOrder.length;

    const result = await runWorker(async () => {
      const handle = await startRun("ses-at27b");
      await waitFor(
        () => publishCalls.filter((entry) => entry.runId === runId).length === 1,
        "the publication of ses-at27b",
      );
      await handle.signal(stopSignal);
      return handle.result();
    });

    // The Run keeps the residual wait, because SDD section 68 forbids a success terminal state
    // without a Proof Pack.
    expect(result.status).toBe("CANCELLED");

    const call = publishCalls.filter((entry) => entry.runId === runId).at(-1);
    expect(call?.reviewedChangedFiles).toEqual(["src/app.ts"]);
    expect(call?.baseSha).toBe("a".repeat(40));
    expect(call?.repositorySlug).toBe("acme/primary");
    expect(call?.baseBranch).toBe("main");

    expect(
      postedProgress
        .slice(progressBefore)
        .some((message) =>
          message.includes("Pull request: https://github.com/acme/fixture/pull/1"),
        ),
    ).toBe(true);

    expect(activityOrder.slice(orderBefore).slice(-3)).toEqual([
      "review",
      "checkBase",
      "publish",
    ]);
  });

  it("does not claim that nothing was published when a stop follows a successful publication", async () => {
    const runId = "run-ses-at27c";
    const finalBefore = postedFinalResponses.length;

    const result = await runWorker(async () => {
      const handle = await startRun("ses-at27c");
      await waitFor(
        () => publishCalls.filter((entry) => entry.runId === runId).length === 1,
        "the publication of ses-at27c",
      );
      await handle.signal(stopSignal);
      return handle.result();
    });

    // SDD section 68 forbids a success terminal state before Phase 10, so the status stands.
    expect(result.status).toBe("CANCELLED");

    const body = postedFinalResponses.slice(finalBefore).at(-1) ?? "";
    expect(body).not.toContain("No change was published");
    expect(body).toContain("https://github.com/acme/fixture/pull/1");
    expect(body).toContain("published");
  });
});
