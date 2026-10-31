import { describe, expect, it } from "vitest";
import { parseReviewReport, ReviewReportInvalidError } from "~/domain/review/review-report.js";

const finding = {
  id: "RV-1",
  severity: "high",
  category: "correctness",
  requirement: "VAL-API-001",
  evidence: "src/auth.ts:84",
  description: "The handler returns 200 for an expired token.",
};

describe("parseReviewReport", () => {
  it("parses a pass report with no finding", () => {
    const report = parseReviewReport(JSON.stringify({ version: 1, verdict: "pass", changeDescription: "The change adds the health endpoint.", findings: [] }));
    expect(report.verdict).toBe("pass");
    expect(report.findings).toEqual([]);
  });

  it("parses a fail report with one finding", () => {
    const report = parseReviewReport(
      JSON.stringify({ version: 1, verdict: "fail", changeDescription: "The change adds the health endpoint.", findings: [finding] }),
    );
    expect(report.findings[0]?.id).toBe("RV-1");
    expect(report.findings[0]?.severity).toBe("high");
  });

  it("refuses text that is not JSON", () => {
    expect(() => parseReviewReport("not json")).toThrow(ReviewReportInvalidError);
  });

  it("refuses a severity the SDD does not list", () => {
    const bad = { ...finding, severity: "critical" };
    expect(() =>
      parseReviewReport(JSON.stringify({ version: 1, verdict: "fail", changeDescription: "The change adds the health endpoint.", findings: [bad] })),
    ).toThrow(ReviewReportInvalidError);
  });

  it("refuses a category the schema does not list", () => {
    const bad = { ...finding, category: "vibes" };
    expect(() =>
      parseReviewReport(JSON.stringify({ version: 1, verdict: "fail", changeDescription: "The change adds the health endpoint.", findings: [bad] })),
    ).toThrow(ReviewReportInvalidError);
  });

  it("refuses an unknown key", () => {
    const bad = { ...finding, extra: true };
    expect(() =>
      parseReviewReport(JSON.stringify({ version: 1, verdict: "fail", changeDescription: "The change adds the health endpoint.", findings: [bad] })),
    ).toThrow(ReviewReportInvalidError);
  });

  it("refuses two findings that share one identifier", () => {
    expect(() =>
      parseReviewReport(
        JSON.stringify({ version: 1, verdict: "fail", changeDescription: "The change adds the health endpoint.", findings: [finding, finding] }),
      ),
    ).toThrow(/more than one finding/);
  });

  it("refuses an empty description", () => {
    const bad = { ...finding, description: "   " };
    expect(() =>
      parseReviewReport(JSON.stringify({ version: 1, verdict: "fail", changeDescription: "The change adds the health endpoint.", findings: [bad] })),
    ).toThrow(ReviewReportInvalidError);
  });

  it("names the field in the message", () => {
    const bad = { ...finding, evidence: 4 };
    expect(() =>
      parseReviewReport(JSON.stringify({ version: 1, verdict: "fail", changeDescription: "The change adds the health endpoint.", findings: [bad] })),
    ).toThrow(/evidence/);
  });
});
