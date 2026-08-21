import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";
import {
  PrismaProjectRegistry,
  PrismaSecretStore,
  PrismaTenantRegistry,
} from "~/persistence/prisma/project-registry.prisma.js";
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { buildServer } from "~/http/server.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { Env } from "~/config/env.js";

const token = "t".repeat(32);
const env = {
  DATABASE_URL: "",
  FACTOREE_SECRET_KEY: "c".repeat(64),
  ADMIN_API_TOKEN: token,
  LINEAR_WEBHOOK_SECRET: "webhook-secret",
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "factoree",
  PORT: 3000,
  LOG_LEVEL: "error",
} satisfies Env;

let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let app: ReturnType<typeof buildServer>;

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  const tenants = new PrismaTenantRegistry(prisma, env.FACTOREE_SECRET_KEY);
  app = buildServer({
    env,
    logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
    prisma,
    projects: new PrismaProjectRegistry(prisma),
    tenants,
    secrets: new PrismaSecretStore(prisma, env.FACTOREE_SECRET_KEY),
    runs: new PrismaRunRepository(prisma),
    delegation: new DelegationService({
      tenants,
      projects: new PrismaProjectRegistry(prisma),
      webhookLog: new PrismaWebhookLog(prisma),
      starter: { start: vi.fn(() => Promise.resolve(undefined)), signalStop: vi.fn(() => Promise.resolve(true)), signalHumanInput: vi.fn(() => Promise.resolve(true)) },
      logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
    }),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await stop();
});

const auth = { authorization: `Bearer ${token}` };

describe("administration API", () => {
  it("reports health and readiness", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });

  it("rejects an administration request without the token", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/projects?linearWorkspaceId=ws-1" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a wrong token of the same length and a token of a different length", async () => {
    const sameLength = await app.inject({
      method: "GET",
      url: "/admin/projects?linearWorkspaceId=ws-1",
      headers: { authorization: `Bearer ${"x".repeat(token.length)}` },
    });
    expect(sameLength.statusCode).toBe(401);

    const otherLength = await app.inject({
      method: "GET",
      url: "/admin/projects?linearWorkspaceId=ws-1",
      headers: { authorization: `Bearer ${token}extra` },
    });
    expect(otherLength.statusCode).toBe(401);
  });

  it("serves metrics only with the administration token", async () => {
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    const authorized = await app.inject({ method: "GET", url: "/metrics", headers: auth });
    expect(authorized.statusCode).toBe(200);
  });

  it("creates, reads, updates, and deletes a project", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/projects",
      headers: auth,
      payload: {
        linearWorkspaceId: "ws-admin",
        workspaceName: "Admin",
        key: "demo",
        name: "Demo",
        primaryRepository: "acme/demo",
        linearTeamId: "team-1",
      },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json<{ id: string }>();

    const read = await app.inject({
      method: "GET",
      url: `/admin/projects/${project.id}?linearWorkspaceId=ws-admin`,
      headers: auth,
    });
    expect(read.statusCode).toBe(200);

    const updated = await app.inject({
      method: "PUT",
      url: `/admin/projects/${project.id}?linearWorkspaceId=ws-admin`,
      headers: auth,
      payload: { name: "Renamed" },
    });
    expect(updated.json<{ name: string }>().name).toBe("Renamed");

    const removed = await app.inject({
      method: "DELETE",
      url: `/admin/projects/${project.id}?linearWorkspaceId=ws-admin`,
      headers: auth,
    });
    expect(removed.statusCode).toBe(204);
  });

  it("stores a project secret as ciphertext and reads it back through the secret store", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/projects",
      headers: auth,
      payload: {
        linearWorkspaceId: "ws-secret",
        workspaceName: "Secret",
        key: "s",
        name: "S",
        primaryRepository: "acme/s",
      },
    });
    const project = created.json<{ id: string }>();
    const put = await app.inject({
      method: "PUT",
      url: `/admin/projects/${project.id}/secrets/GITHUB_TOKEN?linearWorkspaceId=ws-secret`,
      headers: auth,
      payload: { value: "ghp_super_secret_value_12345678" },
    });
    expect(put.statusCode).toBe(204);
    const read = await app.inject({
      method: "GET",
      url: `/admin/projects/${project.id}?linearWorkspaceId=ws-secret`,
      headers: auth,
    });
    expect(read.body).not.toContain("ghp_super_secret_value_12345678");

    const stored = await prisma.projectSecret.findFirstOrThrow({ where: { projectId: project.id } });
    expect(JSON.stringify(stored)).not.toContain("ghp_super_secret_value_12345678");
    const secrets = new PrismaSecretStore(prisma, env.FACTOREE_SECRET_KEY);
    expect(await secrets.get(stored.tenantId, project.id, "GITHUB_TOKEN")).toBe(
      "ghp_super_secret_value_12345678",
    );
  });

  it("does not return a project of another tenant", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/projects",
      headers: auth,
      payload: {
        linearWorkspaceId: "ws-owner",
        workspaceName: "Owner",
        key: "own",
        name: "Own",
        primaryRepository: "acme/own",
      },
    });
    const project = created.json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: "/admin/projects",
      headers: auth,
      payload: {
        linearWorkspaceId: "ws-other",
        workspaceName: "Other",
        key: "oth",
        name: "Oth",
        primaryRepository: "acme/oth",
      },
    });
    const stolen = await app.inject({
      method: "GET",
      url: `/admin/projects/${project.id}?linearWorkspaceId=ws-other`,
      headers: auth,
    });
    expect(stolen.statusCode).toBe(404);
  });
});
