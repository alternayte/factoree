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
  // Specification section 9. No Product for the Linear team, or two Products claim it. An
  // operator must resolve the binding, so this state is terminal.
  "BLOCKED_ROUTING",
  // Specification section 10. Several repositories, and no confident target. The Run waits for
  // a Linear reply, the same way `WAITING_FOR_INPUT` does.
  "BLOCKED_TARGET",
  // Specification section 15. A target repository moved before publication. The Run ends here,
  // and Factoree creates no pull request.
  "BLOCKED_STALE_SET",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = [
  "READY_FOR_HUMAN",
  "STALE_BASE",
  "FAILED_CONFIGURATION",
  "FAILED",
  "FAILED_REVIEW",
  "CANCELLED",
  "BLOCKED_ROUTING",
  "BLOCKED_STALE_SET",
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
  // SDD section 9 item 5. The Work Item states no observable success assertion, and the bounded
  // question rounds ended with no human answer. Implementation must not start.
  "VALIDATION_UNRESOLVED",
  // Specification section 10. The bounded question rounds ended with no confirmed target
  // repository.
  "TARGET_UNRESOLVED",
  // SDD section 36. At least one assertion is FAIL and the repair budget of SDD section 42 is
  // spent.
  "VALIDATION_FAILED",
  // SDD section 36. Factoree could not run a check, so it proved nothing. A repair cannot help.
  "VALIDATION_BLOCKED",
  // SDD section 36. An assertion needs a human, so an L3 Run cannot complete on its own.
  "VALIDATION_MANUAL_REQUIRED",
  // SDD section 41 and section 42. The review reported at least one blocking finding, and the
  // repair budget of SDD section 42 is spent.
  "REVIEW_BLOCKING_FINDINGS",
  // SDD section 40. Factoree could not obtain a usable review, so it proved nothing about the
  // change. A repair cannot help. See DI-8.7.
  "REVIEW_UNAVAILABLE",
  // SDD section 46 step 5. The patch of the trusted checkout did not reproduce the verified
  // hash, so publication is blocked. A repair cannot help.
  "PATCH_HASH_MISMATCH",
  // SDD section 44. Every check passed and the worktree holds no change against the base SHA,
  // so there is no verified artifact to publish.
  "EMPTY_PATCH",
  // SDD section 46. The trusted checkout, the push, or the pull request creation failed.
  "PUBLICATION_FAILED",
  // SDD section 68. A clause of the completion invariant did not hold at the moment the Run was
  // ready to complete. Factoree must never report success it cannot prove, so the Run fails.
  "COMPLETION_INVARIANT_UNMET",
  "INTERNAL_ERROR",
] as const;

export type RunFailureReason = (typeof RUN_FAILURE_REASONS)[number];
