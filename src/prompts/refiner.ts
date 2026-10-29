/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const REFINER_PROMPT_VERSION = "refiner@1";

export interface RefinerPromptFields {
  workItem: string;
  goal: string;
  statedCriteria: string[];
  contextContract: string;
  primaryRepositoryPath: string;
  proposalPath: string;
  proposalSchema: string;
  skills: string[];
}

const section = (title: string, body: string): string => `## ${title}\n\n${body}\n`;

const list = (items: string[], empty: string): string =>
  items.length === 0 ? empty : items.map((item) => `- ${item}`).join("\n");

/**
 * docs/specs/refiner-agent.md. The refiner reads the code and proposes what done means and how to
 * prove it. It writes data. Factoree's gate decides what freezes, so the prompt states the rules
 * the gate applies.
 */
export const renderRefinerPrompt = (fields: RefinerPromptFields): string =>
  [
    "# Refiner instructions",
    "",
    "You are the Refiner. You run in a fresh context before any code changes. Read the " +
      "repository, then propose the acceptance criteria of this Work Item and the check that " +
      "proves each one.",
    "",
    section("Work Item", fields.workItem),
    section("Goal", fields.goal),
    section("Criteria the Work Item states", list(fields.statedCriteria, "None.")),
    section("Context Contract", fields.contextContract),
    section(
      "Primary repository",
      `The repository is at ${fields.primaryRepositoryPath}. Read it. You must not change any file in it.`,
    ),
    section("Skills", list(fields.skills, "None.")),
    section(
      "Proposal",
      `Write one JSON document to ${fields.proposalPath}, and nothing else.\n\n${fields.proposalSchema}`,
    ),
    section(
      "Rules",
      [
        "State the required behaviour, not the defect. \"A failed delivery is never retried\" becomes \"A failed delivery is retried\".",
        "Set `quote` to the exact sentence of the Work Item that the criterion restates. Set it to null for a criterion you inferred from the code.",
        "Give each criterion the check that proves it: `test` with a test file path, `command` with a shell command, `http` with \"METHOD /path\", or `browser` with a route that starts with \"/\".",
        "Use `manual` only when no automated check can prove the criterion.",
        "Prefer an existing test or command of the repository. Name the files that show the pattern in `patterns`.",
        "Ask a question only for a decision the Work Item and the code leave open. Give your proposed answer and its reason.",
        "You must not invent product behaviour the Work Item and the code do not imply.",
      ].join("\n"),
    ),
  ].join("\n");
