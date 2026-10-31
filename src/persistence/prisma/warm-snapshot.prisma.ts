import type { FactoreePrismaClient } from "./client.js";
import type { WarmSnapshot, WarmSnapshotStore } from "~/domain/runs/warm-snapshot.js";

export class PrismaWarmSnapshotStore implements WarmSnapshotStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async find(key: { tenantId: string; adapter: string; repositoryUrl: string }): Promise<WarmSnapshot | null> {
    const row = await this.prisma.warmSnapshot.findUnique({ where: { tenantId_adapter_repositoryUrl: key } });
    return row === null ? null : toSnapshot(row);
  }

  async save(snapshot: WarmSnapshot): Promise<WarmSnapshot | null> {
    const key = { tenantId: snapshot.tenantId, adapter: snapshot.adapter, repositoryUrl: snapshot.repositoryUrl };
    const fields = { image: snapshot.image, configSha: snapshot.configSha, snapshotId: snapshot.snapshotId };
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.warmSnapshot.findUnique({ where: { tenantId_adapter_repositoryUrl: key } });
      await tx.warmSnapshot.upsert({
        where: { tenantId_adapter_repositoryUrl: key },
        create: { ...key, ...fields },
        update: { ...fields, createdAt: new Date() },
      });
      return previous === null || previous.snapshotId === snapshot.snapshotId ? null : toSnapshot(previous);
    });
  }

  async forget(snapshot: WarmSnapshot): Promise<void> {
    await this.prisma.warmSnapshot.deleteMany({
      where: {
        tenantId: snapshot.tenantId,
        adapter: snapshot.adapter,
        repositoryUrl: snapshot.repositoryUrl,
        snapshotId: snapshot.snapshotId,
      },
    });
  }
}

const toSnapshot = (row: {
  tenantId: string;
  adapter: string;
  repositoryUrl: string;
  image: string;
  configSha: string;
  snapshotId: string;
}): WarmSnapshot => ({
  tenantId: row.tenantId,
  adapter: row.adapter,
  repositoryUrl: row.repositoryUrl,
  image: row.image,
  configSha: row.configSha,
  snapshotId: row.snapshotId,
});
