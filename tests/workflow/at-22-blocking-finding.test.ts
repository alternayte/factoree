import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { createWorkflowHarness, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  statusCalls,
  implementCalls,
  reviewCalls,
  reviewReports,
  reviewDecisions,
  runtimeOverrides,
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
 * AT-22, SDD section 64: "A concrete high-severity finding tied to a mandatory rule blocks the
 * Run and triggers repair." Controller ruling B: the harness `review` double parses this exact
 * report with the real `parseReviewReport` and decides it with the real `decideReview`, so the
 * rule under test is the real rule.
 */
describe("AT-22 — a blocking finding repairs the Run", () => {
  it("enters REPAIRING, raises the repair count, and carries the finding into the next implement call", async () => {
    const runId = "run-ses-at22";
    runtimeOverrides.set(runId, { repairMaxAttempts: 2 });
    reviewReports.set(runId, (attempt) => ({
      text: JSON.stringify({
        version: 1,
        verdict: "fail",
        findings: [
          {
            id: "RV-1",
            severity: "high",
            category: "correctness",
            requirement: "VAL-API-001",
            evidence: "src/auth.ts:84",
            description: "The handler returns 200 for an expired token.",
          },
        ],
      }),
      // Attempt 1 blocks. The repair fixes it, so attempt 2 reports no finding, exactly as the
      // harness `passing` default does when a test states no override.
      changedFiles: attempt === 1 ? ["src/auth.ts"] : [],
    }));

    await runWorker(async () => {
      const handle = await startRun("ses-at22");
      // Waits for the second review, the one the repair triggers, so the repair's implement
      // call is already recorded before the test inspects it.
      await waitFor(() => reviewCalls.filter((c) => c.runId === runId).length === 2, "the second review of ses-at22");
      await handle.signal(stopSignal);
      await handle.result();
    });

    const repairs = statusCalls.filter((entry) => entry.runId === runId && entry.status === "REPAIRING");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.repairCount).toBe(1);
    expect(repairs[0]?.repairReason).toBe("REVIEW");

    const implementsOfRun = implementCalls.filter((entry) => entry.runId === runId);
    expect(implementsOfRun).toHaveLength(2);
    expect(implementsOfRun[1]?.repairFindings).toEqual([
      expect.stringContaining("RV-1"),
    ]);

    // The decision the double returned really marks the finding blocking. This is the real
    // `decideReview`'s own verdict, read from the harness, not a re-derivation in the test.
    const decisions = reviewDecisions.get(runId) ?? [];
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.decisions).toHaveLength(1);
    expect(decisions[0]?.decisions[0]?.finding.id).toBe("RV-1");
    expect(decisions[0]?.decisions[0]?.blocking).toBe(true);
    expect(decisions[0]?.passed).toBe(false);
    // The repair fixed it: the second review's finding no longer names a file this attempt
    // changed, so `decideReview` does not block it, and the decision passes.
    expect(decisions[1]?.decisions[0]?.blocking).toBe(false);
    expect(decisions[1]?.passed).toBe(true);
  });
});
