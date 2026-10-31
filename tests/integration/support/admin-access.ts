import { randomUUID } from "node:crypto";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { AuthHandle } from "~/http/auth/auth.js";
import { PrismaInstallSettingsStore } from "~/persistence/prisma/install-settings.prisma.js";
import type { ServerDependencies } from "~/http/server.js";
import type { Logger } from "~/telemetry/logger.js";

export const TEST_MASTER_KEY = "c".repeat(64);
export const TEST_PUBLIC_URL = "http://localhost:3000";

export const testServerEnv: ServerDependencies["env"] = {
  FACTOREE_PUBLIC_URL: TEST_PUBLIC_URL,
  FACTOREE_MASTER_KEY: TEST_MASTER_KEY,
  FACTOREE_UNSAFE_LOCAL_SANDBOX: undefined,
};

/** The settings store and the auth handle of a test server, on the test database. */
export const testAuth = (prisma: FactoreePrismaClient, logger: Logger) => {
  const settings = new PrismaInstallSettingsStore(prisma, TEST_MASTER_KEY);
  const auth = new AuthHandle({ prisma, settings, publicUrl: TEST_PUBLIC_URL, masterKey: TEST_MASTER_KEY, logger });
  return { settings, auth };
};

/** Setup calls the tests never make. A call fails the test that made it. */
export const unusedSetupCalls: ServerDependencies["setup"] = {
  github: {
    convertManifest: () => Promise.reject(new Error("unused")),
    readInstallation: () => Promise.reject(new Error("unused")),
  },
  linear: {
    exchangeCode: () => Promise.reject(new Error("unused")),
    readOrganization: () => Promise.reject(new Error("unused")),
    listTeams: () => Promise.reject(new Error("unused")),
  },
};

/**
 * A signed-in person, as the Linear sign-in leaves one: a better-auth user, one Linear account
 * per workspace, the membership rows the sign-in records, and an API key of that person.
 */
export const seedAdminKey = async (
  prisma: FactoreePrismaClient,
  auth: AuthHandle,
  input: { workspaces: string[]; admin?: boolean },
): Promise<{ key: string; keyId: string; userId: string }> => {
  const now = new Date();
  const userId = randomUUID();
  await prisma.user.create({
    data: { id: userId, name: "Operator", email: `${userId}@example.test`, emailVerified: false, createdAt: now, updatedAt: now },
  });
  for (const workspace of input.workspaces) {
    const tenant = await prisma.tenant.upsert({
      where: { linearWorkspaceId: workspace },
      create: { linearWorkspaceId: workspace, name: workspace },
      update: {},
    });
    const linearUserId = `linear-user-${randomUUID()}`;
    await prisma.account.create({
      data: { id: randomUUID(), accountId: linearUserId, providerId: "linear", userId, createdAt: now, updatedAt: now },
    });
    await prisma.linearMember.create({ data: { linearUserId, tenantId: tenant.id, admin: input.admin ?? true } });
  }
  const created = await (await auth.current()).api.createApiKey({ body: { name: "test", userId } });
  return { key: created.key, keyId: created.id, userId };
};
