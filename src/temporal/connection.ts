import {
  Connection,
  Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import type { Env } from "~/config/env.js";
import { agentRunWorkflow, humanInputSignal, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildSyncInstallationWorkflowId, syncInstallationWorkflow } from "~/workflows/sync-installation.workflow.js";
import type { WorkflowStarter } from "~/domain/runs/delegation-service.js";
import { buildAheadWorkflowId, type RequestBuildAhead } from "~/domain/runs/build-ahead.js";
import { buildAheadSignal, buildAheadWorkflow } from "~/workflows/build-ahead.workflow.js";

const tlsOptions = (env: Env) => (env.FACTOREE_TEMPORAL_API_KEY === undefined ? {} : { tls: true, apiKey: env.FACTOREE_TEMPORAL_API_KEY });

export const createTemporalClient = async (env: Env): Promise<Client> => {
  const connection = await Connection.connect({ address: env.FACTOREE_TEMPORAL_ADDRESS, ...tlsOptions(env) });
  return new Client({ connection, namespace: env.FACTOREE_TEMPORAL_NAMESPACE });
};

export const createWorkerConnection = async (env: Env): Promise<NativeConnection> =>
  NativeConnection.connect({ address: env.FACTOREE_TEMPORAL_ADDRESS, ...tlsOptions(env) });

// A signal for a workflow that is not running is a normal outcome, not a request failure.
// The Run already ended, or the stop arrived before the start.
const signalIfRunning = async (send: () => Promise<void>): Promise<boolean> => {
  try {
    await send();
    return true;
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return false;
    throw error;
  }
};

export const createTemporalWorkflowStarter = (client: Client, taskQueue: string): WorkflowStarter => ({
  async start(input) {
    try {
      await client.workflow.start(agentRunWorkflow, {
        taskQueue,
        workflowId: input.workflowId,
        args: input.args,
      });
    } catch (error) {
      // A repeated delivery that passed the database check must not create a second Run.
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
  },
  async signalStop(workflowId) {
    return signalIfRunning(() => client.workflow.getHandle(workflowId).signal(stopSignal));
  },
  async signalHumanInput(workflowId, body) {
    return signalIfRunning(() => client.workflow.getHandle(workflowId).signal(humanInputSignal, body));
  },
});

/**
 * Starts `syncInstallationWorkflow`, keyed on the installation id. A repeated `installation`
 * webhook joins the run already in flight rather than start a second one.
 */
export const createSyncInstallationStarter =
  (client: Client, taskQueue: string) =>
  async (input: { tenantId: string; githubInstallationId: string }): Promise<void> => {
    try {
      await client.workflow.start(syncInstallationWorkflow, {
        taskQueue,
        workflowId: buildSyncInstallationWorkflowId(input.githubInstallationId),
        args: [{ tenantId: input.tenantId, githubInstallationId: input.githubInstallationId }],
      });
    } catch (error) {
      // A repeated delivery must join the running sync, not fail the webhook.
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
  };

/**
 * docs/specs/run-speed.md. Requests one build-ahead of a repository. Signal-with-start starts the
 * workflow of the repository, or reaches the one that runs, which then builds once more.
 */
export const createBuildAheadRequester =
  (client: Client, taskQueue: string): RequestBuildAhead =>
  async (request) => {
    await client.workflow.signalWithStart(buildAheadWorkflow, {
      taskQueue,
      workflowId: buildAheadWorkflowId(request.tenantId, request.repositoryFullName),
      args: [request],
      signal: buildAheadSignal,
      signalArgs: [],
    });
  };
