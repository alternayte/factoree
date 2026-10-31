import { Worker } from "@temporalio/worker";
import { loadEnv } from "~/config/env.js";
import { createLogger } from "~/telemetry/logger.js";
import { metrics } from "~/telemetry/metrics.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createPrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import {
  PrismaSecretStore,
  PrismaTenantRegistry,
  PrismaProductRegistry,
  PrismaRepositoryRegistry,
} from "~/persistence/prisma/product-registry.prisma.js";
import { PrismaAgentExecutionRepository } from "~/persistence/prisma/agent-execution.prisma.js";
import { PrismaAgentSessionStore } from "~/persistence/prisma/agent-session.prisma.js";
import { PrismaEvidenceStore } from "~/persistence/prisma/evidence.prisma.js";
import { PrismaValidationResultStore } from "~/persistence/prisma/validation-result.prisma.js";
import { PrismaReviewFindingStore } from "~/persistence/prisma/review-finding.prisma.js";
import { PlaywrightBrowserDriver } from "~/adapters/browser/playwright/playwright-browser-driver.js";
import { createEvidenceStorage } from "~/adapters/evidence/evidence-storage-factory.js";
import { createLinearFileUploadApi } from "~/adapters/linear/linear-evidence-storage.js";
import type { HttpValidationFetch } from "~/domain/validation/http-validation.js";
import type { ReadinessProbe } from "~/domain/runs/preview.js";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { FlySpriteSandbox } from "~/adapters/sandbox/fly-sprites/fly-sprite-sandbox.js";
import { createSpritesGateway } from "~/adapters/sandbox/fly-sprites/sprites-client.js";
import { KilnClient } from "~/adapters/sandbox/kiln/kiln-client.js";
import { KILN_RUNNER_BIN, KilnSandbox } from "~/adapters/sandbox/kiln/kiln-sandbox.js";
import { PrismaWarmSnapshotStore } from "~/persistence/prisma/warm-snapshot.prisma.js";
import { buildAgentRunnerRegistry } from "~/adapters/runners/registry.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { SpriteReaper } from "~/domain/runs/sprite-reaper.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import { createLinearAgentClient } from "~/adapters/linear/linear-agent-client.js";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { GitHubPullRequests } from "~/adapters/github/github-pull-requests.js";
import { GitHubAppTokenProvider } from "~/adapters/github/app-token-provider.js";
import { RefinementEngine } from "~/domain/refinement/refinement-engine.js";
import { ContextResolver } from "~/domain/context/context-resolver.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import { BackstageContextSource } from "~/domain/context/backstage-source.js";
import { BackstageCatalogClient } from "~/adapters/backstage/backstage-catalog-client.js";
import { McpContextSource } from "~/domain/context/mcp-source.js";
import { McpJsonRpcClient } from "~/adapters/mcp/mcp-json-rpc-client.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import type {
  BackstageSourceSettings,
  McpSourceSettings,
} from "~/domain/context/context-source-configuration.js";
import { ConfiguredContextSourceProvider } from "~/domain/context/context-source-provider.js";
import type { ContextSourceSecretReader } from "~/domain/context/context-source-provider.js";
import { PrismaContextContractStore } from "~/persistence/prisma/context-contract.prisma.js";
import { PrismaValidationContractStore } from "~/persistence/prisma/validation-contract.prisma.js";
import { PrismaContextSourceConfigurationStore } from "~/persistence/prisma/context-source-configuration.prisma.js";
import { createActivities } from "~/activities/index.js";
import { createWorkerConnection } from "~/temporal/connection.js";
import { parseWorkflowId } from "~/temporal/workflow-id.js";
import type { AgentSessionPort, WorkItemPort } from "~/domain/runs/ports.js";
import { LinearTokenProvider } from "~/domain/products/linear-token-provider.js";
import { createLinearOAuthClient } from "~/adapters/linear/linear-oauth.js";
import { GitHubRepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";
import { TenantScopedLinearTeamLookup } from "~/adapters/linear/team-lookup-by-tenant.js";
import { DiscoveryService } from "~/domain/products/discovery-service.js";

const env = loadEnv();
const redactor = new Redactor([
  env.ADMIN_API_TOKEN,
  env.LINEAR_WEBHOOK_SECRET,
  env.FACTOREE_SECRET_KEY,
  env.GITHUB_APP_PRIVATE_KEY,
  env.GITHUB_WEBHOOK_SECRET,
  ...(env.KILN_API_KEY === undefined ? [] : [env.KILN_API_KEY]),
  ...(env.KILN_REGISTRY_TOKEN === undefined ? [] : [env.KILN_REGISTRY_TOKEN]),
]);
const logger = createLogger({ level: env.LOG_LEVEL, redactor });
const prisma = createPrismaClient(env.DATABASE_URL);
const tenants = new PrismaTenantRegistry(prisma, env.FACTOREE_SECRET_KEY);
const products = new PrismaProductRegistry(prisma);
const repositories = new PrismaRepositoryRegistry(prisma);

// A Linear access token lives for twenty-four hours. The provider refreshes it before it expires
// and writes the new pair back, so a worker that runs for weeks needs no daily hand-over. Without
// the client credentials it can only report the expiry, so the operator learns what to configure.
const linearTokens = new LinearTokenProvider({
  tenants,
  oauth:
    env.LINEAR_CLIENT_ID === undefined || env.LINEAR_CLIENT_SECRET === undefined
      ? null
      : createLinearOAuthClient({
          clientId: env.LINEAR_CLIENT_ID,
          clientSecret: env.LINEAR_CLIENT_SECRET,
        }),
  logger,
});
const runs = new PrismaRunRepository(prisma);

// SDD section 31. The adapter comes from configuration. The local adapter cannot enforce an
// egress policy, so SandboxManager accepts it only under the explicit opt in below.
const createSandbox = (): Sandbox => {
  switch (env.SANDBOX_ADAPTER) {
    case "local":
      return new LocalProcessSandbox({ rootDirectory: env.SANDBOX_LOCAL_ROOT });
    case "kiln":
      // docs/specs/kiln-sandbox-provider.md. The env schema requires all three when the adapter is kiln.
      return new KilnSandbox({
        client: new KilnClient({ baseUrl: env.KILN_URL ?? "", apiKey: env.KILN_API_KEY ?? "" }),
        image: env.KILN_IMAGE ?? "",
        ...(env.KILN_REGISTRY_USERNAME === undefined || env.KILN_REGISTRY_TOKEN === undefined
          ? {}
          : { registryCredential: { username: env.KILN_REGISTRY_USERNAME, token: env.KILN_REGISTRY_TOKEN } }),
      });
    case "fly-sprites":
      return new FlySpriteSandbox({
        gateway: createSpritesGateway({
          token: env.SPRITES_TOKEN ?? "",
          ...(env.SPRITES_BASE_URL === undefined ? {} : { baseUrl: env.SPRITES_BASE_URL }),
        }),
      });
  }
};
const sandbox = createSandbox();

const sandboxManager = new SandboxManager({
  sandbox,
  logger,
  warmSnapshots: new PrismaWarmSnapshotStore(prisma),
  // docs/specs/proof-pack-and-visual-evidence.md. The install script was proven on the Sprite image.
  installBrowserTools: env.SANDBOX_ADAPTER === "fly-sprites",
  ...(env.SANDBOX_ADAPTER === "local" ? { allowUnenforcedNetwork: true } : {}),
});

// SDD section 33 names two required adapters. A stock `.factoree/config.yaml` selects
// `opencode` for the Implementer and `claude` for the User Validator and the Reviewer, so both
// must be registered before a stock repository can run.
const runners = buildAgentRunnerRegistry(redactor, {
  ...(env.OPENCODE_MODEL === undefined ? {} : { model: env.OPENCODE_MODEL }),
  ...(env.OPENCODE_VARIANT === undefined ? {} : { variant: env.OPENCODE_VARIANT }),
  roleVariants: {
    ...(env.OPENCODE_VARIANT_IMPLEMENTER === undefined ? {} : { implementer: env.OPENCODE_VARIANT_IMPLEMENTER }),
    ...(env.OPENCODE_VARIANT_REFINER === undefined ? {} : { refiner: env.OPENCODE_VARIANT_REFINER }),
    ...(env.OPENCODE_VARIANT_VALIDATOR === undefined ? {} : { validator: env.OPENCODE_VARIANT_VALIDATOR }),
    ...(env.OPENCODE_VARIANT_REVIEWER === undefined ? {} : { reviewer: env.OPENCODE_VARIANT_REVIEWER }),
  },
  // B-2. On the sandbox image the runner calls the root-owned CLI, never one the bootstrap installed.
  ...(sandbox.capabilities.supportsCustomImage ? { executable: `${KILN_RUNNER_BIN}/opencode` } : {}),
}, { silenceLimitMs: env.AGENT_SILENCE_MINUTES * 60_000 });
const reaper = new SpriteReaper({
  sandboxes: { [sandbox.name]: sandbox },
  runs,
  onDestroyed: (entry) => metrics.sandboxesDestroyed.inc({ adapter: entry.adapter, reason: "RETENTION" }),
});

// The Linear access token belongs to the workspace of the Run. The session id carries the
// workspace prefix in the workflow id, so the activity resolves the client for each call.
const agentSession: AgentSessionPort = {
  acknowledge: (sessionId, message) => call(sessionId, (client) => client.acknowledge(sessionId, message)),
  progress: (sessionId, message) => call(sessionId, (client) => client.progress(sessionId, message)),
  elicit: (sessionId, question) => call(sessionId, (client) => client.elicit(sessionId, question)),
  respond: (sessionId, body) => call(sessionId, (client) => client.respond(sessionId, body)),
  fail: (sessionId, message) => call(sessionId, (client) => client.fail(sessionId, message)),
  addLink: (sessionId, label, url) => call(sessionId, (client) => client.addLink(sessionId, label, url)),
};

// SDD section 28. The session identifier resolves the workspace client, in the same way it
// already does for `AgentSessionPort` above, and the issue identifier names the Work Item.
const workItems: WorkItemPort = {
  facts: (sessionId, issueId) => call(sessionId, (client) => client.facts(issueId)),
};

async function call<T>(
  sessionId: string,
  body: (client: ReturnType<typeof createLinearAgentClient>) => Promise<T>,
): Promise<T> {
  const run = await prisma.run.findUnique({
    where: { linearAgentSessionId: sessionId },
    select: { temporalWorkflowId: true },
  });
  if (!run) throw new Error(`no workspace for agent session ${sessionId}`);
  const { workspaceId } = parseWorkflowId(run.temporalWorkflowId);
  return await withLinearToken(workspaceId, (token) => body(createLinearAgentClient(token)));
}

/**
 * Runs one Linear call with a valid access token, and retries it once with a fresh token when
 * Linear rejects the one it received.
 *
 * A Linear access token lives for twenty-four hours, and it can be revoked before that. The
 * provider refreshes an expiring token on its own, so this retry covers the second case only:
 * a token that was still inside its window and stopped working.
 */
async function withLinearToken<T>(workspaceId: string, body: (token: string) => Promise<T>): Promise<T> {
  const token = await linearTokens.tokenFor(workspaceId);
  try {
    return await body(token);
  } catch (error) {
    if (!isLinearAuthenticationError(error)) throw error;
    logger.warn("Linear rejected the access token, refreshing it", {
      step: "linear_token",
      linear_workspace_id: workspaceId,
    });
    return await body(await linearTokens.tokenFor(workspaceId, { force: true }));
  }
}

/** Recognizes the answer Linear gives for a token it does not accept. */
function isLinearAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authentication required|not authenticated|AUTHENTICATION_ERROR|\b401\b/i.test(message);
}

