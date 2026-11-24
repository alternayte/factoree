import { describe, expect, it } from "vitest";
import type { PrReviewFinding } from "~/domain/pull-requests/pr-follow-up.js";
import { decideTriage, parseTriageReport, TriageReportInvalidError } from "~/domain/review/triage-report.js";

const finding = (key: string): PrReviewFinding => ({ key, reviewId: 1, commentId: 2, author: "review-bot[bot]", path: "src/a.ts", line: 3, body: "claim" });

/** DI-21.110. A bot finding is a claim: Factoree keeps it only with a defect, a rule and evidence. */
describe("decideTriage", () => {
  it("keeps only a complete keep, and drops a blank keep, a missing finding and a duplicate", () => {
    const findings = [finding("a"), finding("b"), finding("c"), finding("d"), finding("e")];
    const report = parseTriageReport(
      JSON.stringify({
        version: 1,
        findings: [
          { key: "a", decision: "keep", defect: "Null dereference", rule: "SDD §41", evidence: "src/a.ts:3", reason: "" },
          { key: "b", decision: "keep", defect: "Wrong", rule: "", evidence: "src/a.ts:4", reason: "" },
          { key: "c", decision: "drop", defect: "", rule: "", evidence: "", reason: "A style preference." },
          { key: "e", decision: "keep", defect: "x", rule: "y", evidence: "z", reason: "" },
          { key: "e", decision: "drop", defect: "", rule: "", evidence: "", reason: "again" },
          { key: "invented", decision: "keep", defect: "x", rule: "y", evidence: "z", reason: "" },
        ],
      }),
    );
    const decisions = decideTriage(findings, report);
    expect(decisions.map((decision) => [decision.key, decision.kept])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
      ["d", false],
      ["e", false],
    ]);
    expect(decisions[2]?.reason).toBe("A style preference.");
  });

  it("refuses a report with another shape", () => {
    expect(() => parseTriageReport(JSON.stringify({ version: 1, findings: [{ key: "a", decision: "maybe" }] }))).toThrow(TriageReportInvalidError);
  });
});
