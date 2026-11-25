import { describeDecision } from "~/domain/runs/factoree-decision.js";
import type { ProofPackInput } from "~/domain/evidence/proof-pack.js";

/**
 * docs/specs/pr-body-for-humans.md. The body of a Factoree pull request, written for the human who
 * reviews it: what changed and why, where to look first, what was asked with its result, what
 * needs a human eye, and what Factoree did not prove. The machine facts of AT-29 sit last, in a
 * collapsed block.
 *
 * Factoree owns only the text between the two markers. Each verified push replaces that block and
 * keeps any text a human wrote outside it (DI-21.217).
 */

export const OWNED_BLOCK_START = "<!-- factoree:body -->";
export const OWNED_BLOCK_END = "<!-- /factoree:body -->";

/** The most entries the Where to look list shows. A longer guide stops being a guide. */
export const MAX_WHERE_TO_LOOK = 8;

/** One entry of the reviewer's reading guide: a changed file, an optional line range, and why to read it. */
export interface WhereToLookEntry {
  path: string;
  startLine: number | null;
  endLine: number | null;
  reason: string;
}

/** docs/specs/pr-body-for-humans.md, DI-21.217. One pull request whose body the proof pack step writes. */
export interface PullRequestBodyTarget {
  repositorySlug: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  githubInstallationId: string;
  baseSha: string;
  patchSha256: string;
  changedFileCount: number;
  /** The head commit, so the reading guide links its lines. */
  commitSha: string;
}

/** One frozen criterion of the validation contract, with its last result and its openable evidence. */
export interface BodyCriterion {
  statement: string;
  /** The ticket sentence that implies the criterion, for an implied criterion. Null for a stated one. */
  impliedBy?: string | null;
  result: "PASS" | "FAIL" | "BLOCKED" | "MANUAL_REQUIRED" | "UNSTABLE";
  reason: string;
  evidence: Array<{ label: string; url: string }>;
}

/** One criterion a human judges by eye, with its screenshot or the reason Factoree has none. */
export interface BodyForYourEye {
  statement: string;
  route: string;
  screenshotUrl: string | null;
  reason: string | null;
}

/** What a PR follow-up run answered, for the Since the last commit section. */
export interface BodySinceLastCommit {
  startedBy: string;
  fixed: Array<{ place: string; change: string }>;
  dropped: Array<{ place: string; reason: string }>;
  ciFailures: string[];
  decided: boolean;
}

export interface PullRequestBodyFacts {
  workItemTitle: string;
  workItemUrl: string | null;
  runId: string;
  baseSha: string;
  patchSha256: string;
  changedFileCount: number;
  repairCount: number;
  /** The contract version of the head commit. A new run freezes version 1. */
  contractRevision: number;
  /** One line per verification check, or the summary sentence of the check sprite. */
  verification: string[];
  /** The fresh reviewer's two or three sentences, or empty when the review wrote none. */
  summary: string;
  whereToLook: WhereToLookEntry[];
  /**
   * The web URL of the repository, such as `https://github.com/acme/app`, and the head commit, so a
   * Where to look entry links its lines. Null in a change set, whose paths name no one repository.
   */
  linkTarget: { repositoryUrl: string; commitSha: string } | null;
  /**
   * The facts of the proof pack. Null at the first publication, before the proof pack exists: the
   * body then says that Factoree adds them, and the proof pack step writes the whole block.
   */
  proof: {
    criteria: BodyCriterion[];
    implied: Array<{ statement: string; quote: string }>;
    notBuilt: string[];
    forYourEye: BodyForYourEye[];
    /** DI-21.220. The pull request preview of the head, from its successful deployment, or null. */
    previewUrl: string | null;
    notProven: string[];
    sinceLastCommit: BodySinceLastCommit | null;
    proofPackUrl: string | null;
  } | null;
  /** docs/specs/draft-of-failed-run.md. The warning block that starts a draft of a failed run. */
  draftWarning?: string;
  /** docs/specs/change-sets.md. The sibling and merge order section. It ends the block. */
  changeSet?: string[];
}

