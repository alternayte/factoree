import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { VERIFY_FAILURE_TEXT, createWorkflowHarness, hold, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  completions,
  statusesOf,
  implementCalls,
  verifyCalls,
  userValidateCalls,
  reviewCalls,
  runtimeOverrides,
  verifyOutcomes,
  heldReviews,
  cancelledLiveReviews,
  input,
  runWorker,
} = harness;

/** One recorded activity call. The run id is absent on the two session-scoped activities. */
interface ActivityCall {
  name: string;
  runId: string | undefined;
}

const activityCalls: ActivityCall[] = [];

/**
 * The activity names that publish work outside the sandbox. SDD sections 44 to 47 place them in
 * a later phase, so a Phase 3 Run must call none of them. The test asserts the absence by name,
 * so a later phase that adds one of these activities to this path fails this test.
 */
const PUBLISHING_ACTIVITY_NAMES = [
  "publish",
  "publishChange",
  "pushBranch",
  "openPullRequest",
  "createPullRequest",
  "mergePullRequest",
];

const isPublishingName = (name: string): boolean =>
  PUBLISHING_ACTIVITY_NAMES.includes(name) || name.toLowerCase().includes("publish");

/**
 * Wraps every activity double of the harness, so the test records the name of each call. The
 * wrapper delegates immediately and keeps the Temporal activity context of the caller.
 */
const recordActivityCalls = (): void => {
  const doubles = harness.activities as unknown as Record<string, (value: unknown) => unknown>;
  for (const name of Object.keys(doubles)) {
    const original = doubles[name];
    if (original === undefined) continue;
    doubles[name] = (value: unknown): unknown => {
      const runId = typeof value === "object" && value !== null ? (value as { runId?: unknown }).runId : undefined;
      activityCalls.push({ name, runId: typeof runId === "string" ? runId : undefined });
      return original(value);
    };
  }
};

const namesFor = (runId: string): string[] =>
  activityCalls.filter((entry) => entry.runId === runId).map((entry) => entry.name);

const implementsOf = (runId: string) => implementCalls.filter((entry) => entry.runId === runId);
const verifiesOf = (runId: string) => verifyCalls.filter((entry) => entry.runId === runId);
const userValidatesOf = (runId: string) => userValidateCalls.filter((entry) => entry.runId === runId);
const reviewsOf = (runId: string) => reviewCalls.filter((entry) => entry.runId === runId);
const completionsOf = (runId: string) => completions.filter((entry) => entry.runId === runId);

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  recordActivityCalls();
});

afterAll(async () => {
  await environment.teardown();
});

/** Starts one Run of the default fixture Work Item and Project, and returns its handle. */
const startRun = async (sessionId: string) =>
  environment.client.workflow.start(agentRunWorkflow, {
    taskQueue: "test",
    workflowId: buildWorkflowId("workspace-123", sessionId),
    args: [input(sessionId)],
  });

