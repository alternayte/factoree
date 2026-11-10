import { describe, expect, it } from "vitest";
import {
  endsWithoutPullRequest,
  moveIfStill,
  pullRequestNumberOf,
  pullRequestsOutcome,
  startMoveOf,
  type IssueStatusPort,
  type IssueWorkflowState,
} from "~/domain/runs/issue-status.js";
import { PullRequestCloseHandler } from "~/domain/runs/pull-request-close.js";
import type { ClosedPullRequestRun, WebhookLog } from "~/domain/runs/run-repository.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";

const state = (id: string, type: string, position: number): IssueWorkflowState => ({ id, name: id, type, position });
const STATES = [
  state("Triage", "triage", 0),
  state("Backlog", "backlog", 1),
  state("Todo", "unstarted", 2),
  state("In Review", "started", 4),
  state("In Progress", "started", 3),
  state("Done", "completed", 5),
  state("Duplicate", "canceled", 6),
];
const byId = (id: string): IssueWorkflowState => STATES.find((entry) => entry.id === id) as IssueWorkflowState;

/** An issue in one state. A move changes it, so a later read sees the move. */
const fakeIssue = (initial: string) => {
  const issue = { current: initial, moves: [] as string[] };
  const port: IssueStatusPort = {
    read: () => Promise.resolve({ state: byId(issue.current), teamStates: STATES }),
    move: (_issueId, stateId) => {
      issue.moves.push(stateId);
      issue.current = stateId;
      return Promise.resolve();
    },
    attachPullRequest: () => Promise.resolve(),
  };
  return { issue, port };
};

describe("the issue status of a run (DI-21.49, DI-21.50)", () => {
  it("moves a backlog issue to the first started state by position", () => {
    expect(startMoveOf({ state: byId("Backlog"), teamStates: STATES })).toEqual({ from: byId("Backlog"), to: byId("In Progress") });
    expect(startMoveOf({ state: byId("Todo"), teamStates: STATES })?.to.id).toBe("In Progress");
  });

  it("adopts a started issue without a move, so a merge still completes it", () => {
    expect(startMoveOf({ state: byId("In Review"), teamStates: STATES })).toEqual({ from: byId("In Review"), to: byId("In Review") });
  });

  it("leaves an issue in triage, completed or canceled", () => {
    for (const id of ["Triage", "Done", "Duplicate"]) {
      expect(startMoveOf({ state: byId(id), teamStates: STATES })).toBeNull();
    }
  });

  it("moves back only the statuses that end with no pull request", () => {
    for (const status of ["FAILED", "FAILED_REVIEW", "FAILED_CONFIGURATION", "STALE_BASE", "CANCELLED", "REPORTED", "BLOCKED_ROUTING", "BLOCKED_STALE_SET"]) {
      expect(endsWithoutPullRequest(status)).toBe(true);
    }
    expect(endsWithoutPullRequest("READY_FOR_HUMAN")).toBe(false);
  });

  it("lets a manual move win", async () => {
    const { issue, port } = fakeIssue("Todo");
    expect((await moveIfStill(port, "issue-1", "In Progress", { stateId: "Backlog" })).kind).toBe("human_moved");
    expect(issue.moves).toEqual([]);
  });
});

describe("the pull requests of a run", () => {
  it("decide merged, closed or mixed only once none is open", () => {
    expect(pullRequestsOutcome(["merged", "open"])).toBe("open");
    expect(pullRequestsOutcome(["merged", "merged"])).toBe("merged");
    expect(pullRequestsOutcome(["closed"])).toBe("closed");
    expect(pullRequestsOutcome(["merged", "closed"])).toBe("mixed");
  });

  it("reads the number of a pull request URL", () => {
    expect(pullRequestNumberOf("https://github.com/acme/api/pull/12")).toBe(12);
    expect(pullRequestNumberOf("https://github.com/acme/api/pull/12/files")).toBe(12);
    expect(pullRequestNumberOf("https://github.com/acme/api/issues/12")).toBeNull();
  });
});

describe("the pull_request closed event (DI-21.51)", () => {
  const build = (initial: string, run: Omit<ClosedPullRequestRun, "runId" | "linearIssueId" | "linearAgentSessionId"> | null) => {
    const { issue, port } = fakeIssue(initial);
    const markers = new Set<string>();
    const webhookLog: WebhookLog = {
      recordIfNew: (input) => Promise.resolve(markers.has(input.deliveryId) ? false : (markers.add(input.deliveryId), true)),
      remove: (deliveryId) => Promise.resolve(void markers.delete(deliveryId)),
    };
    const lines: string[] = [];
    const recorded: unknown[] = [];
    const queries: unknown[] = [];
    const redactor = new Redactor();
    const handler = new PullRequestCloseHandler({
      webhookLog,
      runs: {
        closePullRequest: (...args) => {
          queries.push(args);
          return Promise.resolve(run === null ? null : { runId: "run-1", linearIssueId: "issue-1", linearAgentSessionId: "session-1", ...run });
        },
        setIssueState: (_tenantId, _runId, record) => Promise.resolve(void recorded.push(record)),
      },
      issues: () => Promise.resolve(port),
      respond: (_tenantId, _sessionId, body) => Promise.resolve(void lines.push(body)),
      logger: createLogger({ level: "error", redactor, sink: () => undefined }),
    });
    const close = (merged: boolean, deliveryId = "d1") =>
      handler.handle({ tenantId: "t1", deliveryId, repositoryFullName: "acme/api", number: 7, merged });
    return { issue, lines, recorded, queries, close };
  };
  const tracked = { issueStateFromId: "Backlog", issueStateSetId: "In Progress" };

  it("matches the run by repository and number, and moves the issue to the first completed state on a merge", async () => {
    const { issue, lines, recorded, queries, close } = build("In Progress", { ...tracked, pullRequestStates: ["merged"] });
    expect(await close(true)).toBe("handled");
    expect(queries).toEqual([["t1", "acme/api", 7, "merged"]]);
    expect(issue.current).toBe("Done");
    expect(recorded).toEqual([{ fromId: "Backlog", setId: "Done" }]);
    expect(lines).toEqual([]);
  });

  it("moves the issue back and posts one line when every pull request closed without a merge", async () => {
    const { issue, lines, close } = build("In Progress", { ...tracked, pullRequestStates: ["closed"] });
    await close(false);
    expect(issue.current).toBe("Backlog");
    expect(lines).toEqual(["The pull request of this run closed without a merge, so Factoree moved the issue back to Backlog."]);
  });

  it("moves nothing and posts one line on a mix of merged and closed", async () => {
    const { issue, lines, close } = build("In Progress", { ...tracked, pullRequestStates: ["merged", "closed"] });
    await close(false);
    expect(issue.moves).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("for a human to judge");
  });

  it("leaves an issue a human moved, and leaves an issue the run never moved", async () => {
    const moved = build("Todo", { ...tracked, pullRequestStates: ["merged"] });
    await moved.close(true);
    expect(moved.issue.moves).toEqual([]);
    const untracked = build("In Progress", { issueStateFromId: null, issueStateSetId: null, pullRequestStates: ["merged"] });
    await untracked.close(true);
    expect(untracked.issue.moves).toEqual([]);
  });

  it("handles one delivery once, and ignores a pull request no run opened", async () => {
    const once = build("In Progress", { ...tracked, pullRequestStates: ["closed"] });
    await once.close(false);
    expect(await once.close(false)).toBe("duplicate");
    expect(once.lines).toHaveLength(1);
    expect(await build("Backlog", null).close(true)).toBe("unmatched");
  });
});
