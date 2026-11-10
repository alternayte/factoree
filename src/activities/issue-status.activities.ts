import type { Logger } from "~/telemetry/logger.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import { moveIfStill, pullRequestNumberOf, startMoveOf, type IssueStatusPort } from "~/domain/runs/issue-status.js";

export interface IssueStatusActivityDependencies {
  runs: RunRepository;
  /** The Linear status port of the tenant's workspace. */
  issues: (tenantId: string) => Promise<IssueStatusPort>;
  agentSession: AgentSessionPort;
  logger: Logger;
}

/**
 * docs/specs/egress-honesty-and-issue-status.md. The Linear issue status of a run. The workflow
 * calls each activity inside `notify`, so a Linear fault never fails a run.
 */
export const createIssueStatusActivities = (dependencies: IssueStatusActivityDependencies) => ({
  /**
   * DI-21.49. Moves the issue to the team's first started state, unless it is in triage, started,
   * completed or canceled. The run records the move before it makes it, so a retry after a lost
   * answer still knows the state Factoree set.
   */
  async startIssueWork(input: { tenantId: string; runId: string; issueId: string }): Promise<void> {
    const port = await dependencies.issues(input.tenantId);
    const snapshot = await port.read(input.issueId);
    if (snapshot === null) return;
    const move = startMoveOf(snapshot);
    if (move === null) {
      dependencies.logger.info("the issue stays in its state", {
        run_id: input.runId,
        step: "issue_status",
        state_type: snapshot.state.type,
      });
      return;
    }
    await dependencies.runs.setIssueState(input.tenantId, input.runId, { fromId: move.from.id, setId: move.to.id });
    await port.move(input.issueId, move.to.id);
    dependencies.logger.info("the issue moved to started", { run_id: input.runId, step: "issue_status", state: move.to.name });
  },

  /**
   * DI-21.50. A run that ends with no pull request moves its issue back to the state it moved it
   * from, while the issue is still in the state the run set.
   */
  async restoreIssueStatus(input: { tenantId: string; runId: string }): Promise<void> {
    const run = await dependencies.runs.findById(input.tenantId, input.runId);
    if (run === null || run.linearIssueId === null || run.issueStateFromId === null || run.issueStateSetId === null) return;
    const port = await dependencies.issues(input.tenantId);
    const moved = await moveIfStill(port, run.linearIssueId, run.issueStateSetId, { stateId: run.issueStateFromId });
    if (moved.kind === "moved") {
      await dependencies.runs.setIssueState(input.tenantId, input.runId, { fromId: run.issueStateFromId, setId: moved.to.id });
    }
    dependencies.logger.info("the issue status after the run", { run_id: input.runId, step: "issue_status", outcome: moved.kind });
  },

  /**
   * DI-21.52. Links a new pull request to the issue as an attachment and to the agent session as
   * an external URL. The issue then shows its pull request without the Linear GitHub integration.
   */
  async linkPullRequest(input: {
    tenantId: string;
    sessionId: string;
    issueId: string | null;
    pullRequestUrl: string;
    repositorySlug: string;
  }): Promise<void> {
    // The attachment goes first. Linear keeps one attachment per URL, so a retry repeats it safely.
    if (input.issueId !== null) {
      const number = pullRequestNumberOf(input.pullRequestUrl);
      const port = await dependencies.issues(input.tenantId);
      await port.attachPullRequest(input.issueId, {
        url: input.pullRequestUrl,
        title: number === null ? "Pull request" : `Pull request #${String(number)}`,
        subtitle: input.repositorySlug,
      });
    }
    await dependencies.agentSession.addLink(input.sessionId, "Pull request", input.pullRequestUrl);
  },
});
