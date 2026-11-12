import { takesFollowUp } from "./run-recovery.js";

/**
 * docs/specs/draft-of-failed-run.md, issue #41. A human can ask Factoree to publish the last patch
 * of a failed run as a draft pull request: the "Publish as draft" option under the failure post,
 * the typed reply, or the button on the run page. All three take one path.
 */

/** The command. The option of the elicitation sends it as its value, so one matcher serves both. */
export const DRAFT_COMMAND = "publish as draft";

/** The one option of the elicitation that follows the failure post of a qualifying run. */
export const DRAFT_OPTION = { label: "Publish as draft", value: DRAFT_COMMAND } as const;

/**
 * True when the whole reply is the command: case-insensitive, with surrounding whitespace and a
 * final period ignored. Any other reply stays a follow-up reply.
 */
export const isDraftCommand = (body: string): boolean =>
  body.trim().replace(/\.$/, "").trimEnd().toLowerCase() === DRAFT_COMMAND;

export const DRAFT_SOURCES = ["linear", "factoree_ui"] as const;

export type DraftSource = (typeof DRAFT_SOURCES)[number];

/** Who asked for the draft and from where. `by` is the Linear user or the admin, or null. */
export interface DraftRequest {
  source: DraftSource;
  by: string | null;
}

/** One frozen assertion, with its result for the attempt of the last patch. */
export interface DraftAssertionFact {
  key: string;
  statement: string;
  result: string;
  reason: string;
}

/** One finding of the review of the last patch. */
export interface DraftFindingFact {
  key: string;
  severity: string;
  category: string;
  evidence: string;
  description: string;
  /** Factoree's own decision. SDD section 41. */
  blocking: boolean;
}

/** The stored facts that decide a draft request, and that the warning block lists. */
export interface DraftFacts {
  runId: string;
  status: string;
  failureReason: string | null;
  failureMessage: string | null;
  pullRequestUrl: string | null;
  hasPatch: boolean;
  /** DI-21.76. The attempt whose check sprite received the last patch, or null with no patch. */
  patchAttempt: number | null;
  /** The number of RunTarget rows. Two or more is a change set. */
  targetCount: number;
  assertions: DraftAssertionFact[];
  findings: DraftFindingFact[];
  /** DI-21.80. True when a review of the last patch finished. */
  reviewed: boolean;
}

/** DI-21.80. The reason of an assertion with no result row for the attempt of the last patch. */
export const NOT_CHECKED_REASON = "Factoree ran no check of this assertion on this patch.";

export type DraftDecision =
  | { kind: "published"; pullRequestUrl: string }
  | { kind: "refused"; reason: string }
  | { kind: "qualifies" };

const oneLine = (text: string, limit = 300): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
};

/** The findings of the review of the last patch whose severity is blocker. */
export const blockerFindings = (facts: Pick<DraftFacts, "findings">): DraftFindingFact[] =>
  facts.findings.filter((finding) => finding.severity === "blocker");

/**
 * Decides one draft request. A run that already published its draft answers with its pull
 * request, so a second request is idempotent. An unproven patch qualifies; a known defect does not.
 */
export const decideDraft = (facts: DraftFacts): DraftDecision => {
  if (facts.status === "DRAFT_PUBLISHED" && facts.pullRequestUrl !== null) {
    return { kind: "published", pullRequestUrl: facts.pullRequestUrl };
  }
  if (!takesFollowUp(facts.status)) {
    return {
      kind: "refused",
      reason: `This run is ${facts.status}, so Factoree publishes no draft of it. A draft is for a failed run.`,
    };
  }
  // DI-21.78. A run that failed after it opened a pull request already has one.
  if (facts.pullRequestUrl !== null) {
    return { kind: "refused", reason: `This run already opened a pull request: ${facts.pullRequestUrl}.` };
  }
  if (!facts.hasPatch) {
    return {
      kind: "refused",
      reason: "This run has no patch, because it failed before a check sprite received one. Factoree has nothing to publish as a draft.",
    };
  }
  if (facts.targetCount > 1) {
    return {
      kind: "refused",
      reason: `This run is a change set of ${facts.targetCount} repositories. Factoree publishes no draft of a change set.`,
    };
  }
  if (facts.failureReason === "PATCH_HASH_MISMATCH") {
    return {
      kind: "refused",
      reason: "The last patch of this run did not reproduce its verified hash, so Factoree publishes no draft of it.",
    };
  }
  const blockers = blockerFindings(facts);
  if (blockers.length > 0) {
    return {
      kind: "refused",
      reason: [
        "The review of this patch found a blocker, so Factoree publishes no draft of it. Reply with guidance to start a follow-up run that fixes it.",
        ...blockers.map((finding) => `- ${finding.key} at ${oneLine(finding.evidence, 120)}: ${oneLine(finding.description)}`),
      ].join("\n"),
    };
  }
  return { kind: "qualifies" };
};