const oneLine = (text: string, limit = 400): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
};

/** The web URL of the repository of a pull request URL, such as `https://github.com/acme/app`. */
export const repositoryUrlOf = (pullRequestUrl: string): string | null => {
  const match = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+\/?$/.exec(pullRequestUrl);
  return match?.[1] ?? null;
};

/** The Linear issue key of a work item, such as `FAC-73`, read from its Linear URL. */
export const issueKeyOf = (workItemUrl: string | null): string | null => {
  if (workItemUrl === null) return null;
  const match = /\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#]|$)/.exec(workItemUrl);
  return match?.[1]?.toUpperCase() ?? null;
};

const RESULT_WORDS: Record<BodyCriterion["result"], string> = {
  PASS: "Passed",
  FAIL: "Failed",
  BLOCKED: "Not proven",
  MANUAL_REQUIRED: "Needs a human",
  UNSTABLE: "Unstable",
};

const lineRange = (entry: WhereToLookEntry): string =>
  entry.startLine === null ? "" : entry.endLine === null || entry.endLine === entry.startLine ? `:${String(entry.startLine)}` : `:${String(entry.startLine)}-${String(entry.endLine)}`;

const whereToLookLine = (entry: WhereToLookEntry, target: PullRequestBodyFacts["linkTarget"]): string => {
  const label = `\`${entry.path}${lineRange(entry)}\``;
  if (target === null) return `- ${label}: ${oneLine(entry.reason, 300)}`;
  const anchor = entry.startLine === null ? "" : `#L${String(entry.startLine)}${entry.endLine === null || entry.endLine === entry.startLine ? "" : `-L${String(entry.endLine)}`}`;
  const url = `${target.repositoryUrl}/blob/${target.commitSha}/${entry.path.split("/").map(encodeURIComponent).join("/")}${anchor}`;
  return `- [${label}](${url}): ${oneLine(entry.reason, 300)}`;
};

const criterionLine = (criterion: BodyCriterion): string => {
  const evidence = criterion.evidence.length === 0 ? "" : ` (${criterion.evidence.map((item) => `[${item.label}](${item.url})`).join(", ")})`;
  const reason = criterion.result === "PASS" || criterion.reason.trim() === "" ? "" : ` ${oneLine(criterion.reason, 300)}`;
  const implied = criterion.impliedBy == null ? "" : ` Implied by the ticket sentence "${oneLine(criterion.impliedBy, 300)}".`;
  return `- **${RESULT_WORDS[criterion.result]}:** ${oneLine(criterion.statement, 300)}${evidence}${reason}${implied}`;
};

const forYourEyeLines = (item: BodyForYourEye): string[] => {
  const head = `- On \`${oneLine(item.route, 200)}\`: ${oneLine(item.statement, 300)}`;
  if (item.screenshotUrl === null) return [`${head} Factoree has no screenshot: ${oneLine(item.reason ?? "no reason was recorded.", 300)}`];
  return [head, "", `  ![screenshot of ${oneLine(item.route, 80)}](${item.screenshotUrl})`];
};

const sinceLines = (since: BodySinceLastCommit): string[] => [
  "### Since the last commit",
  "",
  `${oneLine(since.startedBy, 400)} started this commit.${since.decided ? " A human decision outranks every other request." : ""}`,
  ...(since.fixed.length + since.dropped.length + since.ciFailures.length === 0 ? [] : [""]),
  ...since.ciFailures.map((check) => `- Fixed the failed check ${oneLine(check, 200)}.`),
  ...since.fixed.map((item) => `- Fixed at \`${oneLine(item.place, 200)}\`: ${oneLine(item.change, 400)}`),
  ...since.dropped.map((item) => `- Did not change \`${oneLine(item.place, 200)}\`: ${oneLine(item.reason, 400)}`),
  "",
];

