/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 3. A PR follow-up run: the run that a failed PR
 * reviewer check, or a human "request changes" review, starts on an open Factoree pull request. It
 * pushes one new verified commit to the branch of that pull request.
 *
 * The agent-run workflow imports this module, so it imports nothing at run time.
 */
import type { PullRequestEvent } from "./pull-request-event.js";
import type {
  CheckAnnotation,
  CheckOnCommit,
  CiFinding,
  PullRequestReviewOnGitHub,
  ReviewThreadOnGitHub,
} from "./review-apps.js";

/**
 * What started a PR follow-up run. base: a bring-current update that conflicted or failed its check
 * (slice 4). It does not count toward the limit of automatic follow-up runs.
 *
 * docs/specs/pr-feedback-loop.md, DI-21.210. automatic: the findings of review apps or failed CI
 * checks, with no human decision. human: at least one human decision, with any automatic findings
 * of the same head. reviewer: a run of a history from before the review apps, started by the failed
 * check of the named PR reviewer. Such a run still replays, and reads as automatic.
 */
export type PrFollowUpTrigger = "automatic" | "human" | "base" | "reviewer";

/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.119. The bring-current update that a
 * PR follow-up run finishes: the base it merges in, and the conflict or the failed check.
 */
export interface PrBaseUpdate {
  /** The verified base of the pull request before the update. */
  previousBaseSha: string;
  /** The files where the merge of the base into the branch conflicts. Empty for a failed check. */
  conflicts: string[];
  /** The failed check after a clean update, or null for a conflict. */
  failure: string | null;
}

/**
 * docs/specs/change-sets.md, slice 9, DI-21.159. One pull request of the change set that a set run
 * holds. An open member checks out at its verified base with the diff to its head applied. A merged
 * member stays fixed at its merge commit, and takes no new commit.
 */
export interface PrSetMember {
  pullRequestId: string;
  repositoryId: string;
  repositoryFullName: string;
  number: number;
  url: string;
  headBranch: string;
  /** The head the run read. A new commit's parent. */
  headSha: string;
  /** The verified base of an open member, or the merge commit of a merged member. */
  baseSha: string;
  baseBranch: string;
  state: "open" | "merged";
  contractRevision: number;
  /** The autonomy level of the verified head. An unchanged member keeps it. */
  autonomyLevel: string;
}

/** DI-21.159. The change set of a set run: its members in set order and the edges of its origin run. */
export interface PrChangeSet {
  members: PrSetMember[];
  edges: Array<{ provider: string; consumer: string }>;
}

/** The longest text of one finding that a PR follow-up run carries. */
export const MAX_FINDING_BODY_CHARACTERS = 4_000;

/** The most findings one PR follow-up run carries. A review with more names the rest by count. */
export const MAX_FINDINGS = 50;

/**
 * One comment of a review, or the body of the review itself. The PR reviewer's findings, and the
 * sentences of a human "request changes" review, both take this shape.
 */
export interface PrReviewFinding {
  /** Unique in the run: `comment-<id>` for a review comment, `review-<id>` for a review body. */
  key: string;
  reviewId: number;
  /** The review comment id, or null for the body of the review. A reply goes to this thread. */
  commentId: number | null;
  author: string;
  /** The file and the line the comment sits on, or null for a review body. */
  path: string | null;
  line: number | null;
  body: string;
}

/** The triage decision on one PR reviewer finding (SDD section 41). */
export interface TriagedFinding {
  key: string;
  kept: boolean;
  /** The concrete defect. Empty for a dropped finding. */
  defect: string;
  /** The rule or the mandatory requirement the change breaks. Empty for a dropped finding. */
  rule: string;
  /** The changed file and line. Empty for a dropped finding. */
  evidence: string;
  /** Why the finding was dropped. Empty for a kept finding. */
  reason: string;
}

/** docs/specs/pr-feedback-loop.md. A finding of one review app: a thread it started, an annotation or a review body. */
export interface ReviewAppFinding extends PrReviewFinding {
  /** The review app, in lower case. */
  appSlug: string;
  /**
   * DI-21.214. The SHA-256 fingerprint of a finding with no thread: an annotation or a review body.
   * Absent for a thread finding, whose answer is Factoree's reply in the thread.
   */
  fingerprint?: string;
}

/**
 * docs/specs/pr-feedback-loop.md, DI-21.210. One human decision on the pull request: a "request
 * changes" review, a mention of Factoree from a user with write access, or a reply in the Linear
 * agent session while the pull request is open. It skips triage and outranks every other sentence.
 */
