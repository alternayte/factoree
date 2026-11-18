import { mergeOrderOf } from "../runs/merge-order.js";
import type { PublishedPullRequest } from "./pull-request-store.js";

/**
 * docs/specs/change-sets.md, slice 8. The merge-order commit status of a change set. Factoree sets
 * it on the head of each consumer pull request: pending while a provider pull request is open,
 * success when every provider has merged, and failure when a provider closes unmerged or holds a
 * head that Factoree did not push after a set check. A ruleset that requires the status holds the
 * consumer back until its providers merged.
 *
 * The PR workflow and the agent run import this module through activities only.
 */

/** The commit status context. A ruleset requires it by this name. */
export const CHANGE_SET_STATUS_CONTEXT = "factoree/change-set";

/** GitHub refuses a commit status description longer than 140 characters. */
const MAX_DESCRIPTION = 140;

export type ChangeSetStatusState = "pending" | "success" | "failure";

/** One pull request of a change set: a target of the origin run that opened a pull request. */
export interface ChangeSetMember {
  repositoryId: string;
  repositoryFullName: string;
  githubInstallationId: string;
  number: number;
  url: string;
  /** `pr:<tenant>:<repository>#<number>`, derived from the run target, so it is known before the record exists. */
  workflowId: string;
  /** The record of the pull request, or null while the publication has not recorded it yet. */
  record: PublishedPullRequest | null;
  /** DI-21.155. The last status Factoree set on this pull request: `<sha> <state> <description>`. */
  statusKey: string | null;
}

/** DI-21.155. The pull requests of one change set, with the edges of the run that opened them. */
export interface ChangeSet {
  /** The run that opened every pull request of the set. */
  originRunId: string;
  /** Every target of the origin run, in set order, with or without a pull request. */
  targets: string[];
  /** The targets that opened a pull request, in set order. Two or more. */
  members: ChangeSetMember[];
  /** The cited provider-to-consumer edges of the origin run, by repository full name. */
  edges: Array<{ provider: string; consumer: string }>;
}

/** One status to set on the head of one consumer pull request. */
export interface ChangeSetStatus {
  member: ChangeSetMember;
  sha: string;
  state: ChangeSetStatusState;
  description: string;
  /** The provider pull request the status points to. */
  targetUrl: string;
}

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const label = (member: ChangeSetMember): string => `${member.repositoryFullName}#${String(member.number)}`;

const fit = (text: string): string => (text.length <= MAX_DESCRIPTION ? text : `${text.slice(0, MAX_DESCRIPTION - 1)}…`);

const list = (members: readonly ChangeSetMember[]): string => members.map(label).join(", ");

/** The key Factoree stores for the last status it set, so an unchanged status is not set again. */
export const changeSetStatusKey = (status: Pick<ChangeSetStatus, "sha" | "state" | "description">): string =>
  `${status.sha} ${status.state} ${status.description}`;

/**
 * DI-21.141. A cycle among the targets gives no safe merge order, so the set carries no status.
 */
export const hasSafeOrder = (set: Pick<ChangeSet, "targets" | "edges">): boolean =>
  mergeOrderOf(set.targets, set.edges.map((edge) => ({ ...edge, file: "", line: 0 }))).kind !== "cycle";

/**
 * docs/specs/change-sets.md, slice 8, DI-21.155. The status of each open consumer pull request of a
 * set, from the records of every pull request of the set:
 * - failure when a provider pull request closed without a merge, or when an open provider holds a
 *   head that is not its verified head, the head Factoree pushed after a set check;
 * - pending while a provider pull request is open;
 * - success when every provider pull request merged, or when no provider of the consumer opened one.
 * A set with no safe order, and a set whose records are not all written yet, gets no status.
 */
