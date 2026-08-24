import type { ValidationEvidenceKind, ValidationMethod } from "~/domain/validation/validation-contract.js";

/** SDD section 36 lists exactly these results. */
export const ASSERTION_RESULTS = ["PASS", "FAIL", "BLOCKED", "MANUAL_REQUIRED"] as const;

export type AssertionResult = (typeof ASSERTION_RESULTS)[number];

/** One artefact SDD section 39 turns into one immutable Evidence row. */
export interface EvidenceArtifact {
  kind: ValidationEvidenceKind;
  /** What produced the artefact, for example `browser:VAL-UI-001:screenshot`. */
  source: string;
  contentType: string;
  bytes: Uint8Array;
  /** Already redacted. Nothing in this object may hold a secret. */
  metadata: Record<string, unknown>;
}

export interface AssertionOutcome {
  assertionId: string;
  method: ValidationMethod;
  result: AssertionResult;
  /** One readable sentence. It reaches Linear, the repair prompt, and the operator log. */
  reason: string;
  artifacts: EvidenceArtifact[];
}

export interface UserValidationOutcome {
  /** True only when every assertion is PASS. SDD section 36. */
  passed: boolean;
  outcomes: AssertionOutcome[];
  summary: string;
  /** The failing assertions, formatted for `ImplementActivityInput.repairFindings`. */
  failures: string[];
}

/**
 * Builds the Run-level result from every assertion outcome. SDD section 36: L3 cannot complete
 * unless every assertion is PASS. An empty outcome list proves nothing, so it is not a pass.
 */
export const summarizeUserValidation = (outcomes: AssertionOutcome[]): UserValidationOutcome => {
  const passed = outcomes.length > 0 && outcomes.every((outcome) => outcome.result === "PASS");

  const failures = outcomes
    .filter((outcome) => outcome.result !== "PASS")
    .map((outcome) => `${outcome.assertionId} (${outcome.result}): ${outcome.reason}`);

  const summary =
    outcomes.length === 0
      ? "User validation produced no outcome."
      : passed
        ? `All ${outcomes.length} assertions passed.`
        : `${failures.length} of ${outcomes.length} assertions did not pass.`;

  return { passed, outcomes, summary, failures };
};