export interface HumanDecision {
  /** `review-<id>`, `review-comment-<id>`, `comment-<id>` or `linear-<reply id>`. */
  key: string;
  source: "github" | "linear";
  author: string;
  body: string;
  /** The file and the line a review comment sits on, or null. */
  path: string | null;
  line: number | null;
  /** The review comment to reply in, or null for a conversation comment, a review body or a Linear reply. */
  commentId: number | null;
  url: string | null;
}

/** The pull request a PR follow-up run works on, and what started it. */
export interface PrFollowUpInput {
  pullRequestId: string;
  repositoryId: string;
  repositoryFullName: string;
  number: number;
  url: string;
  headBranch: string;
  /** D2. The head commit this run read. The new commit's parent is this commit. */
  headSha: string;
  /**
   * D2. The verified base of the pull request. The work sprite starts here, with base..head applied.
   * For the base trigger it is the new base, and the work sprite merges the head into it.
   */
  baseSha: string;
  baseBranch: string;
  /** The contract revision this run freezes. The proof pack names it, and the record takes it at publication. */
  contractRevision: number;
  trigger: PrFollowUpTrigger;
  /** A history from before the review apps: the PR reviewer, as `slug` and check name, for the reviewer trigger. */
  reviewer?: { appSlug: string; checkName: string } | null;
  /** A history from before the review apps: the human who requested changes, for the human trigger. */
  reviewerLogin?: string | null;
  /** A history from before the review apps: the PR reviewer findings to triage, or the sentences of the human review. */
  findings?: PrReviewFinding[];
  /** The findings past MAX_FINDINGS that the run does not carry. */
  omittedFindings: number;
  /**
   * A history from before docs/specs/pr-feedback-loop.md: plain comments that started nothing. The
   * proof pack no longer lists them (DI-21.213), so a run ignores them.
   */
  plainComments?: string[];
  /** docs/specs/pr-feedback-loop.md. The review app findings to triage. */
  reviewAppFindings?: ReviewAppFinding[];
  /** docs/specs/pr-feedback-loop.md. The failed CI checks of the head. They skip triage. */
  ciFindings?: CiFinding[];
  /** docs/specs/pr-feedback-loop.md. The human decisions, oldest first. They skip triage. */
  decisions?: HumanDecision[];
  /** Slice 4. The bring-current update this run finishes, for the base trigger. Absent otherwise. */
  baseUpdate?: PrBaseUpdate;
  /**
   * docs/specs/change-sets.md, slice 9. The change set of the pull request: the run holds every
   * member in one work sprite. Absent for a pull request of one repository.
   */
  changeSet?: PrChangeSet;
}

/**
 * True for the only events that can start a PR follow-up run: a failed check run or commit status,
 * and a submitted "request changes" review. The PR workflow asks the planner about these alone, so
 * the many checks of a pull request cost it nothing.
 */
export const mayStartFollowUp = (event: PullRequestEvent): boolean => {
  if (event.kind === "check_run") return event.status === "completed" && event.conclusion === "failure";
  if (event.kind === "commit_status") return event.state === "failure";
  if (event.kind === "review") return event.action === "submitted" && event.state === "changes_requested";
  return false;
};

/** DI-21.209. The quiet window: the reviews of a head settle once no event of it arrives for this long. */
export const SETTLE_QUIET_MS = 2 * 60_000;

/** DI-21.209. The longest wait for a pending review app check, from the first event of the head. */
export const SETTLE_MAX_MS = 30 * 60_000;

/** DI-21.210. The events that may carry a human decision. The PR workflow holds them until the plan. */
export type DecisionEvent = Extract<PullRequestEvent, { kind: "review" | "comment" | "review_comment" | "linear_reply" }>;

/**
 * docs/specs/pr-feedback-loop.md, DI-21.210. True for an event that may be a human decision: a
 * submitted "request changes" review, a submitted review whose body mentions Factoree, a comment or
 * a review comment that mentions Factoree, and a Linear reply. Write access is checked when the PR
 * workflow takes it.
 */
export const isDecisionEvent = (event: PullRequestEvent): boolean => {
  if (event.kind === "review") return event.action === "submitted" && (event.state === "changes_requested" || event.mentions === true);
  if (event.kind === "comment" || event.kind === "review_comment") return event.mentions;
  return event.kind === "linear_reply";
};

