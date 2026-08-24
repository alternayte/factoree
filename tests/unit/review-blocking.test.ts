import { describe, expect, it } from "vitest";
import { decideReview } from "~/domain/review/blocking.js";
import type { ReviewFinding, ReviewReport } from "~/domain/review/review-report.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";

const contract: ValidationContract = {
  version: 1,
  runId: "run-1",
  workItem: "FAC-1",
  goal: "The token check rejects an expired token.",
  assertions: [
    {
      id: "VAL-API-001",
      requirement: "An expired token is rejected.",
      statement: "A request with an expired token answers 401.",
      method: "http",
      evidence: ["request-response"],
      preconditions: [],
    },
  ],
};

const changedFiles = ["src/auth.ts", "tests/unit/auth.test.ts"];

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: "RV-1",
  severity: "high",
  category: "correctness",
  requirement: "VAL-API-001",
  evidence: "src/auth.ts:84",
  description: "The handler returns 200 for an expired token.",
  ...over,
});

const report = (findings: ReviewFinding[], verdict: "pass" | "fail" = "fail"): ReviewReport => ({
  version: 1,
  verdict,
  findings,
});

describe("decideReview", () => {
  it("passes a report with no finding", () => {
    const decision = decideReview({ report: report([], "pass"), contract, changedFiles });
    expect(decision.passed).toBe(true);
    expect(decision.blocking).toEqual([]);
  });

  it("blocks a valid high finding", () => {
    const decision = decideReview({ report: report([finding()]), contract, changedFiles });
    expect(decision.passed).toBe(false);
    expect(decision.blocking).toHaveLength(1);
    expect(decision.failures[0]).toContain("RV-1");
  });

  it("blocks a valid blocker finding", () => {
    const decision = decideReview({
      report: report([finding({ severity: "blocker" })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(false);
  });

  it("does not block a medium finding", () => {
    const decision = decideReview({
      report: report([finding({ severity: "medium" })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(true);
    expect(decision.nonBlocking).toHaveLength(1);
    expect(decision.nonBlocking[0]?.reason).toContain("severity");
  });

  it("does not block a style finding at any severity", () => {
    const decision = decideReview({
      report: report([finding({ category: "style", severity: "blocker" })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(true);
    expect(decision.nonBlocking[0]?.reason).toContain("style");
  });

  it("does not block a finding whose evidence names an unchanged file", () => {
    const decision = decideReview({
      report: report([finding({ evidence: "src/other.ts:12" })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(true);
    expect(decision.nonBlocking[0]?.reason).toContain("changed");
  });

  it("does not block a finding whose VAL requirement names no frozen assertion", () => {
    const decision = decideReview({
      report: report([finding({ requirement: "VAL-API-999" })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(true);
    expect(decision.nonBlocking[0]?.reason).toContain("frozen Validation Contract");
  });

  it("accepts a repository rule as a requirement", () => {
    const decision = decideReview({
      report: report([finding({ requirement: "The repository forbids a bare catch." })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(false);
  });

  it("blocks even when the agent verdict says pass", () => {
    const decision = decideReview({ report: report([finding()], "pass"), contract, changedFiles });
    expect(decision.passed).toBe(false);
  });

  it("passes when the agent verdict says fail and no finding is valid", () => {
    const decision = decideReview({
      report: report([finding({ severity: "low" })], "fail"),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(true);
  });

  it("resolves an evidence path with a leading dot slash", () => {
    const decision = decideReview({
      report: report([finding({ evidence: "./src/auth.ts:84" })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(false);
  });

  it("resolves an evidence path with no line", () => {
    const decision = decideReview({
      report: report([finding({ evidence: "src/auth.ts" })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(false);
  });
});
