import type { FactoreePrismaClient } from "./client.js";
import type { ObjectStore } from "~/adapters/s3/s3-object-store.js";
import { RETAINED_KINDS } from "~/domain/evidence/artifact-links.js";

export interface StoredArtifactRecord {
  id: string;
  tenantId: string;
  runId: string;
  kind: string;
  name: string;
  contentType: string;
  objectKey: string;
  bytes: number;
  sha256: string;
  deletedAt: Date | null;
  createdAt: Date;
}

/** docs/specs/s3-object-store.md. The evidence objects in the object store, one row each. */
export class PrismaStoredArtifactStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  /** A Temporal retry of one upload finds the object it already stored, so it writes no second one. */
  async findSame(runId: string, name: string, sha256: string): Promise<StoredArtifactRecord | null> {
    return this.prisma.storedArtifact.findFirst({ where: { runId, name, sha256, deletedAt: null } });
  }

  async create(record: Omit<StoredArtifactRecord, "deletedAt" | "createdAt">): Promise<StoredArtifactRecord> {
    return this.prisma.storedArtifact.create({ data: record });
  }

  async byId(id: string): Promise<StoredArtifactRecord | null> {
    return this.prisma.storedArtifact.findUnique({ where: { id } });
  }

  /** The artifacts of one run, for the run page. */
  async forRun(tenantId: string, runId: string): Promise<StoredArtifactRecord[]> {
    return this.prisma.storedArtifact.findMany({ where: { tenantId, runId }, orderBy: { createdAt: "asc" } });
  }

  /** The live objects of the given kinds in one product's runs created before the cutoff. */
  async expired(productId: string, kinds: readonly string[], before: Date, limit: number): Promise<StoredArtifactRecord[]> {
    return this.prisma.storedArtifact.findMany({
      where: { kind: { in: [...kinds] }, deletedAt: null, createdAt: { lt: before }, run: { productId } },
      take: limit,
    });
  }

  async markDeleted(id: string, at: Date): Promise<void> {
    await this.prisma.storedArtifact.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: at } });
  }

  /**
   * docs/specs/s3-object-store.md. Deletes the video and trace objects older than each product's
   * Evidence retention. The object goes first, so a failed delete keeps the row live for the next
   * pass. The row stays, marked deleted, so the run page can say so.
   */
  async deleteExpired(now: Date, bucket: ObjectStore | null): Promise<number> {
    if (bucket === null) return 0;
    const products = await this.prisma.product.findMany({ where: { evidenceRetentionDays: { not: null } }, select: { id: true, evidenceRetentionDays: true } });
    let deleted = 0;
    for (const product of products) {
      const before = new Date(now.getTime() - product.evidenceRetentionDays! * 24 * 60 * 60_000);
      for (const artifact of await this.expired(product.id, RETAINED_KINDS, before, 500)) {
        try {
          await bucket.delete(artifact.objectKey);
        } catch {
          continue;
        }
        await this.markDeleted(artifact.id, now);
        deleted += 1;
      }
    }
    return deleted;
  }

  /**
   * docs/specs/s3-object-store.md. The evidence of one run for the run page: every row with a stored
   * artifact, in any store, with the object store size and the retention delete where they exist.
   */
  async runArtifacts(tenantId: string, runId: string): Promise<RunArtifactView[]> {
    const run = await this.prisma.run.findFirst({ where: { id: runId, tenantId }, select: { product: { select: { evidenceRetentionDays: true } } } });
    if (run === null) return [];
    const [evidence, stored] = await Promise.all([
      this.prisma.evidence.findMany({ where: { tenantId, runId, storageRef: { not: null } }, orderBy: { createdAt: "asc" } }),
      this.forRun(tenantId, runId),
    ]);
    const byId = new Map(stored.map((artifact) => [artifact.id, artifact]));
    return evidence.map((row) => {
      const id = /\/artifacts\/([0-9a-f-]{36})(?:\/|$)/.exec(row.storageRef ?? "")?.[1];
      const artifact = id === undefined ? undefined : byId.get(id);
      return {
        id: row.id,
        kind: row.kind,
        source: row.source,
        sha256: row.sha256,
        link: row.storageRef!,
        store: artifact !== undefined ? "s3" : row.storageRef!.startsWith("file://") ? "filesystem" : "linear",
        bytes: artifact?.bytes ?? null,
        deletedAt: artifact?.deletedAt ?? null,
        deletedAfterDays: artifact?.deletedAt != null ? run.product.evidenceRetentionDays : null,
        createdAt: row.createdAt,
      };
    });
  }
}

export interface RunArtifactView {
  id: string;
  kind: string;
  source: string;
  sha256: string;
  link: string;
  store: "s3" | "linear" | "filesystem";
  bytes: number | null;
  deletedAt: Date | null;
  deletedAfterDays: number | null;
  createdAt: Date;
}
