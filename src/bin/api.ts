import { loadEnv } from "~/config/env.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import { createPrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";
import {
  PrismaProductRegistry,
  PrismaRepositoryRegistry,
  PrismaSecretStore,
  PrismaTenantRegistry,
} from "~/persistence/prisma/product-registry.prisma.js";
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { createSyncInstallationStarter, createTemporalClient, createTemporalWorkflowStarter } from "~/temporal/connection.js";
import { buildServer } from "~/http/server.js";
import { LinearTokenProvider } from "~/domain/products/linear-token-provider.js";
import { createLinearOAuthClient } from "~/adapters/linear/linear-oauth.js";
import { TenantScopedLinearTeamLookup } from "~/adapters/linear/team-lookup-by-tenant.js";
import { createLinearAgentClient } from "~/adapters/linear/linear-agent-client.js";
import type { RefusalNotifier } from "~/domain/runs/delegation-service.js";
import { GitHubAppTokenProvider } from "~/adapters/github/app-token-provider.js";
import { GitHubRepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";
import { DiscoveryService } from "~/domain/products/discovery-service.js";
import { verifyGitHubSignature } from "~/adapters/github/webhook-verifier.js";

const env = loadEnv();
const redactor = new Redactor([
  env.ADMIN_API_TOKEN,
  env.LINEAR_WEBHOOK_SECRET,
  env.FACTOREE_SECRET_KEY,
  env.GITHUB_APP_PRIVATE_KEY,
  env.GITHUB_WEBHOOK_SECRET,
]);
const logger = createLogger({ level: env.LOG_LEVEL, redactor });
const prisma = createPrismaClient(env.DATABASE_URL);
const tenants = new PrismaTenantRegistry(prisma, env.FACTOREE_SECRET_KEY);
const products = new PrismaProductRegistry(prisma);
const repositories = new PrismaRepositoryRegistry(prisma);
const secrets = new PrismaSecretStore(prisma, env.FACTOREE_SECRET_KEY);
const runs = new PrismaRunRepository(prisma);
const client = await createTemporalClient(env);

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

// Specification section 9. A routing refusal must reach the human, not only Linear's delivery
// log. `DelegationService` posts the reason on the agent session that raised it. No Run row
// exists yet at that point, so the token resolves from the workspace id the webhook carried.
const refusalNotifier: RefusalNotifier = {
  postFailure: async (workspaceId, sessionId, message) => {
    const linearClient = createLinearAgentClient(await linearTokens.tokenFor(workspaceId));
    await linearClient.fail(sessionId, message);
  },
};

const delegation = new DelegationService({
  tenants,
  products,
  repositories,
  webhookLog: new PrismaWebhookLog(prisma),
  starter: createTemporalWorkflowStarter(client, env.TEMPORAL_TASK_QUEUE),
  refusalNotifier,
  logger,
  repositoryBaseUrl: env.GITHUB_BASE_URL,
});

// The Products administration route resolves a team key by tenant. `TenantScopedLinearTeamLookup`
// reads the workspace id of that tenant, then asks `linearTokens` for its access token.
const linearTeams = new TenantScopedLinearTeamLookup(
  { linearWorkspaceIdFor: async (tenantId) => (await prisma.tenant.findUnique({ where: { id: tenantId } }))?.linearWorkspaceId ?? null },
  linearTokens,
);

// Ruling 1 and ruling 2. One credential path to GitHub: every GitHub adapter mints its token
// through this one provider, and every mint carries only the scope its one operation needs.
const githubTokens = new GitHubAppTokenProvider({
  appId: env.GITHUB_APP_ID,
  privateKeyBase64: env.GITHUB_APP_PRIVATE_KEY,
  apiBaseUrl: env.GITHUB_API_BASE_URL,
});

// The GitHub webhook route reads and writes the same `.factoree/config.yaml` declaration
// `syncInstallationWorkflow` reads, through the same `DiscoveryService`.
const discoveryClient = new GitHubRepositoryDiscoveryClient({
  apiBaseUrl: env.GITHUB_API_BASE_URL,
  tokens: githubTokens,
});
const discovery = new DiscoveryService(discoveryClient, products, repositories, linearTeams, logger);

// Verifies the raw request body against the `X-Hub-Signature-256` header, before any parse.
const verifyGitHubWebhookSignature = (raw: Buffer, signature: string): boolean =>
  verifyGitHubSignature({ rawBody: raw, signature, secret: env.GITHUB_WEBHOOK_SECRET }).ok;

const startInstallationSync = createSyncInstallationStarter(client, env.TEMPORAL_TASK_QUEUE);

// docs/specs/proof-pack-and-visual-evidence.md. The Run is over when CI publishes the preview, so
// the link reaches the Linear session from here. The tenant row carries the workspace id.
const recordPullRequestPreview = async (input: {
  tenantId: string;
  repositoryFullName: string;
  commitSha: string;
  previewUrl: string;
}): Promise<boolean> => {
  const target = await runs.setPullRequestPreview(
    input.tenantId,
    input.repositoryFullName,
    input.commitSha,
    input.previewUrl,
  );
  if (target === null) return false;
  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId } });
  if (tenant === null) return false;
  const linearClient = createLinearAgentClient(await linearTokens.tokenFor(tenant.linearWorkspaceId));
  await linearClient.addLink(target.linearAgentSessionId, "Preview", input.previewUrl);
  logger.info("pull request preview linked", { run_id: target.runId, step: "preview_link" });
  return true;
};

const app = buildServer({
  env,
  logger,
  prisma,
  tenants,
  products,
  repositories,
  linearTeams,
  secrets,
  runs,
  delegation,
  discovery,
  verifyGitHubSignature: verifyGitHubWebhookSignature,
  startInstallationSync,
  recordPullRequestPreview,
});
await app.listen({ port: env.PORT, host: "0.0.0.0" });
logger.info("api started", { step: "boot" });
