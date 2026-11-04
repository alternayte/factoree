import type { FactoreePrismaClient } from "./client.js";
import type { RetiredWarmSnapshot, WarmSnapshot, WarmSnapshotStore } from "~/domain/runs/warm-snapshot.js";

export class PrismaWarmSnapshotStore implements WarmSnapshotStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async find(key: { tenantId: string; adapter: string; repositoryUrl: string }): Promise<WarmSnapshot | null> {
    const row = await this.prisma.warmSnapshot.findUnique({ where: { tenantId_adapter_repositoryUrl: key } });
    return row === null ? null : toSnapshot(row);
  }

  /** docs/specs/run-speed.md. The bootstrap keys of the stored snapshots of one repository. */
  async keysFor(tenantId: string, repositoryUrl: string): Promise<string[]> {
    const rows = await this.prisma.warmSnapshot.findMany({ where: { tenantId, repositoryUrl }, select: { bootstrapKey: true } });
    return rows.map((row) => row.bootstrapKey);
  }

  /** docs/specs/run-speed.md. The templates the stored snapshots of one adapter belong to. */
  async templatesOf(adapter: string): Promise<string[]> {
    const rows = await this.prisma.warmSnapshot.findMany({ where: { adapter }, select: { template: true }, distinct: ["template"] });
    return rows.map((row) => row.template);
  }

  async save(snapshot: WarmSnapshot): Promise<WarmSnapshot | null> {
    const key = { tenantId: snapshot.tenantId, adapter: snapshot.adapter, repositoryUrl: snapshot.repositoryUrl };
    const fields = {
      template: snapshot.template,
      bootstrapKey: snapshot.bootstrapKey,
      warmCommandExitCode: snapshot.warmCommandExitCode,
      snapshotId: snapshot.snapshotId,
    };
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

  async retire(snapshot: RetiredWarmSnapshot): Promise<void> {
    const key = { adapter: snapshot.adapter, snapshotId: snapshot.snapshotId };
    await this.prisma.retiredWarmSnapshot.upsert({
      where: { adapter_snapshotId: key },
      create: { ...key, tenantId: snapshot.tenantId },
      update: {},
    });
  }

  async listRetired(limit: number): Promise<RetiredWarmSnapshot[]> {
    return this.prisma.retiredWarmSnapshot.findMany({
      select: { tenantId: true, adapter: true, snapshotId: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
  }

  async dropRetired(snapshot: RetiredWarmSnapshot): Promise<void> {
    await this.prisma.retiredWarmSnapshot.deleteMany({
      where: { adapter: snapshot.adapter, snapshotId: snapshot.snapshotId },
    });
  }
}

const toSnapshot = (row: {
  tenantId: string;
  adapter: string;
  repositoryUrl: string;
  template: string;
  bootstrapKey: string;
  warmCommandExitCode: number | null;
  snapshotId: string;
}): WarmSnapshot => ({
  tenantId: row.tenantId,
  adapter: row.adapter,
  repositoryUrl: row.repositoryUrl,
  template: row.template,
  bootstrapKey: row.bootstrapKey,
  warmCommandExitCode: row.warmCommandExitCode,
  snapshotId: row.snapshotId,
});
