import type { AssertionResult } from "~/domain/validation/validation-result.js";

export interface ValidationAssertionResultRecord {
  id: string;
  tenantId: string;
  runId: string;
  /** The database identifier of the `ValidationAssertion` row. */
  validationAssertionId: string;
  /** The contract-level identifier, for example `VAL-UI-001`. */
  assertionKey: string;
  result: AssertionResult;
  reason: string;
  /** The user validation pass this result belongs to. The first pass is 1. */
  attempt: number;
  /** docs/specs/check-faults.md. The SHA-256 of the plan entry that ran, or null when unknown. */
  planEntrySha256: string | null;
  createdAt: Date;
}

export interface RecordAssertionResultInput {
  tenantId: string;
  runId: string;
  validationAssertionId: string;
  assertionKey: string;
  result: AssertionResult;
  reason: string;
  attempt: number;
  planEntrySha256?: string | null;
}

/**
 * SDD section 39. A result row is immutable once written. `record` is idempotent, so a Temporal
 * activity retry with the same `(runId, validationAssertionId, attempt)` writes nothing new.
 */
export interface ValidationResultStore {
  /** Idempotent on `(runId, validationAssertionId, attempt)`. A Temporal retry writes nothing new. */
  record(input: RecordAssertionResultInput): Promise<ValidationAssertionResultRecord>;
  listForRun(tenantId: string, runId: string): Promise<ValidationAssertionResultRecord[]>;
  /**
   * docs/specs/check-faults.md. The one change to a written row: a FAIL of an assertion that passed
   * in an earlier attempt with the same plan entry, while the reviewer passed the change, becomes
   * UNSTABLE. Only a FAIL row changes, so a repeat writes nothing new.
   */
  markUnstable(tenantId: string, runId: string, attempt: number, rows: ReadonlyArray<{ assertionKey: string; reason: string }>): Promise<void>;
}
