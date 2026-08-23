export const RUN_STATUSES = [
  "RECEIVED",
  "REFINING",
  "WAITING_FOR_INPUT",
  "RESOLVING_CONTEXT",
  "BUILDING_VALIDATION_CONTRACT",
  "PREPARING",
  "IMPLEMENTING",
  "VERIFYING",
  "USER_VALIDATING",
  "REVIEWING",
  "REPAIRING",
  "PUBLISHING",
  "READY_FOR_HUMAN",
  "STALE_BASE",
  "FAILED_CONFIGURATION",
  "FAILED",
  "FAILED_REVIEW",
  "CANCELLED",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = [
  "READY_FOR_HUMAN",
  "STALE_BASE",
  "FAILED_CONFIGURATION",
  "FAILED",
  "FAILED_REVIEW",
  "CANCELLED",
] as const satisfies readonly RunStatus[];

const terminal = new Set<string>(TERMINAL_RUN_STATUSES);

export const isTerminalRunStatus = (status: RunStatus): boolean => terminal.has(status);

export const RUN_FAILURE_REASONS = [
  "RUN_TIMEOUT",
  "STOPPED_BY_HUMAN",
  "CONFIGURATION_INVALID",
  "IMPLEMENTATION_FAILED",
  // SDD section 35. Deterministic verification did not pass, and the repair budget of SDD
  // section 42 is spent. SDD section 48 fixes the state names, not the failure reasons.
  "VERIFICATION_FAILED",
  // SDD section 8. A material product question stayed open after the bounded question rounds.
  "REFINEMENT_UNRESOLVED",
  // SDD section 23. A conflict with no authority winner stayed open after the bounded rounds.
  "CONTEXT_UNRESOLVED",
  "INTERNAL_ERROR",
] as const;

export type RunFailureReason = (typeof RUN_FAILURE_REASONS)[number];
