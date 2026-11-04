import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import type { UserValidateActivityOutput } from "~/activities/validation.activities.js";
import { createWorkflowHarness } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await environment?.teardown();
});

/**
 * docs/specs/agent-session-usage-and-hangs.md. A hung session gets one more try. A second hang
 * in the same step ends the Run with AGENT_HUNG, and the message names the role and the limit.
 */
describe("a hung agent session in the Run workflow", () => {
  const harness = createWorkflowHarness(() => environment);
  const hang = { silenceLimitMs: 60_000 };
  const failureOf = (runId: string) => harness.completions.filter((entry) => entry.runId === runId).at(-1);

  const passingValidation: UserValidateActivityOutput = {
    passed: true,
    results: [{ assertionId: "VAL-UI-001", result: "PASS", reason: "The page renders." }],
    hasFailure: false,
    hasManual: false,
    hasBlocked: false,
    summary: "Every user validation assertion passed.",
    failures: [],
    sessionId: "ses_fake_validator",
    previewUrl: null,
    hang: null,
  };
  const hungValidation: UserValidateActivityOutput = {
    ...passingValidation,
    passed: false,
    results: [],
    summary: "The User Validator session wrote no output for 1 minute, so Factoree stopped it.",
    hang,
  };

  it("starts one fresh validator session after a hang, and fails with AGENT_HUNG on the second", async () => {
    harness.userValidationOutcomes.set("run-hang-validator", () => hungValidation);

    const result = await harness.runWorker(async () => (await harness.start("hang-validator")).result());

    expect(result.status).toBe("FAILED");
    expect(failureOf("run-hang-validator")?.failureReason).toBe("AGENT_HUNG");
    const calls = harness.userValidateCalls.filter((entry) => entry.runId === "run-hang-validator");
    expect(calls.map((entry) => entry.afterHang ?? false)).toEqual([false, true]);
    expect(calls.map((entry) => entry.attempt)).toEqual([1, 1]);
    // docs/specs/run-speed.md. The reviewer starts beside the validator, once, and the second
    // validator hang ends the Run without a second review.
    expect(harness.reviewCalls.filter((entry) => entry.runId === "run-hang-validator")).toHaveLength(1);
    expect(harness.postedErrors.at(-1)).toContain("The User Validator session wrote no output for 1 minute");
  });

  it("continues the Run when the fresh validator session finishes", async () => {
    let calls = 0;
    harness.userValidationOutcomes.set("run-hang-once", () => {
      calls += 1;
      return calls === 1 ? hungValidation : passingValidation;
    });

    const result = await harness.runWorker(async () => (await harness.start("hang-once")).result());

    expect(result.status).toBe("READY_FOR_HUMAN");
    expect(harness.reviewCalls.filter((entry) => entry.runId === "run-hang-once")).toHaveLength(1);
  });

  it("resumes a hung Implementer once with its session, charged to the repair budget", async () => {
    harness.implementHangs.set("run-hang-implementer", (call) => (call.attempt === 1 ? hang : null));

    const result = await harness.runWorker(async () => (await harness.start("hang-implementer")).result());

    expect(result.status).toBe("READY_FOR_HUMAN");
    const calls = harness.implementCalls.filter((entry) => entry.runId === "run-hang-implementer");
    expect(calls.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(calls[0]?.continueSession).toBeUndefined();
    expect(calls[1]?.continueSession).toEqual({ sessionId: "ses_fake", processId: "process-fake", runner: "opencode" });
    const repair = harness.statusCalls.find((entry) => entry.runId === "run-hang-implementer" && entry.status === "REPAIRING");
    expect(repair).toMatchObject({ repairCount: 1, repairReason: "AGENT_HUNG" });
  });

  it("fails with AGENT_HUNG when the resumed Implementer session hangs again", async () => {
    harness.implementHangs.set("run-hang-twice", () => hang);

    const result = await harness.runWorker(async () => (await harness.start("hang-twice")).result());

    expect(result.status).toBe("FAILED");
    expect(failureOf("run-hang-twice")?.failureReason).toBe("AGENT_HUNG");
    expect(harness.implementCalls.filter((entry) => entry.runId === "run-hang-twice")).toHaveLength(2);
    expect(harness.postedErrors.at(-1)).toContain("The Implementer session wrote no output for 1 minute");
  });

  it("fails with AGENT_HUNG when the repair budget leaves no room to resume", async () => {
    harness.runtimeOverrides.set("run-hang-no-budget", { repairMaxAttempts: 0 });
    harness.implementHangs.set("run-hang-no-budget", () => hang);

    const result = await harness.runWorker(async () => (await harness.start("hang-no-budget")).result());

    expect(failureOf("run-hang-no-budget")?.failureReason).toBe("AGENT_HUNG");
    expect(result.status).toBe("FAILED");
    expect(harness.implementCalls.filter((entry) => entry.runId === "run-hang-no-budget")).toHaveLength(1);
    expect(harness.postedErrors.at(-1)).toContain("the repair budget is spent");
  });

  it("starts one fresh Reviewer session after a hang, and fails with AGENT_HUNG on the second", async () => {
    harness.reviewOutcomes.set("run-hang-reviewer", () => ({
      passed: false,
      verdict: "fail",
      reportUsable: false,
      reportProblem: "The Reviewer session wrote no output for 1 minute, so Factoree stopped it.",
      hang,
    }));

    const result = await harness.runWorker(async () => (await harness.start("hang-reviewer")).result());

    expect(result.status).toBe("FAILED");
    expect(failureOf("run-hang-reviewer")?.failureReason).toBe("AGENT_HUNG");
    const calls = harness.reviewCalls.filter((entry) => entry.runId === "run-hang-reviewer");
    expect(calls.map((entry) => entry.afterHang ?? false)).toEqual([false, true]);
  });

  it("starts one fresh refiner session after a hang, and fails with AGENT_HUNG on the second", async () => {
    harness.refinerOutcomes.set("run-hang-refiner", {
      status: "unavailable",
      accepted: [],
      decisions: [],
      visualEvidenceGap: null,
      reason: "The refiner session wrote no output for the silence limit.",
      hang,
    });

    const result = await harness.runWorker(async () => (await harness.start("hang-refiner")).result());

    expect(result.status).toBe("FAILED");
    expect(failureOf("run-hang-refiner")?.failureReason).toBe("AGENT_HUNG");
    const calls = harness.refinerCalls.filter((entry) => entry.runId === "run-hang-refiner");
    expect(calls.map((entry) => entry.afterHang ?? false)).toEqual([false, true]);
    expect(harness.implementCalls.filter((entry) => entry.runId === "run-hang-refiner")).toEqual([]);
  });
});
