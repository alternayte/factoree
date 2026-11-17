import type { Logger } from "~/telemetry/logger.js";
import type { ClosedPullRequestRun, RunRepository, WebhookLog } from "./run-repository.js";
import { moveIfStill, pullRequestsOutcome, type IssueMove, type IssueStatusPort } from "./issue-status.js";
import type { FailedDeployIssueMove } from "~/domain/pull-requests/deploys.js";

export interface PullRequestCloseDependencies {
  webhookLog: WebhookLog;
  runs: Pick<RunRepository, "closePullRequest" | "setIssueState" | "findById">;
  /** The Linear status port of the tenant's workspace. */
  issues: (tenantId: string) => Promise<IssueStatusPort>;
  /** Posts one line in the agent session of the run. */
  respond: (tenantId: string, sessionId: string, body: string) => Promise<void>;
  logger: Logger;
  /**
   * docs/specs/blocked-by-wait.md. The runs that wait for the issue of this run. A merge starts a
   * sweep of the tenant at once. A close without a merge posts one line on each waiting session.
   */
  blockers?: {
    sweepSoon(tenantId: string): void;
    pullRequestClosedUnmerged(tenantId: string, blockerIssueId: string, pullRequest: string): Promise<void>;
  };
}

export type PullRequestCloseOutcome = "handled" | "duplicate" | "unmatched";

/** The line a close posts, by what the move did. */
const closedLine = (count: number, move: IssueMove | null): string => {
  const subject = count === 1 ? "The pull request of this run closed without a merge" : "Every pull request of this run closed without a merge";
  if (move === null) return `${subject}. Factoree did not move the issue, because this run did not move it.`;
  switch (move.kind) {
    case "moved":
      return `${subject}, so Factoree moved the issue back to ${move.to.name}.`;
    case "human_moved":
      return `${subject}. The issue status changed by hand, so Factoree left it in ${move.current.name}.`;
    default:
      return `${subject}. Factoree could not move the issue back.`;
  }
};

/**
 * docs/specs/egress-honesty-and-issue-status.md, DI-21.51. A GitHub `pull_request` event with the
 * action `closed`. Factoree records the state on the run target, and once no pull request of the
 * run is open it decides: every one merged moves the issue to the team's first completed state,
 * every one closed moves it back to the state the run moved it from with one line, and a mix moves
 * nothing and posts one line. A move happens only while the issue is in the state Factoree set.
 */
export class PullRequestCloseHandler {
  constructor(private readonly dependencies: PullRequestCloseDependencies) {}

  async handle(input: {
    tenantId: string;
    deliveryId: string;
    repositoryFullName: string;
    number: number;
    merged: boolean;
  }): Promise<PullRequestCloseOutcome> {
    const isNew = await this.dependencies.webhookLog.recordIfNew({
      tenantId: input.tenantId,
      deliveryId: input.deliveryId,
      eventType: "pull_request.closed",
    });
    if (!isNew) return "duplicate";
    try {
      return await this.apply(input);
    } catch (error) {
      // A redelivery must find no marker, so the event is not lost.
      await this.dependencies.webhookLog.remove(input.deliveryId);
      throw error;
    }
  }

