import type { Prisma, PrismaClient } from "@prisma/client";
import type { ReviewCategory, ReviewSeverity } from "~/domain/review/review-report.js";
import type {
  RecordReviewFindingInput,
  ReviewFindingRecord,
  ReviewFindingStore,
} from "~/domain/review/review-finding-store.js";

type Row = Prisma.ReviewFindingGetPayload<Record<string, never>>;

const toRecord = (row: Row): ReviewFindingRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  runId: row.runId,
  attempt: row.attempt,
  verdict: row.verdict as "pass" | "fail",
  findingKey: row.findingKey,
  severity: row.severity as ReviewSeverity,
  category: row.category as ReviewCategory,
  requirement: row.requirement,
  evidence: row.evidence,
  description: row.description,
  blocking: row.blocking,
  decisionReason: row.decisionReason,
  createdAt: row.createdAt,
});

export class PrismaReviewFindingStore implements ReviewFindingStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Confirms a found row belongs to the caller's tenant. SDD section 52 makes the Linear
   * workspace the tenant boundary, and one tenant must never retrieve another tenant's finding.
   */
  private assertOwnedByTenant(row: Row, tenantId: string): Row {
    if (row.tenantId !== tenantId) {
      throw new Error("Review finding row belongs to a different tenant than the caller.");
    }
    return row;
  }

  /**
   * SDD section 53. A finding row is immutable once written. `record` is idempotent on
   * `(runId, attempt, findingKey)`, so a Temporal activity retry writes nothing new.
   */
  async record(input: RecordReviewFindingInput): Promise<ReviewFindingRecord> {
    const key = {
      runId_attempt_findingKey: {
        runId: input.runId,
        attempt: input.attempt,
        findingKey: input.findingKey,
      },
    };
    const existing = await this.prisma.reviewFinding.findUnique({ where: key });
    if (existing) return toRecord(this.assertOwnedByTenant(existing, input.tenantId));

    try {
      const created = await this.prisma.reviewFinding.create({
        data: {
          tenantId: input.tenantId,
          runId: input.runId,
          attempt: input.attempt,
          verdict: input.verdict,
          findingKey: input.findingKey,
          severity: input.severity,
          category: input.category,
          requirement: input.requirement,
          evidence: input.evidence,
          description: input.description,
          blocking: input.blocking,
          decisionReason: input.decisionReason,
        },
      });
      return toRecord(created);
    } catch (error) {
      // Two concurrent attempts can both miss the read above. The unique index decides, and the
      // loser reads the winner rather than failing the Run.
      const row = await this.prisma.reviewFinding.findUnique({ where: key });
      if (row) return toRecord(this.assertOwnedByTenant(row, input.tenantId));
      throw error;
    }
  }

  async listForRun(tenantId: string, runId: string): Promise<ReviewFindingRecord[]> {
    const rows = await this.prisma.reviewFinding.findMany({
      where: { tenantId, runId },
      orderBy: [{ attempt: "asc" }, { findingKey: "asc" }],
    });
    return rows.map(toRecord);
  }
}
