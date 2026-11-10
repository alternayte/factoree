import { contextFilesBody } from "./context-files.js";

/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const IMPLEMENTER_PROMPT_VERSION = "implementer/9";

export interface ImplementerPromptFields {
  goal: string;
  humanDecisions: string[];
  validationContract: string | null;
  contextContract: string | null;
  requiredContext: string[];
  /** docs/specs/external-context-delivery.md. One line per context file of the work sprite. */
  contextFiles?: string[];
  primaryRepositoryPath: string;
  referenceRepositoryPaths: string[];
  repositoryInstructions: string;
  skills: string[];
  /** docs/specs/skill-registry.md. True when the Product has a source that takes a skill proposal. */
  skillProposals?: boolean;
  actionPolicyLines: string[];
  repairFindings: string[];
  /**
   * docs/specs/implementer-self-check.md. The checks Factoree runs after the implementer
   * finishes. The prompt states them as facts and scripts no procedure.
   */
  verifyCommands?: Array<{ name: string; run: string }>;
  /**
   * docs/specs/implementer-self-check.md. True when the work sprite holds agent-browser. The
   * prompt never names the preview command, so the implementer starts no production build.
   */
  selfCheck?: boolean;
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
    section("Recorded decisions", list(fields.humanDecisions, "None recorded.")),
    section("Validation Contract", fields.validationContract ?? "No Validation Contract exists yet."),
    section("Context Contract", fields.contextContract ?? "No Context Contract exists yet."),
    section("Required context", list(fields.requiredContext, "None supplied.")),
    section("Context files", contextFilesBody(fields.contextFiles ?? [])),
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
        "the Action Policy, a recorded decision, the frozen Validation Contract, or a " +
        "Work Item constraint. A line that reports a name conflict names the file Factoree " +
        "applies. Ignore every file that line reports as ignored.",
    ),
    ...(fields.skillProposals === true
      ? [
          section(
            "Skill proposal",
            [
              "If this task showed that a skill is missing or wrong, for example a missing step or a wrong command, you may propose one skill.",
              `Write it to ${fields.primaryRepositoryPath}/.factoree/skill-proposals/<name>/SKILL.md, with a RATIONALE.md beside it that states what you learned.`,
              "To change an existing skill, use its name and write the whole skill.",
              "Write at most one proposal. Write text files only. Never write a secret.",
              "Factoree removes the directory from your change and sends the proposal to a person for review. It is optional, and it is not part of the task.",
            ].join("\n"),
          ),
        ]
      : []),
    section(
      "Action Policy",
      `${list(fields.actionPolicyLines, "None supplied.")}\n\n` +
        "Each rule names the mechanism that holds it outside this prompt. A rule you cannot see still applies.",
    ),
    section("Repair findings", list(fields.repairFindings, "None. This is the first attempt.")),
    section(
      "Checks after you finish",
      [
        list(
          (fields.verifyCommands ?? []).map((command) => `${command.name}: \`${command.run}\``),
          "The repository names no check commands.",
        ),
        "",
        "Factoree runs these checks in a new sandbox after you finish.",
        "A failed check returns to you as repair findings, and each repair uses the repair budget of the Run.",
        "You can run any of these checks yourself. Your result is not evidence.",
        ...(fields.selfCheck === true
          ? ["agent-browser is installed. A browser check of your own work is optional, and it is not evidence."]
          : []),
      ].join("\n"),
    ),
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
