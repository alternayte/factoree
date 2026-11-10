import type { ActionPolicy } from "~/domain/policy/action-policy.js";
import type { EgressFacts } from "~/domain/runs/egress.js";
import { looksLikeCredentialValue } from "~/domain/security/credential-formats.js";
import { IMPLEMENTER_PROMPT_VERSION, renderImplementerPrompt } from "~/prompts/implementer.js";

export interface BuildImplementerInput {
  goal: string;
  humanDecisions: string[];
  validationContract: string | null;
  contextContract: string | null;
  requiredContext: string[];
  /** docs/specs/external-context-delivery.md. One line per context file of the work sprite. */
  contextFiles?: string[];
  /** docs/specs/work-item-images-and-links.md. One line per image file of the work sprite. */
  imageFiles?: string[];
  primaryRepositoryPath: string;
  referenceRepositoryPaths: string[];
  repositoryInstructions: string;
  skills: string[];
  /** docs/specs/skill-registry.md. True when the Product has a source that takes a skill proposal. */
  skillProposals?: boolean;
  actionPolicy: ActionPolicy;
  repairFindings: string[];
  /** Non-production Project test secrets only. See SDD section 30. */
  projectTestSecrets: Record<string, string>;
  /** docs/specs/implementer-self-check.md. The checks Factoree runs after the implementer finishes. */
  verifyCommands?: Array<{ name: string; run: string }>;
  /** docs/specs/implementer-self-check.md. True when the work sprite holds agent-browser. */
  selfCheck?: boolean;
  /** docs/specs/egress-honesty-and-issue-status.md. The allow list facts, and the result file. */
  egress?: EgressFacts | null;
  resultPath?: string | null;
}

export interface ImplementerInput {
  prompt: string;
  promptVersion: string;
  environment: Record<string, string>;
}

export class ForbiddenImplementerMaterialError extends Error {
  // The message names the key only. A secret value must never reach an error message or a log
  // line.
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

/**
 * The explicit list of credential words. A word in a key matches only as a whole word, never as
 * a stem inside a longer word. A stem test rejected `GITHUB_AUTHOR`, because `author` contains
 * `auth`. The list spells out each variant instead. A bounded list that a reader can audit beats
 * a clever rule that a reader must simulate.
 */
const CREDENTIAL_WORDS = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "key",
  "keys",
  "cred",
  "creds",
  "credential",
  "credentials",
  "auth",
  "oauth",
  "pat",
  "pats",
  "password",
  "passphrase",
  "bearer",
  "apikey",
]);

const isCredentialWord: WordPredicate = (word) => CREDENTIAL_WORDS.has(word);

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
 * GitHub credential under a spelling an exact list would miss. A prefix match on the provider
 * word and a whole-word match on the credential word close that gap without the substring trap:
 * each predicate tests one word at a time, so `reproduction` and `fixture` never join into a
 * string that falsely contains `production`.
 *
 * SDD section 30 forbids a Linear token, a GitHub write credential, a production secret, and a
 * Factoree admin credential. The name check is the secondary guardrail. The value check is the
 * primary control, because a value reveals a credential far more reliably than a key does. Do
 * not add a further name heuristic here. A fused abbreviation such as `GHTOKEN` that holds a
 * real GitHub token is caught by its value. The same name over any other value is not a
 * credential. See the task report for the residual gaps.
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

/**
 * Reports whether a key name matches one of the four SDD section 30 prohibitions. It is exported
 * so the Project secret writer can refuse a misfiled credential when an operator stores it,
 * rather than at the moment a Run needs it.
 */
export const isForbiddenName = (key: string): boolean => {
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

/**
 * The primary control. A value in a known provider credential format is a credential whatever
 * the key is called. This catches the case no name rule can catch, an innocuous key that holds a
 * real token. The formats come from the one shared list in `src/domain/security`.
 */
const isForbiddenValue = (value: string): boolean => looksLikeCredentialValue(value);

/** SDD section 34 assembles the Implementer input and rejects forbidden material with a thrown error. */
/**
 * The one shared credential guard. It rejects a forbidden Project test secret before it reaches
 * either fresh agent session, the Implementer or the User Validator. A caller that skips this
 * guard reopens SDD section 30 for its own session.
 */
export const guardAgainstForbiddenMaterial = (projectTestSecrets: Record<string, string>): void => {
  for (const [key, value] of Object.entries(projectTestSecrets)) {
    if (isForbiddenValue(value)) throw new ForbiddenImplementerMaterialError(key);
    if (isForbiddenName(key)) throw new ForbiddenImplementerMaterialError(key);
  }
};

export const buildImplementerInput = (input: BuildImplementerInput): ImplementerInput => {
  guardAgainstForbiddenMaterial(input.projectTestSecrets);

  return {
    prompt: renderImplementerPrompt({
      goal: input.goal,
      humanDecisions: input.humanDecisions,
      validationContract: input.validationContract,
      contextContract: input.contextContract,
      requiredContext: input.requiredContext,
      contextFiles: input.contextFiles ?? [],
      imageFiles: input.imageFiles ?? [],
      primaryRepositoryPath: input.primaryRepositoryPath,
      referenceRepositoryPaths: input.referenceRepositoryPaths,
      repositoryInstructions: input.repositoryInstructions,
      skills: input.skills,
      skillProposals: input.skillProposals === true,
      verifyCommands: input.verifyCommands ?? [],
      selfCheck: input.selfCheck === true,
      egress: input.egress ?? null,
      resultPath: input.resultPath ?? null,
      actionPolicyLines: input.actionPolicy.describe(),
      repairFindings: input.repairFindings,
    }),
    promptVersion: IMPLEMENTER_PROMPT_VERSION,
    environment: { ...input.projectTestSecrets },
  };
};
