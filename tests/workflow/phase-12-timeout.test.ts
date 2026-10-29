import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createWorkflowHarness, hold, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await environment?.teardown();
});

/**
 * SDD section 50. On timeout Factoree cancels the active process, starts no new side effect,
 * keeps the evidence, and records `RUN_TIMEOUT`.
 *
 * The Run budget check runs between stages, not while an activity is in flight, so the workflow
 * cannot interrupt the Implementer mid-call. It cancels the session through the separate
 * `cancelImplementer` activity, after the Implementer call returns. The test lets real time pass
 * the one-second budget floor while the Implementer still holds. The test then releases the
 * Implementer. The Run reaches its deadline check. The fix has a real session to cancel.
 */
describe("Phase 12 — a Run that exhausts its budget", () => {
  it("cancels the live session, publishes nothing, and records RUN_TIMEOUT", async () => {
    const harness = createWorkflowHarness(() => environment);
    const runId = "run-session-timeout";

    // The Implementer holds until the test releases it. The budget floors at one second, so the
    // deadline passes while the Implementer still holds.
    const release = hold(harness.heldImplementations, runId);

    const status = await harness.runWorker(async () => {
      const handle = await harness.start("session-timeout", { maxRunMinutes: 5 / 60 });
      await waitFor(
        () => harness.implementCalls.length === 1,
        "the Implementer to start",
        30_000,
      );

      // The budget is 5,000 milliseconds, because the work sprite, the refiner and the contract
      // freeze now precede the Implementer. This margin guarantees the deadline passed
      // before the release, without depending on how fast the machine schedules the test.
      await new Promise((resolve) => setTimeout(resolve, 5_200));
      release();
      return await handle.result();
    });

    expect(status.status).toBe("FAILED");

    const completion = harness.completions.find((entry) => entry.runId === runId);
    expect(completion?.failureReason).toBe("RUN_TIMEOUT");

    // SDD section 50 obligation 1. The Run must cancel the active process. The Implementer
    // already returned on its own by the time the Run reaches its deadline check, so the proof
    // is the explicit second cancellation Factoree issues for a session it did not itself end.
    expect(harness.cancelledSessions.length).toBeGreaterThan(0);

    // SDD section 50 obligation 2. No publication, and no Proof Pack.
    expect(harness.publishCalls.filter((entry) => entry.runId === runId)).toEqual([]);
    expect(harness.proofPackCalls.filter((entry) => entry.runId === runId)).toEqual([]);

    // SDD section 50 obligation 4. The failure reason is `RUN_TIMEOUT`, asserted above.

    // The human was told.
    expect(harness.postedErrors.join("\n")).toMatch(/duration/i);
  }, 180_000);
});
