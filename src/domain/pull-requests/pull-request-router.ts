import type { Logger } from "~/telemetry/logger.js";
import type { PullRequestEvent } from "./pull-request-event.js";
import type { PublishedPullRequest, PullRequestStore } from "./pull-request-store.js";
import { DEPLOY_WINDOW_MS, deployResultOf } from "./deploys.js";

/** One event for the PR workflow of one pull request. */
export interface PullRequestSignal {
  workflowId: string;
  tenantId: string;
  pullRequestId: string;
  event: PullRequestEvent;
}

export interface PullRequestEventRouterDependencies {
  pullRequests: Pick<PullRequestStore, "findByNumber" | "findByCommit" | "recordEvent" | "listOpenByBase" | "listMergedForDeploy"> &
    Partial<Pick<PullRequestStore, "listOpenByAgentSession">>;
  /** Signal-with-start: it reaches the PR workflow that runs, or starts it. */
  signal: (input: PullRequestSignal) => Promise<void>;
  logger: Logger;
  now?: () => Date;
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

  /**
   * Slice 5, DI-21.120, DI-21.121. A `deployment_status` names the deployed commit. The pull requests
   * whose head or merge commit it is take it as `byCommit` routes it: a deployment of a head stays
   * the preview link. A deploy result (success, failure or error) also reaches every pull request of
   * the repository that merged inside the deploy window and holds no successful deploy of that
   * environment yet. Its PR workflow reads from GitHub whether the deployed commit holds the merge
   * commit, so the route makes no GitHub call.
   */
  async byDeployment(tenantId: string, repositoryFullName: string, event: Extract<PullRequestEvent, { kind: "deployment_status" }>): Promise<PullRequestRouteOutcome> {
    const direct = await this.dependencies.pullRequests.findByCommit(tenantId, repositoryFullName, event.sha);
    let outcome: PullRequestRouteOutcome = "unmatched";
    const reached = new Set<string>();
    for (const pullRequest of direct) {
      reached.add(pullRequest.id);
      const delivered = await this.deliver(pullRequest, event);
      if (delivered === "routed" || outcome === "unmatched") outcome = delivered;
    }
    if (deployResultOf(event.state) === null) return outcome;
    const since = new Date(this.now().getTime() - DEPLOY_WINDOW_MS);
    const merged = await this.dependencies.pullRequests.listMergedForDeploy(tenantId, repositoryFullName, event.environment, since);
    for (const pullRequest of merged) {
      if (reached.has(pullRequest.id)) continue;
      const delivered = await this.deliver(pullRequest, event);
      if (delivered === "routed" || outcome === "unmatched") outcome = delivered;
    }
    return outcome;
  }

  /**
   * docs/specs/pr-feedback-loop.md, DI-21.211. A reply in the Linear agent session while the pull
   * request of its run is open. The first open pull request of the session takes it: in a change set
   * its PR follow-up run runs as the whole set. The answer is the workflow id that took it, or null
   * when the session has no open pull request.
   */
  async byAgentSession(tenantId: string, agentSessionId: string, event: Extract<PullRequestEvent, { kind: "linear_reply" }>): Promise<string | null> {
    const open = (await this.dependencies.pullRequests.listOpenByAgentSession?.(tenantId, agentSessionId)) ?? [];
    const pullRequest = open[0];
    if (pullRequest === undefined) return null;
    await this.dependencies.signal({ workflowId: pullRequest.workflowId, tenantId: pullRequest.tenantId, pullRequestId: pullRequest.id, event });
    return pullRequest.workflowId;
  }

  private now(): Date {
    return this.dependencies.now === undefined ? new Date() : this.dependencies.now();
  }

  /** DI-21.121. The PR workflow of a merged pull request takes deploys until the window ends. */
  private takesDeploy(pullRequest: PublishedPullRequest, event: PullRequestEvent): boolean {
    return (
      event.kind === "deployment_status" &&
      pullRequest.state === "merged" &&
      pullRequest.closedAt !== null &&
      pullRequest.closedAt.getTime() + DEPLOY_WINDOW_MS > this.now().getTime()
    );
  }

  private async deliver(pullRequest: PublishedPullRequest, event: PullRequestEvent): Promise<PullRequestRouteOutcome> {
    if (pullRequest.state === "open" || event.kind === "reopened" || this.takesDeploy(pullRequest, event)) {
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