export const decideChangeSetStatuses = (set: ChangeSet): ChangeSetStatus[] => {
  if (!hasSafeOrder(set)) return [];
  if (set.members.some((member) => member.record === null)) return [];
  const statuses: ChangeSetStatus[] = [];
  for (const consumer of set.members) {
    const record = consumer.record;
    if (record === null || record.state !== "open") continue;
    if (!set.edges.some((edge) => same(edge.consumer, consumer.repositoryFullName))) continue;
    const providers = set.members.filter(
      (member) =>
        member !== consumer &&
        set.edges.some((edge) => same(edge.consumer, consumer.repositoryFullName) && same(edge.provider, member.repositoryFullName)),
    );
    const closed = providers.filter((member) => member.record?.state === "closed");
    const unchecked = providers.filter((member) => member.record?.state === "open" && member.record.headSha !== member.record.verifiedHeadSha);
    const open = providers.filter((member) => member.record?.state === "open");
    const base = { member: consumer, sha: record.headSha };
    if (closed.length > 0) {
      statuses.push({
        ...base,
        state: "failure",
        description: fit(`${list(closed)} closed without a merge, so no safe merge order holds.`),
        targetUrl: closed[0]?.url ?? consumer.url,
      });
    } else if (unchecked.length > 0) {
      const first = unchecked[0];
      statuses.push({
        ...base,
        state: "failure",
        description: fit(
          unchecked.length === 1 && first !== undefined && first.record !== null
            ? `${label(first)} has the head ${first.record.headSha.slice(0, 7)}, which Factoree did not check with this set.`
            : `${list(unchecked)} have heads that Factoree did not check with this set.`,
        ),
        targetUrl: first?.url ?? consumer.url,
      });
    } else if (open.length > 0) {
      statuses.push({
        ...base,
        state: "pending",
        description: fit(`Merge ${list(open)} first.`),
        targetUrl: open[0]?.url ?? consumer.url,
      });
    } else {
      statuses.push({
        ...base,
        state: "success",
        description: fit(providers.length === 0 ? "No provider of this change set opened a pull request." : `${list(providers)} merged.`),
        targetUrl: providers[0]?.url ?? consumer.url,
      });
    }
  }
  return statuses;
};

/**
 * DI-21.157. At L4 a consumer pull request takes auto-merge only after every provider pull request
 * of its set merged. The answer is the sentence of the unmet condition, or null.
 */
export const providersNotMerged = (set: ChangeSet, pullRequestId: string): string | null => {
  const consumer = set.members.find((member) => member.record?.id === pullRequestId);
  if (consumer === undefined) return null;
  const providers = set.members.filter(
    (member) =>
      member !== consumer &&
      set.edges.some((edge) => same(edge.consumer, consumer.repositoryFullName) && same(edge.provider, member.repositoryFullName)),
  );
  const waiting = providers.filter((member) => member.record?.state !== "merged");
  if (!hasSafeOrder(set) && set.edges.some((edge) => same(edge.consumer, consumer.repositoryFullName))) {
    return "The change set has no safe merge order, so a human merges it.";
  }
  return waiting.length === 0 ? null : `The provider pull requests ${list(waiting)} of the change set have not merged yet.`;
};

/** DI-21.155. The reads and writes of a change set across its pull request records. */
export interface ChangeSetStore {
  /** The set of the run that opened the pull request, or null when that run opened one pull request. */
  changeSetOfPullRequest(tenantId: string, pullRequestId: string): Promise<ChangeSet | null>;
  /** The set of pull requests that one run opened, or null when it opened fewer than two. */
  changeSetOfRun(tenantId: string, originRunId: string): Promise<ChangeSet | null>;
  /** Records the last status Factoree set on the pull request. */
  markChangeSetStatus(tenantId: string, pullRequestId: string, key: string): Promise<void>;
}

/** The GitHub call of the change-set status. It mints a Commit statuses write token for the one repository. */
export interface CommitStatusPort {
  setStatus(
    slug: string,
    sha: string,
    status: { state: ChangeSetStatusState; context: string; description: string; targetUrl: string },
    installationId: string,
  ): Promise<void>;
}
