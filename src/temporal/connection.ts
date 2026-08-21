import { Connection, Client } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import type { Env } from "~/config/env.js";

const tlsOptions = (env: Env) => (env.TEMPORAL_API_KEY === undefined ? {} : { tls: true, apiKey: env.TEMPORAL_API_KEY });

export const createTemporalClient = async (env: Env): Promise<Client> => {
  const connection = await Connection.connect({ address: env.TEMPORAL_ADDRESS, ...tlsOptions(env) });
  return new Client({ connection, namespace: env.TEMPORAL_NAMESPACE });
};

export const createWorkerConnection = async (env: Env): Promise<NativeConnection> =>
  NativeConnection.connect({ address: env.TEMPORAL_ADDRESS, ...tlsOptions(env) });
