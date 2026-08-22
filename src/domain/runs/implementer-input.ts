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

type WordPredicate = (word: string) => boolean;

const exactly = (target: string): WordPredicate => (word) => word === target;

/** Matches a word by prefix. */
const startsWith = (prefix: string): WordPredicate => (word) => word.startsWith(prefix);

/** Matches a stem anywhere inside one word, so `oauth` matches `auth` and `credentials` matches `cred`. */
const CREDENTIAL_STEMS = ["token", "secret", "key", "cred", "auth", "pat", "pass", "bearer"];
const isCredentialWord: WordPredicate = (word) => CREDENTIAL_STEMS.some((stem) => word.includes(stem));

/**
 * A short prefix such as `gh` also opens ordinary English words, for example `ghost`, `ghetto`,
 * `gherkin`, `ghoul`, and `ghastly`, so a bare two-letter prefix is too broad. A provider word
 * is instead a word that starts with the whole word `github`, which covers `github`,
 * `githubenterprise`, and `githubapp`, or a word that is exactly one of the short abbreviations
 * `gh`, `ghe`, or `ghes`, which is how a real abbreviation appears, standing alone.
 */
const isGithubProviderWord: WordPredicate = (word) =>
  startsWith("github")(word) || word === "gh" || word === "ghe" || word === "ghes";

/**
 * A forbidden rule is a list of word predicates. Every predicate must match at least one word
 * in the key before the rule fires. A rule with one predicate matches on a bare word, for
 * example `admin`. The GitHub rule has two predicates, a provider word and a separate credential
 * word, so a name such as `MY_GITHUB_MIRROR_URL` survives: it carries the provider word but no
 * credential word.
 *
 * A hand-maintained list of exact credential names cannot keep up with ordinary naming variety,
 * for example `GHE_TOKEN`, `GITHUB_OAUTH`, and `GITHUB_MIRROR_CREDENTIALS` all name a real
 * GitHub credential under a spelling an exact list would miss. Prefix matching on the provider
 * word and stem matching on the credential word close that gap without re-introducing the
 * whole-name substring trap: each predicate still tests one word at a time, so `reproduction`
 * and `fixture` are never joined into a string that could falsely contain `production`.
 *
 * SDD section 30 forbids a Linear token, a GitHub write credential, a production secret, and a
 * Factoree admin credential. This is the one list and the one matching rule that enforces it.
 * The check inspects the key only, never the value. See the task report for the reasoning and
 * for the limits this leaves open.
 */
const FORBIDDEN_RULES: readonly WordPredicate[][] = [
  [exactly("linear")],
  [exactly("factoree")],
  [exactly("admin")],
  [exactly("production")],
  [exactly("prod")],
  [isGithubProviderWord, isCredentialWord],
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

const matchesAnyWord = (words: Set<string>, predicate: WordPredicate): boolean =>
  [...words].some((word) => predicate(word));

const isForbiddenName = (key: string): boolean => {
  const words = wordsOf(key);

  // A key whose entire word set is the bare GitHub provider word is ambiguous on its own. A
  // secret literally named GITHUB or GH carries no other context, so it is rejected rather than
  // assumed harmless.
  if (words.size === 1) {
    const [only] = words;
    if (only !== undefined && isGithubProviderWord(only)) return true;
  }

  return FORBIDDEN_RULES.some((rule) => rule.every((predicate) => matchesAnyWord(words, predicate)));
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
