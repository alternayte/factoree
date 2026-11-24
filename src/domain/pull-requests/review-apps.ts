/**
 * docs/specs/pr-feedback-loop.md. The review apps of a Factoree pull request, their verdicts on the
 * head, their findings, and the repository CI checks that failed. The PR workflow reads these facts
 * once the reviews of a head settle, and plans one PR follow-up run from them.
 *
 * The agent-run workflow imports this module, so it imports nothing at run time.
 */

/** One review of the pull request, as GitHub lists it. */
export interface PullRequestReviewOnGitHub {
  reviewId: number;
  authorLogin: string;
  /** GitHub's account type: User or Bot. */
  authorType: string;
  /** GitHub's review state in upper case, such as COMMENTED or CHANGES_REQUESTED. */
  state: string;
  commitSha: string | null;
  body: string;
}

/** One check run or commit status on one commit. */
export interface CheckOnCommit {
  kind: "check_run" | "status";
  /** The check run id, or null for a commit status. */
  id: number | null;
  /** The check run name, or the commit status context. */
  name: string;
  /** The app that reported a check run, in lower case, or null. */
  appSlug: string | null;
  /** The login that created a commit status, in lower case, or null. */
  creatorLogin: string | null;
  completed: boolean;
  /** A check run conclusion, or a commit status state. Null while a check runs. */
  conclusion: string | null;
  title: string | null;
  summary: string | null;
  text: string | null;
  detailsUrl: string | null;
}

/** One comment of a review thread, oldest first. */
export interface ReviewThreadComment {
  commentId: number;
  authorLogin: string;
  body: string;
  url: string | null;
}

/** One review thread of the pull request. */
export interface ReviewThreadOnGitHub {
  isResolved: boolean;
  path: string | null;
  line: number | null;
  comments: ReviewThreadComment[];
}

/** One annotation of a check run. */
export interface CheckAnnotation {
  path: string | null;
  startLine: number | null;
  level: string | null;
  title: string | null;
  message: string;
}

/** The verdict of one review app on the head. */
export type ReviewAppVerdict = "pending" | "acts" | "success" | "none";

/** docs/specs/pr-feedback-loop.md. A failed check run or commit status of an app that is no review app. */
export interface CiFinding {
  /** `check-<id>` for a check run, `status-<context>` for a commit status. */
  key: string;
  name: string;
  appSlug: string | null;
  conclusion: string;
  summary: string;
  annotations: string[];
  /** The last lines of the job log of a GitHub Actions check, redacted, or null. */
  logTail: string | null;
  detailsUrl: string | null;
}

/** DI-21.155. Factoree's own commit status on a consumer head of a change set. It is no CI check. */
const FACTOREE_STATUS_CONTEXT = "factoree/change-set";

/** The app slug of a GitHub App login `<slug>[bot]`, in lower case, or null for any other login. */
export const appSlugOfLogin = (login: string): string | null => {
  const match = /^([a-z0-9][a-z0-9-]*)\[bot\]$/i.exec(login.trim());
  return match === null ? null : (match[1] as string).toLowerCase();
};

const botOf = (slug: string): string => `${slug}[bot]`;

/**
 * docs/specs/pr-feedback-loop.md, DI-21.206. The review apps of a pull request: each GitHub App,
 * other than Factoree and the apps on the product deny list, that submitted a review on it. The
 * answer is the app slugs in lower case, in the order of their first review.
 */
export const reviewAppsOf = (
  reviews: readonly PullRequestReviewOnGitHub[],
  factoreeSlug: string | null,
  denyList: readonly string[],
): string[] => {
  const denied = new Set(denyList.map((slug) => slug.toLowerCase()));
  const self = factoreeSlug?.toLowerCase() ?? null;
  const apps: string[] = [];
  for (const review of reviews) {
    if (review.authorType !== "Bot") continue;
    const slug = appSlugOfLogin(review.authorLogin);
    if (slug === null || slug === self || denied.has(slug) || apps.includes(slug)) continue;
    apps.push(slug);
  }
  return apps;
};

/** The check runs and commit statuses of one app on a commit. A status is the app's when its bot created it. */
export const checksOfApp = (checks: readonly CheckOnCommit[], appSlug: string): CheckOnCommit[] =>
  checks.filter((check) => (check.kind === "check_run" ? check.appSlug === appSlug : check.creatorLogin === botOf(appSlug)));

/** A check run conclusion that is no pass and no skip. */
const ACTING_CONCLUSIONS = new Set(["failure", "neutral", "timed_out", "cancelled", "action_required", "stale"]);

/**
 * docs/specs/pr-feedback-loop.md, DI-21.206. The verdict of one review app on the head. It is
 * pending while one of its checks runs. It acts when one of its checks ends with failure or neutral
 * (or timed out, cancelled, action required or stale), or a status with failure or error. It is
 * success when every check passed or was skipped, and none when the app has no check on the head.
 */
export const reviewAppVerdict = (checks: readonly CheckOnCommit[], appSlug: string): ReviewAppVerdict => {
  const own = checksOfApp(checks, appSlug);
  if (own.length === 0) return "none";
  if (own.some((check) => !check.completed)) return "pending";
  const acts = own.some((check) =>
    check.kind === "check_run" ? ACTING_CONCLUSIONS.has(check.conclusion ?? "") : check.conclusion === "failure" || check.conclusion === "error",
  );
  return acts ? "acts" : "success";
};

/**
 * docs/specs/pr-feedback-loop.md, DI-21.207. The unresolved threads that the app started, on any
 * head, that Factoree has not answered. A thread whose last comment is Factoree's own reply is
 * answered: the next PR follow-up run does not triage it again until the thread takes a new comment.
 */
