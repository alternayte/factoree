import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { startDatabase } from "./support/database.js";
import { testAuth, testServerEnv, TEST_MASTER_KEY, unusedSetupCalls } from "./support/admin-access.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import type { PrismaInstallSettingsStore } from "~/persistence/prisma/install-settings.prisma.js";
import {
  PrismaProductRegistry,
  PrismaRepositoryRegistry,
  PrismaSecretStore,
  PrismaTenantRegistry,
} from "~/persistence/prisma/product-registry.prisma.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { DiscoveryService } from "~/domain/products/discovery-service.js";
import { buildServer } from "~/http/server.js";
import { issueSetupToken } from "~/http/setup/setup-token.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";

/**
 * docs/specs/release-0-1-0.md. A workspace that holds the Linear app from before setup cannot
 * install it again, so setup takes over its stored installation. The stored token must still
 * work, and an installation of another GitHub App does not stay bound.
 */
let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let app: FastifyInstance;
let tenants: PrismaTenantRegistry;
let setupAuth: { authorization: string };
let settings: PrismaInstallSettingsStore;

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  const logger = createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined });
  const access = testAuth(prisma, logger);
  settings = access.settings;
  tenants = new PrismaTenantRegistry(prisma, TEST_MASTER_KEY);
  const products = new PrismaProductRegistry(prisma);
  const repositories = new PrismaRepositoryRegistry(prisma);
  const linearTeams = {
    resolveTeamKey: () => Promise.reject(new Error("unused")),
    resolveTeamId: () => Promise.reject(new Error("unused")),
  };
  app = buildServer({
    env: testServerEnv,
    version: "test",
    logger,
    prisma,
    settings,
    auth: access.auth,
    setup: {
      ...unusedSetupCalls,
      github: {
        ...unusedSetupCalls.github,
        // Only installation 111 belongs to the App of these settings.
        readInstallation: ({ installationId }) =>
          Promise.resolve(installationId === "111" ? { id: "111", accountLogin: "acme" } : null),
      },
      linear: {
        ...unusedSetupCalls.linear,
        listTeams: (linearWorkspaceId) =>
          linearWorkspaceId === "ws-working"
            ? Promise.resolve([{ id: "team-1", key: "ACM", name: "Acme" }])
            : Promise.reject(new Error("the Linear token is revoked")),
      },
    },
    tenants,
    products,
    repositories,
    linearTeams,
    secrets: new PrismaSecretStore(prisma, TEST_MASTER_KEY),
    runs: new PrismaRunRepository(prisma),
    delegation: new DelegationService({
      tenants,
      products,
      repositories,
      webhookLog: new PrismaWebhookLog(prisma),
      starter: {
        start: vi.fn(() => Promise.resolve(undefined)),
        signalStop: vi.fn(() => Promise.resolve(true)),
        signalHumanInput: vi.fn(() => Promise.resolve(true)),
      },
      refusalNotifier: { postFailure: () => Promise.resolve(undefined), postResponse: () => Promise.resolve(undefined) },
      logger,
      repositoryBaseUrl: () => Promise.resolve("https://github.com"),
    }),
    discovery: new DiscoveryService(
      { listInstallationRepositories: () => Promise.reject(new Error("unused")), readConfig: () => Promise.reject(new Error("unused")) },
      products,
      repositories,
      linearTeams,
      logger,
    ),
    startInstallationSync: () => Promise.reject(new Error("unused")),
    recordPullRequestPreview: () => Promise.reject(new Error("unused")),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await stop();
});

interface SetupStatus {
  linearInstall: { done: boolean; existing: Array<{ tenantId: string }> };
  githubInstall: { accounts: string[] };
}

describe("setup with a stored Linear installation", () => {
  beforeAll(async () => {
    await settings.update({
      github: { appId: "999", privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n", webhookSecret: "gh-hook-secret" },
    });
    const token = await issueSetupToken(settings);
    setupAuth = { authorization: `Bearer ${token ?? ""}` };
  });

  it("offers each stored installation while no setup workspace exists", async () => {
    const working = await tenants.putInstallation({
      linearWorkspaceId: "ws-working",
      workspaceName: "Working",
      accessToken: "token-working",
      scopes: ["read"],
    });
    await tenants.putInstallation({
      linearWorkspaceId: "ws-revoked",
      workspaceName: "Revoked",
      accessToken: "token-revoked",
      scopes: ["read"],
    });

    const response = await app.inject({ method: "GET", url: "/api/setup/status", headers: setupAuth });

    expect(response.statusCode).toBe(200);
    const existing = response.json<SetupStatus>().linearInstall.existing;
    expect(existing.map((candidate) => candidate.tenantId)).toContain(working.id);
  });

  it("refuses without the setup token", async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { linearWorkspaceId: "ws-working" } });
    const response = await app.inject({
      method: "POST",
      url: "/api/setup/linear/adopt",
      payload: { tenantId: tenant.id },
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses an installation whose stored token no longer works", async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { linearWorkspaceId: "ws-revoked" } });
    const response = await app.inject({
      method: "POST",
      url: "/api/setup/linear/adopt",
      headers: setupAuth,
      payload: { tenantId: tenant.id },
    });
    expect(response.statusCode).toBe(422);
    expect((await settings.read()).operatorTenantId).toBeNull();
  });

  it("takes over a working installation and unbinds the installations of another App", async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { linearWorkspaceId: "ws-working" } });
    await tenants.putGitHubInstallation(tenant.id, "111", "acme");
    await tenants.putGitHubInstallation(tenant.id, "222", "acme");

    const response = await app.inject({
      method: "POST",
      url: "/api/setup/linear/adopt",
      headers: setupAuth,
      payload: { tenantId: tenant.id },
    });

    expect(response.statusCode).toBe(200);
    expect((await settings.read()).operatorTenantId).toBe(tenant.id);
    const bound = await prisma.gitHubInstallation.findMany({ where: { tenantId: tenant.id } });
    expect(bound.map((installation) => installation.githubInstallationId)).toEqual(["111"]);
    const status = response.json<SetupStatus>();
    expect(status.linearInstall.done).toBe(true);
    expect(status.githubInstall.accounts).toEqual(["acme"]);
  });
});
