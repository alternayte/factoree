import type { Logger } from "~/telemetry/logger.js";
import { metrics } from "~/telemetry/metrics.js";
import type { AgentRunWorkflowInput } from "~/workflows/agent-run.workflow.js";
import { stopResponse, type StopRequest } from "./run-stop.js";

/**
 * docs/specs/blocked-by-wait.md. One blocker of a work item, as the run row stores it in
 * `blockers`. `state` is the Linear state type: triage, backlog, unstarted, started, completed or
 * canceled. `pullRequestUrl` is the pull request of the newest Factoree run of the blocker issue.
 */
export interface Blocker {
  issueId: string;
  identifier: string;
  url: string | null;
  state: string;
  pullRequestUrl: string | null;
}

/** A blocker as Linear returns it, before Factoree adds its own pull request. */
export type ReadBlocker = Omit<Blocker, "pullRequestUrl">;

/** One `inverseRelations` node of the work item, as Linear returns it. */
export interface InverseRelationNode {
  type: string;
  issue: { id: string; identifier: string; url?: string | null; state?: { type: string } | null } | null;
}

/** Linear answers no state type for an issue Factoree cannot read in full, so it stays open. */
const UNKNOWN_STATE = "unknown";

/**
 * "Blocked by X" is an inverse relation of type `blocks` whose `issue` is X. Every other type
 * (related, duplicate, similar) holds nothing. Linear can list a pair twice, so the first wins.
 */
export const blockersOf = (relations: readonly InverseRelationNode[]): ReadBlocker[] => {
  const seen = new Set<string>();
  const blockers: ReadBlocker[] = [];
  for (const relation of relations) {
    if (relation.type !== "blocks" || relation.issue === null || seen.has(relation.issue.id)) continue;
    seen.add(relation.issue.id);
    blockers.push({
      issueId: relation.issue.id,
      identifier: relation.issue.identifier,
      url: relation.issue.url ?? null,
      state: relation.issue.state?.type ?? UNKNOWN_STATE,
    });
  }
  return blockers;
};

/**
 * A blocker is open while its state type is not `completed` and not `canceled`, as Linear's own
 * `hasBlockedByRelations` counts a pair only while both issues are open.
 */
export const isOpenBlocker = (blocker: Pick<Blocker, "state">): boolean =>
  blocker.state !== "completed" && blocker.state !== "canceled";

export const openBlockers = (blockers: readonly Blocker[]): Blocker[] => blockers.filter(isOpenBlocker);

const sorted = (blockers: readonly Blocker[]): Blocker[] =>
  [...blockers]
    .map((blocker) => ({
      issueId: blocker.issueId,
      identifier: blocker.identifier,
      url: blocker.url,
      state: blocker.state,
      pullRequestUrl: blocker.pullRequestUrl,
    }))
    .sort((left, right) => (left.issueId < right.issueId ? -1 : left.issueId > right.issueId ? 1 : 0));

/** True when two reads hold the same blockers with the same facts, in any order. */
export const sameBlockers = (left: readonly Blocker[] | null, right: readonly Blocker[] | null): boolean =>
  left === null || right === null ? left === right : JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));

const openSetKey = (blockers: readonly Blocker[] | null): string | null =>
  blockers === null
    ? null
    : openBlockers(blockers)
        .map((blocker) => blocker.issueId)
        .sort()
        .join(",");

/** DI-21.84. A new line goes out only when the set of open blockers changes. */
export const openSetChanged = (before: readonly Blocker[] | null, after: readonly Blocker[]): boolean =>
  openSetKey(before) !== openSetKey(after);

const named = (blocker: Blocker): string =>
  blocker.pullRequestUrl === null ? blocker.identifier : `${blocker.identifier} (${blocker.pullRequestUrl})`;

const list = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;

/** The elicitation a waiting run posts, for one or more open blockers. */
export const waitingLine = (open: readonly Blocker[]): string =>
  `Waiting for ${list(open.map(named))} to complete. Factoree starts this issue when ${open.length === 1 ? "it does" : "they do"}.`;

/** DI-21.85. The elicitation of a run whose first read of the blockers failed. */
export const UNREAD_LINE =
  "Factoree could not read the blockers of this issue in Linear, so it waits and reads them again within a minute.";