/**
 * docs/specs/pr-feedback-loop.md, DI-21.209. True for an event after which the head may hold
 * something to act on: a human decision, any submitted review, a check run that completed with
 * neither success nor skipped, and a commit status failure or error. The PR workflow waits for the
 * reviews of the head to settle after it, then plans once.
 */
export const needsAttention = (event: PullRequestEvent): boolean => {
  if (isDecisionEvent(event)) return true;
  if (event.kind === "review") return event.action === "submitted";
  if (event.kind === "check_run") return event.status === "completed" && event.conclusion !== "success" && event.conclusion !== "skipped";
  if (event.kind === "commit_status") return event.state === "failure" || event.state === "error";
  return false;
};

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
};

/**
 * DI-21.215. Text that a human or a check wrote, in quotes. The work item parser reads a line that
 * ends in a question mark as an open question of the issue (SDD section 8), so a decision such as
 * "why does this skip the cache?" must not end its line with one, or the run asks it back.
 */
const quoted = (text: string): string => `"${text}"`;

/** Where a finding sits, such as `src/a.ts:12`, or `the review` for a review body. */
export const findingPlace = (finding: Pick<PrReviewFinding, "path" | "line">): string =>
  finding.path === null ? "the review" : finding.line === null ? finding.path : `${finding.path}:${String(finding.line)}`;

/**
 * docs/specs/pr-feedback-loop.md, DI-21.210. The review app findings, the CI findings and the human
 * decisions of a PR follow-up run. A run of a history from before the review apps carries the named
 * PR reviewer's findings, or the sentences of one human review, in `findings`: they read as review
 * app findings and as one decision.
 */
export const followUpParts = (
  followUp: PrFollowUpInput,
): { reviewAppFindings: ReviewAppFinding[]; ciFindings: CiFinding[]; decisions: HumanDecision[] } => {
  const legacy = followUp.findings ?? [];
  const reviewAppFindings =
    followUp.reviewAppFindings ??
    (followUp.trigger === "reviewer" ? legacy.map((finding) => ({ ...finding, appSlug: followUp.reviewer?.appSlug ?? finding.author })) : []);
  const decisions =
    followUp.decisions ??
    (followUp.trigger === "human"
      ? legacy.map((finding) => ({
          key: finding.key,
          source: "github" as const,
          author: followUp.reviewerLogin ?? finding.author,
          body: finding.body,
          path: finding.path,
          line: finding.line,
          commentId: finding.commentId,
          url: null,
        }))
      : []);
  return { reviewAppFindings, ciFindings: followUp.ciFindings ?? [], decisions };
};

/** True for a run that the findings of review apps or CI started, with no human decision. */
export const isAutomaticTrigger = (trigger: PrFollowUpTrigger): boolean => trigger === "automatic" || trigger === "reviewer";

/** Where a human decision sits: a file and line, the conversation, or the Linear agent session. */
export const decisionPlace = (decision: HumanDecision): string =>
  decision.source === "linear"
    ? "the Linear agent session"
    : decision.path === null
      ? "the pull request conversation"
      : decision.line === null
        ? decision.path
        : `${decision.path}:${String(decision.line)}`;

/** The most characters of a CI log tail the work item text carries. */
const MAX_LOG_TAIL_CHARACTERS = 6_000;

/** DI-21.208. The work item lines of one failed CI check: its output, its annotations and its log tail. */
const ciFindingSection = (finding: CiFinding): string[] => [
  `### ${finding.name} (${finding.conclusion})`,
  "",
  ...(finding.summary === "" ? [] : [quoted(oneLine(finding.summary, MAX_FINDING_BODY_CHARACTERS)), ""]),
  ...(finding.annotations.length === 0 ? [] : [...finding.annotations.map((annotation) => `- ${quoted(oneLine(annotation, 600))}`), ""]),
  ...(finding.logTail === null || finding.logTail.trim() === ""
    ? []
    : ["The last lines of the job log:", "", "```", finding.logTail.slice(-MAX_LOG_TAIL_CHARACTERS), "```", ""]),
  ...(finding.detailsUrl === null ? [] : [`Details: ${finding.detailsUrl}`, ""]),
];

/**
 * The work item text of a PR follow-up run. A human decision outranks every other sentence, as a
 * Linear reply does (DI-19.04). The kept review app findings and the failed CI checks are defects to
 * repair, not decisions.
 */
