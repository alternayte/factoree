import { defineQuery, defineSignal, setHandler, workflowInfo } from "@temporalio/workflow";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import { readStopRequest, type StopRequest } from "../domain/runs/run-stop.js";
import { activities } from "./agent-run/activities.js";
import { Run, RunControl, RunEnded } from "./agent-run/run.js";
import { bringCurrentEnding, bringCurrentGreeting, bringCurrentRun } from "./agent-run/stories/bring-current-run.js";
import { NEW_RUN_GREETING, newRun, newRunEnding } from "./agent-run/stories/new-run.js";
import { humanReviewInput, prFollowUpEnding, prFollowUpGreeting, prFollowUpRun } from "./agent-run/stories/pr-follow-up-run.js";
import type { AgentRunWorkflowInput, AgentRunWorkflowResult, RunSnapshot } from "./agent-run/types.js";

// The worker registers every function this module exports as a workflow type, so it exports the
// run workflow, its signals, its query and its types only.
export type {
  AgentRunProductInput,
  AgentRunProductRepositoryInput,
  AgentRunWorkItemInput,
  AgentRunWorkflowInput,
  AgentRunWorkflowResult,
  DeployFailureInput,
  RunSnapshot,
} from "./agent-run/types.js";
export { MAX_QUESTION_ROUNDS } from "./agent-run/run.js";

/**
 * SDD section 50, issue #45. The payload names where the stop came from. It is optional, so a
 * signal with no argument, from an older client or the Temporal CLI, still stops the Run and
 * reads as a Linear stop (DI-21.64).
 */
export const stopSignal = defineSignal<[StopRequest?]>("stop");
export const humanInputSignal = defineSignal<[string]>("humanInput");
export const runStatusQuery = defineQuery<RunSnapshot>("runStatus");

/**
 * SDD section 48. One run of one work item. The workflow type stays `agentRunWorkflow` for every
 * kind of run, because the PR workflow starts its children by this name and an open run must
 * replay (docs/specs/run-workflow-structure.md). It dispatches once, on its input, to the story of
 * its kind: a new run, a PR follow-up run or a bring-current run.
 */
export async function agentRunWorkflow(input: AgentRunWorkflowInput): Promise<AgentRunWorkflowResult> {
  const control = new RunControl();
  const prFollowUp = input.prFollowUp ?? null;
  const bringCurrent = input.bringCurrent ?? null;
  const review = prFollowUp === null ? null : humanReviewInput(prFollowUp);
  if (review !== null) control.humanInputs.push(review);
  setHandler(stopSignal, (request?: StopRequest) => {
    if (!control.stopRequested) control.stopRequest = readStopRequest(request);
    control.stopRequested = true;
  });
  setHandler(humanInputSignal, (body: string) => {
    control.humanInputs.push(body);
  });
  setHandler(runStatusQuery, () => control.snapshot());

  const created = await activities.createRun({
    tenantId: input.tenantId,
    productId: input.productId,
    linearIssueId: input.linearIssueId,
    linearAgentSessionId: input.agentSessionId,
    // docs/specs/run-recovery.md. A follow-up run shares the agent session and has its own workflow id.
    temporalWorkflowId: workflowInfo().workflowId,
    autonomyLevel: input.autonomyLevel,
    workItemTitle: input.workItem.title,
    workItemUrl: input.workItem.url,
    ...(input.followUpOfRunId === undefined ? {} : { followUpOfRunId: input.followUpOfRunId }),
    ...(input.followUpReply === undefined ? {} : { followUpReply: input.followUpReply }),
  });
  control.runId = created.runId;
  // docs/specs/blocked-by-wait.md. A stop cancelled the waiting run before this workflow started.
  if (created.ended === true) {
    control.status = created.status ?? "CANCELLED";
    return { runId: created.runId, status: control.status };
  }

  const ending = bringCurrent !== null ? bringCurrentEnding(bringCurrent) : prFollowUp !== null ? prFollowUpEnding(prFollowUp) : newRunEnding;
  // The Run budget starts here, so every later step and wait consumes it.
  const run = new Run(created.runId, input, control, ending);
  try {
    await activities.acknowledgeSession({
      sessionId: input.agentSessionId,
      message: bringCurrent !== null ? bringCurrentGreeting(bringCurrent) : prFollowUp !== null ? prFollowUpGreeting(prFollowUp) : NEW_RUN_GREETING,
    });
    await run.enter("RECEIVED", { startedAt: new Date(Date.now()).toISOString() });
    if (bringCurrent !== null) return await bringCurrentRun(run, bringCurrent);
    if (prFollowUp !== null) return await prFollowUpRun(run, prFollowUp);
    return await newRun(run);
  } catch (error) {
    if (error instanceof RunEnded) return error.result;
    return await run.failInternally(error);
  }
}
