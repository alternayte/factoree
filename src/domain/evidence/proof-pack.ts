import { createHash } from "node:crypto";
import type {
  ValidationEvidenceKind,
  ValidationMethod,
} from "~/domain/validation/validation-contract.js";
import type { AssertionResult } from "~/domain/validation/validation-result.js";
import type { ReviewCategory, ReviewSeverity } from "~/domain/review/review-report.js";

/**
 * SDD section 47. The Proof Pack optimizes for one human acceptance decision. It must not dump a
 * full raw log into Linear, so no type in this file carries log text. A caller therefore cannot
 * pass one, and the rule holds by construction rather than by care.
 */

/** The largest number of changed files the Proof Pack names one by one. */
export const MAX_LISTED_CHANGED_FILES = 50;

/** The largest number of characters one free text field contributes. */
export const MAX_FIELD_CHARACTERS = 500;

/** SDD section 47 fixes these headings and this order. */
export const PROOF_PACK_HEADINGS = [
  "## Factoree delivery",
  "### Pull request",
  "### Validation contract",
  "### Deterministic verification",
  "### Independent review",
  "### Context used",
  "### Context conflicts",
  "### Change summary",
  "### Preview",
  "### Known limitations",
  "### Run metadata",
] as const;

/** One stored artefact of SDD section 39. The bytes stay in storage, and the reference travels. */
export interface ProofPackEvidenceRef {
  kind: ValidationEvidenceKind | "deterministic_check";
  source: string;
  sha256: string;
  storageRef: string | null;
}

export interface ProofPackAssertion {
  id: string;
  requirement: string;
  /** SDD section 24. The observable behavior. It is the success criterion a human audits. */
  statement: string;
  method: ValidationMethod;
  requiredEvidence: ValidationEvidenceKind[];
  result: AssertionResult;
  reason: string;
  evidence: ProofPackEvidenceRef[];
}

/** SDD section 35. One deterministic check. The retained log stays out of the Proof Pack. */
export interface ProofPackCheck {
  name: string;
  command: string;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  stdoutSha256: string;
  stderrSha256: string;
}

export interface ProofPackFinding {
  id: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  requirement: string;
  evidence: string;
  description: string;
  /** Factoree's own decision. SDD section 41. A non-blocking finding is a known limitation. */
  blocking: boolean;
  decisionReason: string;
  attempt: number;
}

export interface ProofPackContextItem {
  ref: string;
  authority: string;
  classification: string;
  sourceVersion: string;
  contentSha256: string | null;
  reason: string;
}

export interface ProofPackConflict {
  id: string;
  subject: string;
  winnerRef: string | null;
  loserRef: string | null;
  reason: string;
}

export interface ProofPackInput {
  runId: string;
  workItem: { title: string; url: string | null };
  pullRequestUrl: string;
  assertions: ProofPackAssertion[];
  checks: ProofPackCheck[];
  /** The agent claim of SDD section 41. Factoree's own decision drove the Run. */
  reviewVerdict: "pass" | "fail";
  /** The number of Reviewer sessions this Run ran. */
  reviewPasses: number;
  findings: ProofPackFinding[];
  contextItems: ProofPackContextItem[];
  /** SDD section 21. A discoverable item stays available through a tool and is not preloaded. */
  discoverableItemCount: number;
  conflicts: ProofPackConflict[];
  changedFiles: string[];
  patchByteLength: number;
  previewUrl: string | null;
  baseSha: string;
  patchSha256: string;
  commitSha: string;
  repairCount: number;
  repairLimit: number;
}

/** Keeps one field inside the cap. A truncated field says so, so a reader never guesses. */
const cap = (value: string): string =>
  value.length <= MAX_FIELD_CHARACTERS
    ? value
    : `${value.slice(0, MAX_FIELD_CHARACTERS)} [truncated]`;

/** One Markdown table cell. A newline breaks a table, and a pipe starts a new column. */
const cell = (value: string): string =>
  cap(value)
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();

const evidenceCell = (assertion: ProofPackAssertion): string => {
  if (assertion.evidence.length === 0) return "No stored evidence.";
  return assertion.evidence
    .map((item) => `${item.kind}: ${item.storageRef ?? item.sha256.slice(0, 12)}`)
    .join("; ");
};

const validationSection = (input: ProofPackInput): string[] => {
  if (input.assertions.length === 0) return ["No assertion was recorded."];
  const rows = input.assertions.map(
    (assertion) =>
      `| ${cell(assertion.id)} | ${cell(assertion.result)} | ${cell(evidenceCell(assertion))} |`,
  );
  const criteria = input.assertions.map(
    (assertion) =>
      // A newline inside a bullet breaks the list, exactly as it breaks a table row, so the
      // statement and the reason pass the same normalization the table cells use.
      `- ${assertion.id} proves ${assertion.requirement} by ${assertion.method}: ` +
      `${cell(assertion.statement)} Result: ${assertion.result}. ${cell(assertion.reason)}`,
  );
  return [
    "| Assertion | Result | Evidence |",
    "|---|---|---|",
    ...rows,
    "",
    "Success criteria:",
    "",
    ...criteria,
  ];
};

