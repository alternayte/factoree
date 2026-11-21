import { readTextWithCap } from "~/adapters/http/capped-response-body.js";
import { createHostCredentialWiring, rebindGitHubTokens } from "./host-credential-wiring.js";
import { PrismaCredentialBindingStore } from "~/persistence/prisma/sandbox-lease.prisma.js";
import { GITHUB_REBIND_INTERVAL_MS } from "~/domain/products/host-credentials.js";
import { PrismaRepositorySetupStore } from "~/persistence/prisma/repository-setup.prisma.js";
import { PrismaAppChangeIssueStore } from "~/persistence/prisma/app-change-issue.prisma.js";
import { createLinearIssues } from "~/adapters/linear/linear-issues.js";
import { createLinearIssueStatus } from "~/adapters/linear/linear-issue-status.js";
import type { IssueStatusPort } from "~/domain/runs/issue-status.js";
import { PrismaRunSkillStore } from "~/persistence/prisma/run-skill.prisma.js";
import { PrismaRunViewReader } from "~/persistence/prisma/run-view.prisma.js";
import { PrismaRunDraftStore } from "~/persistence/prisma/run-draft.prisma.js";
import { SkaelRegistry } from "~/adapters/skael/skael-registry.js";
import { OrganizationSkillsRegistry } from "~/adapters/github/organization-skills-registry.js";
import { GitHubSkillProposals } from "~/adapters/github/github-skill-proposals.js";
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
import { PrismaRunStageStore } from "~/persistence/prisma/run-stage.prisma.js";
import { PrismaRunEventStore } from "~/persistence/prisma/run-event.prisma.js";
import { PrismaEvidenceStore } from "~/persistence/prisma/evidence.prisma.js";
import { PrismaValidationResultStore } from "~/persistence/prisma/validation-result.prisma.js";
import { PrismaReviewFindingStore } from "~/persistence/prisma/review-finding.prisma.js";
import { PlaywrightBrowserDriver } from "~/adapters/browser/playwright/playwright-browser-driver.js";
import { createEvidenceStorage } from "~/adapters/evidence/evidence-storage-factory.js";
import { createLinearFileUploadApi } from "~/adapters/linear/linear-evidence-storage.js";
import type { HttpValidationFetch } from "~/domain/validation/http-validation.js";
import type { ReadinessProbe } from "~/domain/runs/preview.js";
import { KILN_RUNNER_BIN, templateServes } from "~/adapters/sandbox/kiln/kiln-sandbox.js";
import { kilnSandboxSize } from "~/domain/settings/install-settings.js";
import { SettingsSandbox } from "~/adapters/sandbox/settings-sandbox.js";
import { PrismaSandboxLeaseStore } from "~/persistence/prisma/sandbox-lease.prisma.js";
import { PrismaSandboxProviderStore } from "~/persistence/prisma/sandbox-provider.prisma.js";
import { PrismaBuildAheadFailureStore } from "~/persistence/prisma/build-ahead-failure.prisma.js";
import { SandboxProviderSelector } from "~/domain/runs/provider-selection.js";
import { sandboxMinimumOfRepositories } from "~/domain/runs/sandbox-minimum.js";
import { PrismaRunSlots } from "~/persistence/prisma/run-slots.prisma.js";
import { PrismaInstallSettingsStore } from "~/persistence/prisma/install-settings.prisma.js";
import type { AgentSessionSettings } from "~/adapters/runners/cli-agent-runner.js";
import type { AgentRunInput } from "~/domain/runs/agent-runner.js";
import { PrismaWarmSnapshotStore } from "~/persistence/prisma/warm-snapshot.prisma.js";
import { buildAgentRunnerRegistry } from "~/adapters/runners/registry.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { SpriteReaper } from "~/domain/runs/sprite-reaper.js";
import { createLinearAgentClient } from "~/adapters/linear/linear-agent-client.js";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { GitHubPullRequests } from "~/adapters/github/github-pull-requests.js";
import { GitHubAutoMerge } from "~/adapters/github/github-auto-merge.js";
import { GitHubDeployments } from "~/adapters/github/github-deployments.js";
import { GitHubPullRequestReviews } from "~/adapters/github/github-pull-request-reviews.js";
import { GitHubAppTokenProvider } from "~/adapters/github/app-token-provider.js";
import { RefinementEngine } from "~/domain/refinement/refinement-engine.js";
import { ContextResolver } from "~/domain/context/context-resolver.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import { BackstageContextSource } from "~/domain/context/backstage-source.js";
import { BackstageCatalogClient } from "~/adapters/backstage/backstage-catalog-client.js";
import { McpContextSource } from "~/domain/context/mcp-source.js";
import { McpJsonRpcClient } from "~/adapters/mcp/mcp-json-rpc-client.js";
import { LlmsTxtClient } from "~/adapters/llms-txt/llms-txt-client.js";
import { LlmsTxtContextSource } from "~/domain/context/llms-txt-source.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import type {
  BackstageSourceSettings,
  LlmsTxtSourceSettings,
  McpSourceSettings,
} from "~/domain/context/context-source-configuration.js";
import { ConfiguredContextSourceProvider } from "~/domain/context/context-source-provider.js";
import type { ContextSourceSecretReader } from "~/domain/context/context-source-provider.js";
import { PrismaContextContractStore } from "~/persistence/prisma/context-contract.prisma.js";
import { PrismaValidationContractStore } from "~/persistence/prisma/validation-contract.prisma.js";
import { PrismaContextSourceConfigurationStore } from "~/persistence/prisma/context-source-configuration.prisma.js";
import { createActivities } from "~/activities/index.js";
import { createBuildAheadRequester, createTemporalClient, createWorkerConnection } from "~/temporal/connection.js";
import { BuildAheadTrigger, setBuildAheadRequest } from "~/domain/runs/build-ahead.js";
import { parseWorkflowId } from "~/temporal/workflow-id.js";
import type { AgentSessionPort, WorkItemPort } from "~/domain/runs/ports.js";
import { LinearTokenProvider } from "~/domain/products/linear-token-provider.js";
import { githubApiBaseUrl, githubAppCredentials, githubBaseUrl, linearOAuthFromSettings } from "./install-wiring.js";
import { createRunWaits } from "./blocker-wait-wiring.js";
import { PullRequestCloseHandler } from "~/domain/runs/pull-request-close.js";
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";
import { PrismaPullRequestStore } from "~/persistence/prisma/pull-request-store.prisma.js";
import { GitHubCommitStatuses } from "~/adapters/github/github-commit-statuses.js";
import { GitHubRepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";
import { TenantScopedLinearTeamLookup } from "~/adapters/linear/team-lookup-by-tenant.js";
import { DiscoveryService } from "~/domain/products/discovery-service.js";
import { buildInfo } from "~/config/build-info.js";
import { checkOpenRunsReplay } from "~/temporal/upgrade-check.js";
import { isAgentRunnerName, resolveRole } from "~/domain/products/agent-settings.js";
import { ModelCatalogService } from "~/domain/products/model-catalog-service.js";
import { opencodeModelsFileOf, opencodeProviderConfigOf } from "~/domain/products/model-catalog.js";
import { PrismaModelCatalogStore } from "~/persistence/prisma/model-catalog.prisma.js";
import { renderVisionFailure, roleModelsOf, visionGaps } from "~/domain/products/model-vision.js";
import type { WorkItemContentPort } from "~/domain/context/work-item-content.js";
import { createLinearWorkItemReader } from "~/adapters/linear/linear-work-item-content.js";
import { GitHubWorkItemLinks } from "~/adapters/github/github-work-item-links.js";
import { createModelsDevSource } from "~/adapters/models-dev/models-dev-source.js";

// docs/specs/release-0-1-0.md. `factoree --version` answers before the environment loads, so it
// works with no configuration.
if (process.argv.includes("--version")) {
  process.stdout.write(`factoree ${buildInfo.version} (commit ${buildInfo.commit}, built ${buildInfo.buildDate})\n`);
  process.exit(0);
}

const env = loadEnv();
// docs/specs/release-0-1-0.md. The master key is the one secret of the environment. Every
// credential the install settings decrypt joins the redactor when it is read.
const redactor = new Redactor([env.FACTOREE_MASTER_KEY]);
const logger = createLogger({ level: env.FACTOREE_LOG_LEVEL, redactor });
const prisma = createPrismaClient(env.FACTOREE_DATABASE_URL);
const settings = new PrismaInstallSettingsStore(prisma, env.FACTOREE_MASTER_KEY, (value) => redactor.addSecret(value));
const tenants = new PrismaTenantRegistry(prisma, env.FACTOREE_MASTER_KEY);
const products = new PrismaProductRegistry(prisma);
const repositories = new PrismaRepositoryRegistry(prisma);

// A Linear access token lives for twenty-four hours. The provider refreshes it before it expires
// and writes the new pair back, so a worker that runs for weeks needs no daily hand-over. Without
// the client credentials it can only report the expiry, so the operator learns what to configure.
const linearTokens = new LinearTokenProvider({
  tenants,
  oauth: linearOAuthFromSettings(settings),
  logger,
});
const runs = new PrismaRunRepository(prisma);

// SDD section 31 and docs/specs/release-0-1-0.md. The install settings name the provider. The
// adapter reads them before each new sandbox, so a provider change needs no restart. The local
// adapter cannot enforce an egress policy, so SandboxManager accepts it only under the opt in of
// FACTOREE_UNSAFE_LOCAL_SANDBOX, which the settings check as well.
const localSandboxAllowed = env.FACTOREE_UNSAFE_LOCAL_SANDBOX === "1";
// DI-15.14. Every create takes a slot of the maxLive of its provider, across all workers.
// docs/specs/sandbox-provider-spillover.md. The install lists several providers. A run is pinned to
// one, and holds its slots there from start to end.
const sandboxProviders = new PrismaSandboxProviderStore(prisma, env.FACTOREE_MASTER_KEY, (value) => redactor.addSecret(value));
const leases = new PrismaSandboxLeaseStore(prisma);
const buildAheadFailures = new PrismaBuildAheadFailureStore(prisma);
const sandbox = new SettingsSandbox({
  settings: async () => ({ ...(await settings.read()).sandbox, providers: await sandboxProviders.list() }),
  allowLocal: localSandboxAllowed,
  localRoot: env.FACTOREE_SANDBOX_LOCAL_ROOT,
  leases,
  logger,
  onEvicted: (victim) => metrics.sandboxesDestroyed.inc({ adapter: victim.adapter, reason: "LIMIT" }),
});
const providerSelector = new SandboxProviderSelector({
  refresh: () => sandbox.refresh(),
  providers: () => sandbox.providerSettings(),
  capabilities: (providerId) => sandbox.adapterOf(providerId)?.capabilities ?? null,
  usage: () => leases.usage(),
  hold: (providerId, runId, count, minimum) => sandbox.hold(providerId, runId, count, minimum),
  heldProviderOf: (runId) => leases.heldProviderOf(runId),
  failedBuildAheads: (tenantId, repositoryUrl) => buildAheadFailures.failedProviders(tenantId, repositoryUrl),
});
/** The enabled providers whose adapter builds. A build-ahead builds a warm snapshot on each. */
const usableProviderIds = async (): Promise<string[]> => {
  await sandbox.refresh();
  return sandbox
    .providerSettings()
    .filter((provider) => provider.enabled && sandbox.adapterOf(provider.id) !== null)
    .map((provider) => provider.id);
};
try {
  await sandbox.refresh();
} catch (error) {
  // A worker may start before setup stores a provider. The first Run reads the settings again.
  logger.warn("the sandbox provider is not configured yet", { step: "boot", error: String(error) });
}

const warmSnapshots = new PrismaWarmSnapshotStore(prisma);
// docs/specs/run-speed.md. One row per stage of each run.
const stages = new PrismaRunStageStore(prisma);
// docs/specs/run-diagnostics.md. The faults and the Factoree decisions of each run and setup run.
const events = { store: new PrismaRunEventStore(prisma), redactor, logger };
// docs/specs/host-credentials.md. The secrets and the token provider are built further down, and
// a credential is read only when a sandbox is prepared.
const hostCredentials = createHostCredentialWiring({ prisma, secrets: () => secrets, tokens: () => githubTokens });
const credentialBindings = new PrismaCredentialBindingStore(prisma);
const sandboxManager = new SandboxManager({
  sandbox,
  // docs/specs/sandbox-memory-and-size.md. The size each sandbox of a repository needs.
  sandboxMinimum: (tenantId, repositoryUrls) => sandboxMinimumOfRepositories(repositories, tenantId, repositoryUrls),
  logger,
  warmSnapshots,
  stages,
  events,
  hostCredentials: hostCredentials.access,
  credentialBindings,
  // docs/specs/proof-pack-and-visual-evidence.md. The install script was proven on the Sprite image.
  // The sandbox name is the provider id, so the type of the provider decides.
  installBrowserTools: (sandboxName) =>
    (sandbox.providerSettings().find((provider) => provider.id === sandboxName)?.type ?? sandboxName) === "fly-sprites",
  ...(localSandboxAllowed ? { allowUnenforcedNetwork: true } : {}),
  // docs/specs/change-sets.md, DI-21.136. A change set with no set snapshot asks for its build-ahead.
  // The client exists before the first run prepares a sandbox.
  requestSetBuildAhead: (request) => createBuildAheadRequester(blockerClient, env.FACTOREE_TEMPORAL_TASK_QUEUE)(setBuildAheadRequest(request)),
  // docs/specs/change-sets.md, DI-21.148. The build-ahead of a set starts each wired group once.
  // The probe is defined below, and the manager reads it only when a sandbox is prepared.
  previewProbe: (url) => previewProbe(url),
  redactor,
});

// docs/specs/claude-code-runner.md. The Product of the Run holds the runner, the model and the
// effort of each role, and the silence limit. The worker reads them when a session starts, so a
// change applies to the next session with no restart. A session on a runner other than the one
// its role resolves to, from a run that started before a change, runs at the CLI defaults: a
// model of one runner means nothing to the other.
const modelCatalog = new ModelCatalogService({ store: new PrismaModelCatalogStore(prisma), source: createModelsDevSource(), logger });

const sessionSettings = async (input: AgentRunInput, runner: string): Promise<AgentSessionSettings> => {
  // docs/specs/repository-setup-and-services.md. A setup session belongs to a setup row, not a run.
  const product = input.runId.startsWith("setup:")
    ? (await prisma.repositorySetup.findUniqueOrThrow({ where: { id: input.runId.slice("setup:".length) }, include: { product: true } })).product
    : (await prisma.run.findUniqueOrThrow({ where: { id: input.runId }, include: { product: true } })).product;
  const record = await products.findById(product.tenantId, product.id);
  const resolved = record === null ? null : resolveRole(record, input.role);
  const matches = resolved !== null && resolved.runner === runner;
  // B-2. On the sandbox image the runner calls the root-owned CLI, never one the bootstrap installed.
  const customImage = (await sandbox.forRef(input.ref)).capabilities.supportsCustomImage;
  const model = matches ? resolved.model : null;
  const effort = matches ? resolved.effort : null;
  // docs/specs/model-picker.md. An opencode session reads its model from the catalog the picker offered.
  const catalog = runner === "opencode" && model !== null ? await modelCatalog.current() : null;
  return {
    model,
    effort,
    silenceLimitMs: product.silenceMinutes * 60_000,
    executable: customImage && isAgentRunnerName(runner) ? `${KILN_RUNNER_BIN}/${runner}` : null,
    modelsFile: catalog === null || model === null ? null : opencodeModelsFileOf(catalog.raw, model, effort),
    providerConfig: catalog === null || model === null ? null : opencodeProviderConfigOf(catalog.raw, model),
  };
};

// SDD section 33 names two required adapters. docs/specs/claude-code-runner.md: the Product
// selects one of them for each role.
const runners = buildAgentRunnerRegistry(redactor, {}, { settingsFor: sessionSettings });
const reaper = new SpriteReaper({
  // docs/specs/sandbox-provider-spillover.md. The view of the provider each ref names.
  sandboxes: (providerId) => sandbox.forProvider(providerId),
  runs,
  onDestroyed: (entry) => metrics.sandboxesDestroyed.inc({ adapter: entry.adapter, reason: "RETENTION" }),
  retiredSnapshots: warmSnapshots,
  retryFailedDestroys: () => sandbox.retryFailedDestroys(),
});

// The Linear access token belongs to the workspace of the Run. The session id carries the
// workspace prefix in the workflow id, so the activity resolves the client for each call.
const agentSession: AgentSessionPort = {
  acknowledge: (sessionId, message) => call(sessionId, (client) => client.acknowledge(sessionId, message)),
  progress: (sessionId, message) => call(sessionId, (client) => client.progress(sessionId, message)),
  elicit: (sessionId, question, options) => call(sessionId, (client) => client.elicit(sessionId, question, options)),
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
  // docs/specs/run-recovery.md. A follow-up run shares the session, and every run of it shares
  // the workspace, so any run of the session names the workspace.
  const run = await prisma.run.findFirst({
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
const secrets = new PrismaSecretStore(prisma, env.FACTOREE_MASTER_KEY);

// Ruling 1 and ruling 2. One credential path to GitHub: every GitHub adapter mints its token
// through this one provider, and every mint carries only the scope its one operation needs.
const githubTokens = new GitHubAppTokenProvider({ credentials: githubAppCredentials(settings) });

// Specification section 10. `syncInstallationWorkflow` reads an installation's repositories,
// and one repository's `.factoree/config.yaml`, through this client.
const discoveryClient = new GitHubRepositoryDiscoveryClient({
  apiBaseUrl: githubApiBaseUrl(settings),
  tokens: githubTokens,
});

// Resolves the Linear team a repository declaration names. Reuses the same tenant-scoped
// pattern the Products administration route already wires in `src/bin/api.ts`.
const discoveryLinearTeams = new TenantScopedLinearTeamLookup(
  { linearWorkspaceIdFor: async (tenantId) => (await prisma.tenant.findUnique({ where: { id: tenantId } }))?.linearWorkspaceId ?? null },
  linearTokens,
);

const discoveryService = new DiscoveryService(discoveryClient, products, repositories, discoveryLinearTeams, logger, new PrismaRepositorySetupStore(prisma));

// DI-5.1. `ConfiguredContextSourceProvider` wants a narrow secret-read port, and
// the real `SecretStore` answers it directly through `get`, which already takes a tenant and a
// Product.
const contextSecrets: ContextSourceSecretReader = {
  read: (tenantId, productId, name) => secrets.get(tenantId, productId, name),
};

// DI-5.1. The Backstage and MCP sources are built per Run from the Product configuration.
const contextConfigurations = new PrismaContextSourceConfigurationStore(prisma);
const contextSources = new ConfiguredContextSourceProvider({
  configurations: contextConfigurations,
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
    // docs/specs/external-context-delivery.md. The endpoint is the URL of the llms.txt file.
    llms_txt: (record, credential) =>
      new LlmsTxtContextSource({
        sourceId: record.sourceId,
        endpoint: record.endpoint,
        settings: record.settings as LlmsTxtSourceSettings,
        pages: new LlmsTxtClient({ endpoint: record.endpoint, token: credential }),
      }),
  },
});

// docs/specs/work-item-images-and-links.md. The comments, the images and the linked issues are read
// with the Linear token of the tenant's workspace, and a GitHub link with a read-only App token of
// the one repository. Neither token reaches a sandbox.
const linearWorkspaceOf = async (tenantId: string): Promise<string> => {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { linearWorkspaceId: true } });
  if (!tenant) throw new Error(`no tenant ${tenantId} for the work item read`);
  return tenant.linearWorkspaceId;
};
const githubWorkItemLinks = new GitHubWorkItemLinks({ apiBaseUrl: githubApiBaseUrl(settings), tokens: githubTokens });
const workItemContent: WorkItemContentPort = {
  comments: async (tenantId, issueId) =>
    await withLinearToken(await linearWorkspaceOf(tenantId), (token) => createLinearWorkItemReader(token).comments(issueId)),
  downloadImage: async (tenantId, url, maxBytes) =>
    await withLinearToken(await linearWorkspaceOf(tenantId), (token) => createLinearWorkItemReader(token).downloadImage(url, maxBytes)),
  linearIssue: async (tenantId, identifier) =>
    await withLinearToken(await linearWorkspaceOf(tenantId), (token) => createLinearWorkItemReader(token).issue(identifier)),
  github: (target) => githubWorkItemLinks.read(target),
};

// docs/specs/egress-honesty-and-issue-status.md. The issue status moves act as the Factoree app of
// the tenant's workspace, and each call retries once with a fresh token.
const issueStatusFor = async (tenantId: string): Promise<IssueStatusPort> => {
  const workspaceId = await linearWorkspaceOf(tenantId);
  return {
    read: (issueId) => withLinearToken(workspaceId, (token) => createLinearIssueStatus(token).read(issueId)),
    move: (issueId, stateId) => withLinearToken(workspaceId, (token) => createLinearIssueStatus(token).move(issueId, stateId)),
    attachPullRequest: (issueId, pullRequest) =>
      withLinearToken(workspaceId, (token) => createLinearIssueStatus(token).attachPullRequest(issueId, pullRequest)),
  };
};

// docs/specs/work-item-images-and-links.md. The input types of each role model, from the stored
// models.dev catalog. A product the worker cannot read is not checked here: preparation fails it.
const vision = async (tenantId: string, productId: string, imageCount: number): Promise<string | null> => {
  const record = await products.findById(tenantId, productId);
  if (record === null) return null;
  const raw = (await modelCatalog.current())?.raw ?? null;
  const gaps = visionGaps(raw, roleModelsOf(record));
  return gaps.length === 0 ? null : renderVisionFailure(raw, gaps, imageCount);
};

// SDD section 39. A readiness probe and a validation fetch, both built on the platform `fetch`.
// A caught network error reports no answer rather than throwing, so the caller can keep polling
// or record it as a failed request instead of crashing the activity.
const previewProbe: ReadinessProbe = async (url) => {
  try {
    // A request that hangs must count as no answer, so the readiness deadline still ends the poll.
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    // GitHub issue 81. A preview failure quotes the start of a refused answer, such as the Vite
    // 403 page that names the blocked host. A ready answer needs no body.
    if (response.status >= 200 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status };
    }
    const body = await readTextWithCap(response, 16 * 1024).catch(() => null);
    return body === null ? { status: response.status } : { status: response.status, body };
  } catch {
    return null;
  }
};

