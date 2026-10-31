import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { stopSignal } from "~/workflows/agent-run.workflow.js";
import { createWorkflowHarness, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await environment?.teardown();
});

/**
 * docs/specs/refiner-agent.md and docs/specs/own-proposals-and-parallel-runs.md. The refiner
 * proposes, the gate decides, and Factoree takes every determined proposal without a question.
 */
describe("the refiner in the Run workflow", () => {
  const harness = createWorkflowHarness(() => environment);
  const stated = { id: "AC-R1", statement: "A failed delivery is retried.", source: "ticket:quote", method: "test" as const, target: "tests/retry.test.ts" };
  const implied = {
    id: "AC-R2",
    statement: "A retried delivery keeps its message.",
    source: "implied by: Users lose messages.",
    method: "test" as const,
    target: "tests/retry.test.ts",
  };
  const decisions = [
    { kind: "criterion" as const, statement: 'added the implied criterion "A retried delivery keeps its message"', reason: 'the ticket says "Users lose messages"' },
    { kind: "not_built" as const, statement: 'did not build "Also email the admin"', reason: "no ticket sentence states or implies it" },
  ];

  const validationsOf = (runId: string) => harness.validationCalls.filter((entry) => entry.runId === runId);

  it("freezes the stated and the implied criteria, records each decision, and asks nobody", async () => {
    harness.refinerOutcomes.set("run-ref-take", { status: "proposed", accepted: [stated, implied], decisions, visualEvidenceGap: null, reason: "", hang: null });
    const before = harness.elicitations.length;
    await harness.runWorker(async () => {
      const handle = await harness.start("ref-take");
      await waitFor(() => harness.implementCalls.some((entry) => entry.runId === "run-ref-take"), "the Implementer of ref-take");
      await handle.signal(stopSignal);
      await handle.result();
    });
    expect(harness.elicitations.length).toBe(before);
    expect(validationsOf("run-ref-take")[0]?.acceptanceCriteria).toEqual([stated, implied]);
    expect(harness.decisionCalls.filter((entry) => entry.runId === "run-ref-take").map((entry) => entry.decision)).toEqual(decisions);
    // The implementer follows Factoree's own decisions as it follows a human answer.
    const implementer = harness.implementCalls.find((entry) => entry.runId === "run-ref-take");
    expect(implementer?.humanDecisions).toContain(
      'Factoree added the implied criterion "A retried delivery keeps its message", because the ticket says "Users lose messages".',
    );
  });

  it("ends the Run with REFINEMENT_UNAVAILABLE and starts no Implementer when the refiner changed the worktree", async () => {
    harness.refinerOutcomes.set("run-ref-dirty", {
      status: "worktree_changed",
      accepted: [],
      decisions: [],
      visualEvidenceGap: null,
      reason: "The refiner changed the primary worktree.",
      hang: null,
    });
    const result = await harness.runWorker(async () => (await harness.start("ref-dirty")).result());
    expect(result.status).toBe("FAILED");
    expect(harness.completions.filter((entry) => entry.runId === "run-ref-dirty").at(-1)?.failureReason).toBe(
      "REFINEMENT_UNAVAILABLE",
    );
    expect(harness.implementCalls.filter((entry) => entry.runId === "run-ref-dirty")).toEqual([]);
  });
});
