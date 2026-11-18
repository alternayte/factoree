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

/**
 * docs/specs/provider-unreachable.md. A session that cannot reach the model provider is retried
 * twice, the second time in a fresh sandbox, and a third failure ends the Run with
 * PROVIDER_UNREACHABLE. The retries never touch the repair budget.
 */
describe("an unreachable model provider in the Run workflow", () => {
  const harness = createWorkflowHarness(() => environment);
  const unreachable = { summary: "API Error: Unable to connect to API (EAI_AGAIN)" };
  const failureOf = (runId: string) => harness.completions.filter((entry) => entry.runId === runId).at(-1);
  const preparesOf = (runId: string) => harness.prepared.filter((entry) => entry.runId === runId);

  it("starts a fresh session in the same sandbox after one failure, and continues the Run", async () => {
    harness.implementProviderUnreachable.set("run-unreachable-once", (call) => (call.attempt === 1 ? unreachable : null));

    const result = await harness.runWorker(async () => (await harness.start("unreachable-once")).result());

    expect(result.status).toBe("READY_FOR_HUMAN");
    const calls = harness.implementCalls.filter((entry) => entry.runId === "run-unreachable-once");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.continueSession).toBeUndefined();
    expect(preparesOf("run-unreachable-once")).toHaveLength(1);
    // The repair budget stays whole.
    expect(harness.statusCalls.some((entry) => entry.runId === "run-unreachable-once" && entry.status === "REPAIRING")).toBe(false);
  });

  it("ends with PROVIDER_UNREACHABLE after three failures, names the error, and prepares a fresh sandbox on the second retry", async () => {
    harness.implementProviderUnreachable.set("run-unreachable-thrice", () => unreachable);

    const result = await harness.runWorker(async () => (await harness.start("unreachable-thrice")).result());

    expect(result.status).toBe("FAILED");
    expect(failureOf("run-unreachable-thrice")?.failureReason).toBe("PROVIDER_UNREACHABLE");
    expect(harness.implementCalls.filter((entry) => entry.runId === "run-unreachable-thrice")).toHaveLength(3);
    // One preparation for the Run, and one more for the fresh sandbox of the second retry.
    expect(preparesOf("run-unreachable-thrice")).toHaveLength(2);
    expect(harness.postedErrors.at(-1)).toContain("EAI_AGAIN");
    expect(harness.postedErrors.at(-1)).toContain("could not reach the model provider");
  });
});
