import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { VERIFY_FAILURE_TEXT, createWorkflowHarness, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  completions,
  statusesOf,
  implementCalls,
  verifyCalls,
  userValidateCalls,
  runtimeOverrides,
  verifyOutcomes,
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

    const result = await runWorker(async () => {
      const handle = await startRun("ses-at16a");
      await waitFor(() => verifiesOf("run-ses-at16a").length === 2, "the second verification");
      // The second verification passes, so the Run enters USER_VALIDATING next. The stop must
      // wait for that call, or the stop signal races the transition and this test flakes.
      await waitFor(
        () => userValidatesOf("run-ses-at16a").length === 1,
        "the user validation of ses-at16a",
      );
      await handle.signal(stopSignal);
      return handle.result();
    });

    // The status sequence holds REPAIRING between the failed check and the repair attempt.
    const sequence = statusesOf("run-ses-at16a");
    expect(sequence).toContain("REPAIRING");
    expect(sequence.indexOf("REPAIRING")).toBeGreaterThan(sequence.indexOf("VERIFYING"));

    // The second implement call received the failing check text.
    const attempts = implementsOf("run-ses-at16a");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.repairFindings).toEqual([VERIFY_FAILURE_TEXT]);

    // Nothing was published. The Run invoked exactly these activities, in this order. A new
    // activity on this path changes the list, so the reader must judge it again.
    expect(namesFor("run-ses-at16a")).toEqual([
      "setRunStatus",
      "setRunStatus",
      "refine",
      "setRunAutonomyLevel",
      "setRunStatus",
      "resolveContext",
      "setRunStatus",
      "buildValidationContract",
      "setRunStatus",
      "prepareSandbox",
      "setRunStatus",
      "implement",
      "setRunStatus",
      "verify",
      "setRunStatus",
      "setRunStatus",
      "implement",
      "setRunStatus",
      "verify",
      "setRunStatus",
      "userValidate",
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
      "setRunStatus",
      "resolveContext",
      "setRunStatus",
      "buildValidationContract",
      "setRunStatus",
      "prepareSandbox",
      "setRunStatus",
      "implement",
      "setRunStatus",
      "verify",
      "setRunStatus",
      "setRunStatus",
      "implement",
      "setRunStatus",
      "verify",
      "setRunStatus",
      "setRunStatus",
      "implement",
      "setRunStatus",
      "verify",
      "completeRun",
    ]);
    expect(namesFor("run-ses-at16b").filter(isPublishingName)).toEqual([]);
  });
});
