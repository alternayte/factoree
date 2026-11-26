import { describe, expect, it } from "vitest";
import { PrismaStoredArtifactStore } from "~/persistence/prisma/stored-artifact.prisma.js";
import { withDatabase, seedTenantProjectAndRun } from "./support/database.js";

// docs/specs/s3-object-store.md. Evidence retention deletes only old video and traces of a product
// that set it, deletes the object first, and keeps the row so the run page can say so.
describe("stored artifacts", () => {
  it("deletes old video and traces past the Evidence retention, and the run page shows it", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, productId, runId } = await seedTenantProjectAndRun(prisma);
      const store = new PrismaStoredArtifactStore(prisma);
      const now = new Date();
      const old = new Date(now.getTime() - 10 * 24 * 60 * 60_000);
      const make = async (id: string, kind: string, createdAt: Date) => {
        await store.create({ id, tenantId, runId, kind, name: `${kind}.bin`, contentType: "application/octet-stream", objectKey: `evidence/${tenantId}/${runId}/${id}`, bytes: 10, sha256: id });
        await prisma.storedArtifact.update({ where: { id }, data: { createdAt } });
        await prisma.evidence.create({
          data: { tenantId, runId, kind, source: kind, sha256: id, storageRef: `https://factoree.example/artifacts/${id}`, metadata: {}, idempotencyKey: id },
        });
      };
      await make("00000000-0000-4000-8000-000000000001", "video", old);
      await make("00000000-0000-4000-8000-000000000002", "screenshot", old);
      await make("00000000-0000-4000-8000-000000000003", "trace", now);
      const deletedKeys: string[] = [];
      const bucket = { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: (key: string) => (deletedKeys.push(key), Promise.resolve()) };

      // No retention set: nothing goes.
      expect(await store.deleteExpired(now, bucket)).toBe(0);
      await prisma.product.update({ where: { id: productId }, data: { evidenceRetentionDays: 7 } });
      expect(await store.deleteExpired(now, bucket)).toBe(1);
      expect(deletedKeys).toEqual([`evidence/${tenantId}/${runId}/00000000-0000-4000-8000-000000000001`]);

      const view = await store.runArtifacts(tenantId, runId);
      expect(view.map((item) => [item.kind, item.store, item.deletedAfterDays])).toEqual([
        ["video", "s3", 7],
        ["screenshot", "s3", null],
        ["trace", "s3", null],
      ]);
      expect(await store.runArtifacts("another-tenant", runId)).toEqual([]);
    });
  });
});
