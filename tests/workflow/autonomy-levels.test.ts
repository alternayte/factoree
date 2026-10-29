import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createWorkflowHarness } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await environment?.teardown();
});

/** docs/specs/autonomy-levels.md. The level decides where the Run stops and what it publishes. */
describe("autonomy levels", () => {
  const harness = createWorkflowHarness(() => environment);

  const runAt = async (session: string, level: string, labels: string[] = []) =>
    harness.runWorker(async () => {
      // The Run reads its labels from Linear, so the label double answers for this session.
      harness.workItemLabels.set(session, labels);
      const handle = await harness.start(session, {
        product: { ...harness.productInput, defaultAutonomy: level },
      });
      return handle.result();
    });

  const runIdOf = (session: string) => `run-${session}`;

  it("L0 reports the context and starts no sandbox", async () => {
    const result = await runAt("lvl-l0", "L0");
    expect(result.status).toBe("REPORTED");
    expect(harness.prepared.filter((entry) => entry.runId === runIdOf("lvl-l0"))).toEqual([]);
    expect(harness.postedFinalResponses.at(-1)).toMatch(/REPORTED at L0/);
  });

  it("L1 runs every check and opens no pull request", async () => {
    const result = await runAt("lvl-l1", "L1");
    expect(result.status).toBe("REPORTED");
    expect(harness.implementCalls.some((entry) => entry.runId === runIdOf("lvl-l1"))).toBe(true);
    expect(harness.publishCalls.filter((entry) => entry.runId === runIdOf("lvl-l1"))).toEqual([]);
    expect(harness.postedFinalResponses.at(-1)).toMatch(/REPORTED at L1/);
  });

  it("L2 opens a draft pull request", async () => {
    const result = await runAt("lvl-l2", "L2");
    expect(result.status).toBe("READY_FOR_HUMAN");
    expect(harness.publishCalls.find((entry) => entry.runId === runIdOf("lvl-l2"))?.draft).toBe(true);
  });

  it("L3 opens a pull request that is ready for review", async () => {
    const result = await runAt("lvl-l3", "L3");
    expect(result.status).toBe("READY_FOR_HUMAN");
    expect(harness.publishCalls.find((entry) => entry.runId === runIdOf("lvl-l3"))?.draft).toBe(false);
  });

  it("a payments label on an L3 Product opens a draft pull request", async () => {
    const result = await runAt("lvl-pay", "L3", ["payments"]);
    expect(result.status).toBe("READY_FOR_HUMAN");
    expect(harness.publishCalls.find((entry) => entry.runId === runIdOf("lvl-pay"))?.draft).toBe(true);
  });

  it("a factoree:l0 label on an L3 Product reports and starts no sandbox", async () => {
    const result = await runAt("lvl-label-l0", "L3", ["factoree:l0"]);
    expect(result.status).toBe("REPORTED");
    expect(harness.prepared.filter((entry) => entry.runId === runIdOf("lvl-label-l0"))).toEqual([]);
  });
});
