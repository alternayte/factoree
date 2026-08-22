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
   * SDD section 39. Evidence is immutable, so this never updates. A Temporal retry presents the
   * same idempotency key and receives the row that already exists.
   */
  async record(input: RecordEvidenceInput): Promise<EvidenceRecord> {
    const key = { runId_idempotencyKey: { runId: input.runId, idempotencyKey: input.idempotencyKey } };
    const existing = await this.prisma.evidence.findUnique({ where: key });
    if (existing) return toRecord(existing);

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
      if (row) return toRecord(row);
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