/** The text Factoree owns, markers included. */
export const renderOwnedBlock = (facts: PullRequestBodyFacts): string => {
  const key = issueKeyOf(facts.workItemUrl);
  const proof = facts.proof;
  const lines: string[] = [OWNED_BLOCK_START];
  if (facts.draftWarning !== undefined) lines.push(facts.draftWarning, "");
  if (facts.summary.trim() !== "") lines.push("### Summary", "", oneLine(facts.summary, 800), "");
  const guide = facts.whereToLook.slice(0, MAX_WHERE_TO_LOOK);
  if (guide.length > 0) {
    lines.push(
      "### Where to look",
      "",
      "Read these first, in this order. The independent reviewer wrote this guide after it read the whole change. It is a guide, not evidence.",
      "",
      ...guide.map((entry) => whereToLookLine(entry, facts.linkTarget)),
      "",
    );
  }
  if (proof === null) {
    lines.push("Factoree adds what was asked, the evidence and what it did not prove when it posts the proof pack in Linear.", "");
  } else {
    if (proof.sinceLastCommit !== null) lines.push(...sinceLines(proof.sinceLastCommit));
    if (proof.criteria.length + proof.implied.length + proof.notBuilt.length > 0) {
      lines.push("### What was asked", "");
      if (proof.criteria.length > 0) lines.push(...proof.criteria.map(criterionLine), "");
      if (proof.implied.length > 0) {
        lines.push(
          "Factoree also took these criteria, because a ticket sentence implies them:",
          "",
          ...proof.implied.map((item) => `- ${oneLine(item.statement, 300)} (the ticket says "${oneLine(item.quote, 300)}")`),
          "",
        );
      }
      if (proof.notBuilt.length > 0) {
        lines.push("Not built, because no ticket sentence states or implies it:", "", ...proof.notBuilt.map((item) => `- ${oneLine(item, 300)}`), "");
      }
    }
    if (proof.forYourEye.length > 0 || proof.previewUrl !== null) {
      lines.push("### Needs your eye", "");
      if (proof.previewUrl !== null) {
        lines.push(`[Open the pull request preview](${proof.previewUrl}). The repository CI deployed this commit there. It is a link for you, not evidence.`, "");
      }
      if (proof.forYourEye.length > 0) {
        lines.push("Factoree does not check these. Look at each one and judge it yourself.", "", ...proof.forYourEye.flatMap(forYourEyeLines), "");
      }
    }
    lines.push("### What Factoree did not prove", "", ...(proof.notProven.length === 0 ? ["Nothing."] : proof.notProven.map((item) => `- ${oneLine(item, 500)}`)), "");
  }
  const links = [
    ...(key === null ? [] : [`Fixes ${key}`]),
    ...(proof?.proofPackUrl == null ? [] : [`[Proof pack](${proof.proofPackUrl})`]),
  ];
  if (links.length > 0) lines.push(links.join(" · "), "");
  lines.push(
    "<details>",
    "<summary>Run metadata</summary>",
    "",
    `- Work item: ${facts.workItemUrl === null ? `${facts.workItemTitle} (no Work Item URL)` : `[${oneLine(facts.workItemTitle, 200)}](${facts.workItemUrl})`}`,
    `- Run ID: ${facts.runId}`,
    `- Base SHA: ${facts.baseSha}`,
    `- Patch SHA-256: ${facts.patchSha256}`,
    `- Changed files: ${String(facts.changedFileCount)}`,
    `- Repair count: ${String(facts.repairCount)}`,
    `- Contract version: ${String(facts.contractRevision)}`,
    "- Verification:",
    ...facts.verification.map((item) => `  - ${oneLine(item, 300)}`),
    "",
    "Factoree applied the patch to a clean trusted checkout and proved its hash again before it pushed.",
    "",
    "</details>",
  );
  if (facts.changeSet !== undefined && facts.changeSet.length > 0) lines.push("", ...facts.changeSet);
  lines.push(OWNED_BLOCK_END);
  return lines.join("\n");
};

