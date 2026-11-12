import { describe, expect, it } from "vitest";
import { decideDraft, isDraftCommand, renderDraftWarning, type DraftFacts } from "~/domain/runs/run-draft.js";

/** docs/specs/draft-of-failed-run.md. A failed run with a passing review and one failed assertion. */
const failed: DraftFacts = {
  runId: "run-1",
  status: "FAILED",
  failureReason: "VALIDATION_FAILED",
  failureMessage: "VAL-UI-001 failed and the repair budget is spent.",
  pullRequestUrl: null,
  hasPatch: true,
  patchAttempt: 3,
  targetCount: 1,
  assertions: [
    { key: "VAL-UI-001", statement: "The button is blue.", result: "FAIL", reason: "The button is red." },
    { key: "VAL-UI-002", statement: "The page loads.", result: "PASS", reason: "It loads." },
  ],
  findings: [],
  reviewed: true,
};

describe("the draft command", () => {
  it("matches the whole reply, case-insensitive, with whitespace and a final period ignored", () => {
    for (const body of ["publish as draft", "Publish as draft", "  PUBLISH AS DRAFT.  ", "publish as draft .\n"]) {
      expect(isDraftCommand(body)).toBe(true);
    }
  });

  it("never matches a real follow-up reply", () => {
    for (const body of ["fix the button colour", "publish as draft please", "Please publish as draft", "publish as draft!", "publish  as draft", ""]) {
      expect(isDraftCommand(body)).toBe(false);
    }
  });
});

describe("the draft decision", () => {
  it("takes a failed run with a patch, whatever its checks", () => {
    expect(decideDraft(failed)).toEqual({ kind: "qualifies" });
    expect(decideDraft({ ...failed, status: "FAILED_REVIEW", failureReason: "REVIEW_BLOCKING_FINDINGS" })).toEqual({ kind: "qualifies" });
  });

  it("answers a run that already published its draft with its pull request", () => {
    expect(decideDraft({ ...failed, status: "DRAFT_PUBLISHED", pullRequestUrl: "https://github.com/a/b/pull/4" })).toEqual({
      kind: "published",
      pullRequestUrl: "https://github.com/a/b/pull/4",
    });
  });

  it("refuses a run that did not fail, a run with no patch, a change set and a hash mismatch", () => {
    const refusal = (facts: DraftFacts): string => {
      const decision = decideDraft(facts);
      return decision.kind === "refused" ? decision.reason : `not refused: ${decision.kind}`;
    };
    expect(refusal({ ...failed, status: "READY_FOR_HUMAN" })).toContain("A draft is for a failed run.");
    expect(refusal({ ...failed, status: "CANCELLED" })).toContain("A draft is for a failed run.");
    expect(refusal({ ...failed, hasPatch: false, patchAttempt: null })).toContain("has no patch");
    expect(refusal({ ...failed, targetCount: 2 })).toContain("no draft of a change set");
    expect(refusal({ ...failed, failureReason: "PATCH_HASH_MISMATCH" })).toContain("did not reproduce its verified hash");
    expect(refusal({ ...failed, pullRequestUrl: "https://github.com/a/b/pull/2" })).toContain("already opened a pull request");
  });

  it("refuses a patch whose review found a blocker, and takes one with a lesser finding", () => {
    const finding = { key: "RV-1", severity: "blocker", category: "correctness", evidence: "src/a.ts:3", description: "It throws.", blocking: true };
    const decision = decideDraft({ ...failed, findings: [finding] });
    expect(decision.kind).toBe("refused");
    expect(decision.kind === "refused" ? decision.reason : "").toContain("- RV-1 at src/a.ts:3: It throws.");
    expect(decideDraft({ ...failed, findings: [{ ...finding, severity: "high" }] })).toEqual({ kind: "qualifies" });
  });
});

describe("the draft warning block", () => {
  it("starts with the warning, then lists each assertion that did not pass and the review of the patch", () => {
    const finding = { key: "RV-2", severity: "medium", category: "style", evidence: "src/b.ts:9", description: "A long line.", blocking: false };
    expect(renderDraftWarning({ ...failed, findings: [finding] })).toBe(
      [
        "> [!WARNING]",
        "> **Factoree did not prove this change.** The run failed, and a human asked Factoree to publish its last patch as a draft. Only a human marks it ready.",
        ">",
        "> Why the run failed: VAL-UI-001 failed and the repair budget is spent.",
        ">",
        "> Assertions that did not pass:",
        "> - VAL-UI-001 is FAIL: The button is blue. The button is red.",
        ">",
        "> Review of this patch:",
        "> - RV-2 (medium, style) at src/b.ts:9: A long line.",
      ].join("\n"),
    );
  });

  it("says when the patch was not reviewed", () => {
    expect(renderDraftWarning({ ...failed, reviewed: false })).toContain("> - This patch was not reviewed.");
  });
});
