import type {
  ReviewCategory,
  ReviewFinding,
  ReviewReport,
  ReviewSeverity,
} from "~/domain/review/review-report.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";

/** SDD section 41. Only these two severities can block. */
const BLOCKING_SEVERITIES = new Set<ReviewSeverity>(["blocker", "high"]);

/**
 * SDD section 41. A style preference does not block, whatever severity the Reviewer gave it.
 * See controller decision 6.
 */
const NON_BLOCKING_CATEGORIES = new Set<ReviewCategory>(["style"]);

/** One finding and the decision Factoree took about it. */
export interface FindingDecision {
  finding: ReviewFinding;
  blocking: boolean;
  /** Plain words for a human. A non-blocking decision states why the finding did not block. */
  reason: string;
}

export interface ReviewDecision {
  decisions: FindingDecision[];
  blocking: FindingDecision[];
  nonBlocking: FindingDecision[];
  /** True when no finding blocks. It is Factoree's decision, never the agent verdict. */
  passed: boolean;
  /** The line Factoree posts to Linear. */
  summary: string;
  /** The blocking findings, formatted for `ImplementActivityInput.repairFindings`. */
  failures: string[];
}

/** Removes a trailing `:84`, `:80-90`, or `:84:12` location, and a leading `./`. */
const stripLocation = (token: string): string =>
  token.replace(/(:\d+(?:-\d+)?){1,2}$/, "").replace(/^\.\//, "");

/**
 * Reads the file part of an evidence string. SDD section 41 shows the `path:line` form. A
 * Reviewer can also write a range, a column, or a short note after the location, so this
 * function takes the first token and removes the location from it. The gate must not fail
 * open: a finding that really names a changed file must block.
 */
export const evidenceFileOf = (evidence: string): string =>
  stripLocation(evidence.trim().split(/[\s,]/)[0] ?? "");

/**
 * Reports whether the evidence names a file this Run changed. A Reviewer can write a note
 * before or after the location, so every token is a candidate. An absolute path, and a path
 * that carries a repository prefix, still name the file, so a changed path that is a suffix of
 * a candidate counts as a match. This errs toward blocking. A gate that fails open would let a
 * real defect reach a human as a passing review.
 */
const namesChangedFile = (evidence: string, changed: Set<string>): boolean => {
  for (const token of evidence.trim().split(/[\s,]+/)) {
    const file = stripLocation(token);
    if (file === "") continue;
    if (changed.has(file)) return true;
    for (const candidate of changed) {
      if (file.endsWith(`/${candidate}`)) return true;
    }
  }
  return false;
};

const requirementIsResolvable = (requirement: string, contract: ValidationContract): boolean => {
  const text = requirement.trim();
  // Controller decision 4. A Reviewer that invents an assertion identifier names no mandatory
  // requirement. Any other text names a repository rule or a constraint, and Factoree cannot
  // enumerate those deterministically.
  if (!text.startsWith("VAL-")) return true;
  return contract.assertions.some((assertion) => assertion.id === text);
};

const decideFinding = (
  finding: ReviewFinding,
  contract: ValidationContract,
  changed: Set<string>,
): FindingDecision => {
  if (!BLOCKING_SEVERITIES.has(finding.severity)) {
    return {
      finding,
      blocking: false,
      reason:
        `SDD section 41: the severity "${finding.severity}" does not block. Only a blocker or ` +
        "a high finding blocks.",
    };
  }

  if (NON_BLOCKING_CATEGORIES.has(finding.category)) {
    return {
      finding,
      blocking: false,
      reason: "SDD section 41: a style preference does not block.",
    };
  }

  if (!requirementIsResolvable(finding.requirement, contract)) {
    return {
      finding,
      blocking: false,
      reason:
        `SDD section 41: the requirement "${finding.requirement}" names no assertion of the ` +
        "frozen Validation Contract, so the finding names no mandatory requirement.",
    };
  }

  if (!namesChangedFile(finding.evidence, changed)) {
    return {
      finding,
      blocking: false,
      reason:
        `SDD section 41 and section 43: the evidence "${finding.evidence}" names no file this ` +
        "Run changed, so the finding lies outside the change under review.",
    };
  }

  return {
    finding,
    blocking: true,
    reason:
      `SDD section 41: a ${finding.severity} ${finding.category} finding names a mandatory ` +
      "requirement and specific evidence inside the change.",
  };
};

const failureLine = (decision: FindingDecision): string =>
  `${decision.finding.id} (${decision.finding.severity}, ${decision.finding.category}) at ` +
  `${decision.finding.evidence}: ${decision.finding.description} It breaks: ` +
  `${decision.finding.requirement}`;

/**
 * SDD section 41. Factoree decides which findings block. The agent `verdict` field is carried
 * on the report and decides nothing. See controller decision 2.
 */
export const decideReview = (input: {
  report: ReviewReport;
  contract: ValidationContract;
  changedFiles: string[];
}): ReviewDecision => {
  const changed = new Set(input.changedFiles.map((file) => file.replace(/^\.\//, "")));
  const decisions = input.report.findings.map((finding) =>
    decideFinding(finding, input.contract, changed),
  );
  const blocking = decisions.filter((decision) => decision.blocking);
  const nonBlocking = decisions.filter((decision) => !decision.blocking);
  const passed = blocking.length === 0;

  const counted = `${decisions.length} ${decisions.length === 1 ? "finding" : "findings"}`;
  const summary = passed
    ? `The independent review reported ${counted}, and none of them blocks.`
    : `The independent review reported ${counted}, and ${blocking.length} of them ` +
      `${blocking.length === 1 ? "blocks" : "block"} the Run.`;

  return {
    decisions,
    blocking,
    nonBlocking,
    passed,
    summary,
    failures: blocking.map(failureLine),
  };
};