const ownedRange = (body: string): { start: number; end: number } | null => {
  const start = body.indexOf(OWNED_BLOCK_START);
  if (start < 0) return null;
  const close = body.indexOf(OWNED_BLOCK_END, start + OWNED_BLOCK_START.length);
  if (close < 0) return null;
  return { start, end: close + OWNED_BLOCK_END.length };
};

/**
 * DI-21.217. The body with the owned block replaced. Text outside the markers stays. A body with no
 * markers, such as one from before the owned block, keeps its old text below the new block.
 */
export const withOwnedBlock = (existing: string | null, block: string): string => {
  const current = existing ?? "";
  const range = ownedRange(current);
  if (range === null) return current.trim() === "" ? block : `${block}\n\n${current}`;
  return `${current.slice(0, range.start)}${block}${current.slice(range.end)}`;
};

/**
 * DI-21.217. The parts of the owned block that the proof pack step cannot rebuild and keeps: the
 * draft warning at its start, and the change set section at its end. Each is null when absent.
 */
export const keptPartsOf = (existing: string | null): { draftWarning: string | null; changeSet: string[] | null } => {
  const current = existing ?? "";
  const range = ownedRange(current);
  const inner = range === null ? "" : current.slice(range.start + OWNED_BLOCK_START.length, range.end - OWNED_BLOCK_END.length);
  const lines = inner.split("\n");
  const first = lines.findIndex((text) => text.trim() !== "");
  let draftWarning: string | null = null;
  if (first >= 0 && lines[first]?.startsWith("> [!WARNING]") === true) {
    let last = first;
    while (last + 1 < lines.length && (lines[last + 1] ?? "").startsWith(">")) last += 1;
    draftWarning = lines.slice(first, last + 1).join("\n");
  }
  const changeSetAt = lines.findIndex((text) => text.trim() === "### Change set");
  const changeSet = changeSetAt < 0 ? null : lines.slice(changeSetAt).join("\n").trimEnd().split("\n");
  return { draftWarning, changeSet };
};

/** A link a reader on GitHub can open. A worker-local `file:` reference opens for nobody. */
const openable = (ref: string | null): ref is string => ref !== null && /^https:\/\//.test(ref);

const quoted = (text: string, prefix: RegExp): string => text.replace(prefix, "").trim().replace(/^"(.*)"$/, "$1");

/**
 * docs/specs/pr-body-for-humans.md, DI-21.217. The body facts of one pull request, from the proof
 * pack input of the run that pushed its head. The proof pack and the body read one record, so they
 * cannot disagree.
 */