describe("AT-16 — a failing deterministic command blocks publication and triggers repair", () => {
  it("enters repair while budget remains", async () => {
    // The first verification fails, and the second one passes. SDD section 42.
    runtimeOverrides.set("run-ses-at16a", { repairMaxAttempts: 2 });
    verifyOutcomes.set("run-ses-at16a", (attempt) => attempt >= 2);

    // The review pass stays open until this test releases it. The stop therefore arrives while
    // the Run is still inside the review, so the Run never reaches the publication path. A stop
    // sent after the review returns can race that path and make this test flake.
    const releaseReview = hold(heldReviews, "run-ses-at16a");

    const result = await runWorker(async () => {
      const handle = await startRun("ses-at16a");
      await waitFor(() => verifiesOf("run-ses-at16a").length === 2, "the second verification");
      // The second verification passes, so the Run enters USER_VALIDATING and then REVIEWING.
      await waitFor(
        () => userValidatesOf("run-ses-at16a").length === 1,
        "the user validation of ses-at16a",
      );
      await waitFor(() => reviewsOf("run-ses-at16a").length === 1, "the review of ses-at16a");
      await handle.signal(stopSignal);
      // The stop must reach the live Reviewer session before the test releases the pass.
      await waitFor(
        () => cancelledLiveReviews.includes("run-ses-at16a"),
        "the live cancellation of ses-at16a",
      );
      releaseReview();
      return handle.result();
    });
    heldReviews.delete("run-ses-at16a");

    // The status sequence holds REPAIRING between the failed check and the repair attempt.
    const sequence = statusesOf("run-ses-at16a");
    expect(sequence).toContain("REPAIRING");
    expect(sequence.indexOf("REPAIRING")).toBeGreaterThan(sequence.indexOf("VERIFYING"));

    // The second implement call received the failing check text.
    const attempts = implementsOf("run-ses-at16a");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.repairFindings).toEqual([VERIFY_FAILURE_TEXT]);

    // docs/specs/check-isolation.md. The Implementer wrote in the work sprite. Every check of an
    // attempt ran in that attempt's own check sprite, the repair deleted the first check sprite,
    // and the end of the Run deleted the second.
    expect(verifiesOf("run-ses-at16a").map((entry) => entry.spriteId)).toEqual([
      "check-run-ses-at16a-1",
      "check-run-ses-at16a-2",
    ]);
    expect(attempts.every((entry) => entry.spriteId === "sprite-run-ses-at16a")).toBe(true);
    const checks = harness.checkPrepared.filter((entry) => entry.runId === "run-ses-at16a");
    expect(checks.map((entry) => entry.previous?.spriteId ?? null)).toEqual([null, "check-run-ses-at16a-1"]);
    expect(checks.every((entry) => entry.work.spriteId === "sprite-run-ses-at16a")).toBe(true);
    expect(harness.releasedChecks).toContain("check-run-ses-at16a-2");

    // Nothing was published. The Run invoked exactly these activities, in this order. A new
    // activity on this path changes the list, so the reader must judge it again.
    expect(namesFor("run-ses-at16a")).toEqual([
      "setRunStatus",
      "setRunStatus",
      "refine",
      "setRunAutonomyLevel",
      "recordRunTarget",
      "setRunStatus",
      "resolveContext",
      "verifyTargetIdentity",
      "recordRunTargetFacts",
      "claimRunSlot",
      "setRunStatus",
      "prepareSandbox",
      "setRunStatus",
      "proposeRefinement",
      "setRunStatus",
      "buildValidationContract",
      "setRunStatus",
      "implement",
      "prepareCheckSandbox",
      "setRunStatus",
      "verify",
      "setRunStatus",
      "setRunStatus",
      "implement",
      "prepareCheckSandbox",
      "setRunStatus",
      "verify",
      "setRunStatus",
      "userValidate",
      "setRunStatus",
      "review",
      "releaseCheckSandbox",
      "completeRun",
    ]);
    expect(namesFor("run-ses-at16a").filter(isPublishingName)).toEqual([]);
    expect(result.status).toBe("CANCELLED");
  });

  it("blocks the Run when the repair budget is spent (AT-24)", async () => {
    // Every verification fails, so the Run spends the whole repair budget.
    runtimeOverrides.set("run-ses-at16b", { repairMaxAttempts: 2 });
    verifyOutcomes.set("run-ses-at16b", () => false);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-at16b");
      return handle.result();
    });

    // SDD section 42. One first attempt plus two repairs, and no third repair.
    expect(implementsOf("run-ses-at16b")).toHaveLength(3);
    expect(result.status).toBe("FAILED");
    const completion = completionsOf("run-ses-at16b").at(-1);
    expect(completion?.status).toBe("FAILED");
    expect(completion?.failureReason).toBe("VERIFICATION_FAILED");

    // Nothing was published. The Run invoked exactly these activities, in this order. Three
    // implement calls and three verify calls appear, and no publishing activity appears.
    expect(namesFor("run-ses-at16b")).toEqual([
      "setRunStatus",
      "setRunStatus",
      "refine",
      "setRunAutonomyLevel",
      "recordRunTarget",
      "setRunStatus",
      "resolveContext",
      "verifyTargetIdentity",
      "recordRunTargetFacts",
      "claimRunSlot",
      "setRunStatus",
      "prepareSandbox",
      "setRunStatus",
      "proposeRefinement",
      "setRunStatus",
      "buildValidationContract",
      "setRunStatus",
      "implement",
      "prepareCheckSandbox",
      "setRunStatus",
      "verify",
      "setRunStatus",
      "setRunStatus",
      "implement",
      "prepareCheckSandbox",
      "setRunStatus",
      "verify",
      "setRunStatus",
      "setRunStatus",
      "implement",
      "prepareCheckSandbox",
      "setRunStatus",
      "verify",
      "releaseCheckSandbox",
      "completeRun",
    ]);
    expect(namesFor("run-ses-at16b").filter(isPublishingName)).toEqual([]);
  });
});
