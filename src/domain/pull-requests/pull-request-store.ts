import type { PullRequestState } from "~/domain/runs/issue-status.js";
import type { PullRequestEvent } from "./pull-request-event.js";

/** off until Factoree turns on GitHub auto-merge, and unavailable when the repository refuses it. */
export type AutoMergeState = "off" | "enabled" | "unavailable";

/**
 * docs/specs/pr-review-merge-and-deploy.md, DI-21.99. One pull request that a run published. The PR
 * workflow owns it after the run ends.
 */
export interface PublishedPullRequest {
  id: string;
  tenantId: string;
  repositoryId: string;
  repositoryFullName: string;
  number: number;
  url: string;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  /** The run that published the pull request. Issue completion reads its issue state. */
  originRunId: string;
  state: PullRequestState;
  mergeCommitSha: string | null;
  reviewerFollowUps: number;
  /** The contract revision of the head commit. It starts at 1. */
  contractRevision: number;
  autoMerge: AutoMergeState;
  autoMergeReason: string | null;
  workflowId: string;
}

export interface RecordPublishedPullRequestInput {
  tenantId: string;
  runId: string;
  repositoryId: string;
  number: number;
  url: string;
  headBranch: string;
  headSha: string;
  baseBranch: string;
}

export interface PullRequestStore {
  /**
   * Records a pull request after publication. A second publication of the same pull request (DI-9.8)
   * moves the head and keeps the origin run.
   */
  recordPublished(input: RecordPublishedPullRequestInput): Promise<PublishedPullRequest>;
  find(tenantId: string, id: string): Promise<PublishedPullRequest | null>;
  /** GitHub names a repository with its own case, so the match ignores case. */
  findByNumber(tenantId: string, repositoryFullName: string, number: number): Promise<PublishedPullRequest | null>;
  /** The pull requests whose head commit or merge commit is that SHA. */
  findByCommit(tenantId: string, repositoryFullName: string, sha: string): Promise<PublishedPullRequest[]>;
  /**
   * Records one event once per delivery, and applies the facts it carries: a new head commit, or a
   * reopen. `isNew` is false for a delivery the pull request already took.
   */
  recordEvent(tenantId: string, pullRequestId: string, event: PullRequestEvent): Promise<{ isNew: boolean; pullRequest: PublishedPullRequest }>;
  /** Marks the pull request merged or closed. A repeated call writes the same facts. */
  markClosed(
    tenantId: string,
    pullRequestId: string,
    close: { merged: boolean; mergeCommitSha: string | null; closedAt: Date },
  ): Promise<PublishedPullRequest>;
}
