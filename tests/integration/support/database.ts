import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";

export const startDatabase = async (): Promise<{ url: string; stop: () => Promise<void> }> => {
  const container = await new PostgreSqlContainer("postgres:16").start();
  const url = container.getConnectionUri();
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    });
  } catch (error) {
    // Stop the container, so a migration failure does not leak it.
    await container.stop();
    throw error;
  }
  return { url, stop: () => container.stop().then(() => undefined) };
};

/**
 * Starts a database, runs the callback with a connected Prisma client, and stops the database
 * afterward. Use this helper when a test needs only one short-lived database, not a suite-wide
 * client shared across many tests.
 */
export const withDatabase = async (
  run: (prisma: FactoreePrismaClient) => Promise<void>,
): Promise<void> => {
  const database = await startDatabase();
  const prisma = createPrismaClient(database.url);
  try {
    await run(prisma);
  } finally {
    await prisma.$disconnect();
    await database.stop();
  }
};

/**
 * Creates a Tenant, a Product, and a Run in one call, for a test that needs a valid Run to
 * attach a related record to and does not care about the Run's other field values.
 *
 * The returned key names the seeded Product's id `productId`, because `Run.productId` carries a
 * real foreign key to `Product`, and no longer accepts a `Project` id.
 */
export const seedTenantProjectAndRun = async (
  prisma: FactoreePrismaClient,
): Promise<{ tenantId: string; productId: string; runId: string }> => {
  const suffix = randomUUID();
  const tenant = await prisma.tenant.create({
    data: { linearWorkspaceId: `ws-${suffix}`, name: `Tenant ${suffix}` },
  });
  const product = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      slug: `demo-${suffix}`,
      name: `Demo ${suffix}`,
      linearTeamKey: `TEAM-${suffix}`,
      linearTeamId: `team-${suffix}`,
    },
  });
  const run = await prisma.run.create({
    data: {
      tenantId: tenant.id,
      productId: product.id,
      linearAgentSessionId: `session-${suffix}`,
      temporalWorkflowId: `workflow-${suffix}`,
      status: "RECEIVED",
      autonomyLevel: "L2",
    },
  });
  return { tenantId: tenant.id, productId: product.id, runId: run.id };
};