export const bodyFactsOfProofPack = (
  input: ProofPackInput,
  extras: {
    whereToLook: WhereToLookEntry[];
    linkTarget: PullRequestBodyFacts["linkTarget"];
    proofPackUrl: string | null;
    /** DI-21.220. The pull request preview of this head, or null. */
    previewUrl: string | null;
    /** The changed files and the base of this pull request. A change set gives each target its own. */
    changedFileCount: number;
    baseSha: string;
    patchSha256: string;
  },
): PullRequestBodyFacts => {
  const decisions = input.decisions ?? [];
  const implied = decisions
    .filter((decision) => decision.kind === "criterion")
    .map((decision) => ({
      statement: quoted(decision.statement, /^added the implied criterion /),
      quote: quoted(decision.reason, /^the ticket says /),
    }));
  const same = (a: string, b: string): boolean => a.trim().replace(/[.\s]+$/, "").toLowerCase() === b.trim().replace(/[.\s]+$/, "").toLowerCase();
  const impliedOf = (statement: string): string | null => implied.find((item) => same(item.statement, statement))?.quote ?? null;
  const notBuilt = decisions.filter((decision) => decision.kind === "not_built").map((decision) => quoted(decision.statement, /^did not build /));
  const unproven = input.draft === undefined ? input.assertions.filter((assertion) => assertion.result !== "PASS") : [];
  const notProven = [
    ...(input.draft !== undefined && !input.draft.reviewed ? ["The independent reviewer did not review this patch."] : []),
    ...((input.checkDefiningFiles ?? []).length === 0
      ? []
      : [
          `The change edits files that define a check, so Factoree's own checks cannot prove it: ${(input.checkDefiningFiles ?? []).map((file) => `\`${file}\``).join(", ")}.`,
        ]),
    ...unproven.map((assertion) => `${assertion.statement} is ${RESULT_WORDS[assertion.result].toLowerCase()}: ${assertion.reason}`),
    ...(input.fakes ?? []).map(
      (fake) => `A fake answered for ${fake.name} (the compose service \`${fake.service}\`${fake.target === undefined ? "" : ` of ${fake.target}`}), so the data it served is not real.`,
    ),
    ...(input.visualEvidenceGap === null ? [] : [`No screenshot proves the visible change: ${input.visualEvidenceGap}`]),
    ...decisions.filter((decision) => decision.kind === "dropped" || decision.kind === "visual_evidence").map(describeDecision),
    ...(input.setCheckNotes ?? []),
    ...input.findings
      .filter((finding) => !finding.blocking)
      .map((finding) => `The reviewer noted ${finding.id} (${finding.severity}) at \`${finding.evidence}\`, which does not block: ${finding.description}`),
  ];
  const followUp = input.pullRequestFollowUp;
  return {
    workItemTitle: input.workItem.title,
    workItemUrl: input.workItem.url,
    runId: input.runId,
    baseSha: extras.baseSha,
    patchSha256: extras.patchSha256,
    changedFileCount: extras.changedFileCount,
    repairCount: input.repairCount,
    contractRevision: followUp?.contractRevision ?? 1,
    verification: [
      ...input.checks.map((check) => `${check.passed ? "Passed" : "Failed"} ${check.name}: \`${check.command}\``),
      `Independent review: ${String(input.reviewPasses)} ${input.reviewPasses === 1 ? "pass" : "passes"}, ` +
        `${String(input.findings.filter((finding) => finding.blocking).length)} blocking ${input.findings.filter((finding) => finding.blocking).length === 1 ? "finding" : "findings"}.`,
    ],
    summary: input.changeDescription,
    whereToLook: extras.whereToLook,
    linkTarget: extras.linkTarget,
    proof: {
      criteria: input.assertions.map((assertion) => ({
        statement: assertion.statement,
        impliedBy: impliedOf(assertion.statement),
        result: assertion.result,
        reason: assertion.reason,
        evidence: assertion.evidence
          .filter((item) => openable(item.storageRef))
          .map((item) => ({ label: item.kind.replace(/_/g, " "), url: item.storageRef ?? "" })),
      })),
      // An implied criterion with an assertion shows on its line. One without stays in the list.
      implied: implied.filter((item) => !input.assertions.some((assertion) => same(assertion.statement, item.statement))),
      notBuilt,
      forYourEye: (input.needsYourEye ?? []).map((item) => ({
        statement: item.statement,
        route: item.route,
        screenshotUrl: item.screenshot !== null && openable(item.screenshot.storageRef) ? item.screenshot.storageRef : null,
        reason: item.screenshot === null ? item.reason : openable(item.screenshot.storageRef) ? null : "the screenshot is stored, and its link does not open on GitHub.",
      })),
      previewUrl: extras.previewUrl,
      notProven,
      sinceLastCommit:
        followUp === undefined
          ? null
          : {
              startedBy: followUp.startedBy,
              fixed: followUp.kept.map((kept) => ({ place: kept.evidence, change: kept.defect })),
              dropped: followUp.droppedFindings ?? [],
              ciFailures: followUp.ciFailures ?? [],
              decided: followUp.trigger === "human",
            },
      proofPackUrl: extras.proofPackUrl,
    },
  };
};
