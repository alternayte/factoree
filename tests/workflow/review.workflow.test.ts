import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import type { ReviewActivityOutput } from "~/activities/review.activities.js";
import { REVIEW_FAILURE_TEXT, createWorkflowHarness, hold, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  completions,
  statusesOf,
  implementCalls,
  reviewCalls,
  reviewOutcomes,
  heldReviews,
  cancelledLiveReviews,
  reviewerConfigurationFaults,
  runtimeOverrides,
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

const implementsOf = (runId: string) => implementCalls.filter((entry) => entry.runId === runId);
const reviewsOf = (runId: string) => reviewCalls.filter((entry) => entry.runId === runId);
const completionsOf = (runId: string) => completions.filter((entry) => entry.runId === runId);

const startRun = async (sessionId: string, maxRunMinutes = 90) =>
  environment.client.workflow.start(agentRunWorkflow, {
    taskQueue: "test",
    workflowId: buildWorkflowId("workspace-123", sessionId),
    args: [input(sessionId, maxRunMinutes)],
  });

/** The blocking outcome the review double reports. SDD section 41 owns the blocking rules. */
const blocking: Partial<ReviewActivityOutput> = {
  passed: false,
  verdict: "fail",
  findingCount: 1,
  blockingCount: 1,
  summary: "The independent review reported 1 blocking finding.",
  failures: [REVIEW_FAILURE_TEXT],
};

/** The unusable report outcome. DI-8.7 owns this path. */
const unusable: Partial<ReviewActivityOutput> = {
  passed: false,
  verdict: "fail",
  reportUsable: false,
  reportProblem: "The Reviewer wrote no report.",
};

describe("REVIEWING", () => {
  it("enters REVIEWING after user validation passes", async () => {
    const runId = "run-ses-rv1";

    await runWorker(async () => {
      const handle = await startRun("ses-rv1");
      await waitFor(() => reviewsOf(runId).length === 1, "the review of ses-rv1");
      // docs/specs/run-speed.md. The review runs beside user validation, and the Run waits in
      // REVIEWING for it once validation passed.
      await waitFor(() => statusesOf(runId).includes("REVIEWING"), "REVIEWING of ses-rv1");
      await handle.signal(stopSignal);
      await handle.result();
    });

    const sequence = statusesOf(runId);
    expect(sequence.indexOf("VERIFYING")).toBeGreaterThanOrEqual(0);
    expect(sequence.indexOf("USER_VALIDATING")).toBeGreaterThan(sequence.indexOf("VERIFYING"));
    expect(sequence.indexOf("REVIEWING")).toBeGreaterThan(sequence.indexOf("USER_VALIDATING"));
  });

  it("repairs once when the review blocks, then passes", async () => {
    const runId = "run-ses-rv2";
    runtimeOverrides.set(runId, { repairMaxAttempts: 2 });
    reviewOutcomes.set(runId, (attempt) => (attempt === 1 ? blocking : {}));

    await runWorker(async () => {
      const handle = await startRun("ses-rv2");
      await waitFor(() => reviewsOf(runId).length === 2, "the second review of ses-rv2");
      await handle.signal(stopSignal);
      await handle.result();
    });

    // SDD section 42. The repair limit is per Run, so this repair uses the same counter the
    // other two stages use.
    const repairs = harness.statusCalls.filter(
      (entry) => entry.runId === runId && entry.status === "REPAIRING",
    );
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.repairCount).toBe(1);
    expect(repairs[0]?.repairReason).toBe("REVIEW");
    expect(implementsOf(runId)).toHaveLength(2);
    expect(implementsOf(runId)[1]?.repairFindings).toEqual([REVIEW_FAILURE_TEXT]);
  });

  it("re-runs verification and user validation before the second review", async () => {
    const runId = "run-ses-rv3";
    runtimeOverrides.set(runId, { repairMaxAttempts: 2 });
    reviewOutcomes.set(runId, (attempt) => (attempt === 1 ? blocking : {}));
    const before = activityOrder.length;

    await runWorker(async () => {
      const handle = await startRun("ses-rv3");
      await waitFor(() => reviewsOf(runId).length === 2, "the second review of ses-rv3");
      // The second user validation runs beside the second review.
      await waitFor(
        () => harness.userValidateCalls.filter((entry) => entry.runId === runId).length === 2,
        "the second user validation of ses-rv3",
      );
      await handle.signal(stopSignal);
      await handle.result();
    });

    // SDD section 42 draws the repair chain: repair, deterministic verification, user-level
    // validation, and then a fresh review.
    const order = activityOrder
      .slice(before)
      .filter((name) => ["implement", "verify", "userValidate", "review"].includes(name));
    // docs/specs/run-speed.md. User validation and the review run beside each other, after
    // verification, in each attempt.
    const second = order.lastIndexOf("implement");
    expect([order.slice(0, second), order.slice(second)].map((attempt) => [...attempt.slice(0, 2), ...attempt.slice(2).sort()])).toEqual([
      ["implement", "verify", "review", "userValidate"],
      ["implement", "verify", "review", "userValidate"],
    ]);
  });

  it("gives one repair both the validation failures and the reviewer blockers (docs/specs/run-speed.md)", async () => {
    const runId = "run-ses-rv-merged";
    runtimeOverrides.set(runId, { repairMaxAttempts: 2 });
    reviewOutcomes.set(runId, (attempt) => (attempt === 1 ? blocking : {}));
    harness.userValidationOutcomes.set(runId, (attempt) =>
      attempt === 1
        ? {
            passed: false,
            results: [{ assertionId: "VAL-UI-001", result: "FAIL", reason: "The button is missing." }],
            hasFailure: true,
            hasManual: false,
            hasBlocked: false,
            summary: "One user validation assertion failed.",
            failures: ["VAL-UI-001: the button is missing."],
            sessionId: "ses_fake_validator",
            previewUrl: null,
            hang: null,
          }
        : {
            passed: true,
            results: [],
            hasFailure: false,
            hasManual: false,
            hasBlocked: false,
            summary: "Every user validation assertion passed.",
            failures: [],
            sessionId: "ses_fake_validator",
            previewUrl: null,
            hang: null,
          },
    );

    await runWorker(async () => {
      const handle = await startRun("ses-rv-merged");
      await waitFor(() => implementsOf(runId).length === 2, "the repair of ses-rv-merged");
      await handle.signal(stopSignal);
      await handle.result();
    });

    const repairs = harness.statusCalls.filter((entry) => entry.runId === runId && entry.status === "REPAIRING");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.repairReason).toBe("VALIDATION");
    expect(implementsOf(runId)[1]?.repairFindings).toEqual(["VAL-UI-001: the button is missing.", REVIEW_FAILURE_TEXT]);
    // The reviewer read the verification summary and no validation evidence.
    expect(reviewsOf(runId)[0]?.validationEvidence).toBeUndefined();
    expect(reviewsOf(runId)[0]?.verificationSummary).toBeDefined();
  });

  it("ends in FAILED_REVIEW when the budget is spent", async () => {
    const runId = "run-ses-rv4";
    runtimeOverrides.set(runId, { repairMaxAttempts: 2 });
    reviewOutcomes.set(runId, () => blocking);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-rv4");
      return handle.result();
    });

    // SDD section 42. One first attempt plus two repairs, and no third repair.
    expect(reviewsOf(runId)).toHaveLength(3);
    expect(result.status).toBe("FAILED_REVIEW");
    expect(completionsOf(runId).at(-1)).toMatchObject({
      status: "FAILED_REVIEW",
      failureReason: "REVIEW_BLOCKING_FINDINGS",
    });
  });

  it("ends in FAILED with REVIEW_UNAVAILABLE when the report is unusable", async () => {
    const runId = "run-ses-rv5";
    runtimeOverrides.set(runId, { repairMaxAttempts: 2 });
    reviewOutcomes.set(runId, () => unusable);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-rv5");
      return handle.result();
    });

    // DI-8.7. A report Factoree cannot read proves nothing, and a repair cannot
    // fix it, so the Run starts none.
    expect(statusesOf(runId)).not.toContain("REPAIRING");
    expect(reviewsOf(runId)).toHaveLength(1);
    expect(result.status).toBe("FAILED");
    expect(completionsOf(runId).at(-1)).toMatchObject({
      status: "FAILED",
      failureReason: "REVIEW_UNAVAILABLE",
    });
  });

  it("ends in FAILED_CONFIGURATION for an unregistered reviewer runner", async () => {
    const runId = "run-ses-rv6";
    reviewerConfigurationFaults.add(runId);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-rv6");
      return handle.result();
    });

    reviewerConfigurationFaults.delete(runId);

    // SDD section 49. An unregistered runner is a repairable configuration fault, not an
    // internal error, and it must not consume the infrastructure retry policy.
    expect(result.status).toBe("FAILED_CONFIGURATION");
    expect(completionsOf(runId).at(-1)).toMatchObject({
      status: "FAILED_CONFIGURATION",
      failureReason: "CONFIGURATION_INVALID",
    });
    expect(reviewsOf(runId)).toHaveLength(1);
  });

  it("cancels the Run when a stop arrives during the review", async () => {
    const runId = "run-ses-rv7";
    const release = hold(heldReviews, runId);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-rv7");
      await waitFor(() => reviewsOf(runId).length === 1, "the review of ses-rv7");
      await handle.signal(stopSignal);
      // The stop must reach the activity while the Reviewer session still runs.
      await waitFor(() => cancelledLiveReviews.includes(runId), "the live cancellation");
      release();
      return handle.result();
    });
    heldReviews.delete(runId);

    expect(result.status).toBe("CANCELLED");
    expect(completionsOf(runId).at(-1)).toMatchObject({
      status: "CANCELLED",
      failureReason: "STOPPED_BY_HUMAN",
    });
    expect(statusesOf(runId)).not.toContain("REPAIRING");
  });
});
