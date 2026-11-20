import { createHash } from "node:crypto";
import type { ValidationPlanEntry } from "~/domain/validation/validation-plan.js";
import type { AssertionOutcome } from "~/domain/validation/validation-result.js";
import type { ValidationAssertionResultRecord } from "~/domain/validation/validation-result-store.js";

/** Sorts object keys, so one entry always gives one hash. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
};

/** docs/specs/check-faults.md. The SHA-256 of one plan entry as it ran. */
export const planEntrySha256Of = (entry: ValidationPlanEntry): string =>
  createHash("sha256").update(JSON.stringify(canonical(entry))).digest("hex");

/** One FAIL of this attempt whose unchanged check passed in an earlier attempt. */
export interface FlippedAssertion {
  assertionId: string;
  /** The earliest attempt where the same plan entry passed. */
  passedAttempt: number;
  /** The reason of the FAIL in this attempt. */
  reason: string;
}

/**
 * docs/specs/check-faults.md, GitHub issue 49. Each assertion that failed in this attempt, the rerun
 * in the same check sprite included, and that passed in an earlier attempt of the run with the same
 * plan entry. The workflow makes it UNSTABLE only when the reviewer of this attempt reports no
 * blocking finding. A row with no entry hash, from an older release, never matches.
 */
export const flippedAssertions = (
  outcomes: readonly AssertionOutcome[],
  entryHashes: ReadonlyMap<string, string>,
  earlier: readonly ValidationAssertionResultRecord[],
  attempt: number,
): FlippedAssertion[] => {
  const flipped: FlippedAssertion[] = [];
  for (const outcome of outcomes) {
    if (outcome.result !== "FAIL") continue;
    const hash = entryHashes.get(outcome.assertionId);
    if (hash === undefined) continue;
    const passed = earlier
      .filter((row) => row.attempt < attempt && row.assertionKey === outcome.assertionId && row.result === "PASS" && row.planEntrySha256 === hash)
      .sort((left, right) => left.attempt - right.attempt)[0];
    if (passed !== undefined) flipped.push({ assertionId: outcome.assertionId, passedAttempt: passed.attempt, reason: outcome.reason });
  }
  return flipped;
};

/** The reason an UNSTABLE flip records: the earlier pass, and the failure of this attempt. */
export const flipReason = (flip: FlippedAssertion, attempt: number): string =>
  `The check passed in attempt ${String(flip.passedAttempt)} and failed in attempt ${String(attempt)} with the same plan entry, ` +
  `while the reviewer passed the change, so Factoree cannot prove it. Attempt ${String(attempt)} said: ${flip.reason}`;