// SDD section 18. The reader clones each repository into a temporary mirror, so the worker owns
// its lifetime and removes the mirrors at shutdown.
const repositoryReader = new GitRepositoryReader();
const secrets = new PrismaSecretStore(prisma, env.FACTOREE_SECRET_KEY);

// Ruling 1 and ruling 2. One credential path to GitHub: every GitHub adapter mints its token
// through this one provider, and every mint carries only the scope its one operation needs.
const githubTokens = new GitHubAppTokenProvider({
  appId: env.GITHUB_APP_ID,
  privateKeyBase64: env.GITHUB_APP_PRIVATE_KEY,
  apiBaseUrl: env.GITHUB_API_BASE_URL,
});

// Specification section 10. `syncInstallationWorkflow` reads an installation's repositories,
// and one repository's `.factoree/config.yaml`, through this client.
const discoveryClient = new GitHubRepositoryDiscoveryClient({
  apiBaseUrl: env.GITHUB_API_BASE_URL,
  tokens: githubTokens,
});

// Resolves the Linear team a repository declaration names. Reuses the same tenant-scoped
// pattern the Products administration route already wires in `src/bin/api.ts`.
const discoveryLinearTeams = new TenantScopedLinearTeamLookup(
  { linearWorkspaceIdFor: async (tenantId) => (await prisma.tenant.findUnique({ where: { id: tenantId } }))?.linearWorkspaceId ?? null },
  linearTokens,
);

