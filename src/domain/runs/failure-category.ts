import type { RunFailureReason } from "./run-status.js";

/**
 * SDD section 67: "Failed Runs have normalized failure categories."
 *
 * A failure reason names the exact rule that stopped the Run. A category names the kind of
 * action a human takes next. The two are separate, because a new reason must not force a new
 * dashboard panel.
 */
export const RUN_FAILURE_CATEGORIES = [
  /** The Run reached the maximum duration of SDD section 50. */
  "TIMEOUT",
  /** A human stopped the Run. SDD section 50. */
  "CANCELLED",
  /** `.factoree/config.yaml` or the Project record names something Factoree cannot use. */
  "CONFIGURATION",
  /** A material question stayed open, so implementation never started. */
  "INPUT_UNRESOLVED",
  /** The Implementer session itself failed. */
  "AGENT",
  /** Deterministic verification did not pass within the repair budget. SDD section 35. */
  "VERIFICATION",
  /** User-level validation did not pass, or Factoree ran no validation. SDD section 36. */
  "VALIDATION",
  /** The independent review blocked, or Factoree obtained no usable review. SDD section 40. */
  "REVIEW",
  /** Patch capture, the hash assertion, or the GitHub publication failed. SDD section 46. */
  "PUBLICATION",
  /** Factoree broke its own invariant. SDD section 68. An operator files a defect. */
  "INTERNAL",
] as const;

export type RunFailureCategory = (typeof RUN_FAILURE_CATEGORIES)[number];

/**
 * The total map from a failure reason to its category. `Record` makes it total, so a new
 * reason in `RUN_FAILURE_REASONS` fails the type check here until somebody classifies it.
 */
const CATEGORY_BY_REASON: Record<RunFailureReason, RunFailureCategory> = {
  RUN_TIMEOUT: "TIMEOUT",
  STOPPED_BY_HUMAN: "CANCELLED",
  CONFIGURATION_INVALID: "CONFIGURATION",
  IMPLEMENTATION_FAILED: "AGENT",
  VERIFICATION_FAILED: "VERIFICATION",
  REFINEMENT_UNRESOLVED: "INPUT_UNRESOLVED",
  CONTEXT_UNRESOLVED: "INPUT_UNRESOLVED",
  VALIDATION_UNRESOLVED: "INPUT_UNRESOLVED",
  VALIDATION_FAILED: "VALIDATION",
  VALIDATION_BLOCKED: "VALIDATION",
  VALIDATION_MANUAL_REQUIRED: "VALIDATION",
  REVIEW_BLOCKING_FINDINGS: "REVIEW",
  REVIEW_UNAVAILABLE: "REVIEW",
  PATCH_HASH_MISMATCH: "PUBLICATION",
  EMPTY_PATCH: "PUBLICATION",
  PUBLICATION_FAILED: "PUBLICATION",
  COMPLETION_INVARIANT_UNMET: "INTERNAL",
  INTERNAL_ERROR: "INTERNAL",
};

/** Returns the normalized category of one failure reason. The map is total, so it never fails. */
export const failureCategoryOf = (reason: RunFailureReason): RunFailureCategory =>
  CATEGORY_BY_REASON[reason];