export const renderPrFollowUpDescription = (input: {
  description: string;
  followUp: PrFollowUpInput;
  kept: readonly TriagedFinding[];
}): string => {
  const followUp = input.followUp;
  const header = [
    input.description,
    "",
    `## Pull request ${followUp.url}`,
    "",
    `This run changes the open pull request ${followUp.url} at its head ${followUp.headSha.slice(0, 12)}. ` +
      "The work starts from the full change of the pull request. Keep every part of it that the review below does not ask to change.",
    "",
    ...(followUp.changeSet === undefined ? [] : changeSetSection(followUp.changeSet)),
  ];
  if (followUp.trigger === "base" && followUp.baseUpdate !== undefined) {
    return [...header, ...baseUpdateSection(followUp.baseBranch, followUp.baseSha, followUp.baseUpdate)].join("\n");
  }
  const parts = followUpParts(followUp);
  const byKey = new Map(parts.reviewAppFindings.map((finding) => [finding.key, finding]));
  const decisions =
    parts.decisions.length === 0
      ? []
      : [
          "## Decisions of humans",
          "",
          "Each of these is a decision of a human. It outranks every other sentence of this issue. Follow it.",
          "",
          ...parts.decisions.map((decision) => `- ${decision.author} (${decisionPlace(decision)}): ${quoted(oneLine(decision.body, MAX_FINDING_BODY_CHARACTERS))}`),
          ...(followUp.omittedFindings > 0 ? [`- ${String(followUp.omittedFindings)} more comments on the pull request.`] : []),
          "",
        ];
  const ci =
    parts.ciFindings.length === 0
      ? []
      : [
          "## Checks that failed on the pull request head",
          "",
          "These repository CI checks failed on the head, and they pass on the base. Each one is a defect to repair. Make each check pass.",
          "",
          ...parts.ciFindings.flatMap(ciFindingSection),
        ];
  const kept =
    input.kept.length === 0
      ? []
      : [
          "## Defects the review apps found",
          "",
          "Factoree triaged the findings of the review apps and kept only these. Each one names a concrete defect, a rule and evidence. Repair each one.",
          "",
          ...input.kept.map((finding) => {
            const source = byKey.get(finding.key);
            return `- ${oneLine(finding.evidence, 200)}: ${oneLine(finding.defect, 600)} Rule: ${oneLine(finding.rule, 300)}.${
              source === undefined ? "" : ` (${source.appSlug}, ${findingPlace(source)})`
            }`;
          }),
          "",
        ];
  return [...header, ...decisions, ...ci, ...kept].join("\n").replace(/\n+$/, "");
};

/**
 * docs/specs/change-sets.md, slice 9. The work item section of a set PR follow-up run: every pull
 * request of the set, each open one at its head, and each merged one fixed at its merge.
 */
const changeSetSection = (changeSet: PrChangeSet): string[] => [
  "## Change set",
  "",
  "This pull request belongs to a change set. The work sprite holds every pull request of the set, each in its own folder. " +
    "Change any open one that the review needs. Factoree pushes a new commit only to the pull requests that change.",
  "",
  ...changeSet.members.map((member) =>
    member.state === "merged"
      ? `- ${member.repositoryFullName}: ${member.url} merged. It stays fixed at its merge commit ${member.baseSha.slice(0, 12)}. Do not change it.`
      : `- ${member.repositoryFullName}: ${member.url}, open at its head ${member.headSha.slice(0, 12)}.`,
  ),
  ...(changeSet.edges.length === 0 ? [] : ["", ...changeSet.edges.map((edge) => `- ${edge.consumer} calls ${edge.provider}.`)]),
  "",
];

/** Slice 4. The work item section of a PR follow-up run that finishes a bring-current update. */
const baseUpdateSection = (baseBranch: string, baseSha: string, update: PrBaseUpdate): string[] => [
  `## The base branch ${baseBranch} moved`,
  "",
  `The work starts from ${baseBranch} at ${baseSha.slice(0, 12)}, with the pull request merged into it. ` +
    "Factoree publishes the result as a merge commit of the pull request head and this base.",
  "",
  ...(update.conflicts.length > 0
    ? [
        "The merge conflicts in these files. Each one holds conflict markers. Resolve every conflict, and keep the intent of both sides:",
        ...update.conflicts.map((file) => `- ${file}`),
      ]
    : [
        "The merge is clean, and the frozen checks failed on it. Repair the change so that every check passes on the new base:",
        "",
        oneLine(update.failure ?? "A check failed.", MAX_FINDING_BODY_CHARACTERS),
      ]),
];