// SDD section 39 and `FACTOREE_EVIDENCE_STORAGE`. The Linear access token belongs to one workspace, so
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
  storage: env.FACTOREE_EVIDENCE_STORAGE,
  localRoot: env.FACTOREE_EVIDENCE_LOCAL_ROOT,
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

// docs/specs/blocked-by-wait.md. The sweep below and the merge of a pull request both release waiting runs.
const blockerClient = await createTemporalClient(env);
const { blockerWait, drainMode } = createRunWaits({
  prisma,
  linearToken: (workspaceId) => linearTokens.tokenFor(workspaceId),
  client: blockerClient,
  taskQueue: env.FACTOREE_TEMPORAL_TASK_QUEUE,
  logger,
});

// docs/specs/pr-review-merge-and-deploy.md, D3. The PR workflow closes a recorded pull request here,
// with the same issue move as the webhook path of DI-21.51.
const pullRequestClose = new PullRequestCloseHandler({
  webhookLog: new PrismaWebhookLog(prisma),
  runs,
  issues: issueStatusFor,
  respond: (_tenantId, sessionId, body) => agentSession.respond(sessionId, body),
  logger,
  blockers: {
    // The activity answers at once. The sweep logs its own failure, and the next tick retries.
    sweepSoon: (tenantId) => {
      void blockerWait
        .sweep(tenantId)
        .then(({ released }) => {
          if (released > 0) logger.info("blocked runs released after a merge", { tenant_id: tenantId, count: released, step: "blockers" });
        })
        .catch((error: unknown) => {
          logger.error("the blocker sweep after a merge failed", { tenant_id: tenantId, error: String(error), step: "blockers" });
        });
    },
    pullRequestClosedUnmerged: (tenantId, issueId, pullRequest) => blockerWait.pullRequestClosedUnmerged(tenantId, issueId, pullRequest),
  },
});

