import { imageFilesBody } from "./context-files.js";

/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const REVIEWER_PROMPT_VERSION = "reviewer@6";

export interface ReviewerPromptFields {
  goal: string;
  validationContract: string;
  contextContract: string | null;
  constraints: string[];
  sourceDiff: string;
  diffTruncated: boolean;
  changedFiles: string[];
  verificationSummary: string;
  repositoryInstructions: string;
  reportPath: string;
  actionPolicy: string[];
  reportSchema: string;
  /**
   * docs/specs/work-item-images-and-links.md. One line per image file of the check sprite. The
   * reviewer must see the mockup to judge a match.
   */
  imageFiles?: string[];
}

const section = (title: string, body: string): string => `## ${title}\n\n${body}\n`;

const list = (items: string[], empty: string): string =>
  items.length === 0 ? empty : items.map((item) => `- ${item}`).join("\n");

/**
 * SDD section 40 fixes the Reviewer input list, and docs/specs/run-speed.md amends it. This
 * function receives the goal, the frozen Validation Contract, the Context Contract, the
 * constraints, the source diff, the changed files, the deterministic verification result, and the
 * repository rules. The reviewer runs beside user validation, so it receives no validation
 * evidence, and it does not anchor on a pass. It receives no Implementer transcript and no
 * Implementer summary, and it renders no such field.
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
    section("Images of the Work Item", imageFilesBody(fields.imageFiles ?? [])),
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
    section(
      "Your report",
      `Write your report as one JSON document to ${fields.reportPath}.\n\n${fields.reportSchema}`,
    ),
    section(
      "Action Policy",
      `${list(fields.actionPolicy, "None supplied.")}\n\n` +
        "Each rule names the mechanism that holds it outside this prompt. A rule you cannot see still applies.",
    ),
    section(
      "Rules",
      [
        "You must not change any file of the repository.",
        "You must review only the change above, against the baseline above.",
        "You must not report a style preference as a blocker or as a high finding.",
        "You must name a mandatory requirement and one changed file for every blocker and every high finding.",
        "You must report useful work outside this change as a low finding of category scope.",
        "You must report a blocker when the change delivers a hand-built stand-in for a tool or a package the Work Item names, for example a vendored package under the name of the real one or a local package source that serves it.",
        "You must report a blocker when the change publishes a package under the id of another project.",
        "Factoree decides which findings block. Your verdict does not decide it.",
      ].join("\n"),
    ),
  ].join("\n");
