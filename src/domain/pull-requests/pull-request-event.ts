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
  | PullRequestDeploymentStatusEvent
  | PullRequestBasePushedEvent
  | PullRequestCommentEvent
  | PullRequestReviewCommentEvent
  | PullRequestReviewThreadEvent
  | PullRequestLinearReplyEvent;

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
  /** docs/specs/pr-feedback-loop.md. True when the review body mentions the Factoree app. Absent before review apps. */
  mentions?: boolean;
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

/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.117. `push` to the base branch of the
 * pull request. GitHub sends no pull request event when its base moves, and a moved base is what
 * makes a conflict, or a branch that is behind.
 */
export interface PullRequestBasePushedEvent {
  kind: "base_pushed";
  deliveryId: string;
  baseBranch: string;
  /** The new head of the base branch. */
  sha: string;
}

/**
 * docs/specs/pr-feedback-loop.md. `issue_comment` with the action `created`, on a pull request: a
 * comment on its conversation. `mentions` is true when the body mentions the Factoree app.
 */
export interface PullRequestCommentEvent {
  kind: "comment";
  deliveryId: string;
  commentId: number;
  authorLogin: string;
  /** GitHub's account type: User or Bot. */
  authorType: string;
  body: string;
  mentions: boolean;
  url: string | null;
}

/**
 * docs/specs/pr-feedback-loop.md. `pull_request_review_comment` with the action `created`: a
 * comment on a line of the diff, which opens a thread or replies in one.
 */
export interface PullRequestReviewCommentEvent {
  kind: "review_comment";
  deliveryId: string;
  commentId: number;
  reviewId: number | null;
  /** The first comment of the thread this comment replies to, or null when it opens the thread. */
  inReplyToId: number | null;
  path: string;
  line: number | null;
  commitSha: string | null;
  authorLogin: string;
  authorType: string;
  body: string;
  mentions: boolean;
  url: string | null;
}

/**
 * docs/specs/pr-feedback-loop.md. `pull_request_review_thread`: a thread was resolved or
 * unresolved. The PR workflow records it only. The planner reads the thread state from GitHub.
 */
export interface PullRequestReviewThreadEvent {
  kind: "review_thread";
  deliveryId: string;
  action: "resolved" | "unresolved";
  /** The first comment of the thread. */
  commentId: number | null;
  senderLogin: string | null;
}

/**
 * docs/specs/pr-feedback-loop.md. A reply in the Linear agent session of the run while its pull
 * request is open. It is a human decision on that pull request.
 */
export interface PullRequestLinearReplyEvent {
  kind: "linear_reply";
  deliveryId: string;
  agentSessionId: string;
  /** The Linear id of the reply, which keys its answer. */
  replyId: string;
  authorName: string | null;
  body: string;
  /** The Linear URL of the reply, or null when Linear names none. */
  url: string | null;
}

/**
 * docs/specs/pr-feedback-loop.md, DI-21.204. True when a GitHub comment body mentions the Factoree
 * app as `@<slug>` or `@<slug>[bot]`, in any case, outside a quoted line and outside a fenced code
 * block. A quote of an earlier mention is not a new decision.
 */
export const mentionsApp = (body: string, appSlug: string | null): boolean => {
  if (appSlug === null || appSlug === "") return false;
  const slug = appSlug.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mention = new RegExp(`(^|[^a-z0-9_/@.-])@${slug}(\\[bot\\])?(?![a-z0-9_-])`, "i");
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || trimmed.startsWith(">")) continue;
    if (mention.test(line.replace(/`[^`]*`/g, ""))) return true;
  }
  return false;
};

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
    case "review_comment":
      return event.commitSha;
    case "comment":
    case "review_thread":
    case "linear_reply":
      return null;
    case "commit_status":
    case "deployment_status":
      return event.sha;
    case "base_pushed":
      // A commit of the base branch is no head of the pull request.
      return null;
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
