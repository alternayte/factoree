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
 * Forbidden name fragments, tested against a normalized key. Normalization lowercases the key
 * and removes every separator, so `GH-TOKEN`, `gh_token`, and `githubToken` all match `ghtoken`.
 * The check inspects the key only, never the value. See the report for the reasoning and limits.
 */
const FORBIDDEN_NAME_FRAGMENTS = [
  "linear",
  "github",
  "ghtoken",
  "adminapitoken",
  "factoreesecret",
  "production",
];

/** A trailing-underscore prefix in the original brief. The normalized form checks a whole word instead. */
const FORBIDDEN_WORDS = new Set(["prod"]);

const normalize = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

const isForbiddenName = (key: string): boolean => {
  const normalized = normalize(key);
  if (FORBIDDEN_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment))) return true;
  const words = key.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0);
  return words.some((word) => FORBIDDEN_WORDS.has(word));
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
