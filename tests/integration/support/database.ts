import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { inject } from "vitest";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";

/**
 * Opens an administrative connection to the shared container's maintenance database.
 * A session must not connect to the template database itself, because Postgres refuses
 * to copy a template database that carries an open connection, including its own.
 */
const openMaintenanceClient = (): Client => {
  const template = inject("templateDatabase");
  const client = new Client({
    host: template.host,
    port: template.port,
    user: template.user,
    password: template.password,
    database: template.maintenanceDatabase,
  });
  return client;
};

const buildUrl = (databaseName: string): string => {
  const template = inject("templateDatabase");
  return `postgresql://${template.user}:${template.password}@${template.host}:${template.port}/${databaseName}`;
};

/**
 * Creates one database inside the shared container, as a `CREATE DATABASE ... TEMPLATE`
 * copy of the already-migrated template database. This costs milliseconds, not the
 * seconds a fresh container and a fresh migration cost.
 */
export const startDatabase = async (): Promise<{ url: string; stop: () => Promise<void> }> => {
  const template = inject("templateDatabase");
  const databaseName = `test_${randomUUID().replace(/-/g, "")}`;

  const admin = openMaintenanceClient();
  await admin.connect();
  try {
    await admin.query(
      `CREATE DATABASE "${databaseName}" TEMPLATE "${template.templateDatabase}"`,
    );
  } finally {
    await admin.end();
  }

  const stop = async (): Promise<void> => {
    const dropClient = openMaintenanceClient();
    await dropClient.connect();
    try {
      // Terminate every remaining connection to the database, so the drop does not fail.
      await dropClient.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await dropClient.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
      await dropClient.end();
    }
  };

  return { url: buildUrl(databaseName), stop };
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
