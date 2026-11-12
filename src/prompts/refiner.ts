import type { EgressFacts } from "~/domain/runs/egress.js";
import { contextFilesBody, imageFilesBody } from "./context-files.js";
import { egressBody } from "./egress.js";

/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const REFINER_PROMPT_VERSION = "refiner@8";

export interface RefinerPromptFields {
  workItem: string;
  goal: string;
  statedCriteria: string[];
  contextContract: string;
  /** docs/specs/external-context-delivery.md. One line per context file of the work sprite. */
  contextFiles: string[];
  /** docs/specs/work-item-images-and-links.md. One line per image file of the work sprite. */
  imageFiles?: string[];
  primaryRepositoryPath: string;
  proposalPath: string;
  proposalSchema: string;
  /** Issue #39, DI-21.66. The most criteria the proposal may hold, a Product setting. */
  criteriaLimit: number;
  /** Issue #39. The most questions the proposal may hold. */
  questionsLimit: number;
  skills: string[];
  /**
   * docs/specs/egress-honesty-and-issue-status.md. The effective allow list of the work sprite and
   * the hosts only the bootstrap reached. Absent in a history recorded before it existed.
   */
  egress?: EgressFacts | null;
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
    section("Images of the Work Item", imageFilesBody(fields.imageFiles ?? [])),
    section("Context files", contextFilesBody(fields.contextFiles)),
    section(
      "Primary repository",
      `The repository is at ${fields.primaryRepositoryPath}. Read it. You must not change any file in it.`,
    ),
    section("Skills", list(fields.skills, "None.")),
    ...(fields.egress === undefined || fields.egress === null
      ? []
      : [
          section(
            "Network access",
            egressBody(
              fields.egress,
              "When a check or the work needs a host this sandbox does not reach, list the host and the reason under `missingHosts`, " +
                "and freeze no check that needs the host. Factoree then stops the Run and asks a human to allow the host.",
            ),
          ),
        ]),
    section(
      "Proposal",
      `Write one JSON document to ${fields.proposalPath}, and nothing else.\n\n${fields.proposalSchema}`,
    ),
    section(
      "Rules",
      [
        "State the required behaviour, not the defect. \"A failed delivery is never retried\" becomes \"A failed delivery is retried\".",
        "Set `origin` to \"stated\" when the Work Item says the criterion, and set `quote` to the exact sentence it restates.",
        "Set `origin` to \"implied\" for an edge case that one sentence of the Work Item directly implies, and set `quote` to that exact sentence. \"Export the table to CSV\" implies \"the export includes the header row\".",
        "Set `origin` to \"new\" and `quote` to null for a criterion that adds behaviour no sentence implies. Factoree does not build it, and lists it for the human.",
        "Give each criterion the check that proves it: `test` with a test file path, `command` with a shell command, `http` with \"METHOD /path\", or `browser` with a route that starts with \"/\".",
        "A criterion with no automated check does not freeze: Factoree drops it. Use `manual` or `code_review` only when no command, test, HTTP request or page can prove the criterion.",
        "Set `visible` to true when the criterion names a page, a screen or a UI element a user sees. Give a visible criterion the method `browser` and the route of the page, so Factoree captures a screenshot of it.",
        `Propose at most ${String(fields.criteriaLimit)} criteria and at most ${String(fields.questionsLimit)} questions. ` +
          "When the Work Item needs more, keep the criteria the Work Item states, merge related ones, and say in a question that the ticket should be split.",
        "Prefer an existing test or command of the repository. Name the files that show the pattern in `patterns`.",
        "Ask a question only for a decision the Work Item and the code leave open. Give your proposed answer and its reason. Factoree takes your answer without asking a human, and the reviewer reads the reason, so give a reason the code or the Work Item supports.",
        "You must not invent product behaviour the Work Item and the code do not imply.",
        "You must not propose a check that needs a host this sandbox does not reach. Name the host under `missingHosts` instead.",
      ].join("\n"),
    ),
  ].join("\n");

/** SDD section 56. Change this value whenever the correction template below changes. DI-21.66. */
export const REFINER_LIMIT_CORRECTION_VERSION = "refiner-limit-correction@1";

export interface RefinerLimitCorrectionFields {
  /** The criteria count and cap, or null when the criteria are within the cap. */
  criteria: { count: number; limit: number } | null;
  /** The questions count and cap, or null when the questions are within the cap. */
  questions: { count: number; limit: number } | null;
  /** The file the corrected proposal goes to. It is a new file, so a missing write cannot pass. */
  proposalPath: string;
}

/**
 * Issue #39, DI-21.66. The one correction round after a proposal over its caps. It names the
 * caps and the counts only, and asks for the whole proposal again.
 */
export const renderRefinerLimitCorrectionPrompt = (fields: RefinerLimitCorrectionFields): string =>
  [
    "# Proposal correction",
    "",
    "Factoree could not use your proposal, because it holds too many items:",
    "",
    list(
      [
        ...(fields.criteria === null
          ? []
          : [`${String(fields.criteria.count)} criteria. The limit is ${String(fields.criteria.limit)}.`]),
        ...(fields.questions === null
          ? []
          : [`${String(fields.questions.count)} questions. The limit is ${String(fields.questions.limit)}.`]),
      ],
      "No list was over its limit.",
    ),
    "",
    "Keep the criteria the Work Item states. Merge related criteria into one. Drop implied criteria " +
      "before stated ones. When the Work Item still needs more, say in a question that the ticket " +
      "should be split.",
    "",
    `Write the whole corrected proposal, as one JSON document, to ${fields.proposalPath}. Write ` +
      "every list again, not only the lists that changed. Write the file and nothing else. " +
      "Factoree asks for a correction only once.",
  ].join("\n");
