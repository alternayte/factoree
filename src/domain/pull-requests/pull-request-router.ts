import type { Logger } from "~/telemetry/logger.js";
import type { PullRequestEvent } from "./pull-request-event.js";
import type { PublishedPullRequest, PullRequestStore } from "./pull-request-store.js";

/** One event for the PR workflow of one pull request. */
export interface PullRequestSignal {
  workflowId: string;
  tenantId: string;
  pullRequestId: string;
  event: PullRequestEvent;
}

export interface PullRequestEventRouterDependencies {
  pullRequests: Pick<PullRequestStore, "findByNumber" | "findByCommit" | "recordEvent" | "listOpenByBase">;
  /** Signal-with-start: it reaches the PR workflow that runs, or starts it. */
  signal: (input: PullRequestSignal) => Promise<void>;
  logger: Logger;
}

/** routed: the PR workflow took it. recorded: the pull request ended, so only the record took it. */
export type PullRequestRouteOutcome = "routed" | "recorded" | "unmatched";

/**
 * docs/specs/pr-review-merge-and-deploy.md, DI-21.101. The webhook route hands each pull request
 * event here. An event of a recorded pull request goes to its PR workflow while the pull request is
 * open, and a reopen starts the workflow again. An event after the merge or the close is recorded on
 * the pull request and starts no workflow.
 */
export class PullRequestEventRouter {
  constructor(private readonly dependencies: PullRequestEventRouterDependencies) {}

  /** A `pull_request` or `pull_request_review` event names the pull request number. */
  async byNumber(tenantId: string, repositoryFullName: string, number: number, event: PullRequestEvent): Promise<PullRequestRouteOutcome> {
    const pullRequest = await this.dependencies.pullRequests.findByNumber(tenantId, repositoryFullName, number);
    if (pullRequest === null) return "unmatched";
    return this.deliver(pullRequest, event);
  }

  /**
   * A `check_run`, `status` or `deployment_status` event names a commit. Every pull request whose
   * head or merge commit it is takes the event. The answer is the best outcome of them.
   */
  async byCommit(tenantId: string, repositoryFullName: string, sha: string, event: PullRequestEvent): Promise<PullRequestRouteOutcome> {
    const pullRequests = await this.dependencies.pullRequests.findByCommit(tenantId, repositoryFullName, sha);
    let outcome: PullRequestRouteOutcome = "unmatched";
    for (const pullRequest of pullRequests) {
      const delivered = await this.deliver(pullRequest, event);
      if (delivered === "routed" || outcome === "unmatched") outcome = delivered;
    }
    return outcome;
  }

  /**
   * Slice 4, DI-21.117. A push to a branch reaches every open pull request that targets it. A
   * pull request that ended takes no push.
   */
  async byBase(tenantId: string, repositoryFullName: string, baseBranch: string, event: PullRequestEvent): Promise<PullRequestRouteOutcome> {
    const pullRequests = await this.dependencies.pullRequests.listOpenByBase(tenantId, repositoryFullName, baseBranch);
    for (const pullRequest of pullRequests) await this.deliver(pullRequest, event);
    return pullRequests.length === 0 ? "unmatched" : "routed";
  }

  private async deliver(pullRequest: PublishedPullRequest, event: PullRequestEvent): Promise<PullRequestRouteOutcome> {
    if (pullRequest.state === "open" || event.kind === "reopened") {
      await this.dependencies.signal({
        workflowId: pullRequest.workflowId,
        tenantId: pullRequest.tenantId,
        pullRequestId: pullRequest.id,
        event,
      });
      return "routed";
    }
    await this.dependencies.pullRequests.recordEvent(pullRequest.tenantId, pullRequest.id, event);
    this.dependencies.logger.info("recorded an event of an ended pull request", {
      pull_request: `${pullRequest.repositoryFullName}#${String(pullRequest.number)}`,
      event: event.kind,
      step: "pull_request_event",
    });
    return "recorded";
  }
}
