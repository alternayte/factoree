import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaProductRegistry, PrismaSecretStore, PrismaTenantRegistry } from "~/persistence/prisma/product-registry.prisma.js";

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
  it("keeps products, secrets, and runs inside their own tenant", async () => {
    const tenants = new PrismaTenantRegistry(prisma, key);
    const products = new PrismaProductRegistry(prisma);
    const secrets = new PrismaSecretStore(prisma, key);
    const runs = new PrismaRunRepository(prisma);

    const a = await tenants.ensureTenant("ws-at33-a", "A");
    const b = await tenants.ensureTenant("ws-at33-b", "B");

    const productA = await products.create({
      tenantId: a.id,
      slug: "a",
      name: "A",
      linearTeamKey: "AT33",
      linearTeamId: "team-at33-a",
    });
    await secrets.put(a.id, productA.id, "TOKEN", "secret-value-of-tenant-a");
    const run = await runs.createIfAbsent({
      tenantId: a.id,
      productId: productA.id,
      linearIssueId: "issue-a",
      linearAgentSessionId: "session-at33",
      temporalWorkflowId: "linear:ws-at33-a:session-at33",
      autonomyLevel: "L2",
    });

    expect(await products.list(b.id)).toHaveLength(0);
    expect(await products.findById(b.id, productA.id)).toBeNull();
    expect(await secrets.get(b.id, productA.id, "TOKEN")).toBeNull();
    expect(await secrets.listNames(b.id, productA.id)).toEqual([]);
    expect(await runs.findById(b.id, run.run.id)).toBeNull();
    expect(await runs.findByAgentSession(b.id, "session-at33")).toBeNull();

    expect(await products.findById(a.id, productA.id)).not.toBeNull();
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

  /**
   * Every table that carries a tenant column, ordered by name. `AgentSession` names its columns
   * in snake_case (DI-14.42), so its tenant column is `tenant_id`.
   */
  const tenantedTableNames = async (): Promise<string[]> => {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('tenantId', 'tenant_id')
    `;
    return rows.map((row) => row.table_name).sort();
  };

  it("records the tenant on every tenant-owned row", async () => {
    expect(await tenantedTableNames()).toEqual(
      [
        "AgentExecution",
        // docs/specs/agent-session-usage-and-hangs.md. One row per agent session of one tenant.
        "AgentSession",
        // SDD section 21 and SDD section 52. Phase 4 added the Context Contract tables, and each
        // one is tenant-owned.
        "ContextConflict",
        "ContextContract",
        "ContextItem",
        // SDD section 53. Phase 5 added the ContextSourceConfiguration table, and it is
        // tenant-owned as well.
        "ContextSourceConfiguration",
        "Evidence",
        // The multi-repo-tenancy branch added GitHubInstallation, Product, ProductSecret,
        // Repository, and RunTarget. Each one is tenant-owned. It also removed Project and
        // ProjectSecret, so neither name appears here any more.
        "GitHubInstallation",
        "LinearInstallation",
        // docs/specs/release-0-1-0.md. The membership a Linear sign-in records, in one tenant.
        "LinearMember",
        "ProcessedWebhook",
        "Product",
        // docs/specs/autonomy-levels.md. One row for each Product policy change.
        "ProductPolicyChange",
        "ProductSecret",
        "Repository",
        // DI-15.29. A retired warm snapshot still holds one tenant's checkout.
        "RetiredWarmSnapshot",
        // SDD section 53 and SDD section 52. Phase 8 added the ReviewFinding table, and it is
        // tenant-owned as well.
        "ReviewFinding",
        "Run",
        "RunTarget",
        // docs/specs/skill-registry.md. One row per skill and per skill proposal of a run.
        "run_skill",
        "run_skill_proposal",
        // docs/specs/run-speed.md. One row per stage of a run of one tenant.
        "run_stage",
        // SDD section 24 and SDD section 52. Phase 6 added the Validation Contract tables, and
        // each one is tenant-owned.
        "ValidationAssertion",
        "ValidationAssertionResult",
        "ValidationContract",
        // docs/specs/kiln-sandbox-provider.md. A warm snapshot holds one tenant's checkout.
        "WarmSnapshot",
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
  const NOT_TENANT_OWNED = [
    "Tenant",
    "_prisma_migrations",
    // docs/specs/release-0-1-0.md and DI-14.53. The install settings are the one row of the
    // install. A better-auth user can be a member of several tenants (one Linear account per
    // workspace), so the user, its sessions, accounts, verifications and API keys hold no single
    // tenant: `LinearMember` carries the tenant, and every admin call checks it. An audit entry
    // records calls that name no workspace, and refused calls with no person.
    "AdminAuditEntry",
    "InstallSettings",
    // DI-15.14. sandboxMaxLive is the limit of one provider account, shared by every tenant, so a
    // lease counts sandboxes across tenants. It names the Run, and no API reads it.
    "SandboxLease",
    "auth_account",
    "auth_apikey",
    "auth_session",
    "auth_user",
    "auth_verification",
  ];

  it("gives every other table a tenant column", async () => {
    const tenanted = new Set(await tenantedTableNames());
    const untenanted = (await tableNames()).filter((name) => !tenanted.has(name));
    expect(untenanted).toEqual([...NOT_TENANT_OWNED].sort());
  });
});
