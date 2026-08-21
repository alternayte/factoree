import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type { RunStatus } from "~/domain/runs/run-status.js";
import type { Activities } from "~/activities/index.js";
import { buildWorkflowId } from "../temporal/workflow-id.js";

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
    temporalWorkflowId: buildWorkflowId(input.workspaceId, input.agentSessionId),
    autonomyLevel: input.autonomyLevel,
  });
  runId = created.runId;

  try {
    await activities.acknowledgeSession({
      sessionId: input.agentSessionId,
      message: "Factoree accepted the work and started a Run.",
    });

    // The delivery pipeline of SDD section 49 is added by later phases. Until then the Run
    // stays open for a stop signal, for human input, or until the maximum Run duration ends it.
    status = "RECEIVED";
    await activities.setRunStatus({ runId, status, startedAt: new Date(Date.now()).toISOString() });

    const stopped = await condition(() => stopRequested, input.maxRunMinutes * 60_000);

    if (!stopped) {
      status = "FAILED";
      // Write the durable terminal state first. A Linear outage must not leave the Run open.
      await activities.completeRun({
        tenantId: input.tenantId,
        runId,
        status,
        failureReason: "RUN_TIMEOUT",
        completedAt: new Date(Date.now()).toISOString(),
      });
      await notify(() =>
        activities.postError({
          sessionId: input.agentSessionId,
          message: "Factoree stopped the Run because it reached the maximum Run duration.",
        }),
      );
      return { runId, status };
    }

    status = "CANCELLED";
    await activities.completeRun({
      tenantId: input.tenantId,
      runId,
      status,
      failureReason: "STOPPED_BY_HUMAN",
      completedAt: new Date(Date.now()).toISOString(),
    });
    await notify(() =>
      activities.postFinalResponse({
        sessionId: input.agentSessionId,
        body: "Factoree stopped this Run at your request. No change was published.",
      }),
    );
    return { runId, status };
  } catch (error) {
    // Any unhandled activity failure must still drive the Run to a terminal state.
    status = "FAILED";
    await activities.completeRun({
      tenantId: input.tenantId,
      runId,
      status,
      failureReason: "INTERNAL_ERROR",
      completedAt: new Date(Date.now()).toISOString(),
    });
    throw error;
  }
}

// A Linear notification failure must not abort the workflow after the durable state is written.
const notify = async (send: () => Promise<void>): Promise<void> => {
  try {
    await send();
  } catch {
    // The Run is already terminal in the database. The Linear post is best effort.
  }
};
