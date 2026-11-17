/* eslint-disable @typescript-eslint/require-await -- the fake run returns at once */
/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 4. The PR workflow beside a fake `agentRunWorkflow`,
 * so a test sees which runs the PR workflow starts and what it does with their results. A
 * bring-current run reports a conflict, and every other run ends READY_FOR_HUMAN.
 */
import type { AgentRunWorkflowInput, AgentRunWorkflowResult } from "../../../src/workflows/agent-run.workflow.js";

export { pullRequestWorkflow } from "../../../src/workflows/pr.workflow.js";

export async function agentRunWorkflow(input: AgentRunWorkflowInput): Promise<AgentRunWorkflowResult> {
  if (input.bringCurrent !== undefined) {
    return { runId: "bring-current", status: "REPORTED", bringCurrent: { kind: "conflict", baseSha: "base-2", conflicts: ["a.ts"] } };
  }
  return { runId: "follow-up", status: "READY_FOR_HUMAN" };
}
