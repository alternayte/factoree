import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { createWorkflowHarness } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  completions,
  statusCalls,
  implementCalls,
  reviewCalls,
  reviewReports,
  verifyOutcomes,
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

const blockingReport = () => ({
  text: JSON.stringify({
    version: 1,
    verdict: "fail",
    changeDescription: "The change adds the health endpoint.",
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
  changedFiles: ["src/auth.ts"],
});

/**
 * AT-24, SDD section 64: "No third repair starts when maximum repairs is two." SDD section 42
 * bounds repairs per Run, not per stage, so the second case mixes a verification repair with
 * two review repairs and proves the counter is shared. DI-8.9 owns that case.
 */
describe("AT-24 — the repair limit stops the third repair", () => {
  it("stops after two review repairs, with three implement calls and FAILED_REVIEW", async () => {
    const runId = "run-ses-at24-review-only";
    runtimeOverrides.set(runId, { repairMaxAttempts: 2 });
    reviewReports.set(runId, blockingReport);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-at24-review-only");
      return handle.result();
    });

    const implementsOfRun = implementCalls.filter((entry) => entry.runId === runId);
    const reviewsOfRun = reviewCalls.filter((entry) => entry.runId === runId);
    const repairs = statusCalls.filter((entry) => entry.runId === runId && entry.status === "REPAIRING");

    expect(implementsOfRun).toHaveLength(3);
    expect(reviewsOfRun).toHaveLength(3);
    expect(repairs).toHaveLength(2);

    expect(result.status).toBe("FAILED_REVIEW");
    expect(completions.filter((entry) => entry.runId === runId).at(-1)).toMatchObject({
      status: "FAILED_REVIEW",
      failureReason: "REVIEW_BLOCKING_FINDINGS",
    });
  });

  it("shares the repair counter across stages: a verification repair plus two review blocks stop the third repair", async () => {
    const runId = "run-ses-at24-mixed";
    runtimeOverrides.set(runId, { repairMaxAttempts: 2 });
    // SDD section 42. Attempt 1's deterministic verification fails; every later attempt passes.
    verifyOutcomes.set(runId, (attempt) => attempt !== 1);
    // Review runs only once verification and user validation both pass, so its own attempt
    // counter starts at 1 on the workflow's second implement call. It blocks on every call it
    // is reached on.
    reviewReports.set(runId, blockingReport);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-at24-mixed");
      return handle.result();
    });

    const implementsOfRun = implementCalls.filter((entry) => entry.runId === runId);
    const reviewsOfRun = reviewCalls.filter((entry) => entry.runId === runId);
    const repairs = statusCalls.filter((entry) => entry.runId === runId && entry.status === "REPAIRING");

    // One first attempt, one repair for the verification failure, and one repair for the first
    // blocking review. The second blocking review would need a third repair, and the budget of
    // 2 stops it, so no fourth implement call and no third review call happen.
    expect(implementsOfRun).toHaveLength(3);
    expect(reviewsOfRun).toHaveLength(2);
    expect(repairs).toHaveLength(2);
    expect(repairs.map((entry) => entry.repairReason)).toEqual(["VERIFICATION", "REVIEW"]);

    expect(result.status).toBe("FAILED_REVIEW");
    expect(completions.filter((entry) => entry.runId === runId).at(-1)).toMatchObject({
      status: "FAILED_REVIEW",
      failureReason: "REVIEW_BLOCKING_FINDINGS",
    });
  });
});
