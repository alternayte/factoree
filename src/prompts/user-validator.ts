import type { EgressFacts } from "~/domain/runs/egress.js";
import { imageFilesBody } from "./context-files.js";
import { egressBody } from "./egress.js";

/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const USER_VALIDATOR_PROMPT_VERSION = "user-validator@10";

export interface UserValidatorPromptFields {
  goal: string;
  validationContract: string;
  primaryRepositoryPath: string;
  planPath: string;
  previewBaseUrl: string | null;
  actionPolicy: string[];
  planSchema: string;
  /** docs/specs/repository-setup-and-services.md. The account names a browser entry can sign in as. */
  accounts?: string[];
  /** docs/specs/repository-setup-and-services.md. One line per fake: the API and the service. */
  fakes?: string[];
  /**
   * docs/specs/work-item-images-and-links.md. One line per image file of the check sprite. The
   * images are the author's intent, not an Implementer artefact, so the fresh context may see them.
   */
  imageFiles?: string[];
  /**
   * docs/specs/egress-honesty-and-issue-status.md. The effective allow list of the check sprite and
   * the hosts only the bootstrap reached. Absent in a history recorded before it existed.
   */
  egress?: EgressFacts | null;
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
    section("Images of the Work Item", imageFilesBody(fields.imageFiles ?? [])),
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
            "every HTTP request resolves against this URL. The preview may still be building " +
            "while you write the plan, and it may not answer yet.",
    ),
    section(
      "Accounts and fakes",
      [
        (fields.accounts ?? []).length === 0
          ? "The repository defines no account. A browser entry starts signed out."
          : `A browser entry can start signed in. Set "as" to one of these accounts: ${(fields.accounts ?? []).join(", ")}. ` +
            'Factoree signs the account in before the entry runs. An entry without "as" starts signed out. ' +
            "Never write sign-in steps yourself.",
        (fields.fakes ?? []).length === 0
          ? "No external API is faked."
          : `These external APIs are fakes in the sandbox, so their data is not real:\n${(fields.fakes ?? []).map((line) => `- ${line}`).join("\n")}`,
      ].join("\n\n"),
    ),
    ...(fields.egress === undefined || fields.egress === null
      ? []
      : [
          section(
            "Network access",
            egressBody(
              fields.egress,
              "When a check needs a host this sandbox does not reach, state plainly that you cannot check the assertion, and name the host.",
            ),
          ),
        ]),
    section(
      "What Factoree does",
      [
        "Factoree already ran the verify commands of the repository in this sandbox, and they passed.",
        "Factoree executes every check of your Validation Plan after you write it.",
        "Write the plan from the source and the frozen Validation Contract. A check you run yourself is not evidence.",
      ].join("\n"),
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
        "Select an element by its role, label, text or data-testid, such as `role=button[name=\"Save\"]`, " +
          "`[aria-label=\"Email\"]`, `text=Order saved` or `[data-testid=\"timeline\"]`. Never select by a styling class " +
          "such as `.rounded-full`, `span.text-xs`, `.bg-*` or `[class*=\"badge\"]`: markup classes change on every repair, " +
          "and Factoree rejects a plan that selects by one.",
        "Pick a selector that matches exactly one element. A selector that matches two elements fails the check.",
      ].join("\n"),
    ),
  ].join("\n");

/** SDD section 56. Change this value whenever the correction template below changes. DI-15.23. */
export const USER_VALIDATOR_PLAN_CORRECTION_VERSION = "user-validator-plan-correction@1";

export interface PlanCorrectionPromptFields {
  /** Every reason Factoree rejected the plan for, as the plan rules state it. */
  reasons: string[];
  /** One line per frozen assertion: its identifier, its frozen method and the check it needs. */
  assertions: string[];
  /** The file the corrected plan goes to. It is a new file, so a missing write cannot pass. */
  planPath: string;
}

/**
 * DI-15.23. The one correction round after Factoree rejected the Validation Plan. It names only
 * the rejection reasons and the frozen contract the validator already holds, so it reveals
 * nothing the fresh context of SDD section 36 must not see.
 */
export const renderPlanCorrectionPrompt = (fields: PlanCorrectionPromptFields): string =>
  [
    "# Validation Plan correction",
    "",
    "Factoree rejected the Validation Plan for this Validation Contract, and it ran no check. " +
      "It rejected the plan for these reasons:",
    "",
    list(fields.reasons, "No reason was recorded."),
    "",
    "The frozen method of each assertion is binding. You must not change it, and the plan must " +
      "use the check kind that the method requires:",
    "",
    list(fields.assertions, "The contract holds no assertion."),
    "",
    `Write the full corrected Validation Plan, as one JSON document, to ${fields.planPath}. ` +
      "Write every entry again, not only the entries that changed. Write the file and nothing " +
      "else. Do not answer with the plan in a message. Factoree asks for a correction only once.",
  ].join("\n");

/** SDD section 56. Change this value whenever the re-check template below changes. */
export const USER_VALIDATOR_SELECTOR_RECHECK_VERSION = "user-validator-selector-recheck@1";

export interface SelectorRecheckPromptFields {
  /** One block per browser entry that failed only on its selector. */
  failures: Array<{
    assertionId: string;
    /** The entry as the plan held it, as JSON. */
    entry: string;
    /** The failed step: its number, its action and its selector. */
    step: string;
    /** The readable reason the step failed. */
    error: string;
    /** The final screenshot in this sandbox, or null when the driver captured none. */
    screenshotPath: string | null;
    /** The page HTML in this sandbox, or null when the driver read none. */
    htmlPath: string | null;
  }>;
  /** The file the corrected entries go to. */
  answerPath: string;
}

/**
 * docs/specs/by-eye-criteria-and-selector-recheck.md. The one selector re-check of an attempt. It
 * names only what the browser saw: the failed step, the error, the screenshot and the page HTML.
 * It holds no Implementer output, so the fresh context of SDD section 36 holds.
 */
export const renderSelectorRecheckPrompt = (fields: SelectorRecheckPromptFields): string =>
  [
    "# Selector re-check",
    "",
    "Factoree ran your Validation Plan. These browser entries failed only on a selector, twice, in " +
      "the same sandbox. The page may be correct and the selector wrong.",
    "",
    ...fields.failures.flatMap((failure) => [
      `## ${failure.assertionId}`,
      "",
      `Entry: ${failure.entry}`,
      `Failed step: ${failure.step}`,
      `Error: ${failure.error}`,
      failure.screenshotPath === null ? "Final screenshot: none was captured." : `Final screenshot: ${failure.screenshotPath}`,
      failure.htmlPath === null ? "Page HTML: none was read." : `Page HTML at the failed step: ${failure.htmlPath}`,
      "",
    ]),
    "Read the page HTML and the screenshot. For each entry, find the selector that names the element " +
      "the step means, and that matches exactly one element. Select by role, label, text or data-testid. " +
      "Never select by a styling class.",
    "",
    "You may change only the `selector` fields of each entry. Keep every other field and every step " +
      "exactly as it is: the actions, the paths, the expected texts, the values and the order. Factoree " +
      "compares each corrected entry with the entry that failed and rejects it when anything else changed. " +
      "When the page does not hold the element the step means, keep the entry as it is: that is a real failure.",
    "",
    `Write one JSON document to ${fields.answerPath}: { "entries": [ ...one corrected entry per failed entry... ] }. ` +
      "Write the file and nothing else. Do not write the Validation Plan again: Factoree already ran it. " +
      "Factoree runs each corrected entry once, and asks for a re-check only once.",
  ].join("\n");
