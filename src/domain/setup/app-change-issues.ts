/**
 * docs/specs/setup-app-change-issues.md. A merged setup creates and delegates a Linear issue for its
 * app changes. Factoree stores each issue, so a later setup that names the same change creates no
 * second issue, and so the round ends once every issue has ended.
 */
export const APP_CHANGE_ISSUE_MODES = ["one_per_change", "one_for_all"] as const;
export type AppChangeIssueMode = (typeof APP_CHANGE_ISSUE_MODES)[number];

/** merged: the run's pull request merged. not_merged: the run ended with no pull request, or its pull request closed. */
export type AppChangeIssueOutcome = "merged" | "not_merged";

export interface AppChangeIssueRecord {
  id: string;
  tenantId: string;
  productId: string;
  setupId: string;
  repositoryFullName: string;
  changes: string[];
  linearIssueId: string;
  linearIssueIdentifier: string;
  /** docs/specs/setup-speed-and-history.md. Null for an issue stored before the link was. */
  linearIssueUrl: string | null;
  /** Null while the issue is open. */
  outcome: AppChangeIssueOutcome | null;
  createdAt: Date;
  endedAt: Date | null;
}

/** The latest run of an app-change issue, as the round check reads it. */
export interface AppChangeIssueRun {
  terminal: boolean;
  pullRequestUrl: string | null;
}

export interface AppChangeIssueStore {
  create(input: Pick<AppChangeIssueRecord, "tenantId" | "productId" | "setupId" | "repositoryFullName" | "changes" | "linearIssueId" | "linearIssueIdentifier" | "linearIssueUrl">): Promise<AppChangeIssueRecord>;
  listForRepository(tenantId: string, repositoryFullName: string): Promise<AppChangeIssueRecord[]>;
  setOutcome(id: string, outcome: AppChangeIssueOutcome, at: Date): Promise<void>;
  /** The newest run of the Linear issue, or null when none started yet. */
  latestRun(tenantId: string, linearIssueId: string): Promise<AppChangeIssueRun | null>;
}

/** The Linear side: one issue in the team, delegated to Factoree. */
export interface AppChangeIssuePort {
  createDelegatedIssue(input: { teamId: string; title: string; description: string }): Promise<{ id: string; identifier: string; url: string }>;
}

/** Two lines name the same change when they match after trimming and collapsing whitespace. */
const keyOf = (change: string): string => change.trim().replace(/\s+/g, " ").toLowerCase();

/** Each change that an open app-change issue of the repository already requests, with that issue. */
export const alreadyRequested = (
  changes: readonly string[],
  stored: readonly AppChangeIssueRecord[],
): Array<{ change: string; issue: string }> => {
  const open = new Map<string, string>();
  for (const row of stored) {
    if (row.outcome !== null) continue;
    for (const change of row.changes) open.set(keyOf(change), row.linearIssueIdentifier);
  }
  const found: Array<{ change: string; issue: string }> = [];
  for (const change of changes) {
    const issue = open.get(keyOf(change));
    if (issue !== undefined) found.push({ change, issue });
  }
  return found;
};

/** The changes of each issue to create. A change an open issue requests is skipped. */
export const planAppChangeIssues = (
  changes: readonly string[],
  stored: readonly AppChangeIssueRecord[],
  mode: AppChangeIssueMode,
): string[][] => {
  const skipped = new Set(alreadyRequested(changes, stored).map((found) => keyOf(found.change)));
  const seen = new Set<string>();
  const fresh: string[] = [];
  for (const change of changes) {
    const key = keyOf(change);
    if (key === "" || skipped.has(key) || seen.has(key)) continue;
    seen.add(key);
    fresh.push(change.trim());
  }
  if (fresh.length === 0) return [];
  return mode === "one_for_all" ? [fresh] : fresh.map((change) => [change]);
};

const MAX_TITLE = 120;

/**
 * The issue text. The description names the repository full name, so the target choice of the run
 * finds it without a question, and links the setup pull request that named the change.
 */
export const appChangeIssueText = (input: {
  repositoryFullName: string;
  changes: readonly string[];
  setupPullRequestUrl: string | null;
}): { title: string; description: string } => {
  const first = input.changes[0] ?? "";
  const raw = input.changes.length === 1 ? first : `App changes for ${input.repositoryFullName} that its setup needs`;
  const flat = raw.trim().replace(/\s+/g, " ");
  const title = flat.length <= MAX_TITLE ? flat : `${flat.slice(0, MAX_TITLE - 1)}…`;
  const description = [
    `Repository: ${input.repositoryFullName}`,
    "",
    input.changes.length === 1 ? "The Factoree setup of this repository needs this app change:" : "The Factoree setup of this repository needs these app changes:",
    "",
    ...input.changes.map((change) => `- ${change}`),
    "",
    input.setupPullRequestUrl === null
      ? "Factoree created this issue when a setup found the config on the default branch already holds every part it could prove."
      : `Factoree created this issue when the setup pull request merged: ${input.setupPullRequestUrl}`,
    "When every app-change issue of the setup has ended, Factoree runs the setup again, so it can configure what this change makes possible.",
  ].join("\n");
  return { title, description };
};

/** The outcome of an open issue from its latest run and the state of the run's pull request. */
export const outcomeOf = (
  run: AppChangeIssueRun | null,
  pullRequestState: "open" | "merged" | "closed" | null,
): AppChangeIssueOutcome | null => {
  if (run === null) return null;
  if (pullRequestState === "merged") return "merged";
  if (pullRequestState === "closed") return "not_merged";
  if (run.pullRequestUrl === null && run.terminal) return "not_merged";
  return null;
};

/** A round ends when every issue of the setup has ended and at least one pull request merged. */
export const roundEnded = (rows: readonly AppChangeIssueRecord[]): boolean =>
  rows.length > 0 && rows.every((row) => row.outcome !== null) && rows.some((row) => row.outcome === "merged");

/** The owner/repo and number of a GitHub pull request URL, or null. */
export const pullRequestOf = (url: string): { slug: string; number: number } | null => {
  const match = /^https?:\/\/[^/]+\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(url);
  return match === null ? null : { slug: match[1]!, number: Number(match[2]) };
};
