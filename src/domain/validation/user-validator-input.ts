import type { ActionPolicy } from "~/domain/policy/action-policy.js";
import { guardAgainstForbiddenMaterial } from "~/domain/runs/implementer-input.js";
import { USER_VALIDATOR_PROMPT_VERSION, renderUserValidatorPrompt } from "~/prompts/user-validator.js";

export interface BuildUserValidatorInput {
  goal: string;
  validationContract: string;
  primaryRepositoryPath: string;
  planPath: string;
  previewBaseUrl: string | null;
  actionPolicy: ActionPolicy;
  /** Non-production Project test secrets only. See SDD section 30. */
  projectTestSecrets: Record<string, string>;
}

export interface UserValidatorInput {
  prompt: string;
  promptVersion: string;
  environment: Record<string, string>;
}

/** Describes the JSON shape `renderUserValidatorPrompt` asks the validator to write. */
const PLAN_SCHEMA = [
  'The document is one JSON object: { "version": 1, "entries": [...] }.',
  "Each entry names the assertionId of one Validation Contract assertion, and one kind: " +
    '"http", "browser", or "command".',
  'An "http" entry carries a request: { method, path, headers, body, expectStatus, ' +
    "expectBodyContains }.",
  'A "browser" entry carries steps, each one of: goto, click, fill, reload, expectText, ' +
    "expectVisible, or screenshot.",
  'A "command" entry carries a command: { run, expectExitCode }.',
  "Cover every automated assertion of the Validation Contract with exactly one entry.",
].join("\n");

/**
 * SDD section 34 mirrors this builder for the User Validator. It assembles the fresh-context
 * prompt and rejects forbidden material through the one shared guard.
 */
export const buildUserValidatorInput = (input: BuildUserValidatorInput): UserValidatorInput => {
  guardAgainstForbiddenMaterial(input.projectTestSecrets);

  return {
    prompt: renderUserValidatorPrompt({
      goal: input.goal,
      validationContract: input.validationContract,
      primaryRepositoryPath: input.primaryRepositoryPath,
      planPath: input.planPath,
      previewBaseUrl: input.previewBaseUrl,
      actionPolicy: input.actionPolicy.describe(),
      planSchema: PLAN_SCHEMA,
    }),
    promptVersion: USER_VALIDATOR_PROMPT_VERSION,
    environment: { ...input.projectTestSecrets },
  };
};
