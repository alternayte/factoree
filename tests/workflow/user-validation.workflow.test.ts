import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import type { UserValidateActivityOutput } from "~/activities/validation.activities.js";
import { createWorkflowHarness, hold, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  completions,
  statusesOf,
  implementCalls,
  userValidateCalls,
  userValidationOutcomes,
  heldUserValidations,
  heldStatuses,
  cancelledLiveValidations,
  reviewCalls,
  heldReviews,
  cancelledLiveReviews,
  postedProgress,
  activityOrder,
  runtimeOverrides,
  validatorConfigurationFaults,
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
const userValidatesOf = (runId: string) => userValidateCalls.filter((entry) => entry.runId === runId);
const completionsOf = (runId: string) => completions.filter((entry) => entry.runId === runId);
const reviewsOf = (runId: string) => reviewCalls.filter((entry) => entry.runId === runId);

const startRun = async (sessionId: string, maxRunMinutes = 90) =>
  environment.client.workflow.start(agentRunWorkflow, {
    taskQueue: "test",
    workflowId: buildWorkflowId("workspace-123", sessionId),
    args: [input(sessionId, maxRunMinutes)],
  });

const passing: UserValidateActivityOutput = {
  passed: true,
  results: [{ assertionId: "VAL-UI-001", result: "PASS", reason: "The page renders." }],
  hasFailure: false,
  hasManual: false,
  hasBlocked: false,
  summary: "Every user validation assertion passed.",
  failures: [],
  sessionId: "ses_fake_validator",
  previewUrl: null,
};

const failing: UserValidateActivityOutput = {
  passed: false,
  results: [{ assertionId: "VAL-UI-001", result: "FAIL", reason: "The button is missing." }],
  hasFailure: true,
  hasManual: false,
  hasBlocked: false,
  summary: "One user validation assertion failed.",
  failures: ["VAL-UI-001: the button is missing."],
  sessionId: "ses_fake_validator",
  previewUrl: null,
};

const manualOnly: UserValidateActivityOutput = {
  passed: false,
  results: [{ assertionId: "VAL-UI-002", result: "MANUAL_REQUIRED", reason: "A human must look." }],
  hasFailure: false,
  hasManual: true,
  hasBlocked: false,
  summary: "One user validation assertion needs a human.",
  failures: [],
  sessionId: "ses_fake_validator",
  previewUrl: null,
};

const blockedOnly: UserValidateActivityOutput = {
  passed: false,
  results: [{ assertionId: "VAL-UI-003", result: "BLOCKED", reason: "No preview is available." }],
  hasFailure: false,
  hasManual: false,
  hasBlocked: true,
  summary: "One user validation assertion is blocked.",
  failures: [],
  sessionId: "ses_fake_validator",
  previewUrl: null,
};

describe("USER_VALIDATING", () => {
  it("validates after verification and before the residual wait", async () => {
    const runId = "run-ses-uv1";

    await runWorker(async () => {
      const handle = await startRun("ses-uv1");
      await waitFor(() => userValidatesOf(runId).length === 1, "the user validation of ses-uv1");
      await handle.signal(stopSignal);
      await handle.result();
    });

    expect(statusesOf(runId)).toContain("USER_VALIDATING");
    expect(activityOrder.indexOf("verify")).toBeLessThan(activityOrder.indexOf("userValidate"));
  });

  it("repairs once when an assertion fails, then reverifies and revalidates", async () => {
    const runId = "run-ses-uv2";
    runtimeOverrides.set(runId, { repairMaxAttempts: 2 });
    userValidationOutcomes.set(runId, (attempt) => (attempt === 1 ? failing : passing));

    // The second pass passes, so the Run enters REVIEWING and then the publication path. The
    // held review keeps the Run inside the review until the stop reaches the live session, so
    // this Run never enters PUBLISHING and this test does not flake.
    const releaseReview = hold(heldReviews, runId);

    await runWorker(async () => {
      const handle = await startRun("ses-uv2");
      await waitFor(() => userValidatesOf(runId).length === 2, "the second user validation of ses-uv2");
      await waitFor(() => reviewsOf(runId).length === 1, "the review of ses-uv2");
      await handle.signal(stopSignal);
      await waitFor(
        () => cancelledLiveReviews.includes(runId),
        "the live cancellation of ses-uv2",
      );
      releaseReview();
      await handle.result();
    });
    heldReviews.delete(runId);

    expect(statusesOf(runId)).toEqual([
      "RECEIVED",
      "REFINING",
      "RESOLVING_CONTEXT",
      "PREPARING",
      "REFINING",
      "BUILDING_VALIDATION_CONTRACT",
      "IMPLEMENTING",
      "VERIFYING",
      "USER_VALIDATING",
      "REPAIRING",
      "IMPLEMENTING",
      "VERIFYING",
      "USER_VALIDATING",
      "REVIEWING",
    ]);
    expect(implementsOf(runId)[1]!.repairFindings[0]).toContain("VAL-UI-001");
  });

  it("fails with VALIDATION_FAILED when the repair budget is spent", async () => {
    const runId = "run-ses-uv3";
    runtimeOverrides.set(runId, { repairMaxAttempts: 0 });
    userValidationOutcomes.set(runId, () => failing);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-uv3");
      return handle.result();
    });

    expect(result.status).toBe("FAILED");
    expect(completionsOf(runId).at(-1)).toMatchObject({
      status: "FAILED",
      failureReason: "VALIDATION_FAILED",
    });
  });

  it("fails with VALIDATION_MANUAL_REQUIRED and starts no repair", async () => {
    const runId = "run-ses-uv4";
    userValidationOutcomes.set(runId, () => manualOnly);

    await runWorker(async () => {
      const handle = await startRun("ses-uv4");
      await handle.result();
    });

    expect(statusesOf(runId)).not.toContain("REPAIRING");
    expect(completionsOf(runId).at(-1)).toMatchObject({
      status: "FAILED",
      failureReason: "VALIDATION_MANUAL_REQUIRED",
    });
  });

  it("fails with VALIDATION_BLOCKED and starts no repair", async () => {
    const runId = "run-ses-uv5";
    userValidationOutcomes.set(runId, () => blockedOnly);

    await runWorker(async () => {
      const handle = await startRun("ses-uv5");
      await handle.result();
    });

    expect(statusesOf(runId)).not.toContain("REPAIRING");
    expect(completionsOf(runId).at(-1)).toMatchObject({
      status: "FAILED",
      failureReason: "VALIDATION_BLOCKED",
    });
  });

  it("cancels the Run when a stop arrives during user validation", async () => {
    const runId = "run-ses-uv6";
    const release = hold(heldUserValidations, runId);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-uv6");
      await waitFor(() => userValidatesOf(runId).length === 1, "the user validation of ses-uv6");
      await handle.signal(stopSignal);
      // The stop must reach the activity while the User Validator still runs.
      await waitFor(() => cancelledLiveValidations.includes(runId), "the live cancellation");
      release();
      return handle.result();
    });
    heldUserValidations.delete(runId);

    expect(result.status).toBe("CANCELLED");
    expect(completionsOf(runId).at(-1)).toMatchObject({
      status: "CANCELLED",
      failureReason: "STOPPED_BY_HUMAN",
    });
    expect(implementsOf(runId)).toHaveLength(1);
    expect(statusesOf(runId)).not.toContain("REPAIRING");
  });

  it("cancels the Run and starts no pass when the stop is already known", async () => {
    // The stop lands while the `USER_VALIDATING` status write is held open, so the workflow
    // already knows about the stop when `runUserValidate` runs. This drives the entry guard,
    // which must schedule no activity at all. A scheduled activity that is cancelled in the
    // same workflow activation waits forever for a cancellation report.
    const runId = "run-ses-uv8";
    const key = `${runId}:USER_VALIDATING`;
    const release = hold(heldStatuses, key);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-uv8");
      await waitFor(
        () => statusesOf(runId).includes("USER_VALIDATING"),
        "the USER_VALIDATING status of ses-uv8",
      );
      await handle.signal(stopSignal);
      release();
      return handle.result();
    });
    heldStatuses.delete(key);

    expect(result.status).toBe("CANCELLED");
    expect(completionsOf(runId).at(-1)).toMatchObject({
      status: "CANCELLED",
      failureReason: "STOPPED_BY_HUMAN",
    });
    expect(userValidatesOf(runId)).toHaveLength(0);
  });

  it("posts the validation summary to Linear", async () => {
    const runId = "run-ses-uv7";

    await runWorker(async () => {
      const handle = await startRun("ses-uv7");
      await waitFor(() => userValidatesOf(runId).length === 1, "the user validation of ses-uv7");
      await handle.signal(stopSignal);
      await handle.result();
    });

    expect(postedProgress).toContain(passing.summary);
  });

  it("ends in FAILED_CONFIGURATION when no worker registers the configured validator runner", async () => {
    const runId = "run-ses-uv9";
    validatorConfigurationFaults.add(runId);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-uv9");
      return handle.result();
    });

    validatorConfigurationFaults.delete(runId);

    // SDD section 49. An unregistered runner is a repairable configuration fault, not an
    // internal error, and it must not consume the infrastructure retry policy.
    expect(result.status).toBe("FAILED_CONFIGURATION");
    expect(completionsOf(runId).at(-1)).toMatchObject({
      status: "FAILED_CONFIGURATION",
      failureReason: "CONFIGURATION_INVALID",
    });
    expect(userValidatesOf(runId)).toHaveLength(1);
  });
});
