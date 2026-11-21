import type { EgressFacts } from "~/domain/runs/egress.js";
import { contextFilesBody, imageFilesBody } from "./context-files.js";
import { egressBody } from "./egress.js";
import { targetRepositoriesBody, type TargetRepositoryLine } from "./implementer.js";

/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const REFINER_PROMPT_VERSION = "refiner@14";

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
  /** docs/specs/change-sets.md. Every target of a change set. Absent for a run with one target. */
  targetRepositories?: TargetRepositoryLine[];
  /**
   * docs/specs/change-sets.md, DI-21.138. The other repositories of the product, cloned read-only at
   * their default-branch head. Absent or empty when the run cannot add a target.
   */
  siblingRepositories?: SiblingRepositoryLine[];
  proposalPath: string;
  proposalSchema: string;
  /** Issue #39, DI-21.66. The most criteria the proposal may hold, a Product setting. */
  criteriaLimit: number;
  /** Issue #39. The most questions the proposal may hold. */
  questionsLimit: number;
  skills: string[];
  /** GitHub issue 93, DI-21.190. The proven verify commands of the repository. */
  verifyCommands?: Array<{ name: string; run: string }>;
  /**
   * docs/specs/egress-honesty-and-issue-status.md. The effective allow list of the work sprite and
   * the hosts only the bootstrap reached. Absent in a history recorded before it existed.
   */
  egress?: EgressFacts | null;
}

/** docs/specs/change-sets.md. One repository the refiner reads read-only, at the commit it reads. */
export interface SiblingRepositoryLine extends TargetRepositoryLine {
  commitSha: string;
}

const section = (title: string, body: string): string => `## ${title}\n\n${body}\n`;

/** DI-21.139. The rules of the targets and the edges of a proposal. */
const targetRules = (siblings: SiblingRepositoryLine[], targets: number): string[] => [
  ...(siblings.length === 0
    ? []
    : [
        "When the change also needs a repository under \"Other repositories of the product\", add it under `targets` with its `owner/repo` name, the `file` in it (relative to its root) and the `line` that needs the change, and the `reason`. " +
          "Factoree adds the repository only when that line exists in the clone. Add no repository the change does not need, and leave `targets` empty when the targets are enough.",
      ]),
  ...(siblings.length === 0 && targets < 2
    ? []
    : [
        "When one target calls an interface of another target, add one entry under `edges`: `provider` is the repository whose interface the consumer calls, `consumer` is the repository that calls it, and `file` and `line` cite the call in the consumer. " +
          "Factoree merges each provider before its consumers. Add no edge you cannot cite.",
      ]),
];

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
    fields.targetRepositories !== undefined && fields.targetRepositories.length > 1
      ? section("Target repositories", targetRepositoriesBody(fields.targetRepositories, "Read each one. You must not change any file in them."))
      : section(
          "Primary repository",
          `The repository is at ${fields.primaryRepositoryPath}. Read it. You must not change any file in it.`,
        ),
    ...((fields.siblingRepositories ?? []).length === 0
      ? []
      : [
          section(
            "Other repositories of the product",
            [
              "Each one is a read-only clone at the head of its default branch. Read one only when the change can need it. You must not change any file in them.",
              ...(fields.siblingRepositories ?? []).map((sibling) => `- ${sibling.repository}: ${sibling.path} at ${sibling.commitSha}`),
            ].join("\n"),
          ),
        ]),
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
        "A criterion that a page action starts, such as a click, a fill or a page load, gets `browser`: no HTTP request can press a button. A criterion that needs earlier requests or a wait and no page action, such as \"after POST /orders, GET /orders lists the order once it is confirmed\", gets `http` with the check request; its plan can send the earlier requests first and poll the check.",
        "A criterion with no automated check does not freeze: Factoree drops it. Use `manual` or `code_review` only when no command, test, HTTP request or page can prove the criterion.",
        "Set `visible` to true when the criterion names a page, a screen or a UI element a user sees. Give a visible criterion the method `browser` and the route of the page, so Factoree captures a screenshot of it.",
        "A criterion a person judges by eye, such as \"follows the screenshot\", \"looks like\" or \"is consistent with the brand\", gets the method `manual`, `visible` true, and the route of its page as `target`. " +
          "No automated check can judge a look, and a brittle check burns the repair budget. Factoree does not freeze it: it captures a screenshot of the page and shows it to the human.",
        "When you name an element, name it by its role, label, text or `data-testid`. Never name it by a styling class such as `rounded-full`, `text-xs` or `bg-*`: markup classes change on every repair.",
        `Propose at most ${String(fields.criteriaLimit)} criteria and at most ${String(fields.questionsLimit)} questions. ` +
          "When the Work Item needs more, keep the criteria the Work Item states, merge related ones, and say in a question that the ticket should be split.",
        "Prefer an existing test or command of the repository. Name the files that show the pattern in `patterns`.",
        ...((fields.verifyCommands ?? []).length === 0
          ? []
          : [
              `Factoree runs these verify commands on every attempt, and a failed one fails the attempt: ${(fields.verifyCommands ?? []).map((command) => `${command.name}: \`${command.run}\``).join("; ")}.`,
              "Write no criterion that says only that the build, the lint or the whole test suite passes: the verify commands already prove it.",
              "A `command` check that runs a test tool starts from the verify command that runs it: keep its variables, its filter and its arguments, and add a narrower filter, such as one test class.",
            ]),
        "Ask a question only for a decision the Work Item and the code leave open. Give your proposed answer and its reason. Factoree takes your answer without asking a human, and the reviewer reads the reason, so give a reason the code or the Work Item supports.",
        "You must not invent product behaviour the Work Item and the code do not imply.",
        "You must not propose a check that needs a host this sandbox does not reach. Name the host under `missingHosts` instead.",
        ...targetRules(fields.siblingRepositories ?? [], fields.targetRepositories?.length ?? 1),
        "Leave `targets` and `edges` empty when no rule above asks for them.",
        "When two items under \"Selected context\" state rules that disagree for this change, add one entry under `conflicts`: the `subject`, and for each side the `item` as the Context Contract names it (`owner/repo path`) and a `quote` of 20 to 400 characters copied exactly from that file. " +
          "Factoree checks each quote in the file and asks a human which item governs. Report only a disagreement you can quote from both files. Two files that only mention the same word do not disagree. Leave `conflicts` empty when no items disagree.",
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
