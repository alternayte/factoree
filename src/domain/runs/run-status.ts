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
  "INTERNAL_ERROR",
] as const;

export type RunFailureReason = (typeof RUN_FAILURE_REASONS)[number];
