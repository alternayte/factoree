import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createWorkflowHarness } from "./support/harness.js";
import type { VerifyActivityInput, VerifyActivityOutput } from "~/activities/verification.activities.js";

let environment: TestWorkflowEnvironment;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await environment?.teardown();
});

/**
 * SDD section 49 and the Definition of Done: "Infrastructure retries do not consume semantic
 * repair budget."
 *
 * A transport fault is not a decision. It must retry, and it must leave the repair count
 * unchanged. A failing check is a decision. It must not retry, and it must spend the budget.
 */
describe("Phase 12 — an injected transport fault does not consume the repair budget", () => {
  it("retries a failing verification activity and leaves the repair count at zero", async () => {
    const harness = createWorkflowHarness(() => environment);
    const runId = "run-session-fault";

    // The first two calls of `verify` throw a transport fault. The third succeeds. The harness
    // `verifyOutcomes` map reports a pass or a fail, which is a semantic answer. A thrown error
    // is the transport fault, so this test wraps the double instead of using that map.
    let verifyAttempts = 0;
    const realVerify = harness.activities.verify;
    harness.activities.verify = async (
      input: VerifyActivityInput,
    ): Promise<VerifyActivityOutput> => {
      verifyAttempts += 1;
      if (verifyAttempts <= 2) throw new Error("the build cache host refused the connection");
      return realVerify(input);
    };

    await harness.runWorker(async () => {
      const handle = await harness.start("session-fault");
      await handle.result();
    });

    // The activity really retried.
    expect(verifyAttempts).toBe(3);

    // The Run still reached the human-ready state.
    const completion = harness.completions.find((entry) => entry.runId === runId);
    expect(completion?.status).toBe("READY_FOR_HUMAN");

    // No status write reported a repair. SDD section 42 spends the budget on a semantic
    // failure only, and no check ever failed here.
    const repairs = harness.statusCalls.filter(
      (entry) => entry.runId === runId && (entry.repairCount ?? 0) > 0,
    );
    expect(repairs).toEqual([]);

    // Exactly one publication, so the retry duplicated nothing.
    expect(harness.publishCalls.filter((entry) => entry.runId === runId)).toHaveLength(1);
  }, 180_000);

  it("spends the repair budget on a failing check and not on a transport fault", async () => {
    const harness = createWorkflowHarness(() => environment);
    const runId = "run-session-mixed";

    // The first verification attempt fails semantically. The second attempt throws twice
    // before it passes. The budget must fall by exactly one, not by three.
    harness.verifyOutcomes.set(runId, (attempt) => attempt > 1);

    let thrown = 0;
    const realVerify = harness.activities.verify;
    harness.activities.verify = async (
      input: VerifyActivityInput,
    ): Promise<VerifyActivityOutput> => {
      const result = await realVerify(input);
      if (result.passed && thrown < 2) {
        thrown += 1;
        throw new Error("the artifact store timed out");
      }
      return result;
    };

    await harness.runWorker(async () => {
      const handle = await harness.start("session-mixed");
      await handle.result();
    });

    expect(thrown).toBe(2);

    const completion = harness.completions.find((entry) => entry.runId === runId);
    expect(completion?.status).toBe("READY_FOR_HUMAN");

    // Exactly one repair. Two transport faults added nothing to it.
    const counts = harness.statusCalls
      .filter((entry) => entry.runId === runId)
      .map((entry) => entry.repairCount ?? 0);
    expect(Math.max(...counts)).toBe(1);
  }, 180_000);
});