const validationContracts = new PrismaValidationContractStore(prisma, logger);
// docs/specs/pr-review-merge-and-deploy.md and docs/specs/change-sets.md. One store holds the pull
// request records and the change sets they form.
const pullRequestRecords = new PrismaPullRequestStore(prisma);
const worker = await Worker.create({
  connection: await createWorkerConnection(env),
  namespace: env.FACTOREE_TEMPORAL_NAMESPACE,
  taskQueue: env.FACTOREE_TEMPORAL_TASK_QUEUE,
  // A second workflow, `syncInstallationWorkflow`, joined `agentRunWorkflow` on this taskQueue.
  // The worker bundles one file per `workflowsPath`, so the barrel re-exports both.
  workflowsPath: new URL("../workflows/index.js", import.meta.url).pathname,
  // GitHub issue 13. The default grace time is 0, so a shutdown cancelled every activity at once,
  // a one-minute database write included. 8 seconds lets a short activity end, and stays below
  // the 10-second stop timeout of Docker and the 30 seconds of a Kubernetes pod. An agent
  // session still ends at the shutdown: only a reattach (GitHub issue 13) can keep it.
  shutdownGraceTime: "8 seconds",
  activities: createActivities({
    drainModeOn: () => drainMode.isOn(),
    hostCredentials: { access: hostCredentials.access, hosts: hostCredentials.hosts, key: hostCredentials.key, bindings: credentialBindings, coverage: hostCredentials.coverage },
    runs,
    runSlots: new PrismaRunSlots(prisma),
    products,
    repositories,
    agentSession,
    workItems,
    sandboxManager,
    sandbox,
    providerSelector,
    failover: {
      markDown: (providerId, until, reason) => sandboxProviders.markDown(providerId, until, reason),
      releaseHolds: (runId) => leases.releaseHolds(runId),
    },
    sandboxProviderIds: usableProviderIds,
    buildAheadFailures,
    sandboxProviderName: async (providerId) => (await sandboxProviders.find(providerId))?.name ?? null,
    runners,
    executions: new PrismaAgentExecutionRepository(prisma),
    sessions: new PrismaAgentSessionStore(prisma),
    stages,
    events,
    secrets,
    evidence: new PrismaEvidenceStore(prisma),
    redactor,
    reaper,
    refinement: new RefinementEngine(),
    contextResolver: new ContextResolver(),
    contextContracts: new PrismaContextContractStore(prisma),
    contextSources,
    contextDelivery: contextSources,
    workItemContent,
    contextConfigurations,
    vision,
    issueStatus: issueStatusFor,
    publishedPullRequests: pullRequestRecords,
    pullRequestClose,
    // docs/specs/pr-review-merge-and-deploy.md. The L4 merge mints a token per call for one repository.
    autoMerge: new GitHubAutoMerge({ apiBaseUrl: githubApiBaseUrl(settings), tokens: githubTokens }),
    // docs/specs/pr-review-merge-and-deploy.md, slice 3. The review reads and replies of the PR follow-up runs.
    pullRequestReviews: new GitHubPullRequestReviews({ apiBaseUrl: githubApiBaseUrl(settings), tokens: githubTokens }),
    // Slice 5. The deploy report reads compares and deployments, and writes nothing on GitHub.
    deploys: new GitHubDeployments({ apiBaseUrl: githubApiBaseUrl(settings), tokens: githubTokens }),
    // docs/specs/change-sets.md, slices 8 and 9. The pull requests of a set, and the factoree/change-set status.
    changeSets: pullRequestRecords,
    commitStatuses: new GitHubCommitStatuses({ apiBaseUrl: githubApiBaseUrl(settings), tokens: githubTokens }),
    productPageUrl: (productId: string) => `${env.FACTOREE_PUBLIC_URL}/products/${productId}`,
    runPageUrl: (runId: string) => `${env.FACTOREE_PUBLIC_URL.replace(/\/+$/, "")}/runs/${runId}`,
    validationContracts,
    // docs/specs/pr-review-merge-and-deploy.md, D1. The same store holds the passing plans.
    validationPlans: validationContracts,
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
        apiBaseUrl: githubApiBaseUrl(settings),
        tokens: { tokenForInstallation: () => Promise.resolve(token) },
      }),
    gitAuthor: async () => (await settings.read()).gitAuthor,
    logger,
    tokens: githubTokens,
    discoveryClient,
    repositoryFiles: discoveryClient,
    warmSnapshots,
    discoveryService,
    repositoryBaseUrl: githubBaseUrl(settings),
    // docs/specs/skill-registry.md. Skael is the one registry kind. The organization skills
    // repository takes a skill proposal as a pull request.
    skills: new PrismaRunSkillStore(prisma),
    runViews: new PrismaRunViewReader(prisma),
    // docs/specs/draft-of-failed-run.md. The facts and the record of a draft of a failed run.
    drafts: new PrismaRunDraftStore(prisma),
    setups: new PrismaRepositorySetupStore(prisma),
    // docs/specs/setup-app-change-issues.md. The issues act as the Factoree app of the tenant's
    // workspace. The state read mints a pull-request token of the one repository.
    appChangeIssues: new PrismaAppChangeIssueStore(prisma),
    linearIssues: async (tenantId: string) => {
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { linearWorkspaceId: true } });
      if (!tenant) throw new Error(`no tenant ${tenantId} for the app-change issue`);
      return createLinearIssues(await linearTokens.tokenFor(tenant.linearWorkspaceId));
    },
    pullRequestState: (slug: string, number: number, githubInstallationId: string) =>
      new GitHubPullRequests({ apiBaseUrl: githubApiBaseUrl(settings), tokens: githubTokens }).stateByNumber(slug, number, githubInstallationId),
    setupMarks: repositories,
    skillRegistries: (registry, key) => new SkaelRegistry({ url: registry.url, key, set: registry.set }),
    organizationSkills: ({ slug, repository, githubInstallationId }) =>
      new OrganizationSkillsRegistry({
        slug,
        repository,
        githubInstallationId,
        proposals: new GitHubSkillProposals({ apiBaseUrl: githubApiBaseUrl(settings), tokens: githubTokens }),
      }),
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

