import {
  hashValidationContract,
  renderValidationContract,
  VALIDATION_CONTRACT_VERSION,
  type ValidationAssertion,
  type ValidationContract,
  type ValidationEvidenceKind,
  type ValidationMethod,
} from "./validation-contract.js";

/** One acceptance criterion Refinement proposed, or one a human stated. */
export interface ValidationCriterion {
  id: string;
  statement: string;
  source: string;
  /**
   * docs/specs/refiner-agent.md. The method the gate kept for a refiner criterion. Absent for a
   * stated criterion, which the keyword rules classify.
   */
  method?: ValidationMethod;
  /** The runnable check the refiner named: a command, a test path, "METHOD /path", or a route. */
  target?: string;
}

export interface BuildValidationContractInput {
  runId: string;
  workItem: string;
  goal: string;
  acceptanceCriteria: ValidationCriterion[];
  /**
   * SDD section 9 item 5. A Work Item that states no observable outcome blocks the Run. The
   * workflow asks one focused question, and the human answer arrives here as a stated assertion.
   */
  humanAssertions: string[];
}

export interface BuiltValidationContract {
  contract: ValidationContract;
  sha256: string;
  document: string;
}

/** An explicit HTTP method followed by a path. This is the strongest signal a statement carries. */
const HTTP_CALL = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b\s+\/\S*/;

const containsWord = (statement: string, words: readonly string[]): boolean => {
  const lower = statement.toLowerCase();
  return words.some((word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, "i").test(lower));
};

const HTTP_WORDS = ["endpoint", "http status", "returns 200", "returns 401", "returns 403", "returns 404", "returns 500"] as const;

const BROWSER_WORDS = [
  "page", "screen", "click", "clicks", "button", "reload", "browser", "form", "visible",
  "navigate", "navigates", "signed-in", "sign in", "signs in", "modal", "dialog", "menu",
] as const;

const TEST_WORDS = ["test", "tests", "unit test", "integration test", "test suite", "coverage"] as const;

const COMMAND_WORDS = ["command", "cli", "exit code", "exits with", "build", "lint", "script", "npm run"] as const;

const REVIEW_WORDS = ["code review", "reviewed", "review confirms"] as const;

/**
 * The rule order is the confidence order. Two HTTP signals exist, and they do not carry the same
 * confidence. `HTTP_CALL` names an explicit method and a path. This signal is the strongest a
 * statement carries, and it beats every other signal. `HTTP_WORDS` is weak word evidence, such as
 * "endpoint" or "returns 200". This weak signal must not beat a plainly stated page interaction:
 * when the statement carries a browser word too, the method is `browser`. DI-6.4
 * makes `manual` the default: an unrecognized statement is still observable by a human, and
 * Factoree must not claim an automated proof it cannot produce.
 */
export const methodFor = (statement: string): ValidationMethod => {
  if (HTTP_CALL.test(statement)) return "http";
  if (containsWord(statement, REVIEW_WORDS)) return "code_review";
  if (containsWord(statement, HTTP_WORDS) && !containsWord(statement, BROWSER_WORDS)) return "http";
  if (containsWord(statement, BROWSER_WORDS)) return "browser";
  if (containsWord(statement, TEST_WORDS)) return "test";
  if (containsWord(statement, COMMAND_WORDS)) return "command";
  return "manual";
};

/**
 * SDD section 37 lists the browser evidence kinds, and SDD section 38 fixes what an HTTP
 * assertion records. Each other method names the one artefact that proves it.
 */
const EVIDENCE_FOR: Record<ValidationMethod, readonly ValidationEvidenceKind[]> = {
  browser: ["screenshot", "network", "assertion-log"],
  http: ["request-response"],
  command: ["command-output"],
  test: ["test-report"],
  code_review: ["diff-review"],
  manual: ["human-confirmation"],
};

/** SDD section 24 names an assertion by its kind, for example `VAL-UI-001` and `VAL-API-001`. */
const PREFIX_FOR: Record<ValidationMethod, string> = {
  browser: "UI",
  http: "API",
  command: "CMD",
  test: "TEST",
  code_review: "REV",
  manual: "MAN",
};

const GIVEN = /^given\s+(.+?),\s*(.+)$/i;

/**
 * A statement that starts with "Given X, Y" states the permitted precondition X and the
 * observable behavior Y. SDD section 24 requires both fields, and this split invents neither.
 */
const splitPrecondition = (statement: string): { statement: string; preconditions: string[] } => {
  const match = GIVEN.exec(statement);
  if (match === null) return { statement, preconditions: [] };
  const precondition = match[1] ?? "";
  const behavior = match[2] ?? "";
  if (precondition.trim() === "" || behavior.trim() === "") return { statement, preconditions: [] };
  return { statement: behavior.trim(), preconditions: [precondition.trim()] };
};

const assertionsOf = (criteria: ValidationCriterion[]): ValidationAssertion[] => {
  const counters = new Map<ValidationMethod, number>();
  const assertions: ValidationAssertion[] = [];

  for (const criterion of criteria) {
    const raw = criterion.statement.trim();
    if (raw === "") continue;
    const split = splitPrecondition(raw);
    const method = criterion.method ?? methodFor(split.statement);
    const next = (counters.get(method) ?? 0) + 1;
    counters.set(method, next);
    assertions.push({
      id: `VAL-${PREFIX_FOR[method]}-${String(next).padStart(3, "0")}`,
      requirement: criterion.id,
      // The target reaches the contract text, so the validator and the Reviewer read the check.
      statement: criterion.target === undefined ? split.statement : `${split.statement} Check: ${criterion.target}`,
      method,
      evidence: [...EVIDENCE_FOR[method]],
      preconditions: split.preconditions,
    });
  }

  return assertions;
};

/**
 * SDD section 24. The builder is deterministic, so one input always freezes to one hash. It
 * invents no behavior: every assertion restates one acceptance criterion, and it records that
 * criterion identifier. See DI-6.2.
 */
export const buildValidationContract = (
  input: BuildValidationContractInput,
): BuiltValidationContract => {
  const stated: ValidationCriterion[] = input.humanAssertions
    .map((statement, index) => ({
      id: `AC-H${index + 1}`,
      statement,
      source: "human:decision",
    }))
    .filter((criterion) => criterion.statement.trim() !== "");

  const contract: ValidationContract = {
    version: VALIDATION_CONTRACT_VERSION,
    runId: input.runId,
    workItem: input.workItem,
    goal: input.goal,
    assertions: assertionsOf([...input.acceptanceCriteria, ...stated]),
  };

  return {
    contract,
    sha256: hashValidationContract(contract),
    document: renderValidationContract(contract),
  };
};