/** Slice 4. The repair finding lines the first implementer attempt of a base follow-up receives. */
export const baseUpdateFindingLines = (update: PrBaseUpdate): string[] =>
  update.conflicts.length > 0
    ? update.conflicts.map((file) => `The merge of the new base conflicts in ${file}. Resolve the conflict markers in it.`)
    : [`The frozen checks failed after the merge of the new base: ${oneLine(update.failure ?? "A check failed.", MAX_FINDING_BODY_CHARACTERS)}`];

/** The repair finding lines the first implementer attempt of a reviewer follow-up receives. */
export const keptFindingLines = (kept: readonly TriagedFinding[]): string[] =>
  kept.map((finding) => `Review app finding at ${finding.evidence}: ${finding.defect} Rule: ${finding.rule}`);

/** DI-21.208. The repair finding lines the first implementer attempt of a run with failed CI checks receives. */
export const ciFindingLines = (findings: readonly CiFinding[]): string[] =>
  findings.map((finding) => `The CI check ${finding.name} failed on the pull request head (${finding.conclusion}): ${oneLine(finding.summary || "no summary", 600)}`);

/** The reply Factoree posts on the pull request to one dropped finding. */
export const droppedFindingReply = (finding: TriagedFinding): string =>
  [
    "Factoree triaged this finding and did not act on it.",
    "",
    `Reason: ${oneLine(finding.reason, 1_000)}`,
    "",
    "Factoree acts only on a finding that names a concrete defect, the rule it breaks and the evidence in the change.",
  ].join("\n");

/**
 * docs/specs/pr-feedback-loop.md, DI-21.214. The one comment that answers the dropped findings with no
 * thread of one triage: the check annotations and the review bodies of the review apps.
 */
export const droppedUnthreadedReply = (findings: ReadonlyArray<{ author: string; place: string; body: string; reason: string }>): string =>
  [
    `Factoree triaged ${findings.length === 1 ? "this review app finding" : `these ${String(findings.length)} review app findings`} and did not act on ${findings.length === 1 ? "it" : "them"}:`,
    "",
    ...findings.map((finding) => `- ${finding.author} at ${finding.place}: ${oneLine(finding.body, 200)} Reason: ${oneLine(finding.reason, 600)}`),
    "",
    "Factoree acts only on a finding that names a concrete defect, the rule it breaks and the evidence in the change.",
  ].join("\n");

/**
 * docs/specs/pr-feedback-loop.md, DI-21.215. The reply to a human decision that asked a question and
 * changed nothing. A decision in a thread gets it in the thread. A decision with no thread gets it as
 * a conversation comment that quotes the request first.
 */
export const decisionAnswerReply = (decision: HumanDecision, answer: string): string =>
  [
    ...(decision.commentId === null ? [`> ${decision.author}: ${oneLine(decision.body, 300)}`, ""] : []),
    answer.trim(),
    "",
    "Factoree answered this question and changed nothing. To ask for a change, mention Factoree with what to change.",
  ].join("\n");

/** DI-21.215. The final response of a run that answered every human decision and ended ANSWERED. */
export const answeredResponse = (url: string, answers: ReadonlyArray<{ decision: HumanDecision; answer: string }>): string =>
  [
    `Factoree answered ${answers.length === 1 ? "the question" : `the ${String(answers.length)} questions`} on ${url} and changed nothing, so it pushed no commit.`,
    "",
    ...answers.flatMap(({ decision, answer }) => [`**${decision.author} in ${decisionPlace(decision)}:** ${oneLine(decision.body, 300)}`, "", answer.trim(), ""]),
    "To ask for a change, mention Factoree on the pull request with what to change, request changes there, or reply here.",
  ]
    .join("\n")
    .trimEnd();

/** DI-21.215. The progress post of a run that answered some questions and goes on with the changes asked for. */
export const answersProgress = (url: string, answers: ReadonlyArray<{ decision: HumanDecision; answer: string }>): string =>
  [
    `Factoree answered ${answers.length === 1 ? "a question" : `${String(answers.length)} questions`} on ${url}. It goes on with the changes the other requests ask for.`,
    "",
    ...answers.flatMap(({ decision, answer }) => [`**${decision.author} in ${decisionPlace(decision)}:** ${oneLine(decision.body, 300)}`, "", answer.trim(), ""]),
  ]
    .join("\n")
    .trimEnd();