// docs/specs/host-credentials.md. A `github` installation token expires after 1 hour, so the
// worker binds a new one on each live sandbox that holds it. One pass at a time.
let rebinding = false;
const rebindTimer = setInterval(() => {
  if (rebinding) return;
  rebinding = true;
  void rebindGitHubTokens({ bindings: credentialBindings, access: hostCredentials.access, sandbox, logger })
    .then((count) => {
      if (count > 0) logger.info("github tokens bound again", { count, step: "host_credentials" });
    })
    .catch((error: unknown) => {
      logger.error("the github token rebind failed", { error: String(error), step: "host_credentials" });
    })
    .finally(() => {
      rebinding = false;
    });
}, GITHUB_REBIND_INTERVAL_MS);
rebindTimer.unref();

// docs/specs/blocked-by-wait.md. The sweep reads the blockers of every waiting run every minute, with
// one batched Linear query per tenant, and starts each run that no open blocker holds.
const BLOCKER_SWEEP_INTERVAL_MS = 60_000;
// One pass at a time, as the reaper does. A slow Linear answer must not start a second pass.
let sweeping = false;
const blockerTimer = setInterval(() => {
  if (sweeping) return;
  sweeping = true;
  void blockerWait
    .sweep()
    .then(async ({ released }) => {
      if (released > 0) logger.info("blocked runs released", { count: released, step: "blockers" });
      // docs/specs/drain-mode.md. Once drain mode is off, the held runs start, oldest first.
      const started = await drainMode.release();
      if (started > 0) logger.info("held runs started after the update", { count: started, step: "drain" });
    })
    .catch((error: unknown) => {
      logger.error("the blocker sweep failed", { error: String(error), step: "blockers" });
    })
    .finally(() => {
      sweeping = false;
    });
}, BLOCKER_SWEEP_INTERVAL_MS);
blockerTimer.unref();

