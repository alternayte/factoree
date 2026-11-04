import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import type { UserValidateActivityOutput } from "~/activities/validation.activities.js";
import { createWorkflowHarness, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  statusCalls,
  implementCalls,
  reviewCalls,
  verifyOutcomes,
  userValidationOutcomes,
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

const startRun = async (sessionId: string) =>
  environment.client.workflow.start(agentRunWorkflow, {
    taskQueue: "test",
    workflowId: buildWorkflowId("workspace-123", sessionId),
    args: [input(sessionId)],
  });

const failing: UserValidateActivityOutput = {
  passed: false,
  results: [
    { assertionId: "VAL-API-002", result: "FAIL", reason: "The reload does not show the saved name." },
  ],
  hasFailure: true,
  hasManual: false,
  hasBlocked: false,
  summary: "One user validation assertion failed.",
  failures: ["VAL-API-002: the reload does not show the saved name."],
  sessionId: "ses_fake_validator",
  previewUrl: null,
  hang: null,
};

const passing: UserValidateActivityOutput = {
  passed: true,
  results: [{ assertionId: "VAL-API-002", result: "PASS", reason: "The reload shows the saved name." }],
  hasFailure: false,
  hasManual: false,
  hasBlocked: false,
  summary: "Every user validation assertion passed.",
  failures: [],
  sessionId: "ses_fake_validator",
  previewUrl: null,
  hang: null,
};

/**
 * AT-20, SDD section 64: "A build-successful but behaviorally incorrect implementation fails
 * user validation, enters repair, and is fully reverified." This test drives the real workflow.
 * Deterministic verification passes on every attempt, so the build-successful half is real.
 * User validation fails on attempt 1 and passes on attempt 2, so the repair is the system's own
 * decision, not an order the test chose. The acceptance test at
 * `tests/acceptance/at-20-validation-repair.test.ts` proves the same clause against real
 * artefacts: a real preview process, a real scripted session, and the real database.
 */
describe("AT-20 — a behaviorally wrong implementation fails validation, repairs, and is fully reverified", () => {
  it("repairs once when user validation fails, then reverifies fully", async () => {
    const runId = "run-ses-at20";
    runtimeOverrides.set(runId, { repairMaxAttempts: 2 });
    verifyOutcomes.set(runId, () => true);
    userValidationOutcomes.set(runId, (attempt) => (attempt === 1 ? failing : passing));

    await runWorker(async () => {
      const handle = await startRun("ses-at20");
      // docs/specs/run-speed.md. Each attempt that passes verification gets its review beside user
      // validation, so the repair attempt holds the second review.
      await waitFor(() => reviewsOf(runId).length === 2, "the second review of ses-at20");
      await waitFor(
        () => statusCalls.some((entry) => entry.runId === runId && entry.status === "REVIEWING"),
        "REVIEWING of ses-at20",
      );
      await handle.signal(stopSignal);
      await handle.result();
    });

    // The repair clause: the Run enters REPAIRING because user validation failed, and the
    // repair count reaches 1.
    const repairs = statusCalls.filter((entry) => entry.runId === runId && entry.status === "REPAIRING");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.repairCount).toBe(1);
    expect(repairs[0]?.repairReason).toBe("VALIDATION");

    // The reverification clause: each attempt runs implement, then verify, and then user
    // validation and the review beside each other (docs/specs/run-speed.md). This is the
    // workflow's own ordering, not the test's: the repair attempt is "fully reverified".
    const order = activityOrder.filter((name) => ["implement", "verify", "userValidate", "review"].includes(name));
    const second = order.lastIndexOf("implement");
    for (const attempt of [order.slice(0, second), order.slice(second)]) {
      expect(attempt.slice(0, 2)).toEqual(["implement", "verify"]);
      expect(attempt.slice(2).sort()).toEqual(["review", "userValidate"]);
    }

    // The failing assertion carries into the repair's implement call.
    expect(implementsOf(runId)).toHaveLength(2);
    expect(implementsOf(runId)[1]?.repairFindings).toEqual([
      expect.stringContaining("VAL-API-002"),
    ]);
  });
});
