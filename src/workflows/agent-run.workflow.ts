import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type { RunStatus } from "~/domain/runs/run-status.js";
import type { Activities } from "~/activities/index.js";

export interface AgentRunWorkflowInput {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  linearIssueId: string | null;
  agentSessionId: string;
  autonomyLevel: string;
  maxRunMinutes: number;
}

export interface AgentRunWorkflowResult {
  runId: string;
  status: RunStatus;
}

export interface RunSnapshot {
  runId: string | null;
  status: RunStatus;
  humanInputs: string[];
}

export const stopSignal = defineSignal("stop");
export const humanInputSignal = defineSignal<[string]>("humanInput");
export const runStatusQuery = defineQuery<RunSnapshot>("runStatus");

const activities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, initialInterval: "1 second", backoffCoefficient: 2 },
});

export async function agentRunWorkflow(
  input: AgentRunWorkflowInput,
): Promise<AgentRunWorkflowResult> {
  let runId: string | null = null;
  let status: RunStatus = "RECEIVED";
  const humanInputs: string[] = [];
  let stopRequested = false;

  setHandler(stopSignal, () => {
    stopRequested = true;
  });
  setHandler(humanInputSignal, (body: string) => {
    humanInputs.push(body);
  });
  setHandler(runStatusQuery, () => ({ runId, status, humanInputs }));

  const created = await activities.createRun({
    tenantId: input.tenantId,
    projectId: input.projectId,
    linearIssueId: input.linearIssueId,
    linearAgentSessionId: input.agentSessionId,
    temporalWorkflowId: `linear:${input.workspaceId}:${input.agentSessionId}`,
    autonomyLevel: input.autonomyLevel,
  });
  runId = created.runId;

  await activities.acknowledgeSession({
    sessionId: input.agentSessionId,
    message: "Factoree accepted the work and started a Run.",
  });

  // The delivery pipeline of SDD section 49 is added by later phases. Until then the Run
  // stays open for a stop signal, for human input, or until the maximum Run duration ends it.
  status = "WAITING_FOR_INPUT";
  await activities.setRunStatus({ runId, status, startedAt: new Date(Date.now()).toISOString() });

  const stopped = await condition(() => stopRequested, input.maxRunMinutes * 60_000);

  if (!stopped) {
    status = "FAILED";
    await activities.postError({
      sessionId: input.agentSessionId,
      message: "Factoree stopped the Run because it reached the maximum Run duration.",
    });
    await activities.completeRun({
      runId,
      status,
      failureReason: "RUN_TIMEOUT",
      completedAt: new Date(Date.now()).toISOString(),
    });
    return { runId, status };
  }

  status = "CANCELLED";
  await activities.postFinalResponse({
    sessionId: input.agentSessionId,
    body: "Factoree stopped this Run at your request. No change was published.",
  });
  await activities.completeRun({
    runId,
    status,
    failureReason: "STOPPED_BY_HUMAN",
    completedAt: new Date(Date.now()).toISOString(),
  });
  return { runId, status };
}
