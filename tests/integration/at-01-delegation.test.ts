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
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { createTemporalWorkflowStarter } from "~/temporal/connection.js";
import { createActivities } from "~/activities/index.js";
import { buildServer } from "~/http/server.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { Env } from "~/config/env.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";

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
} satisfies Env;

const logger = createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined });
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

  worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: env.TEMPORAL_TASK_QUEUE,
    workflowsPath: new URL("../../src/workflows/agent-run.workflow.ts", import.meta.url).pathname,
    activities: createActivities({ runs: new PrismaRunRepository(prisma), agentSession, logger }),
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

describe("AT-01 delegation", () => {
  it("creates exactly one Run for one delegation and ignores a duplicate delivery", async () => {
    const first = await send(payload, "delivery-at01");
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ kind: "started" });

    await waitForRun("session-1");

    const duplicate = await send(payload, "delivery-at01");
    expect(duplicate.json()).toEqual({ kind: "duplicate" });

    const differentDelivery = await send(payload, "delivery-at01-b");
    expect(differentDelivery.json()).toMatchObject({ kind: "started" });

    await new Promise((resolve) => setTimeout(resolve, 1000));
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
