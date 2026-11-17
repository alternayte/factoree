import { z } from "zod";
import type { PrReviewFinding, TriagedFinding } from "~/domain/pull-requests/pr-follow-up.js";

/**
 * docs/specs/pr-review-merge-and-deploy.md. The report of the fresh reviewer session that triages
 * the PR reviewer's findings. A bot finding is a claim, not evidence: the session keeps a finding
 * only with a concrete defect, a rule and evidence (SDD section 41), and gives a reason for every
 * finding it drops. Factoree decides from the report, never from the bot.
 */
export interface TriageReport {
  version: 1;
  findings: Array<{
    key: string;
    decision: "keep" | "drop";
    defect: string;
    rule: string;
    evidence: string;
    reason: string;
  }>;
}

export class TriageReportInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriageReportInvalidError";
  }
}

const reportSchema = z
  .object({
    version: z.literal(1),
    findings: z.array(
      z
        .object({
          key: z.string(),
          decision: z.enum(["keep", "drop"]),
          defect: z.string(),
          rule: z.string(),
          evidence: z.string(),
          reason: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

/** The prompt text that describes the report shape. */
export const TRIAGE_REPORT_SCHEMA_TEXT = [
  'The document is one JSON object: { "version": 1, "findings": [...] }.',
  "Write one entry for each finding above, with exactly these fields: key, decision, defect, rule, evidence, reason.",
  "key is the key of the finding, as the list above writes it.",
  'decision is "keep" or "drop".',
  "For keep: defect states the concrete defect in plain words, rule names the rule or the mandatory requirement the change breaks, " +
    "and evidence names one changed file and line, for example src/auth.ts:84. reason is an empty string.",
  "For drop: reason says in one or two sentences why the finding names no concrete defect, no rule or no evidence. defect, rule and evidence may be empty.",
  "Write no other key. Write no comment.",
].join("\n");

/** Parses the report text one triage session wrote. It decides nothing. */
export const parseTriageReport = (text: string): TriageReport => {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new TriageReportInvalidError(`The triage report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = reportSchema.safeParse(document);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "the document"}: ${issue.message}`).join("; ");
    throw new TriageReportInvalidError(`The triage report does not match the report schema: ${detail}`);
  }
  return parsed.data;
};

const blank = (value: string): boolean => value.trim() === "";

/**
 * DI-21.110. Factoree's own decision on each finding, in the order of the findings. A finding is kept
 * only when the session kept it and wrote a defect, a rule and evidence. A keep with a blank field,
 * a finding the report does not name, and a key the report names twice are dropped with the reason.
 * A key the report invents names no finding, so it is ignored.
 */
export const decideTriage = (findings: readonly PrReviewFinding[], report: TriageReport): TriagedFinding[] => {
  const entries = new Map<string, TriageReport["findings"][number] | "duplicate">();
  for (const entry of report.findings) entries.set(entry.key, entries.has(entry.key) ? "duplicate" : entry);
  return findings.map((finding): TriagedFinding => {
    const entry = entries.get(finding.key);
    const dropped = (reason: string): TriagedFinding => ({ key: finding.key, kept: false, defect: "", rule: "", evidence: "", reason });
    if (entry === undefined) return dropped("The triage session gave no decision on this finding.");
    if (entry === "duplicate") return dropped("The triage session gave more than one decision on this finding.");
    if (entry.decision === "drop") return dropped(blank(entry.reason) ? "The triage session found no concrete defect, rule and evidence." : entry.reason.trim());
    if (blank(entry.defect) || blank(entry.rule) || blank(entry.evidence)) {
      return dropped("The triage session kept this finding without a defect, a rule and evidence, so Factoree does not act on it.");
    }
    return { key: finding.key, kept: true, defect: entry.defect.trim(), rule: entry.rule.trim(), evidence: entry.evidence.trim(), reason: "" };
  });
};
