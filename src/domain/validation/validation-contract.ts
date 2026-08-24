import { createHash } from "node:crypto";

/** SDD section 24 fixes the document schema version. */
export const VALIDATION_CONTRACT_VERSION = 1 as const;

/** SDD section 24 lists exactly these methods. No other value is allowed. */
export const VALIDATION_METHODS = [
  "command",
  "test",
  "http",
  "browser",
  "code_review",
  "manual",
] as const;

export type ValidationMethod = (typeof VALIDATION_METHODS)[number];

/**
 * SDD section 24 requires each assertion to name its required evidence. SDD section 37 lists the
 * browser evidence kinds, and SDD section 38 lists what an HTTP assertion records. The remaining
 * kinds name the artefact each other method produces. Phase 7 captures these artefacts. Phase 6
 * only requires them.
 */
export const VALIDATION_EVIDENCE_KINDS = [
  "screenshot",
  "video",
  "trace",
  "network",
  "console",
  "assertion-log",
  "request-response",
  "command-output",
  "test-report",
  "diff-review",
  "human-confirmation",
] as const;

export type ValidationEvidenceKind = (typeof VALIDATION_EVIDENCE_KINDS)[number];

/** SDD section 24. One frozen observable assertion. */
export interface ValidationAssertion {
  id: string;
  /** The acceptance criterion this assertion proves. SDD section 24 calls it the requirement. */
  requirement: string;
  statement: string;
  method: ValidationMethod;
  evidence: ValidationEvidenceKind[];
  /** SDD section 24. The state a validator is permitted to establish before the assertion runs. */
  preconditions: string[];
}

/** SDD section 24. The frozen definition of success for one Run. */
export interface ValidationContract {
  version: typeof VALIDATION_CONTRACT_VERSION;
  runId: string;
  /** The Work Item identifier, or the Run identifier when the Work Item has none. */
  workItem: string;
  goal: string;
  assertions: ValidationAssertion[];
}

export class ValidationContractInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationContractInvalidError";
  }
}

const METHODS = new Set<string>(VALIDATION_METHODS);
const EVIDENCE = new Set<string>(VALIDATION_EVIDENCE_KINDS);

export const isValidationMethod = (value: string): value is ValidationMethod => METHODS.has(value);

export const isValidationEvidenceKind = (value: string): value is ValidationEvidenceKind =>
  EVIDENCE.has(value);

const present = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.trim() !== "";

/**
 * SDD section 9 item 5 requires at least one observable success assertion, and SDD section 9 item
 * 9 requires a valid contract before implementation starts. SDD section 24 fixes the required
 * fields. A contract that fails this rule must never freeze.
 */
export const validateValidationContract = (contract: ValidationContract): void => {
  const fail = (message: string): never => {
    throw new ValidationContractInvalidError(message);
  };

  if (!present(contract.goal)) fail("The Validation Contract records no goal.");
  if (!present(contract.workItem)) fail("The Validation Contract names no Work Item.");
  if (contract.assertions.length === 0) {
    fail(
      "The Validation Contract holds no assertion. SDD section 9 requires at least one " +
        "observable success assertion before implementation can start.",
    );
  }

  const seen = new Set<string>();
  for (const assertion of contract.assertions) {
    const name = present(assertion.id) ? assertion.id : "an assertion with no identifier";
    if (!present(assertion.id)) fail("A validation assertion records no identifier.");
    if (!present(assertion.requirement)) {
      fail(`Validation assertion "${name}" records no source requirement.`);
    }
    if (!present(assertion.statement)) {
      fail(`Validation assertion "${name}" records no observable behavior.`);
    }
    if (!isValidationMethod(assertion.method)) {
      fail(`Validation assertion "${name}" records the unknown method "${String(assertion.method)}".`);
    }
    if (assertion.evidence.length === 0) {
      fail(`Validation assertion "${name}" requires no evidence.`);
    }
    for (const kind of assertion.evidence) {
      if (!isValidationEvidenceKind(kind)) {
        fail(`Validation assertion "${name}" requires the unknown evidence kind "${String(kind)}".`);
      }
    }
    if (seen.has(assertion.id)) fail(`Validation assertion "${name}" appears twice.`);
    seen.add(assertion.id);
  }
};

/** A JSON text whose object keys are sorted, so one contract always hashes the same. */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
  return `{${entries.join(",")}}`;
};

/** SDD section 25. The contract is immutable, and the hash is its identity and its version. */
export const hashValidationContract = (contract: ValidationContract): string =>
  createHash("sha256").update(canonical(contract)).digest("hex");

const assertionBlock = (assertion: ValidationAssertion): string[] => [
  `### ${assertion.id}`,
  "",
  `- requirement: ${assertion.requirement}`,
  `- statement: ${assertion.statement}`,
  `- method: ${assertion.method}`,
  `- evidence: ${assertion.evidence.join(", ")}`,
  `- preconditions: ${assertion.preconditions.length === 0 ? "none" : assertion.preconditions.join("; ")}`,
  "",
];

/**
 * The human-readable Validation Contract. It reaches the Implementer prompt, the User Validator
 * of Phase 7, the Reviewer of Phase 8, and the Proof Pack of Phase 10. It holds no credential and
 * no file body.
 */
export const renderValidationContract = (contract: ValidationContract): string =>
  [
    "# Validation Contract",
    "",
    `version: ${contract.version}`,
    `runId: ${contract.runId}`,
    `workItem: ${contract.workItem}`,
    "",
    "## Goal",
    "",
    contract.goal,
    "",
    "## Assertions",
    "",
    ...contract.assertions.flatMap(assertionBlock),
    "## Rule",
    "",
    "This contract is frozen. You must not change it, and you must not weaken an assertion. " +
      "A change to the required behavior needs a human decision and a new contract version.",
    "",
  ].join("\n");
