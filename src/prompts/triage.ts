import type { PrReviewFinding } from "~/domain/pull-requests/pr-follow-up.js";
import { findingPlace } from "~/domain/pull-requests/pr-follow-up.js";

/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const TRIAGE_PROMPT_VERSION = "triage@2";

export interface TriagePromptFields {
  pullRequestUrl: string;
  reviewerName: string;
  findings: PrReviewFinding[];
  sourceDiff: string;
  diffTruncated: boolean;
  changedFiles: string[];
  repositoryInstructions: string;
  reportPath: string;
  actionPolicy: string[];
  reportSchema: string;
}

const section = (title: string, body: string): string => `## ${title}\n\n${body}\n`;

const list = (items: string[], empty: string): string => (items.length === 0 ? empty : items.map((item) => `- ${item}`).join("\n"));

/**
 * docs/specs/pr-review-merge-and-deploy.md, docs/specs/pr-feedback-loop.md. The fresh reviewer session
 * that triages the findings of the review apps. It reads the pull request change in a check sprite of the PR head, and it
 * receives no implementer transcript.
 */
export const renderTriagePrompt = (fields: TriagePromptFields): string =>
  [
    "# Triage instructions",
    "",
    "You are an independent Reviewer. You run in a fresh context. The review app " +
      `${fields.reviewerName} reviewed the pull request ${fields.pullRequestUrl}, did not pass it, and wrote the findings below. ` +
      "A finding of a review app is a claim, not evidence. Decide for each finding whether it names a concrete defect " +
      "in this change, a rule the change breaks, and evidence in the changed files. Check each claim against the source.",
    "",
    section(
      "Findings of the review app",
      fields.findings
        .map((finding) => `### ${finding.key}\n\nWhere: ${findingPlace(finding)}\nAuthor: ${finding.author}\n\n${finding.body}`)
        .join("\n\n"),
    ),
    section("Repository rules", fields.repositoryInstructions),
    section("Changed files", list(fields.changedFiles, "The change touched no file.")),
    section(
      "Source diff of the pull request",
      fields.diffTruncated ? `Factoree truncated this diff. The changed-file list above is complete.\n\n${fields.sourceDiff}` : fields.sourceDiff,
    ),
    section("Your report", `Write your report as one JSON document to ${fields.reportPath}.\n\n${fields.reportSchema}`),
    section(
      "Action Policy",
      `${list(fields.actionPolicy, "None supplied.")}\n\nEach rule names the mechanism that holds it outside this prompt. A rule you cannot see still applies.`,
    ),
    section(
      "Rules",
      [
        "You must not change any file of the repository.",
        "Keep a finding only when you can name the concrete defect, the rule or requirement it breaks, and one changed file and line as evidence.",
        "Drop a style preference, a question, a suggestion, a nit, a duplicate of another finding, and a claim the source does not support.",
        "Drop a finding about code the change does not touch.",
        "Give a reason for each finding you drop. Factoree posts it on the pull request as the reply to that finding.",
        "Factoree decides from your report. The review app's verdict does not decide it.",
      ].join("\n"),
    ),
  ].join("\n");
