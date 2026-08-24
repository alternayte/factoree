import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import {
  PrismaProjectRegistry,
  PrismaSecretStore,
  PrismaTenantRegistry,
} from "~/persistence/prisma/project-registry.prisma.js";

const key = "e".repeat(64);
let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
});

afterAll(async () => {
  await prisma.$disconnect();
  await stop();
});

describe("AT-33 tenant isolation", () => {
  it("keeps projects, secrets, and runs inside their own tenant", async () => {
    const tenants = new PrismaTenantRegistry(prisma, key);
    const projects = new PrismaProjectRegistry(prisma);
    const secrets = new PrismaSecretStore(prisma, key);
    const runs = new PrismaRunRepository(prisma);

    const a = await tenants.ensureTenant("ws-at33-a", "A");
    const b = await tenants.ensureTenant("ws-at33-b", "B");

    const projectA = await projects.create({
      tenantId: a.id,
      key: "a",
      name: "A",
      primaryRepository: "acme/a",
    });
    await secrets.put(a.id, projectA.id, "TOKEN", "secret-value-of-tenant-a");
    const run = await runs.createIfAbsent({
      tenantId: a.id,
      projectId: projectA.id,
      linearIssueId: "issue-a",
      linearAgentSessionId: "session-at33",
      temporalWorkflowId: "linear:ws-at33-a:session-at33",
      autonomyLevel: "L2",
    });

    expect(await projects.list(b.id)).toHaveLength(0);
    expect(await projects.findById(b.id, projectA.id)).toBeNull();
    expect(await secrets.get(b.id, projectA.id, "TOKEN")).toBeNull();
    expect(await secrets.listNames(b.id, projectA.id)).toEqual([]);
    expect(await runs.findById(b.id, run.run.id)).toBeNull();
    expect(await runs.findByAgentSession(b.id, "session-at33")).toBeNull();

    expect(await projects.findById(a.id, projectA.id)).not.toBeNull();
    expect(await runs.findById(a.id, run.run.id)).not.toBeNull();
  });

  /** Every table of the public schema, ordered by name. */
  const tableNames = async (): Promise<string[]> => {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    return rows.map((row) => row.table_name).sort();
  };

  /** Every table that carries a `tenantId` column, ordered by name. */
  const tenantedTableNames = async (): Promise<string[]> => {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenantId'
    `;
    return rows.map((row) => row.table_name).sort();
  };

  it("records the tenant on every tenant-owned row", async () => {
    expect(await tenantedTableNames()).toEqual(
      [
        "AgentExecution",
        // SDD section 21 and SDD section 52. Phase 4 added the Context Contract tables, and each
        // one is tenant-owned.
        "ContextConflict",
        "ContextContract",
        "ContextItem",
        // SDD section 53. Phase 5 added the ContextSourceConfiguration table, and it is
        // tenant-owned as well.
        "ContextSourceConfiguration",
        "Evidence",
        "LinearInstallation",
        "ProcessedWebhook",
        "Project",
        "ProjectSecret",
        "Run",
        // SDD section 24 and SDD section 52. Phase 6 added the Validation Contract tables, and
        // each one is tenant-owned.
        "ValidationAssertion",
        "ValidationAssertionResult",
        "ValidationContract",
      ].sort(),
    );
  });

  /**
   * SDD section 52. The assertion above reads the columns that exist, so it can never see a
   * table that forgot the column. This assertion reads the tables that exist instead, and it
   * names every exemption.
   *
   * The exemption list is the point of the test. `Tenant` holds the tenant itself, and
   * `_prisma_migrations` is the migration ledger of Prisma. Neither belongs to one tenant. A new
   * table that carries no `tenantId` fails this test until a human adds it here on purpose, so
   * nobody can add an untenanted table by accident.
   */
  const NOT_TENANT_OWNED = ["Tenant", "_prisma_migrations"];

  it("gives every other table a tenant column", async () => {
    const tenanted = new Set(await tenantedTableNames());
    const untenanted = (await tableNames()).filter((name) => !tenanted.has(name));
    expect(untenanted).toEqual([...NOT_TENANT_OWNED].sort());
  });
});
