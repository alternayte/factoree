import type { ActionPolicy } from "~/domain/policy/action-policy.js";
import { IMPLEMENTER_PROMPT_VERSION, renderImplementerPrompt } from "~/prompts/implementer.js";

export interface BuildImplementerInput {
  goal: string;
  humanDecisions: string[];
  validationContract: string | null;
  contextContract: string | null;
  requiredContext: string[];
  primaryRepositoryPath: string;
  referenceRepositoryPaths: string[];
  repositoryInstructions: string;
  skills: string[];
  actionPolicy: ActionPolicy;
  repairFindings: string[];
  /** Non-production Project test secrets only. See SDD section 30. */
  projectTestSecrets: Record<string, string>;
}

export interface ImplementerInput {
  prompt: string;
  promptVersion: string;
  environment: Record<string, string>;
}

export class ForbiddenImplementerMaterialError extends Error {
  constructor(readonly key: string) {
    super(
      `The Implementer must not receive "${key}". SDD section 30 forbids Linear tokens, GitHub ` +
        "write credentials, production secrets, and Factoree admin credentials.",
    );
    this.name = "ForbiddenImplementerMaterialError";
  }
}

/**
 * A forbidden rule is a list of word groups. Every group must contribute at least one matching
 * word before the rule fires. A rule with one group of one word matches on that bare word, for
 * example `admin`. A rule with two groups matches only when a word from each group is present,
 * for example `github` together with a credential word, so a name such as `MY_GITHUB_MIRROR_URL`
 * survives because it never pairs `github` with a credential word.
 *
 * SDD section 30 forbids a Linear token, a GitHub write credential, a production secret, and a
 * Factoree admin credential. This is the one list and the one matching rule that enforces it.
 * The check inspects the key only, never the value. See the task report for the reasoning and
 * for the limits this leaves open.
 */
const CREDENTIAL_WORDS = ["token", "key", "secret", "credential", "pat", "password", "auth"];

const FORBIDDEN_RULES: readonly (readonly string[])[][] = [
  [["linear"]],
  [["factoree"]],
  [["admin"]],
  [["production"]],
  [["prod"]],
  [["github", "gh"], CREDENTIAL_WORDS],
];

/** Splits a key into lowercase words, on both a separator and a lowercase-to-uppercase boundary. */
const wordsOf = (key: string): Set<string> =>
  new Set(
    key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 0),
  );

const isForbiddenName = (key: string): boolean => {
  const words = wordsOf(key);
  return FORBIDDEN_RULES.some((rule) => rule.every((group) => group.some((word) => words.has(word))));
};

/** SDD section 34 assembles the Implementer input and rejects forbidden material with a thrown error. */
export const buildImplementerInput = (input: BuildImplementerInput): ImplementerInput => {
  for (const key of Object.keys(input.projectTestSecrets)) {
    if (isForbiddenName(key)) throw new ForbiddenImplementerMaterialError(key);
  }

  return {
    prompt: renderImplementerPrompt({
      goal: input.goal,
      humanDecisions: input.humanDecisions,
      validationContract: input.validationContract,
      contextContract: input.contextContract,
      requiredContext: input.requiredContext,
      primaryRepositoryPath: input.primaryRepositoryPath,
      referenceRepositoryPaths: input.referenceRepositoryPaths,
      repositoryInstructions: input.repositoryInstructions,
      skills: input.skills,
      actionPolicyLines: input.actionPolicy.describe(),
      repairFindings: input.repairFindings,
    }),
    promptVersion: IMPLEMENTER_PROMPT_VERSION,
    environment: { ...input.projectTestSecrets },
  };
};
