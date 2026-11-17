import type { Logger } from "~/telemetry/logger.js";
import type { PullRequestEvent } from "~/domain/pull-requests/pull-request-event.js";
import type { PullRequestStore, RecordPublishedPullRequestInput } from "~/domain/pull-requests/pull-request-store.js";
import type { PullRequestCloseHandler } from "~/domain/runs/pull-request-close.js";
import type { PullRequestState } from "~/domain/runs/issue-status.js";

export interface PullRequestActivityDependencies {
  pullRequests: PullRequestStore;
  close: Pick<PullRequestCloseHandler, "closeOfRecord">;
  logger: Logger;
}

export interface TakePullRequestEventOutput {
  isNew: boolean;
  state: PullRequestState;
  headSha: string;
}

/** docs/specs/pr-review-merge-and-deploy.md. The activities of publication and of the PR workflow. */
export const createPullRequestActivities = (dependencies: PullRequestActivityDependencies) => ({
  /**
   * D3, DI-21.99. Records the pull request a run published, and names its PR workflow. The agent run
   * starts that workflow with the answer.
   */
  async recordPullRequest(input: RecordPublishedPullRequestInput): Promise<{ pullRequestId: string; workflowId: string }> {
    const pullRequest = await dependencies.pullRequests.recordPublished(input);
    dependencies.logger.info("pull request recorded", {
      run_id: input.runId,
      pull_request: `${pullRequest.repositoryFullName}#${String(pullRequest.number)}`,
      step: "pull_request_record",
    });
    return { pullRequestId: pullRequest.id, workflowId: pullRequest.workflowId };
  },

  /** DI-21.100. Records one event once per delivery. */
  async takePullRequestEvent(input: { tenantId: string; pullRequestId: string; event: PullRequestEvent }): Promise<TakePullRequestEventOutput> {
    const { isNew, pullRequest } = await dependencies.pullRequests.recordEvent(input.tenantId, input.pullRequestId, input.event);
    dependencies.logger.info("pull request event taken", {
      pull_request: `${pullRequest.repositoryFullName}#${String(pullRequest.number)}`,
      event: input.event.kind,
      delivery_id: input.event.deliveryId,
      new: isNew,
      step: "pull_request_event",
    });
    return { isNew, state: pullRequest.state, headSha: pullRequest.headSha };
  },

  /**
   * DI-21.51, D3. A merge or a close: the record takes the state, and the origin run moves the issue.
   * A retry writes the same state and decides again, and the issue move holds only while the issue is
   * in the state Factoree set.
   */
  async closePullRequestOfRecord(input: {
    tenantId: string;
    pullRequestId: string;
    merged: boolean;
    mergeCommitSha: string | null;
  }): Promise<PullRequestState> {
    const pullRequest = await dependencies.pullRequests.markClosed(input.tenantId, input.pullRequestId, {
      merged: input.merged,
      mergeCommitSha: input.mergeCommitSha,
      closedAt: new Date(),
    });
    await dependencies.close.closeOfRecord({
      tenantId: input.tenantId,
      repositoryFullName: pullRequest.repositoryFullName,
      number: pullRequest.number,
      merged: input.merged,
      originRunId: pullRequest.originRunId,
    });
    return pullRequest.state;
  },
});
