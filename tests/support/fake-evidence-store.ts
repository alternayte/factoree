import { randomUUID } from "node:crypto";
import type { EvidenceRecord, EvidenceStore, RecordEvidenceInput } from "~/domain/evidence/evidence.js";

/** An in-memory `EvidenceStore` with the same immutability rule as the Prisma one. */
export class FakeEvidenceStore implements EvidenceStore {
  readonly rows: EvidenceRecord[] = [];
  private readonly keys = new Map<string, EvidenceRecord>();

  record(input: RecordEvidenceInput): Promise<EvidenceRecord> {
    const key = `${input.runId}:${input.idempotencyKey}`;
    const existing = this.keys.get(key);
    if (existing) return Promise.resolve(existing);
    const row: EvidenceRecord = {
      id: randomUUID(),
      tenantId: input.tenantId,
      runId: input.runId,
      validationAssertionId: input.validationAssertionId ?? null,
      kind: input.kind,
      source: input.source,
      createdAt: new Date(),
      sha256: input.sha256,
      storageRef: input.storageRef ?? null,
      metadata: input.metadata,
    };
    this.rows.push(row);
    this.keys.set(key, row);
    return Promise.resolve(row);
  }

  listForRun(tenantId: string, runId: string): Promise<EvidenceRecord[]> {
    return Promise.resolve(this.rows.filter((row) => row.tenantId === tenantId && row.runId === runId));
  }
}
