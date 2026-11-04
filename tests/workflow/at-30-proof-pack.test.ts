import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { createWorkflowHarness, hold, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  completions,
  postedFinalResponses,
  proofPackCalls,
  proofPackOutcomes,
  verifyOutcomes,
  heldProofPacks,
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

const startRun = (session: string) =>
  environment.client.workflow.start(agentRunWorkflow, {
    taskQueue: "test",
    workflowId: buildWorkflowId("workspace-123", session),
    args: [input(session)],
  });

/**
 * AT-30 and SDD section 68. A successful L3 Run posts exactly one Proof Pack, and only then does
 * it reach the one success terminal state.
 */
describe("AT-30 — the Proof Pack completes a successful Run", () => {
  it("posts one Proof Pack and ends READY_FOR_HUMAN", async () => {
    const runId = "run-ses-at30a";
    const result = await runWorker(async () => (await startRun("ses-at30a")).result());

    expect(result.status).toBe("READY_FOR_HUMAN");
    expect(proofPackCalls.filter((entry) => entry.runId === runId)).toHaveLength(1);
    const completion = completions.filter((entry) => entry.runId === runId).at(-1);
    expect(completion?.status).toBe("READY_FOR_HUMAN");
    // SDD section 48. A success carries no failure reason.
    expect(completion?.failureReason).toBeUndefined();
  });

  it("passes the published facts to the Proof Pack", async () => {
    const runId = "run-ses-at30b";
    await runWorker(async () => (await startRun("ses-at30b")).result());

    const call = proofPackCalls.filter((entry) => entry.runId === runId).at(-1);
    const publication = publishCalls.filter((entry) => entry.runId === runId).at(-1);
    expect(call?.pullRequestUrl).toBe("https://github.com/acme/fixture/pull/1");
    expect(call?.patchSha256).toBe("d".repeat(64));
    expect(call?.commitSha).toBe("e".repeat(40));
    // AT-30 requires the base SHA. It must be the base the publication actually used.
    expect(call?.baseSha).toBe(publication?.baseSha);
    expect(call?.changedFiles).toEqual(publication?.reviewedChangedFiles);
    expect(call?.repairCount).toBe(0);
    expect(call?.reviewVerdict).toBe("pass");
    expect(call?.reviewPasses).toBeGreaterThan(0);
  });

  it("posts the Proof Pack after the publication, never before it", async () => {
    const orderBefore = activityOrder.length;
    await runWorker(async () => (await startRun("ses-at30c")).result());

    const order = activityOrder.slice(orderBefore);
    expect(order.indexOf("publishProofPack")).toBeGreaterThan(order.indexOf("publish"));
  });

  it("fails the Run when the Proof Pack cannot be posted", async () => {
    const runId = "run-ses-at30d";
    proofPackOutcomes.set(runId, () => {
      throw new Error("Linear is down");
    });

    try {
      const result = await runWorker(async () => (await startRun("ses-at30d")).result());

      // SDD section 68. The change is published and Factoree cannot prove it, so it must not
      // report a success it cannot prove.
      expect(result.status).toBe("FAILED");
      const completion = completions.filter((entry) => entry.runId === runId).at(-1);
      expect(completion?.failureReason).toBe("COMPLETION_INVARIANT_UNMET");
    } finally {
      proofPackOutcomes.delete(runId);
    }
  });

  it("names the pull request when the Proof Pack fails, so the change is not lost", async () => {
    const runId = "run-ses-at30e";
    proofPackOutcomes.set(runId, () => {
      throw new Error("Linear is down");
    });
    const errorsBefore = harness.postedErrors.length;

    try {
      await runWorker(async () => (await startRun("ses-at30e")).result());
      const message = harness.postedErrors.slice(errorsBefore).at(-1) ?? "";
      expect(message).toContain("https://github.com/acme/fixture/pull/1");
    } finally {
      proofPackOutcomes.delete(runId);
    }
  });

  it("counts review passes, not implementer attempts", async () => {
    const runId = "run-ses-at30g";
    // Deterministic verification fails on attempt 1, so the Run repairs before it ever reaches a
    // Reviewer. The attempt counter then reads 2 while exactly one review pass ran. The Proof
    // Pack reports this number to a human, so it must be the review count.
    verifyOutcomes.set(runId, (attempt) => attempt >= 2);

    try {
      const result = await runWorker(async () => (await startRun("ses-at30g")).result());
      expect(result.status).toBe("READY_FOR_HUMAN");

      const call = proofPackCalls.filter((entry) => entry.runId === runId).at(-1);
      expect(call?.reviewPasses).toBe(1);
      // The repair still happened, and the repair count reports it.
      expect(call?.repairCount).toBe(1);
    } finally {
      verifyOutcomes.delete(runId);
    }
  });

  it("ends CANCELLED when a stop arrives while the Proof Pack is built", async () => {
    const runId = "run-ses-at30f";
    // The hold removes the race. A stop that lands between the publication and the Proof Pack
    // must end the Run CANCELLED, and a racing test proves nothing about that path.
    const release = hold(heldProofPacks, runId);
    const finalBefore = postedFinalResponses.length;

    const result = await runWorker(async () => {
      const handle = await startRun("ses-at30f");
      await waitFor(
        () => proofPackCalls.filter((entry) => entry.runId === runId).length === 1,
        "the Proof Pack of ses-at30f",
      );
      await handle.signal(stopSignal);
      release();
      return handle.result();
    });

    expect(result.status).toBe("CANCELLED");
    // The publication already happened, so the message must not claim that nothing was published.
    const body = postedFinalResponses.slice(finalBefore).at(-1) ?? "";
    expect(body).not.toContain("No change was published");
    expect(body).toContain("https://github.com/acme/fixture/pull/1");
  });
});

// docs/specs/skill-registry.md. The proposal leaves the work sprite before the Proof Pack names it,
// and the registry hears how the Run ended.
describe("the skill registry signals of a Run", () => {
  it("sends the skill proposal before the Proof Pack and reports the outcome after the Run ends", async () => {
    const runId = "run-ses-skills";
    const orderBefore = activityOrder.length;
    const result = await runWorker(async () =>
      (
        await environment.client.workflow.start(agentRunWorkflow, {
          taskQueue: "test",
          workflowId: buildWorkflowId("workspace-123", "ses-skills"),
          args: [
            {
              ...input("ses-skills"),
              product: { ...input("ses-skills").product, skillRegistry: { kind: "skael", url: "https://skael.test", set: "go-tools" } },
            },
          ],
        })
      ).result(),
    );

    expect(result.status).toBe("READY_FOR_HUMAN");
    const order = activityOrder.slice(orderBefore);
    expect(order.indexOf("submitSkillProposals")).toBeLessThan(order.indexOf("publishProofPack"));
    expect(order.filter((name) => name === "submitSkillProposals")).toHaveLength(1);
    expect(order.at(-1)).toBe("reportSkillOutcome");
    expect(harness.skillOutcomeCalls.find((call) => call.runId === runId)).toMatchObject({
      outcome: "succeeded",
      repairs: 0,
      reviewVerdict: "pass",
      skillRegistry: { kind: "skael", url: "https://skael.test", set: "go-tools" },
    });
  });

  it("sends nothing for a Product with no skill source", async () => {
    const orderBefore = activityOrder.length;
    await runWorker(async () => (await startRun("ses-no-skills")).result());
    const order = activityOrder.slice(orderBefore);
    expect(order).not.toContain("submitSkillProposals");
    expect(order).not.toContain("reportSkillOutcome");
  });
});
