import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaTenantRegistry } from "~/persistence/prisma/product-registry.prisma.js";

const key = "b".repeat(64);
let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let tenants: PrismaTenantRegistry;

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  tenants = new PrismaTenantRegistry(prisma, key);
});

afterAll(async () => {
  await prisma.$disconnect();
  await stop();
});

/**
 * Task 12 deleted `tests/integration/project-registry.test.ts`, which carried this assertion as
 * a side effect of setting up a Project fixture. `PrismaTenantRegistry` outlived Project, and
 * this is its only coverage against a real database, so the assertion moves here rather than
 * disappearing with the file that named it.
 */
describe("tenant registry", () => {
  it("stores the installation access token encrypted", async () => {
    await tenants.putInstallation({
      linearWorkspaceId: "ws-tenant-registry-7",
      workspaceName: "Workspace Seven",
      accessToken: "lin_oauth_abcdefghijklmnopqrstuvwxyz012345",
    });
    const row = await prisma.linearInstallation.findFirstOrThrow({
      where: { linearWorkspaceId: "ws-tenant-registry-7" },
    });
    expect(row.accessTokenCipher).not.toContain("lin_oauth_abcdefghijklmnopqrstuvwxyz012345");
    expect(await tenants.getInstallationToken("ws-tenant-registry-7")).toBe(
      "lin_oauth_abcdefghijklmnopqrstuvwxyz012345",
    );
  });
});