const discoveryService = new DiscoveryService(discoveryClient, products, repositories, discoveryLinearTeams, logger);

// DI-5.1. `ConfiguredContextSourceProvider` wants a narrow secret-read port, and
// the real `SecretStore` answers it directly through `get`, which already takes a tenant and a
// Product.
const contextSecrets: ContextSourceSecretReader = {
  read: (tenantId, productId, name) => secrets.get(tenantId, productId, name),
};

// DI-5.1. The Backstage and MCP sources are built per Run from the Product configuration.
const contextSources = new ConfiguredContextSourceProvider({
  configurations: new PrismaContextSourceConfigurationStore(prisma),
  secrets: contextSecrets,
  fixedSources: () => [new LinearContextSource(), new RepositoryContextSource({ reader: repositoryReader })],
  factories: {
    backstage: (record, credential) =>
      new BackstageContextSource({
        sourceId: record.sourceId,
        catalog: new BackstageCatalogClient({ endpoint: record.endpoint, token: credential }),
        settings: record.settings as BackstageSourceSettings,
      }),
    mcp: (record, credential) => {
      const settings = record.settings as McpSourceSettings;
      return new McpContextSource({
        sourceId: record.sourceId,
        settings,
        // SDD section 58. The allow list of this Project is the whole permission.
        policy: buildActionPolicy({ mcpAllowedTools: settings.allowedTools }),
        tools: new McpJsonRpcClient({ endpoint: record.endpoint, token: credential, fetch }),
      });
    },
  },
});

