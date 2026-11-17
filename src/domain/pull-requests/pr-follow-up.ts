/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 3. A PR follow-up run: the run that a failed PR
 * reviewer check, or a human "request changes" review, starts on an open Factoree pull request. It
 * pushes one new verified commit to the branch of that pull request.
 *
 * The agent-run workflow imports this module, so it imports nothing at run time.
 */
import type { PullRequestEvent } from "./pull-request-event.js";

/**
 * What started a PR follow-up run. base: a bring-current update that conflicted or failed its check
 * (slice 4). It does not count toward the limit of PR reviewer follow-up runs.
 */
export type PrFollowUpTrigger = "reviewer" | "human" | "base";

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

/** The spec: each pull request takes at most 3 PR follow-up runs from the PR reviewer. Human reviews have no limit. */
export const MAX_REVIEWER_FOLLOW_UPS = 3;

/** The longest text of one finding that a PR follow-up run carries. */
export const MAX_FINDING_BODY_CHARACTERS = 4_000;

/** The most findings one PR follow-up run carries. A review with more names the rest by count. */
export const MAX_FINDINGS = 50;

/** The most plain comments the proof pack lists. */
export const MAX_PLAIN_COMMENTS = 20;

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
  /** The PR reviewer, as `slug` and check name, for the reviewer trigger. */
  reviewer: { appSlug: string; checkName: string } | null;
  /** The human who requested changes, for the human trigger. */
  reviewerLogin: string | null;
  /** The PR reviewer findings to triage, or the sentences of the human review. */
  findings: PrReviewFinding[];
  /** The findings past MAX_FINDINGS that the run does not carry. */
  omittedFindings: number;
  /** Plain comments and suggestions on the pull request that started nothing. The proof pack lists them. */
  plainComments: string[];
  /** Slice 4. The bring-current update this run finishes, for the base trigger. Absent otherwise. */
  baseUpdate?: PrBaseUpdate;
}

/** The verdict of the PR reviewer that one check run event or commit status event reports. */
export type ReviewerEventVerdict = "pending" | "passed" | "failed" | "other";

/**
 * DI-21.108. The PR reviewer verdict that one event reports, or null for an event of another check.
 * A check run is pinned to its app by the slug, and a commit status by its sender (DI-21.107). Only
 * a check run that completed with `failure`, or a commit status `failure`, is a failed check that
 * starts triage. A neutral, skipped, cancelled or timed-out conclusion, and a status `error`, is
 * `other`: it is no pass for the L4 merge, and it names no defect, so it starts nothing.
 */
export const reviewerVerdictOfEvent = (
  event: PullRequestEvent,
  reviewer: { appSlug: string; checkName: string },
): ReviewerEventVerdict | null => {
  if (event.kind === "check_run") {
    if (event.name !== reviewer.checkName || (event.appSlug ?? "").toLowerCase() !== reviewer.appSlug) return null;
    if (event.status !== "completed") return "pending";
    if (event.conclusion === "success") return "passed";
    return event.conclusion === "failure" ? "failed" : "other";
  }
  if (event.kind === "commit_status") {
    if (event.context !== reviewer.checkName || (event.senderLogin ?? "").toLowerCase() !== `${reviewer.appSlug}[bot]`) return null;
    if (event.state === "pending") return "pending";
    if (event.state === "success") return "passed";
    return event.state === "failure" ? "failed" : "other";
  }
  return null;
};

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

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
};

/** Where a finding sits, such as `src/a.ts:12`, or `the review` for a review body. */
export const findingPlace = (finding: Pick<PrReviewFinding, "path" | "line">): string =>
  finding.path === null ? "the review" : finding.line === null ? finding.path : `${finding.path}:${String(finding.line)}`;

/**
 * The work item text of a PR follow-up run. A human review outranks every other sentence, as a
 * Linear reply does (DI-19.04). The kept PR reviewer findings are defects to repair, not decisions.
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
  ];
  if (followUp.trigger === "base" && followUp.baseUpdate !== undefined) {
    return [...header, ...baseUpdateSection(followUp.baseBranch, followUp.baseSha, followUp.baseUpdate)].join("\n");
  }
  if (followUp.trigger === "human") {
    return [
      ...header,
      `## Review from ${followUp.reviewerLogin ?? "a human"}: changes requested`,
      "",
      "This review is a decision of a human. It outranks every other sentence of this issue. Follow it.",
      "",
      ...followUp.findings.map((finding) => `- ${findingPlace(finding)}: ${oneLine(finding.body, MAX_FINDING_BODY_CHARACTERS)}`),
      ...(followUp.omittedFindings > 0 ? [`- ${String(followUp.omittedFindings)} more comments on the pull request.`] : []),
    ].join("\n");
  }
  const byKey = new Map(followUp.findings.map((finding) => [finding.key, finding]));
  return [
    ...header,
    `## Defects the PR reviewer found`,
    "",
    "Factoree triaged the PR reviewer's findings and kept only these. Each one names a concrete defect, a rule and evidence. Repair each one.",
    "",
    ...input.kept.map((kept) => {
      const source = byKey.get(kept.key);
      return `- ${oneLine(kept.evidence, 200)}: ${oneLine(kept.defect, 600)} Rule: ${oneLine(kept.rule, 300)}.${
        source === undefined ? "" : ` (${findingPlace(source)})`
      }`;
    }),
  ].join("\n");
};

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
  kept.map((finding) => `PR reviewer finding at ${finding.evidence}: ${finding.defect} Rule: ${finding.rule}`);

/** The reply Factoree posts on the pull request to one dropped finding. */
export const droppedFindingReply = (finding: TriagedFinding): string =>
  [
    "Factoree triaged this finding and did not act on it.",
    "",
    `Reason: ${oneLine(finding.reason, 1_000)}`,
    "",
    "Factoree acts only on a finding that names a concrete defect, the rule it breaks and the evidence in the change.",
  ].join("\n");

/** The "Needs your attention" post at the limit of PR reviewer follow-up runs. */
export const reviewerLimitNotice = (url: string, checkName: string): string =>
  [
    "### Needs your attention",
    "",
    `The PR reviewer check "${checkName}" failed again on ${url}. Factoree already ran ${String(MAX_REVIEWER_FOLLOW_UPS)} PR follow-up runs ` +
      "for the PR reviewer on this pull request, so it starts no other one. A human decides now: request changes, fix the branch, or close the pull request.",
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
  /** DI-21.109. The review comments and review bodies of the app `<slug>[bot]` on one head, oldest first. */
  reviewerFindings(slug: string, number: number, headSha: string, appSlug: string, installationId: string): Promise<PrReviewFinding[]>;
  /** The body and the comments of one review. */
  review(slug: string, number: number, reviewId: number, installationId: string): Promise<ReviewOfPullRequest>;
  /** True when the user holds write, maintain or admin access to the repository. */
  canWrite(slug: string, login: string, installationId: string): Promise<boolean>;
  /** Replies in the thread of a review comment, or comments on the pull request for a review body. */
  reply(slug: string, number: number, finding: PrReviewFinding, body: string, installationId: string): Promise<void>;
  /** One comment on the pull request conversation. */
  comment(slug: string, number: number, body: string, installationId: string): Promise<void>;
}
