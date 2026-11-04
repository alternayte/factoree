/* eslint-disable @typescript-eslint/require-await -- stub AgentSessionPort methods match the port's async signature */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "@temporalio/worker";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { startDatabase } from "./support/database.js";
import { startTemporal } from "./support/temporal.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaRunSlots } from "~/persistence/prisma/run-slots.prisma.js";
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";
import {
  PrismaProductRegistry,
  PrismaRepositoryRegistry,
  PrismaSecretStore,
  PrismaTenantRegistry,
} from "~/persistence/prisma/product-registry.prisma.js";
import { PrismaAgentExecutionRepository } from "~/persistence/prisma/agent-execution.prisma.js";
import { PrismaEvidenceStore } from "~/persistence/prisma/evidence.prisma.js";
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { SpriteReaper } from "~/domain/runs/sprite-reaper.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { FakeRunner } from "../support/fake-runner.js";
import { createTemporalWorkflowStarter } from "~/temporal/connection.js";
import { RefinementEngine } from "~/domain/refinement/refinement-engine.js";
import { ContextResolver } from "~/domain/context/context-resolver.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { PrismaContextContractStore } from "~/persistence/prisma/context-contract.prisma.js";
import { PrismaValidationContractStore } from "~/persistence/prisma/validation-contract.prisma.js";
import { PrismaValidationResultStore } from "~/persistence/prisma/validation-result.prisma.js";
import { PrismaReviewFindingStore } from "~/persistence/prisma/review-finding.prisma.js";
import { createActivities } from "~/activities/index.js";
import { DiscoveryService } from "~/domain/products/discovery-service.js";
import type { RepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";
import { buildServer } from "~/http/server.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { testAuth, testServerEnv, TEST_MASTER_KEY, unusedSetupCalls } from "./support/admin-access.js";
import type { AgentSessionPort, WorkItemPort } from "~/domain/runs/ports.js";
import { MemoryAgentSessionStore } from "../support/memory-agent-session-store.js";

const secret = "webhook-secret";
const TASK_QUEUE = "factoree-at01";

const redactor = new Redactor();
const logger = createLogger({ level: "error", redactor, sink: () => undefined });
const acknowledged: string[] = [];
const agentSession: AgentSessionPort = {
  acknowledge: async (sessionId) => {
    acknowledged.push(sessionId);
  },
  progress: async () => undefined,
  elicit: async () => undefined,
  respond: async () => undefined,
  fail: async () => undefined,
  addLink: async () => undefined,
};

// SDD section 28. This test drives no high-risk label, so an empty list keeps the Project
// default autonomy level, in the same way an issue with no label does in production.
const workItems: WorkItemPort = {
  facts: async () => ({ labels: [], project: null }),
};

let prisma: FactoreePrismaClient;
let stopDatabase: () => Promise<void>;
let stopTemporal: () => Promise<void>;
let environment: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;
let app: ReturnType<typeof buildServer>;

const payload = JSON.parse(readFileSync("tests/fixtures/linear/agent-session-created.json", "utf8")) as Record<string, unknown>;

const send = async (body: Record<string, unknown>, deliveryId: string) => {
  const raw = JSON.stringify({ ...body, webhookTimestamp: Date.now() });
  return app.inject({
    method: "POST",
    url: "/webhooks/linear",
    headers: {
      "content-type": "application/json",
      "linear-signature": createHmac("sha256", secret).update(raw).digest("hex"),
      "linear-delivery": deliveryId,
    },
    payload: raw,
  });
};

beforeAll(async () => {
  const database = await startDatabase();
  stopDatabase = database.stop;
  prisma = createPrismaClient(database.url);

  const temporal = await startTemporal();
  environment = temporal.environment;
  stopTemporal = temporal.stop;

  const tenants = new PrismaTenantRegistry(prisma, TEST_MASTER_KEY);
  const products = new PrismaProductRegistry(prisma);
  const repositories = new PrismaRepositoryRegistry(prisma);
  const tenant = await tenants.ensureTenant("workspace-123", "Acme");
  const product = await products.create({
    tenantId: tenant.id,
    slug: "demo",
    name: "Demo",
    linearTeamKey: "TEAM",
    linearTeamId: "team-1",
  });
  await repositories.upsert({
    tenantId: tenant.id,
    productId: product.id,
    fullName: "acme/demo",
    defaultBranch: "main",
    configSha: "a".repeat(40),
    requestedSecretNames: [],
    linearProjects: [],
    githubInstallationId: "install-1",
  });

  const runs = new PrismaRunRepository(prisma);
  const fakeSandbox = new FakeSandbox();
  // The Phase 1 path never runs an installation sync, so this double only satisfies the shape.
  const discoveryClient: RepositoryDiscoveryClient = {
    listInstallationRepositories: () => Promise.reject(new Error("this test never syncs")),
    readConfig: () => Promise.reject(new Error("this test never syncs")),
  };

  worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: new URL("../../src/workflows/agent-run.workflow.ts", import.meta.url).pathname,
    activities: createActivities({
      runs,
      runSlots: new PrismaRunSlots(prisma),
      products,
      repositories,
      agentSession,
      workItems,
      // This test drives the Phase 1 path, which carries no sandbox. The doubles below satisfy
      // the dependency shape and never run.
      sandboxManager: new SandboxManager({ sandbox: fakeSandbox, allowUnenforcedNetwork: true }),
      sandbox: fakeSandbox,
      runners: new AgentRunnerRegistry([new FakeRunner()]),
      sessions: new MemoryAgentSessionStore(),
      executions: new PrismaAgentExecutionRepository(prisma),
      secrets: new PrismaSecretStore(prisma, TEST_MASTER_KEY),
      evidence: new PrismaEvidenceStore(prisma),
      redactor,
      reaper: new SpriteReaper({ sandboxes: { fake: fakeSandbox }, runs }),
      refinement: new RefinementEngine(),
      contextResolver: new ContextResolver(),
      contextContracts: new PrismaContextContractStore(prisma),
      validationContracts: new PrismaValidationContractStore(prisma),
      // This test drives the Phase 1 path, which never reaches context resolution.
      contextSources: { sourcesFor: () => Promise.resolve(new ContextSourceRegistry([])) },
      repositoryReader: new GitRepositoryReader(),
      // This test drives the Phase 1 path, which never reaches user validation.
      browser: { name: "unused", run: () => Promise.reject(new Error("unused")) },
      httpValidationFetch: () => Promise.reject(new Error("unused")),
      previewProbe: () => Promise.resolve(null),
      evidenceStorage: { name: "unused", put: () => Promise.reject(new Error("unused")) },
      validationResults: new PrismaValidationResultStore(prisma),
      reviewFindings: new PrismaReviewFindingStore(prisma),
      // The Phase 1 path never publishes, so these two doubles only satisfy the shape.
      pullRequests: () => ({
        findByHead: () => Promise.reject(new Error("this test never publishes")),
        create: () => Promise.reject(new Error("this test never publishes")),
      }),
      gitAuthor: () => Promise.resolve({ name: "Factoree", email: "factoree@users.noreply.github.com" }),
      logger,
      // The Phase 1 path never clones, never reads a private repository, and never publishes,
      // so this double only satisfies the shape.
      tokens: { tokenForInstallation: () => Promise.reject(new Error("this test never mints")) },
      // The Phase 1 path never runs an installation sync, so these two doubles only satisfy the
      // shape.
      discoveryClient,
      discoveryService: new DiscoveryService(
        discoveryClient,
        products,
        repositories,
        { resolveTeamKey: () => Promise.reject(new Error("this test never syncs")), resolveTeamId: () => Promise.reject(new Error("this test never syncs")) },
        logger,
      ),
      repositoryBaseUrl: () => Promise.resolve("https://github.com"),
    }),
  });
  workerRun = worker.run();

  // docs/specs/release-0-1-0.md. The Linear webhook secret is an install setting.
  const access = testAuth(prisma, logger);
  await access.settings.update({ linear: { webhookSecret: secret } });
  app = buildServer({
    env: testServerEnv,
    version: "test",
    logger,
    prisma,
    settings: access.settings,
    auth: access.auth,
    setup: unusedSetupCalls,
    tenants,
    products,
    repositories,
    // This test never exercises the Products administration route. It resolves nothing.
    linearTeams: {
      resolveTeamKey: () => Promise.reject(new Error("unused")),
      resolveTeamId: () => Promise.reject(new Error("unused")),
    },
    secrets: new PrismaSecretStore(prisma, TEST_MASTER_KEY),
    runs: new PrismaRunRepository(prisma),
    delegation: new DelegationService({
      tenants,
      products,
      repositories,
      webhookLog: new PrismaWebhookLog(prisma),
      starter: createTemporalWorkflowStarter(environment.client, TASK_QUEUE),
      refusalNotifier: { postFailure: () => Promise.resolve(undefined), postResponse: () => Promise.resolve(undefined) },
      logger,
      repositoryBaseUrl: () => Promise.resolve("https://github.com"),
    }),
    // This test drives the Phase 1 delegation path, which never exercises the GitHub webhook
    // route. These doubles only satisfy the shape `buildServer` now requires.
    discovery: new DiscoveryService(
      discoveryClient,
      products,
      repositories,
      { resolveTeamKey: () => Promise.reject(new Error("unused")), resolveTeamId: () => Promise.reject(new Error("unused")) },
      logger,
    ),
    startInstallationSync: () => Promise.reject(new Error("unused")),
    recordPullRequestPreview: () => Promise.reject(new Error("unused")),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  worker.shutdown();
  await workerRun;
  await prisma.$disconnect();
  await stopTemporal();
  await stopDatabase();
});

const waitForRun = async (sessionId: string): Promise<void> => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const count = await prisma.run.count({ where: { linearAgentSessionId: sessionId } });
    if (count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no Run appeared for ${sessionId}`);
};

// Polls until the Run count for a session reads the expected value on three consecutive
// checks, rather than sleeping a fixed duration and hoping the count has settled.
const waitForStableRunCount = async (sessionId: string, expected: number): Promise<void> => {
  let stableReadings = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const count = await prisma.run.count({ where: { linearAgentSessionId: sessionId } });
    stableReadings = count === expected ? stableReadings + 1 : 0;
    if (stableReadings >= 3) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Run count for ${sessionId} never stabilized at ${expected}`);
};

