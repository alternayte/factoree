import type { ReviewCategory, ReviewSeverity } from "~/domain/review/review-report.js";

export interface RecordReviewFindingInput {
  tenantId: string;
  runId: string;
  /** The review pass this finding belongs to. The first pass is 1. SDD section 42. */
  attempt: number;
  /** The agent claim of SDD section 41. It is recorded and it decides nothing. */
  verdict: "pass" | "fail";
  /** The identifier the Reviewer gave the finding, for example RV-1. */
  findingKey: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  requirement: string;
  evidence: string;
  description: string;
  /** Factoree's own decision. SDD section 41 and DI-8.2. */
  blocking: boolean;
  decisionReason: string;
}

export interface ReviewFindingRecord extends RecordReviewFindingInput {
  id: string;
  createdAt: Date;
}

/**
 * SDD section 53. A finding row is immutable once written. `record` is idempotent on
 * `(runId, attempt, findingKey)`, so a Temporal activity retry writes nothing new.
 */
export interface ReviewFindingStore {
  record(input: RecordReviewFindingInput): Promise<ReviewFindingRecord>;
  listForRun(tenantId: string, runId: string): Promise<ReviewFindingRecord[]>;
}
