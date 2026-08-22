import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  EvidenceKind,
  EvidenceRecord,
  EvidenceStore,
  RecordEvidenceInput,
} from "~/domain/evidence/evidence.js";

type Row = Prisma.EvidenceGetPayload<Record<string, never>>;

const toRecord = (row: Row): EvidenceRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  runId: row.runId,
  validationAssertionId: row.validationAssertionId,
  kind: row.kind as EvidenceKind,
  source: row.source,
  createdAt: row.createdAt,
  sha256: row.sha256,
  storageRef: row.storageRef,
  metadata: (row.metadata ?? {}) as Record<string, unknown>,
});

export class PrismaEvidenceStore implements EvidenceStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Confirms a found row belongs to the caller's tenant. SDD section 52 makes the Linear
   * workspace the tenant boundary, and one tenant must never retrieve another tenant's evidence.
   * The lookup key is `(runId, idempotencyKey)` alone, without the tenant. `Run.id` is a
   * globally unique uuid primary key, so two tenants cannot share a `runId` today, and this
   * mismatch cannot occur. The check stays as defence in depth for SDD section 52.
   */
  private assertOwnedByTenant(row: Row, tenantId: string): Row {
    if (row.tenantId !== tenantId) {
      throw new Error("Evidence row belongs to a different tenant than the caller.");
    }
    return row;
  }

  /**
   * SDD section 39. Evidence is immutable, so this never updates. A Temporal retry presents the
   * same idempotency key and receives the row that already exists.
   */
  async record(input: RecordEvidenceInput): Promise<EvidenceRecord> {
    const key = { runId_idempotencyKey: { runId: input.runId, idempotencyKey: input.idempotencyKey } };
    const existing = await this.prisma.evidence.findUnique({ where: key });
    if (existing) return toRecord(this.assertOwnedByTenant(existing, input.tenantId));

    try {
      const created = await this.prisma.evidence.create({
        data: {
          tenantId: input.tenantId,
          runId: input.runId,
          validationAssertionId: input.validationAssertionId ?? null,
          kind: input.kind,
          source: input.source,
          sha256: input.sha256,
          storageRef: input.storageRef ?? null,
          metadata: input.metadata as Prisma.InputJsonValue,
          idempotencyKey: input.idempotencyKey,
        },
      });
      return toRecord(created);
    } catch (error) {
      // Two concurrent attempts can both miss the read above. The unique index decides, and the
      // loser reads the winner rather than failing the Run.
      const row = await this.prisma.evidence.findUnique({ where: key });
      if (row) return toRecord(this.assertOwnedByTenant(row, input.tenantId));
      throw error;
    }
  }

  async listForRun(tenantId: string, runId: string): Promise<EvidenceRecord[]> {
    const rows = await this.prisma.evidence.findMany({
      where: { tenantId, runId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toRecord);
  }
}
