import { loadEnv } from "~/config/env.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import { createPrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";
import {
  PrismaProjectRegistry,
  PrismaSecretStore,
  PrismaTenantRegistry,
} from "~/persistence/prisma/project-registry.prisma.js";
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { createTemporalClient, createTemporalWorkflowStarter } from "~/temporal/connection.js";
import { buildServer } from "~/http/server.js";

const env = loadEnv();
const redactor = new Redactor([env.ADMIN_API_TOKEN, env.LINEAR_WEBHOOK_SECRET, env.FACTOREE_SECRET_KEY]);
const logger = createLogger({ level: env.LOG_LEVEL, redactor });
const prisma = createPrismaClient(env.DATABASE_URL);
const tenants = new PrismaTenantRegistry(prisma, env.FACTOREE_SECRET_KEY);
const projects = new PrismaProjectRegistry(prisma);
const secrets = new PrismaSecretStore(prisma, env.FACTOREE_SECRET_KEY);
const runs = new PrismaRunRepository(prisma);
const client = await createTemporalClient(env);

const delegation = new DelegationService({
  tenants,
  projects,
  webhookLog: new PrismaWebhookLog(prisma),
  starter: createTemporalWorkflowStarter(client, env.TEMPORAL_TASK_QUEUE),
  logger,
  repositoryBaseUrl: env.GITHUB_BASE_URL,
});

const app = buildServer({ env, logger, prisma, projects, tenants, secrets, runs, delegation });
await app.listen({ port: env.PORT, host: "0.0.0.0" });
logger.info("api started", { step: "boot" });
