/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 5. Repository CI deploys, and Factoree reports each
 * deploy result of a merged pull request. Factoree reads deploys only from GitHub `deployment_status`
 * events, so the deploy job must name an `environment:`. Factoree never deploys, never approves a
 * deploy and never dispatches one. A failed deploy is reported, and rollback stays in CI.
 *
 * This module holds the decisions and the text. `DeployPort` is the GitHub boundary.
 */

/**
 * DI-21.121. The PR workflow of a merged pull request stays open this long after the merge, and the
 * webhook reaches a merged pull request with a deploy only inside the same window. A deploy after it
 * is not read.
 */
export const DEPLOY_WINDOW_DAYS = 14;
export const DEPLOY_WINDOW_MS = DEPLOY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** DI-21.122. The deployments of one environment that Factoree reads for the previous success. */
export const MAX_PREVIOUS_DEPLOYMENTS = 30;

export type DeployResult = "success" | "failure";

/**
 * DI-21.120. The result of one GitHub deployment status. `success` is a deploy. `failure` and
 * `error` are a failed deploy. Every other state (queued, pending, in_progress, inactive) is no
 * result yet, and the PR workflow only records it.
 */
export const deployResultOf = (state: string): DeployResult | null => {
  const lower = state.toLowerCase();
  if (lower === "success") return "success";
  if (lower === "failure" || lower === "error") return "failure";
  return null;
};

/** The GitHub reads of the deploy report. Deployments read and Contents read are enough. */
export interface DeployPort {
  /**
   * True when `ancestor` is in the history of `descendant`, a commit SHA or a branch name: GitHub's
   * compare answers `ahead` or `identical`. A commit GitHub does not know answers false.
   */
  contains(slug: string, ancestor: string, descendant: string, installationId: string): Promise<boolean>;
  /**
   * DI-21.122. The commit of the newest successful deployment of the environment that GitHub
   * created before the deployment `beforeDeploymentId`, or null when none of the newest
   * MAX_PREVIOUS_DEPLOYMENTS succeeded.
   */
  previousSuccess(slug: string, environment: string, beforeDeploymentId: number, installationId: string): Promise<string | null>;
}

/** One recorded deploy result of a merged pull request. */
export interface PullRequestDeployRecord {
  id: string;
  pullRequestId: string;
  /** The run of the verified head at the merge. Its proof pack lists the deploy. */
  runId: string;
  environment: string;
  state: DeployResult;
  deploymentId: string;
  sha: string;
  /** The commit of the previous successful deploy of the environment, or null when Factoree found none. */
  previousSha: string | null;
  logUrl: string | null;
  environmentUrl: string | null;
  resolvedAt: Date | null;
  followUpWorkflowId: string | null;
  /** DI-21.126. The webhook delivery that recorded the row, or null for a row from before the column. */
  deliveryId: string | null;
  /** DI-21.126. The issue move of a failed deploy, or null before Factoree decided it. */
  issueMove: DeployIssueMoveState | null;
  issueStateName: string | null;
  createdAt: Date;
}

export interface RecordDeployInput {
  tenantId: string;
  pullRequestId: string;
  runId: string;
  environment: string;
  state: DeployResult;
  deploymentId: string;
  sha: string;
  previousSha: string | null;
  logUrl: string | null;
  environmentUrl: string | null;
  /** DI-21.126. The webhook delivery of the deployment status. */
  deliveryId: string;
}

/** DI-21.122. A success counts once per environment, and a failure once per deployment. */
export const deployKeyOf = (input: Pick<RecordDeployInput, "state" | "environment" | "deploymentId">): string =>
  input.state === "success" ? `success:${input.environment}` : `failure:${input.deploymentId}`;

/** DI-21.124. The newest failed deploy of an agent session that no reply followed up and no success resolved. */
export interface OpenDeployFailure {
  id: string;
  /** The run whose merged change the failed deploy holds. The follow-up run follows it. */
  runId: string;
  environment: string;
  sha: string;
  previousSha: string | null;
  logUrl: string | null;
  pullRequestUrl: string;
  mergeCommitSha: string | null;
}

/** The commit range of a failed deploy, as a human reads it. */
export const deployRange = (failure: { previousSha: string | null; sha: string }): string =>
  failure.previousSha === null
    ? `up to \`${failure.sha.slice(0, 12)}\` (Factoree found no earlier successful deploy of this environment)`
    : `\`${failure.previousSha.slice(0, 12)}..${failure.sha.slice(0, 12)}\``;

/**
 * The spec and DI-21.126: a successful deploy posts one line in Linear with the environment and the
 * commit. The proof pack document holds the rest.
 */
export const deploySuccessNotice = (input: { environment: string; sha: string }): string =>
  `Deployed to \`${input.environment}\` at commit \`${input.sha.slice(0, 12)}\`. The proof pack is updated.`;

/** What the move of the issue did after a failed deploy, for the notice. */
export type FailedDeployIssueMove = "moved" | "human_moved" | "not_moved";

/**
 * DI-21.126. The stored issue move of a failed deploy. `moving` is written before the Linear call,
 * so a retry knows that the issue may have moved already.
 */
export type DeployIssueMoveState = FailedDeployIssueMove | "moving";

/**
 * The spec: a failed deploy posts the environment, the commit range and the job log link. Rollback
 * stays in CI, and a reply starts a follow-up run (DI-21.124).
 */
export const deployFailureNotice = (input: {
  environment: string;
  sha: string;
  previousSha: string | null;
  logUrl: string | null;
  pullRequestUrl: string;
  issueMove: FailedDeployIssueMove;
  issueStateName: string | null;
}): string =>
  [
    "### Needs your attention",
    "",
    `The deploy to \`${input.environment}\` failed. Its commit range ${deployRange(input)} holds the merged change of ${input.pullRequestUrl}.`,
    `Job log: ${input.logUrl ?? "GitHub sent no log link."}`,
    input.issueMove === "moved"
      ? `Factoree moved the issue back to ${input.issueStateName ?? "its earlier state"}.`
      : input.issueMove === "human_moved"
        ? `The issue status changed by hand, so Factoree left it in ${input.issueStateName ?? "its state"}.`
        : "Factoree did not move the issue.",
    "A deploy log does not name its cause, so Factoree reverts nothing. Rollback stays in CI.",
    "",
    "**Reply here to start a follow-up run.** It refines the issue again with your reply as a decision and the deploy failure as a finding.",
  ].join("\n");

/** DI-21.124. The finding of a follow-up run that a reply after a failed deploy started. */
export const deployFailureFindingLines = (failure: Pick<OpenDeployFailure, "environment" | "sha" | "previousSha" | "logUrl" | "pullRequestUrl">): string[] => [
  `The deploy to ${failure.environment} failed on commit range ${deployRange(failure)}, which holds the merged change of ${failure.pullRequestUrl}. ` +
    `Job log: ${failure.logUrl ?? "none"}. Find the cause of the failure in the change, or say why the change is not the cause.`,
];