describe("AT-01 delegation", () => {
  it("creates exactly one Run for one delegation and ignores a duplicate delivery", async () => {
    const first = await send(payload, "delivery-at01");
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ kind: "started" });

    await waitForRun("session-1");

    const duplicate = await send(payload, "delivery-at01");
    expect(duplicate.json()).toEqual({ kind: "duplicate" });

    // A repeated Linear delivery with a new delivery identifier still must not create a
    // second Run. The deterministic Temporal workflow identifier stops it: the second start
    // raises WorkflowExecutionAlreadyStartedError before any activity runs. The unique
    // linearAgentSessionId column is a database backstop, covered by the repository test.
    const differentDelivery = await send(payload, "delivery-at01-b");
    expect(differentDelivery.json()).toMatchObject({ kind: "started" });

    await waitForStableRunCount("session-1", 1);
    expect(await prisma.run.count({ where: { linearAgentSessionId: "session-1" } })).toBe(1);
    expect(acknowledged.filter((id) => id === "session-1")).toHaveLength(1);
  });

  it("rejects a webhook with a wrong signature", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/linear",
      headers: { "content-type": "application/json", "linear-signature": "00", "linear-delivery": "bad" },
      payload: JSON.stringify(payload),
    });
    expect(response.statusCode).toBe(401);
  });
});
