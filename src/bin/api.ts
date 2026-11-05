import { SkaelRegistry } from "~/adapters/skael/skael-registry.js";
import { PrismaRunViewReader } from "~/persistence/prisma/run-view.prisma.js";
import { fileURLToPath } from "node:url";
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
import {
  createBuildAheadRequester,
  createRepositorySetupStarter,
  createSyncInstallationStarter,
  createTemporalClient,
  createTemporalWorkflowStarter,
} from "~/temporal/connection.js";
import { BuildAheadTrigger } from "~/domain/runs/build-ahead.js";
import { PrismaWarmSnapshotStore } from "~/persistence/prisma/warm-snapshot.prisma.js";
import { buildServer } from "~/http/server.js";
import { LinearTokenProvider } from "~/domain/products/linear-token-provider.js";
import { TenantScopedLinearTeamLookup } from "~/adapters/linear/team-lookup-by-tenant.js";
import { createLinearAgentClient } from "~/adapters/linear/linear-agent-client.js";
import type { RefusalNotifier } from "~/domain/runs/delegation-service.js";
import { GitHubAppTokenProvider } from "~/adapters/github/app-token-provider.js";
import { GitHubRepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";
import { DiscoveryService } from "~/domain/products/discovery-service.js";
import { PrismaInstallSettingsStore } from "~/persistence/prisma/install-settings.prisma.js";
import { AuthHandle } from "~/http/auth/auth.js";
import { issueSetupToken } from "~/http/setup/setup-token.js";
import {
  convertGitHubAppManifest,
  readGitHubAppInstallation,
} from "~/adapters/github/app-manifest.js";
import {
  exchangeLinearCode,
  listLinearTeams,
  readLinearOrganization,
} from "~/adapters/linear/linear-app-flows.js";
import {
  githubApiBaseUrl,
  githubAppCredentials,
  githubBaseUrl,
  linearOAuthFromSettings,
  releaseVersion,
} from "./install-wiring.js";

const env = loadEnv();
// docs/specs/release-0-1-0.md. The credentials live in the database, so the master key is the one
// secret of the environment. A stored credential reaches the log only through a call that names
// it, and the logger redacts every value it is given here.
const redactor = new Redactor([env.FACTOREE_MASTER_KEY]);
const logger = createLogger({ level: env.FACTOREE_LOG_LEVEL, redactor });
const prisma = createPrismaClient(env.FACTOREE_DATABASE_URL);
const settings = new PrismaInstallSettingsStore(prisma, env.FACTOREE_MASTER_KEY, (value) => redactor.addSecret(value));
const tenants = new PrismaTenantRegistry(prisma, env.FACTOREE_MASTER_KEY);
const products = new PrismaProductRegistry(prisma);
const repositories = new PrismaRepositoryRegistry(prisma);
const secrets = new PrismaSecretStore(prisma, env.FACTOREE_MASTER_KEY);
const runs = new PrismaRunRepository(prisma);
const client = await createTemporalClient(env);

// A Linear access token lives for twenty-four hours. The provider refreshes it before it
// expires, with the client credentials the install settings hold at that moment.
const linearTokens = new LinearTokenProvider({
  tenants,
  oauth: linearOAuthFromSettings(settings),
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
  // docs/specs/run-recovery.md. A plain answer to a reply that starts no follow-up run.
  postResponse: async (workspaceId, sessionId, message) => {
    const linearClient = createLinearAgentClient(await linearTokens.tokenFor(workspaceId));
    await linearClient.respond(sessionId, message);
  },
};

const delegation = new DelegationService({
  tenants,
  products,
  repositories,
  webhookLog: new PrismaWebhookLog(prisma),
  starter: createTemporalWorkflowStarter(client, env.FACTOREE_TEMPORAL_TASK_QUEUE),
  refusalNotifier,
  // docs/specs/run-recovery.md. A reply after a failed run starts a follow-up run.
  sessionRuns: runs,
  runViews: new PrismaRunViewReader(prisma),
  logger,
  repositoryBaseUrl: githubBaseUrl(settings),
  productPageUrl: (productId) => `${env.FACTOREE_PUBLIC_URL.replace(/\/+$/, "")}/products/${productId}`,
});

// The Products administration route resolves a team key by tenant. `TenantScopedLinearTeamLookup`
// reads the workspace id of that tenant, then asks `linearTokens` for its access token.
const linearTeams = new TenantScopedLinearTeamLookup(
  { linearWorkspaceIdFor: async (tenantId) => (await prisma.tenant.findUnique({ where: { id: tenantId } }))?.linearWorkspaceId ?? null },
  linearTokens,
);

// Ruling 1 and ruling 2. One credential path to GitHub: every GitHub adapter mints its token
// through this one provider, and every mint carries only the scope its one operation needs.
const githubTokens = new GitHubAppTokenProvider({ credentials: githubAppCredentials(settings) });

// The GitHub webhook route reads and writes the same `.factoree/config.yaml` declaration
// `syncInstallationWorkflow` reads, through the same `DiscoveryService`.
const discoveryClient = new GitHubRepositoryDiscoveryClient({
  apiBaseUrl: githubApiBaseUrl(settings),
  tokens: githubTokens,
});
const discovery = new DiscoveryService(discoveryClient, products, repositories, linearTeams, logger);

const startInstallationSync = createSyncInstallationStarter(client, env.FACTOREE_TEMPORAL_TASK_QUEUE);
// docs/specs/run-speed.md. A changed bootstrap key requests a build-ahead of the warm snapshot.
const warmSnapshots = new PrismaWarmSnapshotStore(prisma);
const buildAhead = new BuildAheadTrigger({
  request: createBuildAheadRequester(client, env.FACTOREE_TEMPORAL_TASK_QUEUE),
  products,
  repositories,
  snapshotKeys: (tenantId, repositoryUrl) => warmSnapshots.keysFor(tenantId, repositoryUrl),
  readConfig: (fullName, ref, installationId) => discoveryClient.readConfig(fullName, ref, installationId),
  listFiles: (fullName, ref, installationId) => discoveryClient.listFiles(fullName, ref, installationId),
  repositoryBaseUrl: githubBaseUrl(settings),
  logger,
});

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
  // The issue shows the first session link only, so the preview also gets one short message.
  if (target.changed) await linearClient.respond(target.linearAgentSessionId, `Preview: ${input.previewUrl}`);
  logger.info("pull request preview linked", { run_id: target.runId, step: "preview_link" });
  return true;
};

const auth = new AuthHandle({ prisma, settings, publicUrl: env.FACTOREE_PUBLIC_URL, masterKey: env.FACTOREE_MASTER_KEY, logger });

const startRepositorySetup = createRepositorySetupStarter(client, env.FACTOREE_TEMPORAL_TASK_QUEUE);
const app = buildServer({
  repositorySetup: {
    listInstallationRepositories: (installationId) => discoveryClient.listInstallationRepositories(installationId),
    startSetup: startRepositorySetup,
  },
  env,
  version: releaseVersion(),
  logger,
  prisma,
  settings,
  auth,
  tenants,
  products,
  repositories,
  linearTeams,
  secrets,
  runs,
  delegation,
  discovery,
  startInstallationSync,
  buildAhead,
  temporalUiUrl: env.FACTOREE_TEMPORAL_UI_URL,
  // docs/specs/skill-registry.md. Skael is the one registry kind.
  checkSkillRegistry: (registry, key) => new SkaelRegistry({ url: registry.url, key, set: registry.set }).check(),
  recordPullRequestPreview,
  setup: {
    github: {
      convertManifest: (input) => convertGitHubAppManifest(input),
      readInstallation: (input) => readGitHubAppInstallation(input),
    },
    linear: {
      exchangeCode: (input) => exchangeLinearCode(input),
      readOrganization: (accessToken) => readLinearOrganization(accessToken),
      listTeams: async (linearWorkspaceId) => listLinearTeams(await linearTokens.tokenFor(linearWorkspaceId)),
    },
  },
  // dist/bin/api.js sits two levels below the repository root, beside ui/dist.
  uiRoot: fileURLToPath(new URL("../../ui/dist", import.meta.url)),
});
// docs/specs/release-0-1-0.md. Until setup ends, each start issues a new one-time setup token and
// names it once, in the log line below. Only its hash is stored.
const setupToken = await issueSetupToken(settings);
await app.listen({ port: env.FACTOREE_PORT, host: "0.0.0.0" });
logger.info("api started", { step: "boot", public_url: env.FACTOREE_PUBLIC_URL });
if (setupToken !== null) {
  logger.info(`setup is not complete. Open ${env.FACTOREE_PUBLIC_URL}/setup and enter the setup token ${setupToken}`, {
    step: "setup",
  });
}
