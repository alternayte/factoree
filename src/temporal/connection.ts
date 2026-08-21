import {
  Connection,
  Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import type { Env } from "~/config/env.js";
import { agentRunWorkflow, humanInputSignal, stopSignal } from "~/workflows/agent-run.workflow.js";
import type { WorkflowStarter } from "~/domain/runs/delegation-service.js";

const tlsOptions = (env: Env) => (env.TEMPORAL_API_KEY === undefined ? {} : { tls: true, apiKey: env.TEMPORAL_API_KEY });

export const createTemporalClient = async (env: Env): Promise<Client> => {
  const connection = await Connection.connect({ address: env.TEMPORAL_ADDRESS, ...tlsOptions(env) });
  return new Client({ connection, namespace: env.TEMPORAL_NAMESPACE });
};

export const createWorkerConnection = async (env: Env): Promise<NativeConnection> =>
  NativeConnection.connect({ address: env.TEMPORAL_ADDRESS, ...tlsOptions(env) });

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
