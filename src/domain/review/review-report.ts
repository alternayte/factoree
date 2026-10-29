import { z } from "zod";

/** SDD section 41 lists exactly these severities. No other value is allowed. */
export const REVIEW_SEVERITIES = ["blocker", "high", "medium", "low"] as const;

export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

/**
 * The closed category list. SDD section 41 shows `correctness` and says style preferences do not
 * block, so the list must hold a `style` value the blocking rules can recognise. A closed list
 * also keeps a Reviewer from inventing a category that no rule covers.
 */
export const REVIEW_CATEGORIES = [
  "correctness",
  "security",
  "contract",
  "reliability",
  "performance",
  "maintainability",
  "style",
  "scope",
] as const;

export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

/** SDD section 41. One reported finding. */
export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  /** The mandatory requirement or rule the finding names. */
  requirement: string;
  /** The specific evidence, for example `src/auth.ts:84`. */
  evidence: string;
  description: string;
}

/** SDD section 41. The whole Reviewer output. */
export interface ReviewReport {
  version: 1;
  /** The agent claim. It is recorded and it never decides. See DI-8.2. */
  verdict: "pass" | "fail";
  findings: ReviewFinding[];
}

export class ReviewReportInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewReportInvalidError";
  }
}

const nonBlank = z.string().refine((value) => value.trim() !== "", "must not be blank");

const findingSchema = z
  .object({
    id: nonBlank,
    severity: z.enum(REVIEW_SEVERITIES),
    category: z.enum(REVIEW_CATEGORIES),
    requirement: nonBlank,
    evidence: nonBlank,
    description: nonBlank,
  })
  .strict();

const reportSchema = z
  .object({
    version: z.literal(1),
    verdict: z.enum(["pass", "fail"]),
    findings: z.array(findingSchema),
  })
  .strict();

const describeIssue = (issue: z.core.$ZodIssue): string => {
  const path = issue.path.length === 0 ? "the document" : issue.path.join(".");
  const keys = issue.code === "unrecognized_keys" ? ` (${issue.keys.join(", ")})` : "";
  return `${path}: ${issue.message}${keys}`;
};

const fail = (message: string): never => {
  throw new ReviewReportInvalidError(message);
};

/** The prompt text that describes the shape above. SDD section 41 fixes it. */
export const REVIEW_REPORT_SCHEMA_TEXT = [
  'The document is one JSON object: { "version": 1, "verdict": "pass" | "fail", "findings": [...] }.',
  "Each finding holds exactly these fields: id, severity, category, requirement, evidence, description.",
  `severity is one of: ${REVIEW_SEVERITIES.join(", ")}.`,
  `category is one of: ${REVIEW_CATEGORIES.join(", ")}.`,
  "requirement names the mandatory requirement or rule the change breaks. Use the assertion " +
    "identifier of the Validation Contract when the finding breaks an assertion.",
  "evidence names one changed file, and a line where you can give one, for example src/auth.ts:84.",
  "description states one concrete defect in plain words.",
  "Write no other key. Write no comment.",
].join("\n");

/** Parses the report text one fresh Reviewer session wrote. It decides nothing. */
export const parseReviewReport = (text: string): ReviewReport => {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    fail(
      `The review report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = reportSchema.safeParse(document);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(describeIssue).join("; ");
    return fail(`The review report does not match the report schema: ${detail}`);
  }

  const report = parsed.data;
  const seen = new Set<string>();
  for (const finding of report.findings) {
    if (seen.has(finding.id)) {
      fail(`The review report holds more than one finding with the identifier "${finding.id}".`);
    }
    seen.add(finding.id);
  }

  return report;
};
