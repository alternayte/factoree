import {
  ActivityCancellationType,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { RunStatus } from "~/domain/runs/run-status.js";
import type { Activities } from "~/activities/index.js";
import type { PrepareSandboxActivityOutput } from "~/activities/sandbox.activities.js";
import type { ImplementActivityOutput } from "~/activities/agent.activities.js";
import type { AgentSessionRef } from "~/domain/runs/agent-runner.js";
import type { ProjectRuntimeConfig } from "~/domain/runs/project-runtime-config.js";
import { buildWorkflowId } from "../temporal/workflow-id.js";

export interface AgentRunSandboxInput {
  primary: { url: string; ref: string };
  references: Array<{ url: string; ref: string }>;
  config: ProjectRuntimeConfig;
  goal: string;
  repositoryInstructions: string;
}

export interface AgentRunWorkflowInput {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  linearIssueId: string | null;
  agentSessionId: string;
  autonomyLevel: string;
  maxRunMinutes: number;
  /** Phase 2. Without this value the workflow keeps the Phase 1 behaviour. */
  sandbox?: AgentRunSandboxInput;
}

export interface AgentRunWorkflowResult {
  runId: string;
  status: RunStatus;
}

export interface RunSnapshot {
  runId: string | null;
  status: RunStatus;
  humanInputs: string[];
  spriteId: string | null;
}

export const stopSignal = defineSignal("stop");
export const humanInputSignal = defineSignal<[string]>("humanInput");
export const runStatusQuery = defineQuery<RunSnapshot>("runStatus");

const activities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, initialInterval: "1 second", backoffCoefficient: 2 },
});

// Preparation clones every repository and runs the bootstrap command, so it takes minutes.
const sandboxActivities = proxyActivities<Activities>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 3, initialInterval: "5 seconds", backoffCoefficient: 2 },
});

/**
 * The margin the Implementer activity keeps after the Run budget ends. It covers the
 * cancellation of the agent process and the write of the AgentExecution row.
 */
const IMPLEMENT_MARGIN_MS = 5 * 60_000;

/** The interval between two heartbeats of the Implementer activity. */
const IMPLEMENT_HEARTBEAT_TIMEOUT_MS = 120_000;

/**
 * The Implementer activity is bounded by the remaining Run budget, not by a fixed timeout, so
 * the maximum Run duration really bounds the Run. The activity heartbeats, so Temporal can
 * deliver a cancellation to it. SDD section 49: a semantic failure must not consume the
 * infrastructure retry policy. The Implementer reports a failed attempt as a result, so one
 * attempt is correct here.
 */
const buildImplementActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${budgetMs + IMPLEMENT_MARGIN_MS} milliseconds`,
    heartbeatTimeout: `${IMPLEMENT_HEARTBEAT_TIMEOUT_MS} milliseconds`,
    // The workflow waits for the cancelled activity, so the evidence the agent already produced
    // still reaches the AgentExecution row.
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
  });

// The cancellation of a live Implementer session runs after the Run budget has ended, so it
// needs its own short timeout.
const cancelActivities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3, initialInterval: "1 second", backoffCoefficient: 2 },
});

// The first Implementer attempt of a Run. A later repair loop attempt increments this value, so
// each attempt writes its own AgentExecution row.
const FIRST_IMPLEMENTER_ATTEMPT = 1;

export async function agentRunWorkflow(
  input: AgentRunWorkflowInput,
): Promise<AgentRunWorkflowResult> {
  let runId: string | null = null;
  let status: RunStatus = "RECEIVED";
  const humanInputs: string[] = [];
  let stopRequested = false;
  let sprite: PrepareSandboxActivityOutput | null = null;
  let implementerSession: AgentSessionRef | null = null;

  setHandler(stopSignal, () => {
    stopRequested = true;
  });
  setHandler(humanInputSignal, (body: string) => {
    humanInputs.push(body);
  });
  setHandler(runStatusQuery, () => ({
    runId,
    status,
    humanInputs,
    spriteId: sprite?.spriteId ?? null,
  }));

  const created = await activities.createRun({
    tenantId: input.tenantId,
    projectId: input.projectId,
    linearIssueId: input.linearIssueId,
    linearAgentSessionId: input.agentSessionId,
    temporalWorkflowId: buildWorkflowId(input.workspaceId, input.agentSessionId),
    autonomyLevel: input.autonomyLevel,
  });
  runId = created.runId;
  // A const holds the identifier, because narrowing of a let does not survive into a closure.
  const id = created.runId;

  // The Run budget starts here. Every later step reads the remaining time from this deadline, so
  // preparation and implementation consume the same budget as the wait does.
  const deadline = Date.now() + input.maxRunMinutes * 60_000;
  const remainingMs = (): number => Math.max(0, deadline - Date.now());

  const failRun = async (
    failureReason: "RUN_TIMEOUT" | "IMPLEMENTATION_FAILED",
    message: string,
  ): Promise<AgentRunWorkflowResult> => {
    status = "FAILED";
    // Write the durable terminal state first. A Linear outage must not leave the Run open.
    await activities.completeRun({
      tenantId: input.tenantId,
      runId: id,
      status,
      failureReason,
      completedAt: new Date(Date.now()).toISOString(),
    });
    await notify(() => activities.postError({ sessionId: input.agentSessionId, message }));
    return { runId: id, status };
  };

  const timeoutMessage = "Factoree stopped the Run because it reached the maximum Run duration.";

  // SDD section 50: a stop must terminate the active agent process, and no change is published.
  const cancelRun = async (): Promise<AgentRunWorkflowResult> => {
    const session = implementerSession;
    if (session !== null) {
      await notify(() =>
        cancelActivities.cancelImplementer({ runnerName: session.runner, session }),
      );
    }
    status = "CANCELLED";
    await activities.completeRun({
      tenantId: input.tenantId,
      runId: id,
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
    return { runId: id, status };
  };

  try {
    await activities.acknowledgeSession({
      sessionId: input.agentSessionId,
      message: "Factoree accepted the work and started a Run.",
    });

    status = "RECEIVED";
    await activities.setRunStatus({ runId: id, status, startedAt: new Date(Date.now()).toISOString() });

    const sandbox = input.sandbox;
    if (sandbox !== undefined) {
      status = "PREPARING";
      await activities.setRunStatus({ runId: id, status });

      // SDD section 32. The sandbox stays after the Run ends. `SpriteReaper` deletes it once the
      // retention window of SDD section 51 has passed.
      // A const holds the prepared sandbox, because narrowing of a let does not survive into a
      // closure.
      const preparedSandbox = await sandboxActivities.prepareSandbox({
        runId: id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        primary: sandbox.primary,
        references: sandbox.references,
        config: sandbox.config,
        environment: {},
      });
      sprite = preparedSandbox;

      // A stop that arrived during preparation must prevent the Implementer from starting.
      if (stopRequested) return await cancelRun();
      // Preparation can consume the whole budget. The Run must end here rather than start work
      // it cannot finish.
      if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

      status = "IMPLEMENTING";
      await activities.setRunStatus({ runId: id, status });

      const budgetMs = remainingMs();
      const implementActivities = buildImplementActivities(budgetMs);
      const scope = new CancellationScope({ cancellable: true });
      const running = scope.run(() =>
        implementActivities.implement({
          runId: id,
          tenantId: input.tenantId,
          projectId: input.projectId,
          runnerName: sandbox.config.implementerRunner,
          spriteId: preparedSandbox.spriteId,
          adapter: preparedSandbox.adapter,
          workspacePath: preparedSandbox.workspacePath,
          primaryPath: preparedSandbox.primaryPath,
          referencePaths: preparedSandbox.referencePaths,
          goal: sandbox.goal,
          humanDecisions: humanInputs,
          repositoryInstructions: sandbox.repositoryInstructions,
          repairFindings: [],
          stagingRead: sandbox.config.stagingRead,
          timeoutMs: budgetMs,
          attempt: FIRST_IMPLEMENTER_ATTEMPT,
        }),
      );
      // SDD section 50: a stop must reach the running agent process. The scope cancellation
      // travels to the activity, and the activity stops the live session.
      const watching = scope
        .run(() => condition(() => stopRequested))
        .then(() => {
          scope.cancel();
        })
        .catch(() => undefined);

      let implementation: ImplementActivityOutput | null = null;
      try {
        implementation = await running;
      } catch (error) {
        // A cancelled Implementer is the stop path, not a fault. Every other error stays a fault.
        if (!isCancellation(error)) throw error;
      } finally {
        scope.cancel();
        await watching;
      }

      if (implementation !== null) {
        implementerSession = {
          sessionId: implementation.sessionId,
          processId: implementation.processId,
          runner: implementation.runner,
        };
      }

      // A stop that arrived while the Implementer ran must end the Run here.
      if (stopRequested) return await cancelRun();

      // SDD section 49: a semantic outcome drives a workflow decision. A failed attempt must not
      // fall into the wait and become a timeout.
      if (implementation === null || !implementation.completed) {
        return await failRun(
          "IMPLEMENTATION_FAILED",
          "The Implementer did not complete the change. Factoree ended the Run.",
        );
      }
    }

    // The delivery pipeline of SDD section 49 is added by later phases. Until then the Run
    // stays open for a stop signal, for human input, or until the Run budget ends it.
    const stopped = await condition(() => stopRequested, remainingMs());

    if (!stopped) return await failRun("RUN_TIMEOUT", timeoutMessage);

    return await cancelRun();
  } catch (error) {
    // Any unhandled activity failure must still drive the Run to a terminal state.
    status = "FAILED";
    await activities.completeRun({
      tenantId: input.tenantId,
      runId: id,
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
