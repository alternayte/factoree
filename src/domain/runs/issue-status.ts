/**
 * docs/specs/egress-honesty-and-issue-status.md. Factoree moves the Linear issue status by itself:
 * to started when a run starts, to completed when its pull requests merge, and back to the
 * previous status when a run ends without a pull request or every pull request closes without a
 * merge. It moves an issue only while the issue is still in the state Factoree set, so a human
 * change of status wins (DI-21.49).
 */

/** One workflow state of a Linear team. `type` is the Linear state type, such as `started`. */
export interface IssueWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
}

/** The current state of one issue and every workflow state of its team. */
export interface IssueStateSnapshot {
  state: IssueWorkflowState;
  teamStates: IssueWorkflowState[];
}

/** The Linear calls the status moves need. The adapter acts as the Factoree app of the workspace. */
export interface IssueStatusPort {
  /** The state of the issue, or null when the issue no longer exists. */
  read(issueId: string): Promise<IssueStateSnapshot | null>;
  move(issueId: string, stateId: string): Promise<void>;
  /** Links a pull request to the issue as an attachment. A second call with the same URL updates it. */
  attachPullRequest(issueId: string, pullRequest: { url: string; title: string; subtitle: string }): Promise<void>;
}

/** The state a run moved its issue from, and the state it set. Both null when it moved nothing. */
export interface IssueStateRecord {
  fromId: string | null;
  setId: string | null;
}

/** The Linear state types a run never moves out of at its start (DI-21.49). */
const UNTOUCHED_AT_START = new Set(["triage", "started", "completed", "canceled"]);

/** The first state of a type by position, as the Linear board orders it, or null. */
export const firstStateOfType = (states: readonly IssueWorkflowState[], type: string): IssueWorkflowState | null =>
  [...states].filter((state) => state.type === type).sort((left, right) => left.position - right.position)[0] ?? null;

/**
 * The move a starting run makes: from the current state to the team's first `started` state. An
 * issue in triage, started, completed or canceled stays where it is, and so does an issue of a
 * team with no started state.
 */
export const startMoveOf = (snapshot: IssueStateSnapshot): { from: IssueWorkflowState; to: IssueWorkflowState } | null => {
  if (UNTOUCHED_AT_START.has(snapshot.state.type)) return null;
  const to = firstStateOfType(snapshot.teamStates, "started");
  return to === null ? null : { from: snapshot.state, to };
};

/**
 * The run statuses that end with no pull request. Such a run moves its issue back to its
 * previous state. READY_FOR_HUMAN is the one status with a pull request.
 */
export const endsWithoutPullRequest = (status: string): boolean =>
  ["FAILED", "FAILED_REVIEW", "FAILED_CONFIGURATION", "STALE_BASE", "CANCELLED", "REPORTED"].includes(status) ||
  status.startsWith("BLOCKED");

export type PullRequestState = "open" | "merged" | "closed";

/**
 * What the pull requests of one run decide together. `open` while any one is open, `merged` when
 * every one merged, `closed` when every one closed without a merge, and `mixed` for the rest.
 */
export const pullRequestsOutcome = (states: readonly PullRequestState[]): "open" | "merged" | "closed" | "mixed" => {
  if (states.length === 0 || states.includes("open")) return "open";
  if (states.every((state) => state === "merged")) return "merged";
  if (states.every((state) => state === "closed")) return "closed";
  return "mixed";
};

/** The number of a GitHub pull request URL, such as 12 of `.../owner/repo/pull/12`, or null. */
export const pullRequestNumberOf = (url: string): number | null => {
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  return match === null ? null : Number(match[1]);
};

export type IssueMove =
  | { kind: "moved"; to: IssueWorkflowState }
  /** The issue is no longer in the state Factoree set. A human moved it, and that wins. */
  | { kind: "human_moved"; current: IssueWorkflowState }
  | { kind: "gone" }
  | { kind: "no_state" };

/**
 * Moves the issue to `targetId` only while it is still in `expectedId`, the state Factoree set.
 * `targetType` instead picks the team's first state of that type.
 */
export const moveIfStill = async (
  port: IssueStatusPort,
  issueId: string,
  expectedId: string,
  target: { stateId: string } | { type: string },
): Promise<IssueMove> => {
  const snapshot = await port.read(issueId);
  if (snapshot === null) return { kind: "gone" };
  if (snapshot.state.id !== expectedId) return { kind: "human_moved", current: snapshot.state };
  const to =
    "stateId" in target
      ? (snapshot.teamStates.find((state) => state.id === target.stateId) ?? null)
      : firstStateOfType(snapshot.teamStates, target.type);
  if (to === null) return { kind: "no_state" };
  if (to.id !== snapshot.state.id) await port.move(issueId, to.id);
  return { kind: "moved", to };
};
