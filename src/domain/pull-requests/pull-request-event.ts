/**
 * docs/specs/pr-review-merge-and-deploy.md. The GitHub events the PR workflow takes for one
 * published pull request. The webhook route turns each delivery into one of these, so the workflow
 * never reads a raw GitHub payload. Every event carries the delivery id, and the PR workflow takes
 * each delivery once (DI-21.100).
 *
 * The union holds every event the spec routes. DI-21.101 lists which kinds act and which kinds the
 * workflow only records.
 */
export type PullRequestEvent =
  | PullRequestClosedEvent
  | PullRequestReopenedEvent
  | PullRequestSynchronizedEvent
  | PullRequestEditedEvent
  | PullRequestAutoMergeDisabledEvent
  | PullRequestReviewEvent
  | PullRequestCheckRunEvent
  | PullRequestCommitStatusEvent
  | PullRequestDeploymentStatusEvent;

export type PullRequestEventKind = PullRequestEvent["kind"];

/** `pull_request` with the action `closed`. A merge carries the merge commit. */
export interface PullRequestClosedEvent {
  kind: "closed";
  deliveryId: string;
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string;
}

/** `pull_request` with the action `reopened`. */
export interface PullRequestReopenedEvent {
  kind: "reopened";
  deliveryId: string;
  headSha: string;
}

/** `pull_request` with the action `synchronize`: a new head commit on the branch. */
export interface PullRequestSynchronizedEvent {
  kind: "synchronized";
  deliveryId: string;
  headSha: string;
  beforeSha: string | null;
  senderLogin: string | null;
}

/**
 * `pull_request` with the action `edited`. GitHub sends it for a title, body or base branch edit,
 * with the mergeable state it knows at that moment. Null means GitHub has not computed it yet.
 */
export interface PullRequestEditedEvent {
  kind: "edited";
  deliveryId: string;
  headSha: string;
  baseBranch: string;
  baseChanged: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
}

/**
 * `pull_request` with the action `auto_merge_disabled`. A human, GitHub or Factoree turned off
 * auto-merge. The head is the head at that moment (DI-21.105).
 */
export interface PullRequestAutoMergeDisabledEvent {
  kind: "auto_merge_disabled";
  deliveryId: string;
  headSha: string;
  senderLogin: string | null;
}

/** `pull_request_review`. The state is GitHub's lowercase review state. */
export interface PullRequestReviewEvent {
  kind: "review";
  deliveryId: string;
  action: "submitted" | "edited" | "dismissed";
  reviewId: number;
  state: "approved" | "changes_requested" | "commented" | "dismissed";
  commitSha: string | null;
  reviewerLogin: string;
  /** GitHub's account type: User or Bot. */
  reviewerType: string;
  /** GitHub's author association, such as OWNER, MEMBER or COLLABORATOR. */
  authorAssociation: string;
  body: string | null;
}

/** `check_run`. The app slug pins a check to the app that reported it. */
export interface PullRequestCheckRunEvent {
  kind: "check_run";
  deliveryId: string;
  action: string;
  checkRunId: number;
  name: string;
  appSlug: string | null;
  headSha: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
}

/** `status`: a commit status on one commit. */
export interface PullRequestCommitStatusEvent {
  kind: "commit_status";
  deliveryId: string;
  sha: string;
  context: string;
  state: "pending" | "success" | "failure" | "error";
  targetUrl: string | null;
  senderLogin: string | null;
}

/** `deployment_status`. CI names the environment in the deploy job. */
export interface PullRequestDeploymentStatusEvent {
  kind: "deployment_status";
  deliveryId: string;
  deploymentId: number;
  environment: string;
  state: string;
  sha: string;
  ref: string;
  environmentUrl: string | null;
  logUrl: string | null;
}

/** The commit an event names, or null when it names none. */
export const eventHeadSha = (event: PullRequestEvent): string | null => {
  switch (event.kind) {
    case "closed":
    case "reopened":
    case "synchronized":
    case "edited":
    case "auto_merge_disabled":
    case "check_run":
      return event.headSha;
    case "review":
      return event.commitSha;
    case "commit_status":
    case "deployment_status":
      return event.sha;
  }
};

/**
 * docs/specs/pr-review-merge-and-deploy.md. One PR workflow per published pull request, keyed by
 * tenant, repository and number. The repository name keeps GitHub's case as discovery stored it.
 */
export const pullRequestWorkflowId = (tenantId: string, repositoryFullName: string, number: number): string => {
  if (!tenantId || !repositoryFullName || !Number.isInteger(number) || number <= 0) {
    throw new Error("a pull request workflow id needs a tenant, a repository and a pull request number");
  }
  return `pr:${tenantId}:${repositoryFullName}#${String(number)}`;
};