/**
 * DI-21.85. The elicitation of a waiting run whose own issue Linear no longer returns: it was
 * deleted or archived, or the app lost access to its team.
 */
export const UNRETURNED_LINE =
  "Factoree cannot read this issue in Linear, so it keeps waiting. Stop the run, or restore the app's access to the issue.";

/** The fixed answer to a reply during the wait. No workflow exists yet to take it. */
export const replyLine = (blockers: readonly Blocker[] | null): string => {
  const open = blockers === null ? [] : openBlockers(blockers);
  const opening =
    blockers === null
      ? "Factoree has not read the blockers of this issue yet."
      : open.length === 0
        ? "No blocker of this issue is open, so Factoree starts it within a minute."
        : `This issue waits for ${list(open.map(named))} to complete.`;
  return `${opening} Remove the relation in Linear to start now.`;
};

/** DI-21.86. The line on a blocked session when a Factoree pull request of a blocker closes unmerged. */
export const closedWithoutMergeLine = (blocker: Blocker, pullRequest: string): string =>
  `The pull request ${pullRequest} of ${blocker.identifier} closed without a merge. ${blocker.identifier} is still open, so this issue keeps waiting for it.`;

/** One run in WAITING_FOR_BLOCKERS. */
export interface WaitingRun {
  id: string;
  tenantId: string;
  productId: string;
  linearIssueId: string | null;
  linearAgentSessionId: string;
  temporalWorkflowId: string;
  /** Null until a read of the blockers succeeds. */
  blockers: Blocker[] | null;
  startInput: AgentRunWorkflowInput;
}

export interface CreateWaitingRunInput {
  tenantId: string;
  productId: string;
  linearIssueId: string | null;
  linearAgentSessionId: string;
  temporalWorkflowId: string;
  autonomyLevel: string;
  workItemTitle: string;
  workItemUrl: string | null;
  startInput: AgentRunWorkflowInput;
  blockers: Blocker[] | null;
}

export interface WaitingRunStore {
  /** Writes the WAITING_FOR_BLOCKERS row. `created` is false when the workflow id has a row. */
  createWaiting(input: CreateWaitingRunInput): Promise<{ runId: string; created: boolean }>;
  /** Every waiting run, or every waiting run of one tenant. */
  listWaiting(tenantId?: string): Promise<WaitingRun[]>;
  findWaiting(tenantId: string, runId: string): Promise<WaitingRun | null>;
  /**
   * Writes the blockers of a run only while it waits and still holds `previous`, so of two sweeps
   * that read at the same time only one posts the change.
   */
  replaceBlockers(runId: string, previous: Blocker[] | null, next: Blocker[]): Promise<boolean>;
  /**
   * DI-21.85. Sets the blockers of a waiting run back to unread (null) while it still holds
   * `previous`. It answers false when another sweep, a stop or the start took the run.
   */
  clearBlockers(runId: string, previous: Blocker[]): Promise<boolean>;
  /**
   * Ends a waiting run as CANCELLED with STOPPED_BY_HUMAN and records the stop. It answers null
   * when the run no longer waits, because a workflow adopted it.
   */
  cancel(tenantId: string, runId: string, request: StopRequest, at: Date): Promise<WaitingRun | null>;
  /** The pull request URL of the newest Factoree run of each issue that has one. */
  pullRequestsOf(tenantId: string, issueIds: readonly string[]): Promise<Map<string, string>>;
}

/** Reads the blockers of several work items of one workspace in one batched query. */
export interface BlockerReader {
  /** The blockers of each issue. An issue Linear does not return is absent from the map. */
  read(issueIds: readonly string[]): Promise<Map<string, ReadBlocker[]>>;
}

export interface BlockerWaitDependencies {
  store: WaitingRunStore;
  /** The blocker reader of the tenant's Linear workspace. */
  reader: (tenantId: string) => Promise<BlockerReader>;
  /**
   * Starts the run workflow with its deterministic id. It answers "already_started" when a
   * workflow of that id exists, so two sweeps or two workers cannot start a run twice.
   */
  start: (workflowId: string, input: AgentRunWorkflowInput) => Promise<"started" | "already_started">;
  /** Posts one activity on the agent session of a run of the tenant. */
  post: (tenantId: string, sessionId: string, kind: "elicitation" | "response", body: string) => Promise<void>;
  logger: Logger;
  now?: () => Date;
}