// docs/specs/run-speed.md. A release can change the default sandbox image, and the install settings
// can change while no worker runs. A warm snapshot of another template then serves no run, so the
// worker requests a build-ahead for every repository. The build-ahead workflow of a repository
// joins the request of a second worker.
try {
  // docs/specs/sandbox-provider-spillover.md. Each provider has its own template.
  let stale = false;
  for (const providerId of await usableProviderIds()) {
    const view = await sandbox.forProvider(providerId);
    const provider = sandbox.providerSettings().find((entry) => entry.id === providerId);
    if (view.warmSnapshots === undefined || view.image === undefined || provider === undefined) continue;
    // docs/specs/sandbox-memory-and-size.md. A repository with a `sandbox` minimum keeps a snapshot
    // of a larger template. Only a template of another image, or below the provider size, is stale.
    const image = view.image;
    const size = kilnSandboxSize(provider);
    if ((await warmSnapshots.templatesOf(providerId)).some((stored) => !templateServes(stored, image, size))) stale = true;
  }
  if (stale) {
    const temporal = await createTemporalClient(env);
    await new BuildAheadTrigger({
      request: createBuildAheadRequester(temporal, env.FACTOREE_TEMPORAL_TASK_QUEUE),
      products,
      repositories,
      snapshotKeys: (tenantId, repositoryUrl) => warmSnapshots.keysFor(tenantId, repositoryUrl),
      setSnapshots: () => warmSnapshots.listSets(),
      readConfig: (fullName, ref, installationId) => discoveryClient.readConfig(fullName, ref, installationId),
      listFiles: (fullName, ref, installationId) => discoveryClient.listFiles(fullName, ref, installationId),
      repositoryBaseUrl: githubBaseUrl(settings),
      credentialKey: hostCredentials.key,
      logger,
    }).afterTemplateChange();
    await temporal.connection.close();
  }
} catch (error) {
  // The sandbox provider is not configured yet, or the request failed. The next run still works.
  logger.warn("the worker did not check the warm snapshot templates", { step: "boot", error: String(error) });
}