export const unansweredThreadsOf = (
  threads: readonly ReviewThreadOnGitHub[],
  appSlug: string,
  factoreeSlug: string | null,
): ReviewThreadOnGitHub[] => {
  const app = botOf(appSlug);
  const self = factoreeSlug === null ? null : botOf(factoreeSlug.toLowerCase());
  return threads.filter((thread) => {
    if (thread.isResolved || thread.comments.length === 0) return false;
    if ((thread.comments[0] as ReviewThreadComment).authorLogin.toLowerCase() !== app) return false;
    const last = thread.comments[thread.comments.length - 1] as ReviewThreadComment;
    return self === null || last.authorLogin.toLowerCase() !== self;
  });
};

/** The newest check run of each name of one app, with an acting conclusion. Their annotations are findings. */
export const actingCheckRunsOf = (checks: readonly CheckOnCommit[], appSlug: string): CheckOnCommit[] =>
  checksOfApp(checks, appSlug).filter((check) => check.kind === "check_run" && check.id !== null && check.completed && ACTING_CONCLUSIONS.has(check.conclusion ?? ""));

/** A failed CI check: a check run that failed or timed out, or a commit status failure or error. */
const ciFailed = (check: CheckOnCommit): boolean =>
  check.completed &&
  (check.kind === "check_run" ? check.conclusion === "failure" || check.conclusion === "timed_out" : check.conclusion === "failure" || check.conclusion === "error");

/**
 * docs/specs/pr-feedback-loop.md, DI-21.208. The repository CI checks that failed on the head: each
 * failed check run or commit status from an app that is neither a review app nor Factoree, and that
 * is not Factoree's change-set status. A check whose name also failed on the base commit starts
 * nothing: the base is broken, and the pull request did not break it.
 */
export const failedCiChecks = (input: {
  head: readonly CheckOnCommit[];
  base: readonly CheckOnCommit[];
  reviewApps: readonly string[];
  factoreeSlug: string | null;
}): CheckOnCommit[] => {
  const self = input.factoreeSlug?.toLowerCase() ?? null;
  const ownedByReviewApp = (check: CheckOnCommit): boolean => input.reviewApps.some((app) => checksOfApp([check], app).length > 0);
  const byFactoree = (check: CheckOnCommit): boolean =>
    check.name === FACTOREE_STATUS_CONTEXT ||
    (self !== null && (check.kind === "check_run" ? check.appSlug === self : check.creatorLogin === botOf(self)));
  const failedOnBase = new Set(input.base.filter(ciFailed).map((check) => `${check.kind}:${check.name}`));
  return input.head.filter(
    (check) => ciFailed(check) && !ownedByReviewApp(check) && !byFactoree(check) && !failedOnBase.has(`${check.kind}:${check.name}`),
  );
};

/** DI-21.208. The job id of a GitHub Actions check run, read from its details URL, or null. */
export const actionsJobIdOf = (detailsUrl: string | null): number | null => {
  if (detailsUrl === null) return null;
  const match = /\/actions\/runs\/\d+\/job(?:s)?\/(\d+)/.exec(detailsUrl);
  return match === null ? null : Number(match[1]);
};

/** The most lines of a job log a CI finding carries. */
export const MAX_LOG_TAIL_LINES = 200;

/** The last lines of a job log, with GitHub's timestamp prefix removed. */
export const logTailOf = (log: string, lines = MAX_LOG_TAIL_LINES): string =>
  log
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((entry) => entry.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/, ""))
    .filter((entry, index, all) => !(index === all.length - 1 && entry === ""))
    .slice(-lines)
    .join("\n");

/** docs/specs/pr-feedback-loop.md, DI-21.212. Why one review app holds back an L4 merge of the head. */
export interface ReviewAppHold {
  appSlug: string;
  reason: "pending" | "not_passed" | "unanswered";
}

/**
 * docs/specs/pr-feedback-loop.md, DI-21.212. The review apps that hold back an L4 merge of the head.
 * An app with a check holds it until every check of it on the head passed (success or skipped). An
 * app with no check holds it while one of its unresolved threads has no answer from Factoree. A
 * dropped finding that Factoree answered does not hold it: the app's own check is its verdict.
 */
export const reviewAppHolds = (input: {
  apps: readonly string[];
  checks: readonly CheckOnCommit[];
  threads: readonly ReviewThreadOnGitHub[];
  factoreeSlug: string | null;
}): ReviewAppHold[] => {
  const holds: ReviewAppHold[] = [];
  for (const app of input.apps) {
    const verdict = reviewAppVerdict(input.checks, app);
    if (verdict === "pending") holds.push({ appSlug: app, reason: "pending" });
    else if (verdict === "acts") holds.push({ appSlug: app, reason: "not_passed" });
    else if (verdict === "none" && unansweredThreadsOf(input.threads, app, input.factoreeSlug).length > 0) holds.push({ appSlug: app, reason: "unanswered" });
  }
  return holds;
};

/**
 * docs/specs/pr-feedback-loop.md, DI-21.214. The fingerprint of a review app finding with no thread:
 * an annotation or a review body. It holds the app, the place and the text with its white space
 * folded, so the same finding on a new check run or a new head matches, and a changed text does not.
 * The caller hashes it.
 */
export const unthreadedFindingFingerprintText = (finding: { appSlug: string; path: string | null; line: number | null; body: string }): string =>
  [finding.appSlug.toLowerCase(), finding.path ?? "", finding.line === null ? "" : String(finding.line), finding.body.replace(/\s+/g, " ").trim().toLowerCase()].join("\n");