/**
 * docs/specs/blocked-by-wait.md. The hold of a blocked work item: the delegation records the
 * waiting run, the sweep reads its blockers again and starts the run when none is open, and a stop
 * or a reply reaches the row, because no workflow exists to signal.
 */
export class BlockerWait {
  constructor(private readonly dependencies: BlockerWaitDependencies) {}

  private async withPullRequests(tenantId: string, read: readonly ReadBlocker[]): Promise<Blocker[]> {
    const pullRequests = read.length === 0 ? new Map<string, string>() : await this.dependencies.store.pullRequestsOf(tenantId, read.map((blocker) => blocker.issueId));
    return read.map((blocker) => ({ ...blocker, pullRequestUrl: pullRequests.get(blocker.issueId) ?? null }));
  }

  /**
   * At delegation. It reads the blockers of the work item with one query. With no open blocker it
   * answers false and the delegation starts the run as before. With an open blocker, or a failed
   * read, it writes the waiting row, posts the elicitation and answers true.
   */
  async hold(input: Omit<CreateWaitingRunInput, "blockers">): Promise<boolean> {
    const issueId = input.linearIssueId;
    if (issueId === null) return false;
    let blockers: Blocker[] | null;
    try {
      const read = await (await this.dependencies.reader(input.tenantId)).read([issueId]);
      blockers = await this.withPullRequests(input.tenantId, read.get(issueId) ?? []);
    } catch (error) {
      // A run on the wrong base is the defect this feature prevents, so a failed read waits.
      this.dependencies.logger.warn("the blockers of the work item were not read; the run waits", {
        tenant_id: input.tenantId,
        workflow_id: input.temporalWorkflowId,
        step: "blockers",
        error: String(error),
      });
      blockers = null;
    }
    if (blockers !== null && openBlockers(blockers).length === 0) return false;
    const { runId, created } = await this.dependencies.store.createWaiting({ ...input, blockers });
    if (!created) return true;
    this.dependencies.logger.info("run waits for blockers", {
      tenant_id: input.tenantId,
      product_id: input.productId,
      run_id: runId,
      step: "blockers",
      blockers: blockers === null ? "unread" : openBlockers(blockers).map((blocker) => blocker.identifier).join(","),
    });
    await this.post(input.tenantId, input.linearAgentSessionId, "elicitation", blockers === null ? UNREAD_LINE : waitingLine(openBlockers(blockers)));
    return true;
  }

  /**
   * One pass over every waiting run, or over the waiting runs of one tenant. Each tenant costs one
   * batched read. A failed tenant never stops the pass of another.
   */
  async sweep(tenantId?: string): Promise<{ released: number }> {
    const waiting = await this.dependencies.store.listWaiting(tenantId);
    const byTenant = new Map<string, WaitingRun[]>();
    for (const run of waiting) byTenant.set(run.tenantId, [...(byTenant.get(run.tenantId) ?? []), run]);
    let released = 0;
    for (const [tenant, runs] of byTenant) {
      try {
        released += await this.sweepTenant(tenant, runs);
      } catch (error) {
        this.dependencies.logger.warn("the blocker sweep of a tenant failed; its runs keep waiting", {
          tenant_id: tenant,
          step: "blockers",
          error: String(error),
        });
      }
    }
    return { released };
  }

