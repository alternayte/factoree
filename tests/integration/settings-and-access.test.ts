import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { startDatabase } from "./support/database.js";
import { seedAdminKey, testAuth, testServerEnv, TEST_MASTER_KEY, unusedSetupCalls } from "./support/admin-access.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaInstallSettingsStore } from "~/persistence/prisma/install-settings.prisma.js";
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
import { authorize } from "~/http/auth/admin-guard.js";
import {
  admitLinearAccount,
  admitUser,
  NotAMemberError,
  principalFor,
  recordLinearMember,
} from "~/http/auth/membership.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { AuthHandle } from "~/http/auth/auth.js";
import type { FastifyRequest } from "fastify";

/**
 * docs/specs/release-0-1-0.md. The install settings are encrypted at rest and read for each use,
 * a Linear sign-in admits only members of a set-up workspace, and a revoked API key stops at once.
 */
let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let app: FastifyInstance;
let auth: AuthHandle;
let settings: PrismaInstallSettingsStore;

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  const logger = createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined });
  const access = testAuth(prisma, logger);
  auth = access.auth;
  settings = access.settings;
  const tenants = new PrismaTenantRegistry(prisma, TEST_MASTER_KEY);
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
    auth,
    setup: unusedSetupCalls,
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
      { listInstallationRepositories: () => Promise.reject(new Error("unused")), readConfig: () => Promise.reject(new Error("unused")), listFiles: () => Promise.reject(new Error("unused")) },
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

describe("the install settings", () => {
  it("stores each credential as cipher text and reads it back as the value", async () => {
    await settings.update({
      github: { appId: "123", privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n", webhookSecret: "gh-hook-secret" },
      linear: { clientId: "linear-client", clientSecret: "linear-client-secret", webhookSecret: "linear-hook-secret" },
      sandbox: { registryUsername: "robot", registryToken: "registry-token" },
    });

    const row = await prisma.installSettings.findUniqueOrThrow({ where: { id: "install" } });
    const stored = JSON.stringify(row);
    for (const plain of ["gh-hook-secret", "linear-client-secret", "linear-hook-secret", "registry-token", "BEGIN PRIVATE KEY"]) {
      expect(stored).not.toContain(plain);
    }

    const read = await settings.read();
    expect(read.github.webhookSecret).toBe("gh-hook-secret");
    expect(read.github.privateKey).toBe("-----BEGIN PRIVATE KEY-----\nkey\n");
    expect(read.linear.clientSecret).toBe("linear-client-secret");
    expect(read.sandbox.registryToken).toBe("registry-token");

    // Another master key cannot read the credentials.
    await expect(new PrismaInstallSettingsStore(prisma, "d".repeat(64)).read()).rejects.toThrow();
  });

  it("keeps a field the patch leaves out and clears one the patch sets to null", async () => {
    await settings.update({ sandbox: { registryUsername: null } });
    const read = await settings.read();
    expect(read.sandbox.registryUsername).toBeNull();
    expect(read.sandbox.registryToken).toBe("registry-token");
  });
});

describe("the webhook secrets", () => {
  const linearDelivery = (secret: string) => {
    const raw = JSON.stringify({ type: "Ping", webhookTimestamp: Date.now() });
    return app.inject({
      method: "POST",
      url: "/webhooks/linear",
      headers: {
        "content-type": "application/json",
        "linear-signature": createHmac("sha256", secret).update(raw).digest("hex"),
      },
      payload: raw,
    });
  };

  const githubDelivery = (secret: string) => {
    const raw = JSON.stringify({ zen: "ping" });
    return app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
      },
      payload: raw,
    });
  };

  it("verifies each delivery with the secret the install settings hold at that moment", async () => {
    await settings.update({ linear: { webhookSecret: "first-linear-secret" }, github: { webhookSecret: "first-github-secret" } });
    expect((await linearDelivery("first-linear-secret")).statusCode).toBe(202);
    expect((await githubDelivery("first-github-secret")).statusCode).not.toBe(401);

    // A secret changed in the UI applies to the next delivery, with no restart.
    await settings.update({ linear: { webhookSecret: "second-linear-secret" }, github: { webhookSecret: "second-github-secret" } });
    expect((await linearDelivery("first-linear-secret")).statusCode).toBe(401);
    expect((await githubDelivery("first-github-secret")).statusCode).toBe(401);
    expect((await linearDelivery("second-linear-secret")).statusCode).toBe(202);
    expect((await githubDelivery("second-github-secret")).statusCode).not.toBe(401);
  });

  it("refuses a delivery while no secret is stored", async () => {
    await settings.update({ linear: { webhookSecret: null }, github: { webhookSecret: null } });
    expect((await linearDelivery("anything")).statusCode).toBe(503);
    expect((await githubDelivery("anything")).statusCode).toBe(401);
  });
});

