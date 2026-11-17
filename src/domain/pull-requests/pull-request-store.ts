import type { PullRequestState } from "~/domain/runs/issue-status.js";
import type { PullRequestEvent } from "./pull-request-event.js";
import type { DeployIssueMoveState, OpenDeployFailure, PullRequestDeployRecord, RecordDeployInput } from "./deploys.js";

/**
 * off until Factoree turns on GitHub auto-merge, and unavailable when the L4 gate of the repository
 * fails (D5). enabled means Factoree turned it on. stopped means a human turned off what Factoree
 * turned on, so Factoree never turns it on again on this pull request (DI-21.105).
 */
export type AutoMergeState = "off" | "enabled" | "unavailable" | "stopped";

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
  /** The time of the merge or the close, or null while open. */
  closedAt: Date | null;
  reviewerFollowUps: number;
  /** The contract revision of the head commit. It starts at 1. */
  contractRevision: number;
  autoMerge: AutoMergeState;
  autoMergeReason: string | null;
  /** DI-21.104. The head commit a publication pushed, after every Factoree check passed. */
  verifiedHeadSha: string | null;
  /** The autonomy level of the run that published the verified head. */
  autonomyLevel: string | null;
  /** DI-21.106. The base branch whose L4 gate Factoree read, or null before the first read. */
  autoMergeGateBase: string | null;
  /** D2. The base SHA of the verified head. A PR follow-up run starts from it. */
  verifiedBaseSha: string | null;
  /** The run that published the verified head. */
  verifiedRunId: string | null;
  /** DI-21.108. The failed PR reviewer check that last started a triage or a limit notice. */
  reviewerHandledKey: string | null;
  /** DI-21.114. The run ids that `reviewerFollowUps` counted. */
  reviewerFollowUpKeys: string[];
  /** DI-21.118. The head commit of the last bring-current update that pushed nothing, until the base moves. */
  bringCurrentHeadSha: string | null;
  workflowId: string;
}

/** What a PR follow-up run needs of the run that published the pull request. */
export interface PullRequestOriginFacts {
  productId: string;
  githubInstallationId: string;
  /** The workflow id of the origin run, which names the Linear workspace. */
  originWorkflowId: string;
  linearAgentSessionId: string;
  linearIssueId: string | null;
  workItemTitle: string | null;
  workItemUrl: string | null;
}

/** DI-21.104. What the L4 merge reads beside the record: the product, the installation and the Linear session. */
export interface PullRequestSteeringFacts {
  productId: string;
  githubInstallationId: string;
  /** The agent session of the origin run, where "Needs your attention" goes. */
  linearAgentSessionId: string;
}

export interface AutoMergeUpdate {
  state: AutoMergeState;
  reason: string | null;
  /** Set when Factoree read the L4 gate of this base branch. */
  gateBase?: string;
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
  /** The autonomy level of the publishing run. The head it pushed becomes the verified head. */
  autonomyLevel: string;
  /** D2. The base SHA the publishing run verified the patch against. */
  baseSha: string;
  /** The contract revision of the pushed head. Absent for the run that opened the pull request. */
  contractRevision?: number;
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
  steeringFacts(tenantId: string, pullRequestId: string): Promise<PullRequestSteeringFacts>;
  /** Writes the auto-merge state, and answers the record before the write. */
  setAutoMerge(tenantId: string, pullRequestId: string, update: AutoMergeUpdate): Promise<PublishedPullRequest>;
  /** D5. The open pull requests of a product whose L4 gate failed, newest first. */
  listAutoMergeUnavailable(tenantId: string, productId: string): Promise<PublishedPullRequest[]>;
  originFacts(tenantId: string, pullRequestId: string): Promise<PullRequestOriginFacts>;
  /** DI-21.108. Marks one failed PR reviewer check as handled. False when it already was. */
  markReviewerHandled(tenantId: string, pullRequestId: string, key: string): Promise<boolean>;
  /**
   * DI-21.114. Counts one PR follow-up run from the PR reviewer once per key, the run id, and answers
   * the count. A second call with the same key writes nothing.
   */
  countReviewerFollowUp(tenantId: string, pullRequestId: string, key: string): Promise<number>;
  /** DI-21.118. Records the head of a bring-current update that pushed nothing. */
  markBringCurrentTried(tenantId: string, pullRequestId: string, headSha: string): Promise<void>;
  /** DI-21.117. The open pull requests of a repository that target that base branch. */
  listOpenByBase(tenantId: string, repositoryFullName: string, baseBranch: string): Promise<PublishedPullRequest[]>;
  /** The recorded events of one kind, oldest first. */
  listEvents(tenantId: string, pullRequestId: string, kind: PullRequestEvent["kind"]): Promise<PullRequestEvent[]>;
  /**
   * Slice 5, DI-21.121. The pull requests of a repository that merged at or after `since` and hold
   * no successful deploy of the environment yet, oldest first.
   */
  listMergedForDeploy(tenantId: string, repositoryFullName: string, environment: string, since: Date): Promise<PublishedPullRequest[]>;
  /** DI-21.122. The deploy results of one pull request, oldest first. */
  listDeploys(tenantId: string, pullRequestId: string): Promise<PullRequestDeployRecord[]>;
  /**
   * DI-21.122. Records one deploy result once by its key. A success also resolves every open failure
   * of its environment on the pull request. False when the key was recorded already.
   */
  recordDeploy(input: RecordDeployInput): Promise<boolean>;
  /** DI-21.126. Writes the issue move of a recorded failed deploy. */
  setDeployIssueMove(tenantId: string, deployId: string, move: DeployIssueMoveState, stateName: string | null): Promise<void>;
  /** DI-21.124. The newest open failed deploy of a pull request whose origin run has this agent session. */
  openDeployFailure(tenantId: string, agentSessionId: string): Promise<OpenDeployFailure | null>;
  /** DI-21.124. Marks a failed deploy as followed up. False when a reply followed it up already. */
  markDeployFollowedUp(tenantId: string, deployId: string, workflowId: string): Promise<boolean>;
}