  /**
   * docs/specs/pr-review-merge-and-deploy.md, D3. The PR workflow of a recorded pull request takes the
   * close. Its delivery is already taken once, so no webhook marker applies, and the origin run of the
   * record decides the issue move.
   */
  async closeOfRecord(input: {
    tenantId: string;
    repositoryFullName: string;
    number: number;
    merged: boolean;
    originRunId: string;
  }): Promise<PullRequestCloseOutcome> {
    return this.apply(input);
  }

  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 5, DI-21.122. A failed deploy holds the merged
   * change of the origin run, so its issue moves back from completed to the state the run moved it
   * from, as a close without a merge moves it (DI-21.51). It moves only while the issue is in the
   * completed state Factoree set.
   */
  async afterFailedDeploy(input: { tenantId: string; originRunId: string }): Promise<{ move: FailedDeployIssueMove; stateName: string | null }> {
    const run = await this.dependencies.runs.findById(input.tenantId, input.originRunId);
    if (run === null || run.linearIssueId === null || run.issueStateSetId === null || run.issueStateFromId === null) {
      return { move: "not_moved", stateName: null };
    }
    const port = await this.dependencies.issues(input.tenantId);
    const snapshot = await port.read(run.linearIssueId);
    if (snapshot === null) return { move: "not_moved", stateName: null };
    if (snapshot.state.id !== run.issueStateSetId) return { move: "human_moved", stateName: snapshot.state.name };
    // Only an issue Factoree completed moves back. An issue the merge did not complete stays.
    if (snapshot.state.type !== "completed") return { move: "not_moved", stateName: snapshot.state.name };
    const move = await moveIfStill(port, run.linearIssueId, run.issueStateSetId, { stateId: run.issueStateFromId });
    if (move.kind === "moved") {
      await this.dependencies.runs.setIssueState(input.tenantId, run.id, { fromId: run.issueStateFromId, setId: move.to.id });
      return { move: "moved", stateName: move.to.name };
    }
    if (move.kind === "human_moved") return { move: "human_moved", stateName: move.current.name };
    return { move: "not_moved", stateName: null };
  }

  private async apply(input: {
    tenantId: string;
    repositoryFullName: string;
    number: number;
    merged: boolean;
    originRunId?: string;
  }): Promise<PullRequestCloseOutcome> {
    const run = await this.dependencies.runs.closePullRequest(
      input.tenantId,
      input.repositoryFullName,
      input.number,
      input.merged ? "merged" : "closed",
      ...(input.originRunId === undefined ? [] : [input.originRunId]),
    );
    if (run === null) return "unmatched";
    await this.decide(input, run);
    // After the issue move, so the sweep reads the blocker issue in the state the merge gave it.
    const blockers = this.dependencies.blockers;
    if (blockers !== undefined && run.linearIssueId !== null) {
      if (input.merged) blockers.sweepSoon(input.tenantId);
      else await blockers.pullRequestClosedUnmerged(input.tenantId, run.linearIssueId, `${input.repositoryFullName}#${String(input.number)}`);
    }
    return "handled";
  }

  private async decide(input: { tenantId: string; merged: boolean }, run: ClosedPullRequestRun): Promise<void> {
    const outcome = pullRequestsOutcome(run.pullRequestStates);
    const log = { run_id: run.runId, step: "pull_request_closed", outcome };
    if (outcome === "open") {
      this.dependencies.logger.info("a pull request of the run closed, and another one is still open", log);
      return;
    }
    if (outcome === "mixed") {
      await this.dependencies.respond(
        input.tenantId,
        run.linearAgentSessionId,
        "Some pull requests of this run merged and others closed without a merge, so Factoree left the issue status for a human to judge.",
      );
      this.dependencies.logger.info("the pull requests of the run merged in part", log);
      return;
    }
    // A run that moved nothing at its start leaves the issue to a human.
    let move: IssueMove | null = null;
    if (run.linearIssueId !== null && run.issueStateSetId !== null) {
      const port = await this.dependencies.issues(input.tenantId);
      if (outcome === "merged") {
        move = await moveIfStill(port, run.linearIssueId, run.issueStateSetId, { type: "completed" });
      } else if (run.issueStateFromId !== null) {
        move = await moveIfStill(port, run.linearIssueId, run.issueStateSetId, { stateId: run.issueStateFromId });
      }
      if (move?.kind === "moved") {
        await this.dependencies.runs.setIssueState(input.tenantId, run.runId, { fromId: run.issueStateFromId, setId: move.to.id });
      }
    }
    if (outcome === "closed") {
      await this.dependencies.respond(input.tenantId, run.linearAgentSessionId, closedLine(run.pullRequestStates.length, move));
    }
    this.dependencies.logger.info("the pull requests of the run closed", { ...log, issue_move: move?.kind ?? "none" });
  }
}
