import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import {
  DEFAULT_VERIFY_COMMANDS,
  VERIFY_FAILURE_TEXT,
  createWorkflowHarness,
  hold,
  waitFor,
} from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  completions,
  statusCalls,
  statusesOf,
  implementCalls,
  verifyCalls,
  userValidateCalls,
  reviewCalls,
  heldVerifications,
  configurationFaults,
  runtimeOverrides,
  verifyOutcomes,
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
const verifiesOf = (runId: string) => verifyCalls.filter((entry) => entry.runId === runId);
const userValidatesOf = (runId: string) => userValidateCalls.filter((entry) => entry.runId === runId);
const reviewsOf = (runId: string) => reviewCalls.filter((entry) => entry.runId === runId);
const completionsOf = (runId: string) => completions.filter((entry) => entry.runId === runId);

/** Starts one Run of the default fixture Work Item and Project, and returns its handle. */
const startRun = async (sessionId: string, maxRunMinutes = 90) =>
  environment.client.workflow.start(agentRunWorkflow, {
    taskQueue: "test",
    workflowId: buildWorkflowId("workspace-123", sessionId),
    args: [input(sessionId, maxRunMinutes)],
  });

describe("deterministic verification in the workflow", () => {
  it("moves the Run through VERIFYING after a completed implementation", async () => {
    // The Implementer reports a completed change, and verification passes.
    runtimeOverrides.set("run-ses-v1", { repairMaxAttempts: 2 });
    verifyOutcomes.set("run-ses-v1", () => true);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-v1");
      await waitFor(() => verifiesOf("run-ses-v1").length === 1, "the verification of ses-v1");
      await handle.signal(stopSignal);
      return handle.result();
    });

    const sequence = statusesOf("run-ses-v1");
    expect(sequence.indexOf("IMPLEMENTING")).toBeGreaterThanOrEqual(0);
    expect(sequence.indexOf("VERIFYING")).toBeGreaterThan(sequence.indexOf("IMPLEMENTING"));
    expect(verifiesOf("run-ses-v1")[0]?.commands).toEqual(DEFAULT_VERIFY_COMMANDS);
    expect(verifiesOf("run-ses-v1")[0]?.attempt).toBe(1);
    expect(result.status).toBe("CANCELLED");
  });

  it("does not accept a false agent success claim", async () => {
    // The Implementer claims success, and verification denies it. No repair budget remains.
    runtimeOverrides.set("run-ses-v2", { repairMaxAttempts: 0 });
    verifyOutcomes.set("run-ses-v2", () => false);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-v2");
      return handle.result();
    });

    // The agent claim is a claim. Only the configured command decides.
    expect(implementsOf("run-ses-v2")[0]?.repairFindings).toEqual([]);
    expect(result.status).toBe("FAILED");
    const completion = completionsOf("run-ses-v2").at(-1);
    expect(completion?.status).toBe("FAILED");
    expect(completion?.failureReason).toBe("VERIFICATION_FAILED");
    expect(implementsOf("run-ses-v2")).toHaveLength(1);
  });

  it("repairs once and re-verifies when budget remains", async () => {
    runtimeOverrides.set("run-ses-v3", { repairMaxAttempts: 2 });
    verifyOutcomes.set("run-ses-v3", (attempt) => attempt >= 2);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-v3");
      await waitFor(() => verifiesOf("run-ses-v3").length === 2, "the second verification of ses-v3");
      // The second verification passes, so the Run enters USER_VALIDATING and then REVIEWING.
      // The stop must wait for the review call, or the stop signal races the transition and this
      // test flakes.
      await waitFor(
        () => userValidatesOf("run-ses-v3").length === 1,
        "the user validation of ses-v3",
      );
      await waitFor(() => reviewsOf("run-ses-v3").length === 1, "the review of ses-v3");
      await handle.signal(stopSignal);
      return handle.result();
    });

    // The first six states are RECEIVED, REFINING, RESOLVING_CONTEXT,
    // BUILDING_VALIDATION_CONTRACT, PREPARING, and IMPLEMENTING. The repair loop follows them.
    // The second verification passes, so the Run enters USER_VALIDATING and then REVIEWING, and
    // the stop signal cancels the Run once the default passing review double returns.
    expect(statusesOf("run-ses-v3").slice(6)).toEqual([
      "VERIFYING",
      "REPAIRING",
      "IMPLEMENTING",
      "VERIFYING",
      "USER_VALIDATING",
      "REVIEWING",
    ]);
    const attempts = implementsOf("run-ses-v3");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.repairFindings).toEqual([VERIFY_FAILURE_TEXT]);
    expect(attempts[1]?.attempt).toBe(2);
    expect(verifiesOf("run-ses-v3")[1]?.attempt).toBe(2);
    expect(completionsOf("run-ses-v3").map((entry) => entry.failureReason)).not.toContain(
      "VERIFICATION_FAILED",
    );
    expect(result.status).toBe("CANCELLED");
  });

  it("starts no third repair when the maximum is two", async () => {
    runtimeOverrides.set("run-ses-v4", { repairMaxAttempts: 2 });
    verifyOutcomes.set("run-ses-v4", () => false);

    const result = await runWorker(async () => {
      const handle = await startRun("ses-v4");
      return handle.result();
    });

    // SDD section 42. One first attempt plus two repairs, and no third repair.
    expect(implementsOf("run-ses-v4")).toHaveLength(3);
    expect(result.status).toBe("FAILED");
    expect(completionsOf("run-ses-v4").at(-1)?.failureReason).toBe("VERIFICATION_FAILED");
  });

  it("records the repair count on the Run", async () => {
    runtimeOverrides.set("run-ses-v5", { repairMaxAttempts: 2 });
    verifyOutcomes.set("run-ses-v5", () => false);

    await runWorker(async () => {
      const handle = await startRun("ses-v5");
      await handle.result();
    });

    const repairs = statusCalls.filter(
      (entry) => entry.runId === "run-ses-v5" && entry.status === "REPAIRING",
    );
    expect(repairs.map((entry) => entry.repairCount)).toEqual([1, 2]);
  });

  it("cancels the Run on a stop signal received during verification", async () => {
    runtimeOverrides.set("run-ses-v6", { repairMaxAttempts: 2 });
    verifyOutcomes.set("run-ses-v6", () => false);
    const release = hold(heldVerifications, "run-ses-v6");

    const result = await runWorker(async () => {
      const handle = await startRun("ses-v6");
      await waitFor(() => verifiesOf("run-ses-v6").length === 1, "the verification of ses-v6");
      await handle.signal(stopSignal);
      release();
      return handle.result();
    });
    heldVerifications.delete("run-ses-v6");

    expect(result.status).toBe("CANCELLED");
    expect(completionsOf("run-ses-v6").at(-1)?.failureReason).toBe("STOPPED_BY_HUMAN");
    // No repair started, so the Implementer ran once only.
    expect(implementsOf("run-ses-v6")).toHaveLength(1);
    expect(statusesOf("run-ses-v6")).not.toContain("REPAIRING");
  });

  it("ends the Run with RUN_TIMEOUT when the budget runs out before a repair", async () => {
    runtimeOverrides.set("run-ses-v7", { repairMaxAttempts: 2 });
    verifyOutcomes.set("run-ses-v7", () => false);
    const release = hold(heldVerifications, "run-ses-v7");

    const result = await runWorker(async () => {
      const handle = await startRun("ses-v7", 0.2);
      await waitFor(() => verifiesOf("run-ses-v7").length === 1, "the verification of ses-v7");
      // The workflow clock passes the Run budget while verification still runs.
      await environment.sleep("20 seconds");
      release();
      return handle.result();
    });
    heldVerifications.delete("run-ses-v7");

    expect(result.status).toBe("FAILED");
    expect(completionsOf("run-ses-v7").at(-1)?.failureReason).toBe("RUN_TIMEOUT");
    expect(implementsOf("run-ses-v7")).toHaveLength(1);
  });

  it("fails with FAILED_CONFIGURATION when the repository has no config file", async () => {
    configurationFaults.add("run-ses-v8");

    const result = await runWorker(async () => {
      const handle = await startRun("ses-v8");
      return handle.result();
    });
    configurationFaults.delete("run-ses-v8");

    expect(result.status).toBe("FAILED_CONFIGURATION");
    expect(completionsOf("run-ses-v8").at(-1)?.failureReason).toBe("CONFIGURATION_INVALID");
    expect(verifiesOf("run-ses-v8")).toHaveLength(0);
  });
});
