import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaReviewFindingStore } from "~/persistence/prisma/review-finding.prisma.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { startDatabase, seedTenantProjectAndRun } from "./support/database.js";

let database: { url: string; stop: () => Promise<void> };
let prisma: FactoreePrismaClient;
let store: PrismaReviewFindingStore;
let tenantId = "";
let runId = "";

beforeAll(async () => {
  database = await startDatabase();
  prisma = createPrismaClient(database.url);
  store = new PrismaReviewFindingStore(prisma);
  const seeded = await seedTenantProjectAndRun(prisma);
  tenantId = seeded.tenantId;
  runId = seeded.runId;
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
  await database.stop();
});

describe("PrismaReviewFindingStore", () => {
  it("writes one immutable row per finding per attempt", async () => {
    const input = {
      tenantId,
      runId,
      attempt: 1,
      verdict: "fail" as const,
      findingKey: "RV-1",
      severity: "high" as const,
      category: "correctness" as const,
      requirement: "VAL-API-001",
      evidence: "src/auth.ts:84",
      description: "The handler returns 200 for an expired token.",
      blocking: true,
      decisionReason: "SDD section 41: a high correctness finding names a mandatory requirement.",
    };
    const first = await store.record(input);
    const second = await store.record(input);
    expect(second.id).toBe(first.id);

    const rows = await store.listForRun(tenantId, runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blocking).toBe(true);
  });

  it("writes a second row for a later attempt", async () => {
    const base = {
      tenantId,
      runId,
      verdict: "fail" as const,
      findingKey: "RV-2",
      severity: "medium" as const,
      category: "style" as const,
      requirement: "VAL-API-002",
      evidence: "src/auth.ts:90",
      description: "The variable name does not follow the naming convention.",
      blocking: false,
      decisionReason: "SDD section 41: a style finding does not block.",
    };
    await store.record({ ...base, attempt: 1 });
    await store.record({ ...base, attempt: 2 });
    const rows = await store.listForRun(tenantId, runId);
    expect(rows.filter((row) => row.findingKey === "RV-2")).toHaveLength(2);
  });

  it("does not read a row of another tenant", async () => {
    const other = await seedTenantProjectAndRun(prisma);
    await store.record({
      tenantId: other.tenantId,
      runId: other.runId,
      attempt: 1,
      verdict: "pass" as const,
      findingKey: "RV-1",
      severity: "low" as const,
      category: "maintainability" as const,
      requirement: "VAL-API-003",
      evidence: "src/other.ts:1",
      description: "A finding that belongs only to the second tenant.",
      blocking: false,
      decisionReason: "SDD section 41: a low finding does not block.",
    });

    const rowsForFirstTenant = await store.listForRun(tenantId, other.runId);
    expect(rowsForFirstTenant).toEqual([]);

    const rowsForOtherTenant = await store.listForRun(other.tenantId, other.runId);
    expect(rowsForOtherTenant).toHaveLength(1);
  });
});