// docs/specs/run-workflow-structure.md. An open run from a release this code cannot replay would
// fail its next workflow task. The worker refuses to poll, so the previous release keeps the run.
const replayCheck = await createTemporalClient(env);
try {
  const replay = await checkOpenRunsReplay({ client: replayCheck, prisma, publicUrl: env.FACTOREE_PUBLIC_URL });
  if (!replay.ok) {
    logger.error("open runs need an earlier release, so the worker does not start", {
      step: "boot",
      version: buildInfo.version,
      runs: replay.blocking.map((entry) => entry.run?.runId ?? entry.workflowId),
      report: replay.report,
    });
    process.exit(78);
  }
} finally {
  await replayCheck.connection.close();
}

// docs/specs/drain-mode.md. The upgrade check passed, so a worker of a newer release ends drain mode,
// and the held runs start on this release. A restart of the same release keeps drain mode on.
try {
  if (await drainMode.endIfNewer()) {
    const started = await drainMode.release();
    logger.info("drain mode ended by this release", { step: "drain", version: buildInfo.version, started });
  }
} catch (error) {
  // The next sweep starts the held runs once drain mode is off.
  logger.error("the worker did not end drain mode", { step: "drain", error: String(error) });
}

logger.info("worker started", {
  step: "boot",
  version: buildInfo.version,
  commit: buildInfo.commit,
  build_date: buildInfo.buildDate,
  sandbox_image_default: buildInfo.sandboxImageDefault ?? "none",
});
try {
  await worker.run();
} finally {
  clearInterval(reapTimer);
  clearInterval(blockerTimer);
  await blockerClient.connection.close();
  repositoryReader.close();
}
