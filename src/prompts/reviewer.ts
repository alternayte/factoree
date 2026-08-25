/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const REVIEWER_PROMPT_VERSION = "reviewer@1";

export interface ReviewerPromptFields {
  goal: string;
  validationContract: string;
  contextContract: string | null;
  constraints: string[];
  sourceDiff: string;
  diffTruncated: boolean;
  changedFiles: string[];
  verificationSummary: string;
  validationEvidence: string[];
  repositoryInstructions: string;
  reportPath: string;
  actionPolicy: string[];
  reportSchema: string;
}

const section = (title: string, body: string): string => `## ${title}\n\n${body}\n`;

const list = (items: string[], empty: string): string =>
  items.length === 0 ? empty : items.map((item) => `- ${item}`).join("\n");

/**
 * SDD section 40 fixes the Reviewer input list. This function receives the goal, the frozen
 * Validation Contract, the Context Contract, the constraints, the source diff, the changed
 * files, the deterministic verification result, the user-validation evidence, and the
 * repository rules. It receives no Implementer transcript and no Implementer summary, and it
 * renders no such field.
 */
export const renderReviewerPrompt = (fields: ReviewerPromptFields): string =>
  [
    "# Reviewer instructions",
    "",
    "You are the independent Reviewer. You run in a fresh context. You hold no memory of any " +
      "earlier session, and you received no Implementer transcript.",
    "",
    section("Goal", fields.goal),
    section("Validation Contract", fields.validationContract),
    section("Context Contract", fields.contextContract ?? "No Context Contract exists for this Run."),
    section("Constraints", list(fields.constraints, "None recorded.")),
    section("Repository rules", fields.repositoryInstructions),
    section("Changed files", list(fields.changedFiles, "The change touched no file.")),
    section(
      "Source diff",
      fields.diffTruncated
        ? `Factoree truncated this diff. The changed-file list above is complete.\n\n${fields.sourceDiff}`
        : fields.sourceDiff,
    ),
    section("Deterministic verification", fields.verificationSummary),
    section("User validation evidence", list(fields.validationEvidence, "None recorded.")),
    section(
      "Your report",
      `Write your report as one JSON document to ${fields.reportPath}.\n\n${fields.reportSchema}`,
    ),
    section(
      "Action Policy",
      `${list(fields.actionPolicy, "None supplied.")}\n\n` +
        "Factoree enforces these rules outside this prompt. A rule you cannot see still applies.",
    ),
    section(
      "Rules",
      [
        "You must not change any file of the repository.",
        "You must review only the change above, against the baseline above.",
        "You must not report a style preference as a blocker or as a high finding.",
        "You must name a mandatory requirement and one changed file for every blocker and every high finding.",
        "You must report useful work outside this change as a low finding of category scope.",
        "Factoree decides which findings block. Your verdict does not decide it.",
      ].join("\n"),
    ),
  ].join("\n");