// SDD section 39. A readiness probe and a validation fetch, both built on the platform `fetch`.
// A caught network error reports no answer rather than throwing, so the caller can keep polling
// or record it as a failed request instead of crashing the activity.
const previewProbe: ReadinessProbe = async (url) => {
  try {
    // A request that hangs must count as no answer, so the readiness deadline still ends the poll.
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return { status: response.status };
  } catch {
    return null;
  }
};

// SDD section 39 and `EVIDENCE_STORAGE`. The Linear access token belongs to one workspace, so
// the port resolves it for the tenant of each artifact. The tenant row carries the workspace
// identifier.
const linearFileUploadApiForTenant = async (tenantId: string) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { linearWorkspaceId: true },
  });
  if (!tenant) throw new Error(`no tenant ${tenantId} for the evidence upload`);
  return createLinearFileUploadApi(await linearTokens.tokenFor(tenant.linearWorkspaceId));
};

const evidenceStorage = createEvidenceStorage({
  storage: env.EVIDENCE_STORAGE,
  localRoot: env.EVIDENCE_LOCAL_ROOT,
  linearApiForTenant: linearFileUploadApiForTenant,
});

const httpValidationFetch: HttpValidationFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, body: await response.text() };
};

const worker = await Worker.create({
  connection: await createWorkerConnection(env),
  namespace: env.TEMPORAL_NAMESPACE,
  taskQueue: env.TEMPORAL_TASK_QUEUE,
  // A second workflow, `syncInstallationWorkflow`, joined `agentRunWorkflow` on this taskQueue.
  // The worker bundles one file per `workflowsPath`, so the barrel re-exports both.
  workflowsPath: new URL("../workflows/index.js", import.meta.url).pathname,
  activities: createActivities({
    runs,
    products,
    repositories,
    agentSession,
    workItems,
    sandboxManager,
    sandbox,
    runners,
    executions: new PrismaAgentExecutionRepository(prisma),
    sessions: new PrismaAgentSessionStore(prisma),
    secrets,
    evidence: new PrismaEvidenceStore(prisma),
    redactor,
    reaper,
    refinement: new RefinementEngine(),
    contextResolver: new ContextResolver(),
    contextContracts: new PrismaContextContractStore(prisma),
    contextSources,
    validationContracts: new PrismaValidationContractStore(prisma, logger),
    repositoryReader,
    browser: new PlaywrightBrowserDriver(),
    httpValidationFetch,
    previewProbe,
    evidenceStorage,
    validationResults: new PrismaValidationResultStore(prisma),
    reviewFindings: new PrismaReviewFindingStore(prisma),
    // The publish activity mints one write-scoped token per Run. It passes the token here. The
    // pull request port then spends the exact same credential the trusted checkout pushes with.
    // A fixed-token provider wraps it at no extra cost: no second mint, no second scope.
    pullRequests: (token: string) =>
      new GitHubPullRequests({
        apiBaseUrl: env.GITHUB_API_BASE_URL,
        tokens: { tokenForInstallation: () => Promise.resolve(token) },
      }),
    gitAuthor: { name: env.FACTOREE_GIT_AUTHOR_NAME, email: env.FACTOREE_GIT_AUTHOR_EMAIL },
    logger,
    tokens: githubTokens,
    discoveryClient,
    discoveryService,
  }),
});

// SDD section 51. The reaper deletes each sandbox after its retention window ends.
const REAP_INTERVAL_MS = 15 * 60_000;
// One pass at a time. A slow provider must not start a second pass over the same batch.
let reaping = false;
const reapTimer = setInterval(() => {
  if (reaping) {
    logger.warn("the previous sandbox reaper pass still runs", { step: "retention" });
    return;
  }
  reaping = true;
  void reaper
    .reap(new Date())
    .then((count) => {
      if (count > 0) logger.info("sandboxes reaped", { count, step: "retention" });
    })
    .catch((error: unknown) => {
      logger.error("the sandbox reaper failed", { error: String(error) });
    })
    .finally(() => {
      reaping = false;
    });
}, REAP_INTERVAL_MS);
reapTimer.unref();

logger.info("worker started", { step: "boot" });
try {
  await worker.run();
} finally {
  clearInterval(reapTimer);
  repositoryReader.close();
}
