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
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";
import {
  PrismaProjectRegistry,
  PrismaSecretStore,
  PrismaTenantRegistry,
} from "~/persistence/prisma/project-registry.prisma.js";
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
import { buildServer } from "~/http/server.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { Env } from "~/config/env.js";
import type { AgentSessionPort, WorkItemPort } from "~/domain/runs/ports.js";

const secret = "webhook-secret";
const env = {
  DATABASE_URL: "",
  FACTOREE_SECRET_KEY: "d".repeat(64),
  ADMIN_API_TOKEN: "t".repeat(32),
  LINEAR_WEBHOOK_SECRET: secret,
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "factoree-at01",
  PORT: 3000,
  LOG_LEVEL: "error",
  SANDBOX_ADAPTER: "local",
  SANDBOX_LOCAL_ROOT: "/tmp/factoree-sandboxes",
  GITHUB_BASE_URL: "https://github.com",
  GITHUB_API_BASE_URL: "https://api.github.com",
  FACTOREE_GIT_AUTHOR_NAME: "Factoree",
  FACTOREE_GIT_AUTHOR_EMAIL: "factoree@users.noreply.github.com",
  EVIDENCE_STORAGE: "filesystem",
  EVIDENCE_LOCAL_ROOT: "/tmp/factoree-evidence-test",
} satisfies Env;

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
};

// SDD section 28. This test drives no high-risk label, so an empty list keeps the Project
// default autonomy level, in the same way an issue with no label does in production.
const workItems: WorkItemPort = {
  labels: async () => [],
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

  const tenants = new PrismaTenantRegistry(prisma, env.FACTOREE_SECRET_KEY);
  const projects = new PrismaProjectRegistry(prisma);
  const tenant = await tenants.ensureTenant("workspace-123", "Acme");
  await projects.create({
    tenantId: tenant.id,
    key: "demo",
    name: "Demo",
    primaryRepository: "acme/demo",
    linearTeamId: "team-1",
  });

  const runs = new PrismaRunRepository(prisma);
  const fakeSandbox = new FakeSandbox();

  worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: env.TEMPORAL_TASK_QUEUE,
    workflowsPath: new URL("../../src/workflows/agent-run.workflow.ts", import.meta.url).pathname,
    activities: createActivities({
      runs,
      agentSession,
      workItems,
      // This test drives the Phase 1 path, which carries no sandbox. The doubles below satisfy
      // the dependency shape and never run.
      sandboxManager: new SandboxManager({ sandbox: fakeSandbox, allowUnenforcedNetwork: true }),
      sandbox: fakeSandbox,
      runners: new AgentRunnerRegistry([new FakeRunner()]),
      executions: new PrismaAgentExecutionRepository(prisma),
      secrets: new PrismaSecretStore(prisma, env.FACTOREE_SECRET_KEY),
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
      gitAuthor: { name: "Factoree", email: "factoree@users.noreply.github.com" },
      logger,
    }),
  });
  workerRun = worker.run();

  app = buildServer({
    env,
    logger,
    prisma,
    projects,
    tenants,
    secrets: new PrismaSecretStore(prisma, env.FACTOREE_SECRET_KEY),
    runs: new PrismaRunRepository(prisma),
    delegation: new DelegationService({
      tenants,
      projects,
      webhookLog: new PrismaWebhookLog(prisma),
      starter: createTemporalWorkflowStarter(environment.client, env.TEMPORAL_TASK_QUEUE),
      logger,
      repositoryBaseUrl: "https://github.com",
    }),
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