const verificationSection = (input: ProofPackInput): string[] => {
  if (input.checks.length === 0) return ["No deterministic check ran."];
  return input.checks.map(
    (check) =>
      `- ${check.name}: \`${cell(check.command)}\` ended with exit code ${check.exitCode} ` +
      `after ${check.durationMs} ms. ${check.passed ? "Passed" : "Failed"}. ` +
      `stdout ${check.stdoutSha256.slice(0, 12)}, stderr ${check.stderrSha256.slice(0, 12)}.`,
  );
};

const reviewSection = (input: ProofPackInput): string[] => {
  const blocking = input.findings.filter((finding) => finding.blocking);
  return [
    `Factoree accepted the change after ${input.reviewPasses} independent review ` +
      `${input.reviewPasses === 1 ? "pass" : "passes"}. The last Reviewer verdict was ` +
      `${input.reviewVerdict}.`,
    "",
    `Findings: ${input.findings.length}. Blocking findings that remain: ${blocking.length}.`,
  ];
};

const contextSection = (input: ProofPackInput): string[] => {
  const lines =
    input.contextItems.length === 0
      ? ["No context item was preloaded."]
      : input.contextItems.map(
          (item) =>
            `- ${item.ref} — authority ${item.authority}, ${item.classification}, version ` +
            `${item.sourceVersion}, hash ${item.contentSha256 ?? "not recorded"}. ` +
            `Selected because ${cap(item.reason)}`,
        );
  return [
    ...lines,
    "",
    `${input.discoverableItemCount} further ${
      input.discoverableItemCount === 1 ? "item stayed" : "items stayed"
    } discoverable through a tool.`,
  ];
};

const conflictSection = (input: ProofPackInput): string[] =>
  input.conflicts.length === 0
    ? ["None."]
    : input.conflicts.map(
        (conflict) =>
          `- ${conflict.id} on "${cap(conflict.subject)}": ${conflict.winnerRef ?? "no winner"} ` +
          `wins over ${conflict.loserRef ?? "no loser"}. ${cap(conflict.reason)}`,
      );

const changeSection = (input: ProofPackInput): string[] => {
  const listed = input.changedFiles.slice(0, MAX_LISTED_CHANGED_FILES);
  const remainder = input.changedFiles.length - listed.length;
  return [
    `${input.changedFiles.length} ${input.changedFiles.length === 1 ? "file" : "files"}, ` +
      `${input.patchByteLength} patch bytes.`,
    "",
    ...listed.map((file) => `- ${file}`),
    ...(remainder > 0 ? [`- and ${remainder} more files.`] : []),
  ];
};

/**
 * SDD section 47. A finding Factoree judged non-blocking is exactly what a human must still
 * weigh, so every one appears here with the reason it did not block. See the Phase 8 carried
 * finding about a defect that failed only one gate.
 */
const limitationSection = (input: ProofPackInput): string[] => {
  const limitations = input.findings.filter((finding) => !finding.blocking);
  if (limitations.length === 0) return ["None."];
  return limitations.map(
    (finding) =>
      `- ${finding.id} (${finding.severity}, ${finding.category}) at ${cell(finding.evidence)}: ` +
      `${cap(finding.description)} It did not block, because ${cap(finding.decisionReason)}`,
  );
};

const metadataSection = (input: ProofPackInput): string[] => [
  `- Run: ${input.runId}`,
  `- Base SHA: ${input.baseSha}`,
  `- Patch SHA-256: ${input.patchSha256}`,
  `- Commit: ${input.commitSha}`,
  `- Repairs: ${input.repairCount} of ${input.repairLimit}`,
];

/** SDD section 47. One Proof Pack, in the exact section order the SDD fixes. */
export const renderProofPack = (input: ProofPackInput): string =>
  [
    "## Factoree delivery",
    "",
    "Status: READY FOR HUMAN REVIEW",
    "",
    `Work Item: ${cap(input.workItem.title)}${
      input.workItem.url === null ? "" : ` (${input.workItem.url})`
    }`,
    "",
    "### Pull request",
    "",
    input.pullRequestUrl,
    "",
    "### Validation contract",
    "",
    ...validationSection(input),
    "",
    "### Deterministic verification",
    "",
    ...verificationSection(input),
    "",
    "### Independent review",
    "",
    ...reviewSection(input),
    "",
    "### Context used",
    "",
    ...contextSection(input),
    "",
    "### Context conflicts",
    "",
    ...conflictSection(input),
    "",
    "### Change summary",
    "",
    ...changeSection(input),
    "",
    "### Preview",
    "",
    input.previewUrl ?? "Not available.",
    "",
    "### Known limitations",
    "",
    ...limitationSection(input),
    "",
    "### Run metadata",
    "",
    ...metadataSection(input),
    "",
  ].join("\n");

/** The identity of one Proof Pack body. The Run row records it, so its existence is provable. */
export const hashProofPack = (body: string): string =>
  createHash("sha256").update(body, "utf8").digest("hex");
