import { describe, expect, it } from "vitest";
import { flippedAssertions, planEntrySha256Of } from "~/domain/validation/flip.js";
import type { ValidationPlanEntry } from "~/domain/validation/validation-plan.js";
import type { ValidationAssertionResultRecord } from "~/domain/validation/validation-result-store.js";

// docs/specs/check-faults.md, GitHub issue 49. Only an unchanged check that passed before is a flip:
// a check the validator rewrote proves nothing about the earlier pass.
describe("flippedAssertions", () => {
  const entry: ValidationPlanEntry = { assertionId: "VAL-UI-002", kind: "browser", steps: [{ action: "goto", path: "/" }, { action: "expectText", selector: "#row", text: "processed" }] };
  const changed: ValidationPlanEntry = { ...entry, steps: [{ action: "goto", path: "/" }, { action: "expectText", selector: "#row", text: "sent" }] };
  const row = (attempt: number, result: "PASS" | "FAIL", hash: string | null): ValidationAssertionResultRecord => ({
    id: `r${String(attempt)}`,
    tenantId: "t",
    runId: "run",
    validationAssertionId: "a",
    assertionKey: "VAL-UI-002",
    result,
    reason: "",
    attempt,
    planEntrySha256: hash,
    createdAt: new Date(0),
  });
  const failed = [{ assertionId: "VAL-UI-002", method: "browser" as const, result: "FAIL" as const, reason: "it held pending", artifacts: [] }];

  it("names a FAIL whose same entry passed in an earlier attempt", () => {
    const hashes = new Map([["VAL-UI-002", planEntrySha256Of(entry)]]);
    expect(flippedAssertions(failed, hashes, [row(1, "PASS", planEntrySha256Of(entry))], 3)).toEqual([
      { assertionId: "VAL-UI-002", passedAttempt: 1, reason: "it held pending" },
    ]);
  });

  it("names no flip when the entry changed, or the earlier row holds no hash", () => {
    const hashes = new Map([["VAL-UI-002", planEntrySha256Of(changed)]]);
    expect(flippedAssertions(failed, hashes, [row(1, "PASS", planEntrySha256Of(entry))], 2)).toEqual([]);
    expect(flippedAssertions(failed, new Map([["VAL-UI-002", planEntrySha256Of(entry)]]), [row(1, "PASS", null)], 2)).toEqual([]);
  });
});
