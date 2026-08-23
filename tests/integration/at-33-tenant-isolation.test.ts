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

  it("records the tenant on every tenant-owned row", async () => {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenantId'
    `;
    const names = rows.map((row) => row.table_name).sort();
    expect(names).toEqual(
      [
        "AgentExecution",
        // SDD section 21 and SDD section 52. Phase 4 added the Context Contract tables, and each
        // one is tenant-owned.
        "ContextConflict",
        "ContextContract",
        "ContextItem",
        "Evidence",
        "LinearInstallation",
        "ProcessedWebhook",
        "Project",
        "ProjectSecret",
        "Run",
      ].sort(),
    );
  });
});
