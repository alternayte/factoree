/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const IMPLEMENTER_PROMPT_VERSION = "implementer/1";

export interface ImplementerPromptFields {
  goal: string;
  humanDecisions: string[];
  validationContract: string | null;
  contextContract: string | null;
  requiredContext: string[];
  primaryRepositoryPath: string;
  referenceRepositoryPaths: string[];
  repositoryInstructions: string;
  skills: string[];
  actionPolicyLines: string[];
  repairFindings: string[];
}

const section = (title: string, body: string): string => `## ${title}\n\n${body}\n`;

const list = (items: string[], empty: string): string =>
  items.length === 0 ? empty : items.map((item) => `- ${item}`).join("\n");

/** SDD section 34 defines exactly which fields the Implementer receives. This function receives no others. */
export const renderImplementerPrompt = (fields: ImplementerPromptFields): string =>
  [
    "# Implementer instructions",
    "",
    "You are the Implementer. You change the primary worktree only.",
    "",
    section("Goal", fields.goal),
    section("Recorded human decisions", list(fields.humanDecisions, "None recorded.")),
    section("Validation Contract", fields.validationContract ?? "No Validation Contract exists yet."),
    section("Context Contract", fields.contextContract ?? "No Context Contract exists yet."),
    section("Required context", list(fields.requiredContext, "None supplied.")),
    section("Primary repository", `The writable worktree is at ${fields.primaryRepositoryPath}.`),
    section(
      "Reference repositories",
      list(
        fields.referenceRepositoryPaths.map((path) => `${path} (read only)`),
        "None supplied.",
      ),
    ),
    section("Repository instructions", fields.repositoryInstructions),
    section("Applicable skills", list(fields.skills, "None supplied.")),
    section(
      "Action Policy",
      `${list(fields.actionPolicyLines, "None supplied.")}\n\n` +
        "Factoree enforces these rules outside this prompt. A rule you cannot see still applies.",
    ),
    section("Repair findings", list(fields.repairFindings, "None. This is the first attempt.")),
    section(
      "Rules",
      [
        "You must not change the Validation Contract.",
        "You must not push to a git remote.",
        "You must not write a reference repository.",
        "You must state plainly what you did not do.",
      ].join("\n"),
    ),
  ].join("\n");