/** The body of the elicitation that follows the failure post of a qualifying run. */
export const DRAFT_OFFER =
  "Factoree can publish the last patch of this run as a draft pull request. The checks did not pass, so a human finishes the change and marks it ready.";

/** The answer to a request that started the draft workflow. */
export const DRAFT_STARTED_LINE = "Factoree publishes the last patch of this run as a draft pull request. The proof pack follows here.";

/** The answer to a request while the draft workflow of the run still runs. */
export const DRAFT_IN_PROGRESS_LINE =
  "Factoree is already publishing the draft pull request of this run. It posts the link here when the pull request opens.";

/** The answer to a request after the draft pull request opened. */
export const draftPublishedLine = (pullRequestUrl: string): string =>
  `The draft pull request of this run is open: ${pullRequestUrl}.`;

/** The first sentence of the pull request body of a draft. */
export const DRAFT_WARNING_TITLE = "Factoree did not prove this change.";

/**
 * The warning block that starts the pull request body of a draft: each assertion that did not
 * pass with its result and reason, then each finding of the review of that patch.
 */
export const renderDraftWarning = (facts: Pick<DraftFacts, "failureMessage" | "assertions" | "findings" | "reviewed">): string => {
  const unmet = facts.assertions.filter((assertion) => assertion.result !== "PASS");
  const lines = [
    `**${DRAFT_WARNING_TITLE}** The run failed, and a human asked Factoree to publish its last patch as a draft. Only a human marks it ready.`,
    ...(facts.failureMessage === null || facts.failureMessage.trim() === "" ? [] : ["", `Why the run failed: ${oneLine(facts.failureMessage, 600)}`]),
    "",
    "Assertions that did not pass:",
    ...(unmet.length === 0
      ? ["- None. Every assertion of this patch passed."]
      : unmet.map((assertion) => `- ${assertion.key} is ${assertion.result}: ${oneLine(assertion.statement, 200)} ${oneLine(assertion.reason)}`)),
    "",
    "Review of this patch:",
    ...(!facts.reviewed
      ? ["- This patch was not reviewed."]
      : facts.findings.length === 0
        ? ["- The review reported no finding."]
        : facts.findings.map(
            (finding) =>
              `- ${finding.key} (${finding.severity}, ${finding.category}) at ${oneLine(finding.evidence, 120)}: ${oneLine(finding.description)}`,
          )),
  ];
  return ["> [!WARNING]", ...lines.map((line) => (line === "" ? ">" : `> ${line}`))].join("\n");
};

/** What the draft publication of a run needs beyond the run record. */
export interface DraftSubject {
  workItemTitle: string;
  workItemUrl: string | null;
  waitedMs: number;
  /** DI-21.81. The repair budget of the product, as the run records no effective limit. */
  repairLimit: number;
  /** The one RunTarget of the run and its repository, or null when the run has none. */
  target: { repositoryId: string; fullName: string; defaultBranch: string; githubInstallationId: string } | null;
}

/** Records who asked for a draft and from where, and the facts that decide it. */
export interface RunDraftStore {
  subject(tenantId: string, runId: string): Promise<DraftSubject | null>;
  facts(tenantId: string, runId: string): Promise<DraftFacts | null>;
  /** DI-21.79. Records the request that started the draft workflow. */
  recordRequest(tenantId: string, runId: string, request: DraftRequest, at: Date): Promise<void>;
  /**
   * Writes DRAFT_PUBLISHED on a run in FOLLOW_UP_STATUSES, and keeps its failure reason, message
   * and end time. It reports false when the run is in no such status.
   */
  markPublished(tenantId: string, runId: string): Promise<boolean>;
}