  private async sweepTenant(tenantId: string, runs: readonly WaitingRun[]): Promise<number> {
    const issueIds = [...new Set(runs.flatMap((run) => (run.linearIssueId === null ? [] : [run.linearIssueId])))];
    const read = issueIds.length === 0 ? new Map<string, ReadBlocker[]>() : await (await this.dependencies.reader(tenantId)).read(issueIds);
    const pullRequests = await this.dependencies.store.pullRequestsOf(tenantId, [
      ...new Set([...read.values()].flat().map((blocker) => blocker.issueId)),
    ]);
    let released = 0;
    for (const run of runs) {
      const log = { tenant_id: tenantId, run_id: run.id, step: "blockers" };
      // DI-21.85. A work item Linear does not return holds its run: Factoree cannot tell that its
      // blockers completed, and a run on the wrong base is the defect this wait prevents. The line
      // goes out once, when the row moves from read blockers to none.
      if (run.linearIssueId !== null && !read.has(run.linearIssueId)) {
        try {
          if (run.blockers !== null && (await this.dependencies.store.clearBlockers(run.id, run.blockers))) {
            await this.post(tenantId, run.linearAgentSessionId, "elicitation", UNRETURNED_LINE);
          }
          this.dependencies.logger.warn("Linear did not return the work item of a waiting run; the run keeps waiting", log);
        } catch (error) {
          this.dependencies.logger.warn("the blocker sweep of a run failed; the run keeps waiting", { ...log, error: String(error) });
        }
        continue;
      }
      const next: Blocker[] = (run.linearIssueId === null ? [] : (read.get(run.linearIssueId) ?? [])).map((blocker) => ({
        ...blocker,
        pullRequestUrl: pullRequests.get(blocker.issueId) ?? null,
      }));
      const open = openBlockers(next);
      try {
        if (!sameBlockers(run.blockers, next)) {
          // Another sweep, a stop or the start took the run since this read.
          if (!(await this.dependencies.store.replaceBlockers(run.id, run.blockers, next))) continue;
          if (open.length > 0 && openSetChanged(run.blockers, next)) {
            await this.post(tenantId, run.linearAgentSessionId, "elicitation", waitingLine(open));
          }
        }
        if (open.length > 0) continue;
        const outcome = await this.dependencies.start(run.temporalWorkflowId, run.startInput);
        if (outcome === "started") released += 1;
        this.dependencies.logger.info(outcome === "started" ? "run released; no blocker is open" : "run already started", log);
      } catch (error) {
        this.dependencies.logger.warn("the blocker sweep of a run failed; the run keeps waiting", { ...log, error: String(error) });
      }
    }
    return released;
  }

  /**
   * A Linear stop or a Factoree UI stop of a waiting run. It answers false when the run does not
   * wait, so the caller reports that nothing stopped.
   */
  async stop(tenantId: string, runId: string, request: StopRequest): Promise<boolean> {
    const run = await this.dependencies.store.cancel(tenantId, runId, request, this.now());
    if (run === null) return false;
    metrics.runsCancelled.inc({ tenant_id: tenantId, product_id: run.productId });
    this.dependencies.logger.info("waiting run stopped", { tenant_id: tenantId, run_id: runId, step: "blockers", source: request.source });
    await this.post(tenantId, run.linearAgentSessionId, "response", stopResponse(request, null));
    return true;
  }

  /** The fixed answer to a reply during the wait. It answers false when the run no longer waits. */
  async answerReply(tenantId: string, runId: string): Promise<boolean> {
    const run = await this.dependencies.store.findWaiting(tenantId, runId);
    if (run === null) return false;
    await this.post(tenantId, run.linearAgentSessionId, "response", replyLine(run.blockers));
    return true;
  }

  /**
   * A Factoree pull request of the blocker issue closed without a merge. Each run that waits for
   * that issue, while it is open, gets one line. The run keeps waiting.
   */
  async pullRequestClosedUnmerged(tenantId: string, blockerIssueId: string, pullRequest: string): Promise<void> {
    for (const run of await this.dependencies.store.listWaiting(tenantId)) {
      const blocker = (run.blockers ?? []).find((candidate) => candidate.issueId === blockerIssueId);
      if (blocker === undefined || !isOpenBlocker(blocker)) continue;
      await this.post(tenantId, run.linearAgentSessionId, "response", closedWithoutMergeLine(blocker, pullRequest));
    }
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  /** A Linear fault never undoes the row the post describes, so it is logged. */
  private async post(tenantId: string, sessionId: string, kind: "elicitation" | "response", body: string): Promise<void> {
    try {
      await this.dependencies.post(tenantId, sessionId, kind, body);
    } catch (error) {
      this.dependencies.logger.warn("the blocker line was not posted", {
        tenant_id: tenantId,
        session_id: sessionId,
        step: "blockers",
        error: String(error),
      });
    }
  }
}
