import { Worker } from "@temporalio/worker";
import { loadEnv } from "~/config/env.js";
import { createLogger } from "~/telemetry/logger.js";
import { metrics } from "~/telemetry/metrics.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createPrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaSecretStore, PrismaTenantRegistry } from "~/persistence/prisma/project-registry.prisma.js";
import { PrismaAgentExecutionRepository } from "~/persistence/prisma/agent-execution.prisma.js";
import { PrismaEvidenceStore } from "~/persistence/prisma/evidence.prisma.js";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { FlySpriteSandbox } from "~/adapters/sandbox/fly-sprites/fly-sprite-sandbox.js";
import { createSpritesGateway } from "~/adapters/sandbox/fly-sprites/sprites-client.js";
import { OpenCodeRunner } from "~/adapters/runners/opencode/opencode-runner.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { SpriteReaper } from "~/domain/runs/sprite-reaper.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import { createLinearAgentClient } from "~/adapters/linear/linear-agent-client.js";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
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

const env = loadEnv();
const redactor = new Redactor([env.ADMIN_API_TOKEN, env.LINEAR_WEBHOOK_SECRET, env.FACTOREE_SECRET_KEY]);
const logger = createLogger({ level: env.LOG_LEVEL, redactor });
const prisma = createPrismaClient(env.DATABASE_URL);
const tenants = new PrismaTenantRegistry(prisma, env.FACTOREE_SECRET_KEY);
const runs = new PrismaRunRepository(prisma);

// SDD section 31. The adapter comes from configuration. The local adapter cannot enforce an
// egress policy, so SandboxManager accepts it only under the explicit opt in below.
const sandbox: Sandbox =
  env.SANDBOX_ADAPTER === "local"
    ? new LocalProcessSandbox({ rootDirectory: env.SANDBOX_LOCAL_ROOT })
    : new FlySpriteSandbox({
        gateway: createSpritesGateway({
          token: env.SPRITES_TOKEN ?? "",
          ...(env.SPRITES_BASE_URL === undefined ? {} : { baseUrl: env.SPRITES_BASE_URL }),
        }),
      });

const sandboxManager = new SandboxManager({
  sandbox,
  ...(env.SANDBOX_ADAPTER === "local" ? { allowUnenforcedNetwork: true } : {}),
});

const runners = new AgentRunnerRegistry([new OpenCodeRunner({ redactor })]);
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
};

// SDD section 28. The session identifier resolves the workspace client, in the same way it
// already does for `AgentSessionPort` above, and the issue identifier names the Work Item.
const workItems: WorkItemPort = {
  labels: (sessionId, issueId) => call(sessionId, (client) => client.labels(issueId)),
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
  const token = await tenants.getInstallationToken(workspaceId);
  if (!token) throw new Error(`no Linear installation for workspace ${workspaceId}`);
  return await body(createLinearAgentClient(token));
}

// SDD section 18. The reader clones each repository into a temporary mirror, so the worker owns
// its lifetime and removes the mirrors at shutdown.
const repositoryReader = new GitRepositoryReader();
const secrets = new PrismaSecretStore(prisma, env.FACTOREE_SECRET_KEY);

// Controller decision 1. `ConfiguredContextSourceProvider` wants a narrow secret-read port, and
// the real `SecretStore` answers it directly through `get`, which already takes a tenant and a
// Project.
const contextSecrets: ContextSourceSecretReader = {
  read: (tenantId, projectId, name) => secrets.get(tenantId, projectId, name),
};

// Controller decision 2. Task 5 built the real Backstage source. Task 8 builds the MCP source.
// Until then a configured MCP row must fail loudly instead of silently building nothing.
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

const worker = await Worker.create({
  connection: await createWorkerConnection(env),
  namespace: env.TEMPORAL_NAMESPACE,
  taskQueue: env.TEMPORAL_TASK_QUEUE,
  workflowsPath: new URL("../workflows/agent-run.workflow.js", import.meta.url).pathname,
  activities: createActivities({
    runs,
    agentSession,
    workItems,
    sandboxManager,
    sandbox,
    runners,
    executions: new PrismaAgentExecutionRepository(prisma),
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
    logger,
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
