/**
 * The patch ids of the run workflow. Each one is a `deprecatePatch` call now: new runs and open
 * runs of this release take the same path, and the call stays where `patched` stood so a history
 * that holds its marker replays (docs/specs/run-workflow-structure.md). The calls go once no open
 * run is older than release 0.16.0.
 */
export const PATCH = {
  /** docs/specs/run-speed.md. The reviewer runs in its own check sprite beside user validation. */
  parallelReview: "run-speed-parallel-review",
  /** docs/specs/early-review-sprite.md. The reviewer's check sprite builds while verify runs. */
  earlyReviewSprite: "early-review-sprite",
  /** A repair start posts one progress line. */
  repairProgress: "repair-progress",
  /** docs/specs/run-recovery.md. An unstable-only validation continues to a draft pull request. */
  unstableAssertion: "unstable-assertion",
  /** docs/specs/run-recovery.md. A failed run posts what blocked it and how to reply. */
  failurePost: "failure-post",
  /** DI-21.32. A configuration failure post says how to reply. */
  configurationFailurePost: "configuration-failure-post",
  /** docs/specs/run-failure-detail.md. An internal error posts its cause. */
  internalErrorPost: "internal-error-post",
  /** docs/specs/work-item-images-and-links.md. The run reads the comments, images and links. */
  workItemContent: "work-item-content",
  /** docs/specs/skill-registry.md. Skill proposals and the run outcome reach the skill sources. */
  skillRegistry: "skill-registry-signals",
  /** docs/specs/egress-honesty-and-issue-status.md. The run moves its issue to started and back. */
  issueStatus: "issue-status",
  /** docs/specs/egress-honesty-and-issue-status.md. A new pull request links to the issue at once. */
  pullRequestLink: "pull-request-link",
  /** DI-21.56. A wait for a sandbox slot moves the deadline. */
  sandboxSlotWait: "sandbox-slot-wait",
  /** docs/specs/sandbox-provider-spillover.md. The run selects its sandbox provider before the work sprite. */
  sandboxProvider: "sandbox-provider-spillover",
  /** docs/specs/draft-of-failed-run.md. A failed run offers its last patch as a draft. */
  draftOffer: "draft-offer",
  /** docs/specs/provider-unreachable.md. An unreachable provider is retried twice, then ends the Run. */
  providerUnreachable: "provider-unreachable",
  /** docs/specs/pr-review-merge-and-deploy.md. Publication records the pull request and starts its PR workflow. */
  prWorkflow: "pr-workflow",
  /** docs/specs/change-sets.md. The run selects a set of target repositories. */
  changeSet: "change-sets",
  /** docs/specs/change-sets.md, slice 5. The refiner can add a target and cite edges. */
  changeSetRefiner: "change-set-refiner-targets",
  /** docs/specs/change-sets.md, DI-21.143. An added target resolves the context again for the set. */
  changeSetContext: "change-set-context-refreeze",
  /** docs/specs/change-sets.md, slice 7. A change set publishes all or nothing. */
  changeSetPublication: "change-set-publication",
  /** docs/specs/change-sets.md, slice 8. A set publication sets the `factoree/change-set` statuses. */
  changeSetStatus: "change-set-status",
  /** docs/specs/context-authority-and-cited-conflicts.md. The context resolves again with cited conflicts. */
  citedConflicts: "cited-context-conflicts",
  /**
   * docs/specs/check-faults.md, GitHub issue 49. A `patched` gate, not yet deprecated: a FAIL whose
   * unchanged check passed in an earlier attempt is UNSTABLE when the reviewer passed the change.
   */
  crossAttemptUnstable: "cross-attempt-unstable",
} as const;
