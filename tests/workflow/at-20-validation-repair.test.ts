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
  postedProgress,
  postedErrors,
  publishCalls,
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

    // The human sees that the repair started, why, and what the implementer received.
    expect(postedProgress).toContain(
      "Factoree starts repair 1 of 2, because user validation did not pass. The implementer receives 1 finding. " +
        "Factoree posts again when it checks the new change.",
    );

    // The failing assertion carries into the repair's implement call.
    expect(implementsOf(runId)).toHaveLength(2);
    expect(implementsOf(runId)[1]?.repairFindings).toEqual([
      expect.stringContaining("VAL-API-002"),
    ]);
  });

  // docs/specs/run-recovery.md. A check that flips by timing spends no repair, and the change
  // reaches a human as a draft.
  it("publishes a draft and spends no repair when the only unproven assertion is unstable", async () => {
    const runId = "run-ses-unstable";
    runtimeOverrides.set(runId, { repairMaxAttempts: 2 });
    verifyOutcomes.set(runId, () => true);
    userValidationOutcomes.set(runId, () => ({
      ...failing,
      results: [{ assertionId: "VAL-API-002", result: "UNSTABLE", reason: "It failed once and passed on a re-run." }],
      hasFailure: false,
      hasUnstable: true,
      failures: [],
      summary: "1 of 1 assertions did not pass.",
    }));

    const result = await runWorker(async () =>
      (
        await environment.client.workflow.start(agentRunWorkflow, {
          taskQueue: "test",
          workflowId: buildWorkflowId("workspace-123", "ses-unstable"),
          args: [{ ...input("ses-unstable"), product: { ...input("ses-unstable").product, defaultAutonomy: "L3" } }],
        })
      ).result(),
    );

    expect(result.status).toBe("READY_FOR_HUMAN");
    expect(statusCalls.filter((entry) => entry.runId === runId && entry.status === "REPAIRING")).toEqual([]);
    expect(publishCalls.find((call) => call.runId === runId)?.draft).toBe(true);
  });

  it("builds the failure post of a run that spent its repairs from the run facts", async () => {
    const runId = "run-ses-failure-post";
    runtimeOverrides.set(runId, { repairMaxAttempts: 0, repairBudgetSource: "product" });
    verifyOutcomes.set(runId, () => true);
    userValidationOutcomes.set(runId, () => failing);
    const errorsBefore = postedErrors.length;
    const orderBefore = activityOrder.length;

    const result = await runWorker(async () => (await startRun("ses-failure-post")).result());

    expect(result.status).toBe("FAILED");
    expect(activityOrder.slice(orderBefore)).toContain("describeRunFailure");
    // Issue #43, DI-21.67. The message names the budget and where it comes from.
    expect(postedErrors.slice(errorsBefore)).toEqual([
      expect.stringContaining(
        "the repair budget (0, from the product setting) is spent. Raise it on the product page or with `repair.maxAttempts` in .factoree/config.yaml.",
      ),
    ]);
  });

  // docs/specs/run-recovery.md. A follow-up run shares the session and makes a run of its own,
  // under its own workflow id. FAC-73 on 0.4.0 reused the failed run's row instead.
  it("records the follow-up run under its own workflow id, linked to the failed run", async () => {
    const workflowId = `${buildWorkflowId("workspace-123", "ses-follow-up")}:follow-up:run-failed`;
    await runWorker(async () =>
      (
        await environment.client.workflow.start(agentRunWorkflow, {
          taskQueue: "test",
          workflowId,
          args: [{ ...input("ses-follow-up"), followUpOfRunId: "run-failed", followUpBrowserAssertions: ["VAL-UI-001"] }],
        })
      ).result(),
    );

    expect(harness.createRunCalls.find((call) => call.linearAgentSessionId === "ses-follow-up")).toMatchObject({
      temporalWorkflowId: workflowId,
      followUpOfRunId: "run-failed",
    });
    // The reply replaced the browser check, so the proof pack says why no visual evidence exists.
    expect(harness.proofPackCalls.find((call) => call.runId === "run-ses-follow-up")?.visualEvidenceGap).toContain(
      "replaced the browser check VAL-UI-001",
    );
  });
});
