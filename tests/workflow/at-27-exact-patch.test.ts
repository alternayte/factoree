import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { createWorkflowHarness, hold, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  completions,
  statusesOf,
  postedProgress,
  postedFinalResponses,
  publishOutcomes,
  publishCalls,
  heldPublishes,
  heldProofPacks,
  proofPackCalls,
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

  it("records the pull request URL and ends the activity order with review, publish", async () => {
    const runId = "run-ses-at27b";

    const progressBefore = postedProgress.length;
    const orderBefore = activityOrder.length;

    const result = await runWorker(async () => {
      const handle = await startRun("ses-at27b");
      return handle.result();
    });

    // SDD section 47 and section 68. The Proof Pack completes a proved Run, so this Run needs no
    // stop to reach a terminal state.
    expect(result.status).toBe("READY_FOR_HUMAN");

    const call = publishCalls.filter((entry) => entry.runId === runId).at(-1);
    expect(call?.reviewedChangedFiles).toEqual(["src/app.ts"]);
    expect(call?.baseSha).toBe("a".repeat(40));
    expect(call?.repositorySlug).toBe("acme/primary");
    expect(call?.baseBranch).toBe("main");

    expect(
      postedProgress
        .slice(progressBefore)
        .some((message) =>
          message.includes("pull request: https://github.com/acme/fixture/pull/1"),
        ),
    ).toBe(true);

    // SDD section 47. The Proof Pack follows the publication, so it closes the ordered tail.
    expect(activityOrder.slice(orderBefore).slice(-3)).toEqual(["review", "publish", "publishProofPack"]);
  });

  it("does not claim that nothing was published when a stop follows a successful publication", async () => {
    const runId = "run-ses-at27c";
    const finalBefore = postedFinalResponses.length;

    // The Proof Pack is held, so the stop lands while the Run sits between a successful
    // publication and its Proof Pack. Without the hold the two race, and a racing test proves
    // nothing about the stop path.
    const release = hold(heldProofPacks, runId);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-at27c");
      await waitFor(
        () => proofPackCalls.filter((entry) => entry.runId === runId).length === 1,
        "the Proof Pack of ses-at27c",
      );
      await handle.signal(stopSignal);
      release();
      return handle.result();
    });

    // SDD section 50. The human stopped the Run, so it ends CANCELLED. The publication already
    // happened, and the message must say so.
    expect(result.status).toBe("CANCELLED");

    const body = postedFinalResponses.slice(finalBefore).at(-1) ?? "";
    expect(body).not.toContain("No change was published");
    expect(body).toContain("https://github.com/acme/fixture/pull/1");
    expect(body).toContain("published");
  });

  // SDD section 50. A stop must cancel the Run and must prevent publication. A stop that arrives
  // while the publication runs must end the Run CANCELLED, not FAILED.
  it("ends the Run CANCELLED when a stop arrives while the publication runs", async () => {
    const runId = "run-ses-at27d";
    const release = hold(heldPublishes, runId);
    publishOutcomes.set(runId, () => {
      throw ApplicationFailure.nonRetryable(
        "the publication failed because the Project holds no token",
        "PUBLICATION_FAILED",
      );
    });

    const completionsBefore = completions.length;

    const result = await runWorker(async () => {
      const handle = await startRun("ses-at27d");
      await waitFor(
        () => publishCalls.filter((entry) => entry.runId === runId).length === 1,
        "the publication of ses-at27d",
      );
      await handle.signal(stopSignal);
      release();
      return handle.result();
    });

    expect(result.status).toBe("CANCELLED");
    const completion = completions.filter((entry) => entry.runId === runId).at(-1);
    expect(completion?.status).toBe("CANCELLED");
    expect(completion?.failureReason).toBe("STOPPED_BY_HUMAN");
    // Factoree published nothing, so it must record no publication failure for this Run.
    expect(
      completions
        .slice(completionsBefore)
        .filter((entry) => entry.runId === runId && entry.failureReason === "PUBLICATION_FAILED"),
    ).toEqual([]);
  });
});
