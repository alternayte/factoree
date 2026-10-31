import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunWorkflow } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { createWorkflowHarness } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const { completions, baseMoves, publishCalls, proofPackCalls, input, runWorker } = harness;

/** The SHA the target branch moved to while the Run worked. */
const MOVED_SHA = "9".repeat(40);

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

const startRun = async (sessionId: string) =>
  environment.client.workflow.start(agentRunWorkflow, {
    taskQueue: "test",
    workflowId: buildWorkflowId("workspace-123", sessionId),
    args: [input(sessionId)],
  });

/**
 * AT-28, amended by docs/specs/own-proposals-and-parallel-runs.md. A target branch that moved after
 * the Run started no longer stops it. Factoree publishes on the verified base, and the proof pack
 * states the move and any conflict, so parallel Runs never block each other.
 */
describe("AT-28 — a moved target branch still publishes", () => {
  it("reaches READY_FOR_HUMAN with a pull request, and hands the move to the proof pack", async () => {
    const runId = "run-ses-at28";
    const move = { headSha: MOVED_SHA, ahead: 3, conflicts: ["src/app.ts"] };
    baseMoves.set(runId, move);

    const result = await runWorker(async () => (await startRun("ses-at28")).result());

    expect(result.status).toBe("READY_FOR_HUMAN");
    expect(completions.filter((entry) => entry.runId === runId).at(-1)?.status).toBe("READY_FOR_HUMAN");
    expect(publishCalls.filter((entry) => entry.runId === runId)).toHaveLength(1);
    expect(proofPackCalls.find((entry) => entry.runId === runId)?.baseMove).toEqual({ baseBranch: "main", ...move });
  });
});
