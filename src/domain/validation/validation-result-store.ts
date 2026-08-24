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
}

/**
 * SDD section 39. A result row is immutable once written. `record` is idempotent, so a Temporal
 * activity retry with the same `(runId, validationAssertionId, attempt)` writes nothing new.
 */
export interface ValidationResultStore {
  /** Idempotent on `(runId, validationAssertionId, attempt)`. A Temporal retry writes nothing new. */
  record(input: RecordAssertionResultInput): Promise<ValidationAssertionResultRecord>;
  listForRun(tenantId: string, runId: string): Promise<ValidationAssertionResultRecord[]>;
}
