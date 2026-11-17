import { describe, expect, it } from "vitest";
import { reviewerVerdictOfEvent, type PrReviewFinding } from "~/domain/pull-requests/pr-follow-up.js";
import { decideTriage, parseTriageReport, TriageReportInvalidError } from "~/domain/review/triage-report.js";
import type { PullRequestEvent } from "~/domain/pull-requests/pull-request-event.js";

const reviewer = { appSlug: "review-bot", checkName: "Code review" };

const check = (overrides: Partial<Extract<PullRequestEvent, { kind: "check_run" }>> = {}): PullRequestEvent => ({
  kind: "check_run",
  deliveryId: "github:d-1",
  action: "completed",
  checkRunId: 7,
  name: "Code review",
  appSlug: "review-bot",
  headSha: "head-1",
  status: "completed",
  conclusion: "failure",
  detailsUrl: null,
  ...overrides,
});

/** DI-21.108. Only the product's PR reviewer, pinned to its app, starts a triage, and only on a failure. */
describe("reviewerVerdictOfEvent", () => {
  it("reads a failed, a pending and a passed check of the PR reviewer", () => {
    expect(reviewerVerdictOfEvent(check(), reviewer)).toBe("failed");
    expect(reviewerVerdictOfEvent(check({ status: "in_progress", conclusion: null }), reviewer)).toBe("pending");
    expect(reviewerVerdictOfEvent(check({ conclusion: "success" }), reviewer)).toBe("passed");
    expect(reviewerVerdictOfEvent(check({ conclusion: "neutral" }), reviewer)).toBe("other");
  });

  it("ignores the same check name from another app", () => {
    expect(reviewerVerdictOfEvent(check({ appSlug: "other-bot" }), reviewer)).toBeNull();
  });

  it("pins a commit status to the bot that sent it", () => {
    const status = (senderLogin: string, state: "failure" | "error"): PullRequestEvent => ({
      kind: "commit_status",
      deliveryId: "github:d-2",
      sha: "head-1",
      context: "Code review",
      state,
      targetUrl: null,
      senderLogin,
    });
    expect(reviewerVerdictOfEvent(status("review-bot[bot]", "failure"), reviewer)).toBe("failed");
    expect(reviewerVerdictOfEvent(status("review-bot[bot]", "error"), reviewer)).toBe("other");
    expect(reviewerVerdictOfEvent(status("dana", "failure"), reviewer)).toBeNull();
  });
});

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
