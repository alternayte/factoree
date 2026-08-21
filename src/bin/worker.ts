import { Worker } from "@temporalio/worker";
import { loadEnv } from "~/config/env.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createPrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaTenantRegistry } from "~/persistence/prisma/project-registry.prisma.js";
import { createLinearAgentClient } from "~/adapters/linear/linear-agent-client.js";
import { createActivities } from "~/activities/index.js";
import { createWorkerConnection } from "~/temporal/connection.js";
import { parseWorkflowId } from "~/temporal/workflow-id.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";

const env = loadEnv();
const redactor = new Redactor([env.ADMIN_API_TOKEN, env.LINEAR_WEBHOOK_SECRET, env.FACTOREE_SECRET_KEY]);
const logger = createLogger({ level: env.LOG_LEVEL, redactor });
const prisma = createPrismaClient(env.DATABASE_URL);
const tenants = new PrismaTenantRegistry(prisma, env.FACTOREE_SECRET_KEY);

// The Linear access token belongs to the workspace of the Run. The session id carries the
// workspace prefix in the workflow id, so the activity resolves the client for each call.
const agentSession: AgentSessionPort = {
  acknowledge: (sessionId, message) => call(sessionId, (client) => client.acknowledge(sessionId, message)),
  progress: (sessionId, message) => call(sessionId, (client) => client.progress(sessionId, message)),
  elicit: (sessionId, question) => call(sessionId, (client) => client.elicit(sessionId, question)),
  respond: (sessionId, body) => call(sessionId, (client) => client.respond(sessionId, body)),
  fail: (sessionId, message) => call(sessionId, (client) => client.fail(sessionId, message)),
};

async function call(
  sessionId: string,
  body: (client: ReturnType<typeof createLinearAgentClient>) => Promise<void>,
): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { linearAgentSessionId: sessionId },
    select: { temporalWorkflowId: true },
  });
  if (!run) throw new Error(`no workspace for agent session ${sessionId}`);
  const { workspaceId } = parseWorkflowId(run.temporalWorkflowId);
  const token = await tenants.getInstallationToken(workspaceId);
  if (!token) throw new Error(`no Linear installation for workspace ${workspaceId}`);
  await body(createLinearAgentClient(token));
}

const worker = await Worker.create({
  connection: await createWorkerConnection(env),
  namespace: env.TEMPORAL_NAMESPACE,
  taskQueue: env.TEMPORAL_TASK_QUEUE,
  workflowsPath: new URL("../workflows/agent-run.workflow.js", import.meta.url).pathname,
  activities: createActivities({ runs: new PrismaRunRepository(prisma), agentSession, logger }),
});

logger.info("worker started", { step: "boot" });
await worker.run();
