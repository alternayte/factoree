import { loadEnv } from "~/config/env.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import { createPrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";
import { PrismaProjectRegistry, PrismaTenantRegistry } from "~/persistence/prisma/project-registry.prisma.js";
import {
  PrismaProductRegistry,
  PrismaRepositoryRegistry,
  PrismaSecretStore,
} from "~/persistence/prisma/product-registry.prisma.js";
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { createTemporalClient, createTemporalWorkflowStarter } from "~/temporal/connection.js";
import { buildServer } from "~/http/server.js";
import { createLinearTeamLookup } from "~/adapters/linear/team-lookup.js";
import type { LinearTeamLookup } from "~/adapters/linear/team-lookup.js";
import { LinearTokenProvider } from "~/domain/projects/linear-token-provider.js";
import { createLinearOAuthClient } from "~/adapters/linear/linear-oauth.js";

const env = loadEnv();
const redactor = new Redactor([env.ADMIN_API_TOKEN, env.LINEAR_WEBHOOK_SECRET, env.FACTOREE_SECRET_KEY]);
const logger = createLogger({ level: env.LOG_LEVEL, redactor });
const prisma = createPrismaClient(env.DATABASE_URL);
const tenants = new PrismaTenantRegistry(prisma, env.FACTOREE_SECRET_KEY);
const projects = new PrismaProjectRegistry(prisma);
const products = new PrismaProductRegistry(prisma);
const repositories = new PrismaRepositoryRegistry(prisma);
const secrets = new PrismaSecretStore(prisma, env.FACTOREE_SECRET_KEY);
const runs = new PrismaRunRepository(prisma);
const client = await createTemporalClient(env);

const delegation = new DelegationService({
  tenants,
  products,
  repositories,
  webhookLog: new PrismaWebhookLog(prisma),
  starter: createTemporalWorkflowStarter(client, env.TEMPORAL_TASK_QUEUE),
  logger,
  repositoryBaseUrl: env.GITHUB_BASE_URL,
});

// A Linear access token lives for twenty-four hours. The provider refreshes it before it
// expires. Without the client credentials the provider can only report the expiry. The route
// then surfaces that failure to the operator, rather than a resolved team key.
const linearTokens = new LinearTokenProvider({
  tenants,
  oauth:
    env.LINEAR_CLIENT_ID === undefined || env.LINEAR_CLIENT_SECRET === undefined
      ? null
      : createLinearOAuthClient({ clientId: env.LINEAR_CLIENT_ID, clientSecret: env.LINEAR_CLIENT_SECRET }),
  logger,
});

// The Products administration route resolves a team key by tenant. A tenant id does not carry
// its Linear workspace id. This reads the tenant row once, then builds a client with the token
// of that workspace. `LinearTeamLookupClient` holds one token per instance, so a fresh instance
// serves each call.
const linearTeams: LinearTeamLookup = {
  async resolveTeamKey(tenantId, teamKey) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const token = await linearTokens.tokenFor(tenant.linearWorkspaceId);
    return createLinearTeamLookup(token).resolveTeamKey(tenantId, teamKey);
  },
  async resolveTeamId(tenantId, teamId) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const token = await linearTokens.tokenFor(tenant.linearWorkspaceId);
    return createLinearTeamLookup(token).resolveTeamId(tenantId, teamId);
  },
};

const app = buildServer({
  env,
  logger,
  prisma,
  projects,
  tenants,
  products,
  repositories,
  linearTeams,
  secrets,
  runs,
  delegation,
});
await app.listen({ port: env.PORT, host: "0.0.0.0" });
logger.info("api started", { step: "boot" });