/** DI-21.216. The reply in the thread of a kept review app finding that a published commit fixed. */
export const fixedFindingReply = (commitSha: string, defect: string): string => `Fixed in ${commitSha.slice(0, 12)}: ${oneLine(defect, 300)}`;

/** DI-21.216. The reply in the thread of a human decision that a published commit carries out. */
export const doneDecisionReply = (commitSha: string): string => `Done in ${commitSha.slice(0, 12)}.`;

/** DI-21.216. One item with no thread that a published commit handled: a kept finding or a human decision. */
export interface HandledUnthreaded {
  kind: "fixed" | "done";
  author: string;
  /** Where it sits, with its preposition, such as `at src/a.ts:12` or `in the pull request conversation`. */
  place: string;
  text: string;
}

/**
 * DI-21.216. The one comment that answers the handled items with no thread of one publication: the
 * kept annotations and review bodies of the review apps, and the human decisions in the
 * conversation or in a review body.
 */
export const handledUnthreadedComment = (commitSha: string, items: readonly HandledUnthreaded[]): string =>
  [
    `Factoree pushed ${commitSha.slice(0, 12)}, which handles:`,
    "",
    ...items.map((item) => `- ${item.kind === "fixed" ? "Fixed" : "Done"}: ${item.author} ${item.place}: ${oneLine(item.text, 300)}`),
  ].join("\n");

/**
 * docs/specs/pr-feedback-loop.md, DI-21.210. The "Needs your attention" post at the product limit of
 * automatic follow-up runs. It names what still fails on the head.
 */
export const automaticLimitNotice = (url: string, limit: number, failing: readonly string[], changeSet = false): string =>
  [
    "### Needs your attention",
    "",
    `${failing.length === 0 ? "The review apps or CI checks" : failing.join(", ")} still ${failing.length === 1 ? "fails" : "fail"} on ${url}. ` +
      `Factoree already ran ${String(limit)} automatic PR follow-up ${limit === 1 ? "run" : "runs"} on this ${changeSet ? "change set" : "pull request"}, ` +
      "so it starts no other one. A human decides now: mention Factoree with what to change, request changes, fix the branch, or close the pull request.",
  ].join("\n");

/** A human review as GitHub answers it: its author, and its body and comments as findings. */
export interface ReviewOfPullRequest {
  reviewerLogin: string;
  findings: PrReviewFinding[];
}

/**
 * The GitHub calls of the PR follow-up runs. Every call mints its own installation token for the
 * one repository, on the control plane only.
 */
export interface PullRequestReviewPort {
  /** The body and the comments of one review. */
  review(slug: string, number: number, reviewId: number, installationId: string): Promise<ReviewOfPullRequest>;
  /** True when the user holds write, maintain or admin access to the repository. */
  canWrite(slug: string, login: string, installationId: string): Promise<boolean>;
  /** Replies in the thread of a review comment, or comments on the pull request for a review body. */
  reply(slug: string, number: number, finding: PrReviewFinding, body: string, installationId: string): Promise<void>;
  /** One comment on the pull request conversation. */
  comment(slug: string, number: number, body: string, installationId: string): Promise<void>;
  /** docs/specs/pr-feedback-loop.md. Every review of the pull request, oldest first. */
  reviews(slug: string, number: number, installationId: string): Promise<PullRequestReviewOnGitHub[]>;
  /** DI-21.206. The newest check run of each name, and the newest commit status of each context, on one commit. */
  checksOnCommit(slug: string, sha: string, installationId: string): Promise<CheckOnCommit[]>;
  /** DI-21.206. The annotations of one check run. */
  annotations(slug: string, checkRunId: number, installationId: string): Promise<CheckAnnotation[]>;
  /** DI-21.207. Every review thread of the pull request, with its comments oldest first. */
  reviewThreads(slug: string, number: number, installationId: string): Promise<ReviewThreadOnGitHub[]>;
  /** DI-21.208. The full log of one GitHub Actions job, or null when GitHub keeps none. It needs Actions read. */
  jobLog(slug: string, jobId: number, installationId: string): Promise<string | null>;
  /** DI-21.211. Adds the 👀 reaction to a conversation comment or a review comment. */
  react(slug: string, target: { kind: "comment" | "review_comment"; commentId: number }, installationId: string): Promise<void>;
}
