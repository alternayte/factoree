import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { humanInputSignal, stopSignal } from "~/workflows/agent-run.workflow.js";
import { createWorkflowHarness, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await environment?.teardown();
});

/** docs/specs/refiner-agent.md. The refiner proposes, the gate decides, a human confirms inferences. */
describe("the refiner in the Run workflow", () => {
  const harness = createWorkflowHarness(() => environment);
  const stated = { id: "AC-R1", statement: "A failed delivery is retried.", source: "ticket:quote", method: "test" as const, target: "tests/retry.test.ts" };
  const inferred = { id: "AC-R2", statement: "Retries stop after five attempts.", source: "refiner:inferred", method: "test" as const, target: "tests/retry.test.ts" };
  const question = "Factoree inferred these acceptance criteria ...\nProposal: accept them, because the existing code implies them.";

  const validationsOf = (runId: string) => harness.validationCalls.filter((entry) => entry.runId === runId);

  it("freezes the stated and the inferred criteria after a human replies yes", async () => {
    harness.refinerOutcomes.set("run-ref-yes", { status: "proposed", accepted: [stated], inferred: [inferred], question, reason: "" });
    const before = harness.elicitations.length;
    await harness.runWorker(async () => {
      const handle = await harness.start("ref-yes");
      await waitFor(() => harness.elicitations.length > before, "the refiner question of ref-yes");
      expect(harness.elicitations[before]).toContain("Proposal:");
      expect(harness.implementCalls.filter((entry) => entry.runId === "run-ref-yes")).toEqual([]);
      await handle.signal(humanInputSignal, "yes");
      await waitFor(() => harness.implementCalls.some((entry) => entry.runId === "run-ref-yes"), "the Implementer of ref-yes");
      await handle.signal(stopSignal);
      await handle.result();
    });
    expect(validationsOf("run-ref-yes")[0]?.acceptanceCriteria).toEqual([stated, inferred]);
  });

  it("freezes only the stated criteria, plus the human answer, when the human corrects the proposal", async () => {
    harness.refinerOutcomes.set("run-ref-no", { status: "proposed", accepted: [stated], inferred: [inferred], question, reason: "" });
    const before = harness.elicitations.length;
    await harness.runWorker(async () => {
      const handle = await harness.start("ref-no");
      await waitFor(() => harness.elicitations.length > before, "the refiner question of ref-no");
      await handle.signal(humanInputSignal, "Retries stop after three attempts.");
      await waitFor(() => harness.implementCalls.some((entry) => entry.runId === "run-ref-no"), "the Implementer of ref-no");
      await handle.signal(stopSignal);
      await handle.result();
    });
    expect(validationsOf("run-ref-no")[0]?.acceptanceCriteria).toEqual([stated]);
    expect(validationsOf("run-ref-no")[0]?.humanAssertions).toEqual(["Retries stop after three attempts."]);
  });

  it("ends the Run with REFINEMENT_UNAVAILABLE and starts no Implementer when the refiner changed the worktree", async () => {
    harness.refinerOutcomes.set("run-ref-dirty", {
      status: "worktree_changed",
      accepted: [],
      inferred: [],
      question: null,
      reason: "The refiner changed the primary worktree.",
    });
    const result = await harness.runWorker(async () => (await harness.start("ref-dirty")).result());
    expect(result.status).toBe("FAILED");
    expect(harness.completions.filter((entry) => entry.runId === "run-ref-dirty").at(-1)?.failureReason).toBe(
      "REFINEMENT_UNAVAILABLE",
    );
    expect(harness.implementCalls.filter((entry) => entry.runId === "run-ref-dirty")).toEqual([]);
  });
});
