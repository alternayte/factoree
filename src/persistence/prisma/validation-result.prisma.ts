import type { Prisma, PrismaClient } from "@prisma/client";
import type { AssertionResult } from "~/domain/validation/validation-result.js";
import type {
  RecordAssertionResultInput,
  ValidationAssertionResultRecord,
  ValidationResultStore,
} from "~/domain/validation/validation-result-store.js";

type Row = Prisma.ValidationAssertionResultGetPayload<Record<string, never>>;

const toRecord = (row: Row): ValidationAssertionResultRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  runId: row.runId,
  validationAssertionId: row.validationAssertionId,
  assertionKey: row.assertionKey,
  result: row.result as AssertionResult,
  reason: row.reason,
  attempt: row.attempt,
  createdAt: row.createdAt,
});

export class PrismaValidationResultStore implements ValidationResultStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Confirms a found row belongs to the caller's tenant. SDD section 52 makes the Linear
   * workspace the tenant boundary, and one tenant must never retrieve another tenant's result.
   */
  private assertOwnedByTenant(row: Row, tenantId: string): Row {
    if (row.tenantId !== tenantId) {
      throw new Error("Validation assertion result row belongs to a different tenant than the caller.");
    }
    return row;
  }

  /**
   * SDD section 39. A result row is immutable, so this never updates. A Temporal retry presents
   * the same `(runId, validationAssertionId, attempt)` and receives the row that already exists.
   */
  async record(input: RecordAssertionResultInput): Promise<ValidationAssertionResultRecord> {
    const key = {
      runId_validationAssertionId_attempt: {
        runId: input.runId,
        validationAssertionId: input.validationAssertionId,
        attempt: input.attempt,
      },
    };
    const existing = await this.prisma.validationAssertionResult.findUnique({ where: key });
    if (existing) return toRecord(this.assertOwnedByTenant(existing, input.tenantId));

    try {
      const created = await this.prisma.validationAssertionResult.create({
        data: {
          tenantId: input.tenantId,
          runId: input.runId,
          validationAssertionId: input.validationAssertionId,
          assertionKey: input.assertionKey,
          result: input.result,
          reason: input.reason,
          attempt: input.attempt,
        },
      });
      return toRecord(created);
    } catch (error) {
      // Two concurrent attempts can both miss the read above. The unique index decides, and the
      // loser reads the winner rather than failing the Run.
      const row = await this.prisma.validationAssertionResult.findUnique({ where: key });
      if (row) return toRecord(this.assertOwnedByTenant(row, input.tenantId));
      throw error;
    }
  }

  async listForRun(tenantId: string, runId: string): Promise<ValidationAssertionResultRecord[]> {
    const rows = await this.prisma.validationAssertionResult.findMany({
      where: { tenantId, runId },
      orderBy: { attempt: "asc" },
    });
    return rows.map(toRecord);
  }
}
