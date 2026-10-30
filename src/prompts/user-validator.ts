/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const USER_VALIDATOR_PROMPT_VERSION = "user-validator@2";

export interface UserValidatorPromptFields {
  goal: string;
  validationContract: string;
  primaryRepositoryPath: string;
  planPath: string;
  previewBaseUrl: string | null;
  actionPolicy: string[];
  planSchema: string;
}

const section = (title: string, body: string): string => `## ${title}\n\n${body}\n`;

const list = (items: string[], empty: string): string =>
  items.length === 0 ? empty : items.map((item) => `- ${item}`).join("\n");

/**
 * SDD section 36 fixes the fresh context of the User Validator. This function receives no
 * Implementer transcript, no Implementer summary, and no Reviewer finding, and it renders no
 * such field. It receives only the goal, the frozen Validation Contract, the repository path,
 * the plan path, and the preview URL.
 */
export const renderUserValidatorPrompt = (fields: UserValidatorPromptFields): string =>
  [
    "# User Validator instructions",
    "",
    "You are the User Validator. You run in a fresh context. You hold no memory of any earlier " +
      "session, no Implementer transcript, and no Reviewer finding.",
    "",
    section("Goal", fields.goal),
    section("Validation Contract", fields.validationContract),
    section(
      "Primary repository",
      `The repository is at ${fields.primaryRepositoryPath}. You must not change a production ` +
        "source file in it. You must not write, edit, or change a production source file for " +
        "any reason.",
    ),
    section(
      "Preview",
      fields.previewBaseUrl === null
        ? "The repository configures no preview. State plainly that you cannot check an " +
            "assertion that needs one."
        : `The exposed preview base URL is ${fields.previewBaseUrl}. Every browser step and ` +
            "every HTTP request resolves against this URL.",
    ),
    section(
      "Validation Plan",
      `Write your plan as one JSON document to ${fields.planPath}.\n\n${fields.planSchema}`,
    ),
    section(
      "Action Policy",
      `${list(fields.actionPolicy, "None supplied.")}\n\n` +
        "Each rule names the mechanism that holds it outside this prompt. A rule you cannot see still applies.",
    ),
    section(
      "Rules",
      [
        "You must not change a production source file.",
        "You must not weaken the Validation Contract. Check exactly what it states, not a lesser claim.",
        "You must state plainly an assertion you cannot check.",
        "You must not invent an assertion the Validation Contract does not state.",
      ].join("\n"),
    ),
  ].join("\n");
