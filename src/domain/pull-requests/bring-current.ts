/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 4. Bring current: Factoree merges the base branch
 * into the branch of its pull request on the trusted checkout, checks the merge in a check sprite
 * against the frozen contract with no agent, and pushes the merge commit only after it passes.
 *
 * The agent-run and PR workflows import this module, so it imports nothing at run time.
 */
import type { BringCurrentReason } from "./auto-merge.js";

/** The pull request a bring-current run updates. The agent-run input `bringCurrent` carries it. */
export interface BringCurrentInput {
  pullRequestId: string;
  repositoryId: string;
  repositoryFullName: string;
  number: number;
  url: string;
  headBranch: string;
  /** The verified head the run merges the base into. The merge commit's first parent. */
  headSha: string;
  /** The verified base of the head. */
  baseSha: string;
  baseBranch: string;
  /** The run whose frozen contract and passing Validation Plan the check replays (D1). */
  contractRunId: string;
  /** The contract revision of the head. The merge commit keeps it. */
  contractRevision: number;
  /** The autonomy level of the verified head. The merge commit keeps it (DI-21.104). */
  autonomyLevel: string;
  reason: BringCurrentReason;
}

/**
 * What a bring-current run did. The PR workflow reads it: a conflict, or a failed check after a
 * clean update, starts a PR follow-up run with the conflict or the failure as a finding.
 */
export type BringCurrentOutcome =
  /** The branch holds the base already. */
  | { kind: "current" }
  /** The branch moved since the PR workflow read it, so the run pushed nothing. */
  | { kind: "moved" }
  | { kind: "pushed"; commitSha: string; baseSha: string }
  | { kind: "conflict"; baseSha: string; conflicts: string[] }
  /** The check of the clean update failed. */
  | { kind: "failed"; baseSha: string; failure: string }
  /** The run ended without an outcome of the update: a stop, a timeout or a fault. */
  | { kind: "ended" };

/** The most conflict files one finding names. */
export const MAX_CONFLICT_FILES = 100;
