import { describe, expect, it } from "vitest";
import { PrismaEvidenceStore } from "~/persistence/prisma/evidence.prisma.js";
import { canonicalEvidenceHash } from "~/domain/evidence/evidence.js";
import { withDatabase, seedTenantProjectAndRun } from "./support/database.js";

describe("PrismaEvidenceStore", () => {
  it("writes an evidence row with every SDD section 39 field", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
      const store = new PrismaEvidenceStore(prisma);
      const record = await store.record({
        tenantId,
        runId,
        kind: "deterministic_check",
        source: "verify:test",
        sha256: canonicalEvidenceHash({ name: "test", exitCode: 0 }),
        metadata: { name: "test", exitCode: 0 },
        idempotencyKey: `run:${runId}:verify:1:test`,
      });
      expect(record.id).toMatch(/[0-9a-f-]{36}/);
      expect(record.tenantId).toBe(tenantId);
      expect(record.validationAssertionId).toBeNull();
      expect(record.storageRef).toBeNull();
      expect(record.createdAt).toBeInstanceOf(Date);
    });
  });

  it("is idempotent for one Temporal retry", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
      const store = new PrismaEvidenceStore(prisma);
      const input = {
        tenantId,
        runId,
        kind: "deterministic_check" as const,
        source: "verify:lint",
        sha256: canonicalEvidenceHash({ name: "lint" }),
        metadata: { name: "lint" },
        idempotencyKey: `run:${runId}:verify:1:lint`,
      };
      const first = await store.record(input);
      const second = await store.record(input);
      expect(second.id).toBe(first.id);
      const all = await store.listForRun(tenantId, runId);
      expect(all.filter((entry) => entry.source === "verify:lint")).toHaveLength(1);
    });
  });

  it("never changes a row that already exists", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
      const store = new PrismaEvidenceStore(prisma);
      const key = `run:${runId}:verify:1:immutable`;
      const first = await store.record({
        tenantId,
        runId,
        kind: "deterministic_check",
        source: "verify:immutable",
        sha256: "a".repeat(64),
        metadata: { exitCode: 1 },
        idempotencyKey: key,
      });
      const second = await store.record({
        tenantId,
        runId,
        kind: "deterministic_check",
        source: "verify:immutable",
        sha256: "b".repeat(64),
        metadata: { exitCode: 0 },
        idempotencyKey: key,
      });
      // SDD section 39: evidence is immutable. A second write with the same key returns the first
      // row and changes nothing.
      expect(second.sha256).toBe(first.sha256);
      expect(second.metadata).toEqual({ exitCode: 1 });
    });
  });

  it("does not return the evidence of another tenant", async () => {
    await withDatabase(async (prisma) => {
      const { runId } = await seedTenantProjectAndRun(prisma);
      const store = new PrismaEvidenceStore(prisma);
      expect(await store.listForRun("00000000-0000-0000-0000-000000000000", runId)).toEqual([]);
    });
  });
});
