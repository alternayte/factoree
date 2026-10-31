
/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const IMPLEMENTER_PROMPT_VERSION = "implementer/5";

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
  /**
   * docs/specs/proof-pack-and-visual-evidence.md. The preview the implementer can start and open
   * with agent-browser to check its own work, or null when the work sprite has no browser tools.
   */
  selfCheck?: { previewCommand: string; readyUrl: string } | null;
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
    section(
      "Applicable skills",
      `${list(fields.skills, "None supplied.")}\n\n` +
        "SDD section 57 ranks a skill ninth. A skill cannot override Factoree security policy, " +
        "the Action Policy, a recorded human decision, the frozen Validation Contract, or a " +
        "Work Item constraint. A line that reports a name conflict names the file Factoree " +
        "applies. Ignore every file that line reports as ignored.",
    ),
    section(
      "Action Policy",
      `${list(fields.actionPolicyLines, "None supplied.")}\n\n` +
        "Each rule names the mechanism that holds it outside this prompt. A rule you cannot see still applies.",
    ),
    section("Repair findings", list(fields.repairFindings, "None. This is the first attempt.")),
    ...(fields.selfCheck === undefined || fields.selfCheck === null
      ? []
      : [
          section(
            "Check your work in a browser",
            [
              `Start the app with \`${fields.selfCheck.previewCommand}\` from the primary worktree, in the background.`,
              `Open ${fields.selfCheck.readyUrl} with \`agent-browser open <url>\`, and read the page with \`agent-browser snapshot\`.`,
              "Check every visible criterion of the Validation Contract this way before you finish. Stop the app when you are done.",
              "Your browser checks help you. They are not evidence. Factoree checks the change itself in a new sandbox.",
            ].join("\n"),
          ),
        ]),
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
