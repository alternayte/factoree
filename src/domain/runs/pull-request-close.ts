import type { Logger } from "~/telemetry/logger.js";
import type { RunRepository, WebhookLog } from "./run-repository.js";
import { moveIfStill, pullRequestsOutcome, type IssueMove, type IssueStatusPort } from "./issue-status.js";

export interface PullRequestCloseDependencies {
  webhookLog: WebhookLog;
  runs: Pick<RunRepository, "closePullRequest" | "setIssueState">;
  /** The Linear status port of the tenant's workspace. */
  issues: (tenantId: string) => Promise<IssueStatusPort>;
  /** Posts one line in the agent session of the run. */
  respond: (tenantId: string, sessionId: string, body: string) => Promise<void>;
  logger: Logger;
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

  private async apply(input: { tenantId: string; repositoryFullName: string; number: number; merged: boolean }): Promise<PullRequestCloseOutcome> {
    const run = await this.dependencies.runs.closePullRequest(
      input.tenantId,
      input.repositoryFullName,
      input.number,
      input.merged ? "merged" : "closed",
    );
    if (run === null) return "unmatched";
    const outcome = pullRequestsOutcome(run.pullRequestStates);
    const log = { run_id: run.runId, step: "pull_request_closed", outcome };
    if (outcome === "open") {
      this.dependencies.logger.info("a pull request of the run closed, and another one is still open", log);
      return "handled";
    }
    if (outcome === "mixed") {
      await this.dependencies.respond(
        input.tenantId,
        run.linearAgentSessionId,
        "Some pull requests of this run merged and others closed without a merge, so Factoree left the issue status for a human to judge.",
      );
      this.dependencies.logger.info("the pull requests of the run merged in part", log);
      return "handled";
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
    return "handled";
  }
}