describe("the sign-in membership hook", () => {
  it("admits a member of a set-up workspace, refuses an outsider, and drops a member who left", async () => {
    await prisma.tenant.create({ data: { linearWorkspaceId: "org-member", name: "Member workspace" } });

    await recordLinearMember(prisma, { id: "linear-alice", admin: false, organizationId: "org-member" });
    await expect(admitLinearAccount(prisma, "linear-alice")).resolves.toBeUndefined();

    await recordLinearMember(prisma, { id: "linear-mallory", admin: true, organizationId: "org-stranger" });
    await expect(admitLinearAccount(prisma, "linear-mallory")).rejects.toBeInstanceOf(NotAMemberError);

    // Alice signs in again from a workspace Factoree is not installed in.
    await recordLinearMember(prisma, { id: "linear-alice", admin: false, organizationId: "org-stranger" });
    await expect(admitLinearAccount(prisma, "linear-alice")).rejects.toBeInstanceOf(NotAMemberError);
  });

  it("makes a Linear workspace admin a Factoree admin of that workspace, and only of that one", async () => {
    const now = new Date();
    const tenant = await prisma.tenant.create({ data: { linearWorkspaceId: "org-admins", name: "Admins" } });
    await prisma.tenant.create({ data: { linearWorkspaceId: "org-elsewhere", name: "Elsewhere" } });
    for (const [userId, linearUserId, admin] of [
      ["user-admin", "linear-admin", true],
      ["user-member", "linear-member", false],
    ] as const) {
      await prisma.user.create({
        data: { id: userId, name: userId, email: `${userId}@example.test`, emailVerified: false, createdAt: now, updatedAt: now },
      });
      await prisma.account.create({
        data: { id: `account-${userId}`, accountId: linearUserId, providerId: "linear", userId, createdAt: now, updatedAt: now },
      });
      await recordLinearMember(prisma, { id: linearUserId, admin, organizationId: "org-admins" });
      await expect(admitUser(prisma, userId)).resolves.toBeUndefined();
    }

    const request = (method: string, linearWorkspaceId: string) =>
      ({ method, query: { linearWorkspaceId }, body: undefined }) as unknown as FastifyRequest;
    const admin = await principalFor(prisma, "user-admin", null, tenant.id);
    const member = await principalFor(prisma, "user-member", null, tenant.id);
    expect(admin?.operatorAdmin).toBe(true);
    expect(member?.operatorAdmin).toBe(false);

    expect(authorize(admin!, request("PUT", "org-admins"))).toBeNull();
    expect(authorize(member!, request("GET", "org-admins"))).toBeNull();
    expect(authorize(member!, request("PUT", "org-admins"))?.status).toBe(403);
    expect(authorize(admin!, request("GET", "org-elsewhere"))?.status).toBe(403);
  });
});

describe("API keys", () => {
  it("authenticate a script, record the key on every call, and stop with 401 after a revoke", async () => {
    const { key, keyId, userId } = await seedAdminKey(prisma, auth, { workspaces: ["ws-keys"] });
    const headers = { authorization: `Bearer ${key}` };

    const read = await app.inject({ method: "GET", url: "/admin/products?linearWorkspaceId=ws-keys", headers });
    expect(read.statusCode).toBe(200);
    const entry = await prisma.adminAuditEntry.findFirst({ where: { apiKeyId: keyId }, orderBy: { createdAt: "desc" } });
    expect(entry).toMatchObject({ userId, apiKeyId: keyId, method: "GET", path: "/admin/products", statusCode: 200 });

    // A key never makes another key.
    const minted = await app.inject({ method: "POST", url: "/admin/api-keys", headers, payload: { name: "second" } });
    expect(minted.statusCode).toBe(403);

    const revoked = await app.inject({ method: "DELETE", url: `/admin/api-keys/${keyId}`, headers });
    expect(revoked.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: "/admin/products?linearWorkspaceId=ws-keys", headers });
    expect(after.statusCode).toBe(401);
    const refused = await prisma.adminAuditEntry.findFirst({ where: { statusCode: 401 }, orderBy: { createdAt: "desc" } });
    expect(refused).toMatchObject({ userId: null, apiKeyId: null, path: "/admin/products" });
  });

  it("refuses a key whose person is no longer a member of any set-up workspace", async () => {
    const { key, userId } = await seedAdminKey(prisma, auth, { workspaces: ["ws-left"] });
    const accounts = await prisma.account.findMany({ where: { userId } });
    await prisma.linearMember.deleteMany({ where: { linearUserId: { in: accounts.map((account) => account.accountId) } } });

    const response = await app.inject({
      method: "GET",
      url: "/admin/products?linearWorkspaceId=ws-left",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(response.statusCode).toBe(401);
  });
});
