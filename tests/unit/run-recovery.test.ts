import { describe, expect, it } from "vitest";
import { noFollowUpLine, renderFailurePost, renderFollowUpDescription, takesFollowUp } from "~/domain/runs/run-recovery.js";
import { prePublicationFailures, type PrePublicationInput } from "~/domain/runs/completion-invariant.js";

/** The recorded facts of FAC-73: a flaky browser assertion and one scope finding. */
const fac73 = {
  assertions: [
    { key: "VAL-UI-001", attempt: 1, method: "browser", statement: "The /configs page shows Loading configs...", result: "FAIL", reason: "Expected text to be visible." },
    { key: "VAL-UI-001", attempt: 2, method: "browser", statement: "The /configs page shows Loading configs...", result: "PASS", reason: "" },
    { key: "VAL-UI-001", attempt: 3, method: "browser", statement: "The /configs page shows Loading configs...", result: "FAIL", reason: "Expected text to be visible." },
  ],
  findings: [
    {
      attempt: 2,
      key: "RV-1",
      severity: "high",
      category: "scope",
      evidence: "components/layouts/HeaderNav.tsx:82",
      description: "The change edits the navigation, which the issue does not ask for.",
      blocking: true,
      decisionReason: "",
    },
  ],
};

describe("run recovery (docs/specs/run-recovery.md)", () => {
  it("takes a follow-up only after FAILED, FAILED_REVIEW, STALE_BASE or FAILED_CONFIGURATION (DI-21.32)", () => {
    expect(["FAILED", "FAILED_REVIEW", "STALE_BASE", "FAILED_CONFIGURATION"].every(takesFollowUp)).toBe(true);
    expect(["READY_FOR_HUMAN", "CANCELLED", "BLOCKED_ROUTING"].some(takesFollowUp)).toBe(false);
    expect(noFollowUpLine("READY_FOR_HUMAN", "https://github.com/acme/shop/pull/7")).toContain("pull/7");
  });

  it("asks for the repair before the reply after a configuration failure (DI-21.32)", () => {
    const post = renderFailurePost("Factoree could not prepare the sandbox.", fac73, "configuration");
    expect(post).toContain("Repair the configuration or the sandbox, then reply here to start a follow-up run.");
    expect(post).not.toContain("What blocked the run");
  });

  it("posts what blocked the run, newest attempt first, with example replies from the facts", () => {
    const post = renderFailurePost("User validation did not pass, and the repair budget is spent.", fac73);
    const lines = post.split("\n");
    expect(lines[0]).toBe("User validation did not pass, and the repair budget is spent.");
    expect(post.indexOf("Attempt 3: VAL-UI-001 is FAIL")).toBeLessThan(post.indexOf("Attempt 2: review finding RV-1"));
    expect(post).not.toContain("is PASS");
    expect(post).toContain('"Drop VAL-UI-001."');
    expect(post).toContain('"Do not change components/layouts/HeaderNav.tsx."');
  });

  it("gives a follow-up run the reply above everything, the frozen criteria and the last patch", () => {
    const text = renderFollowUpDescription({
      description: "Change Loading... to Loading configs...",
      reply: "Drop VAL-UI-001 and check the text in the source instead.",
      failedRunId: "run-73",
      run: fac73,
      previousPatch: "diff --git a/pages/configs/index.tsx b/pages/configs/index.tsx\n",
    });
    expect(text.indexOf("Change Loading...")).toBeLessThan(text.indexOf("Drop VAL-UI-001 and check"));
    expect(text).toContain("outranks every other sentence");
    expect(text).toContain("- VAL-UI-001: The /configs page shows Loading configs...");
    expect(text).toContain("```diff\ndiff --git a/pages/configs/index.tsx");
  });

  it("accepts an unstable-only validation for a draft pull request and for nothing else", () => {
    const base: PrePublicationInput = {
      workItemReady: true,
      contextContractVersion: "c",
      unresolvedConflict: false,
      validationContractVersion: "v",
      validationContractFrozenAt: "2026-11-04T10:00:00Z",
      implementationStartedAt: "2026-11-04T10:01:00Z",
      validationPassed: false,
      validationUnstableOnly: true,
      verificationPassed: true,
      blockingFindingCount: 0,
      repairCount: 0,
      repairLimit: 2,
    };
    expect(prePublicationFailures({ ...base, draft: true })).toEqual([]);
    expect(prePublicationFailures({ ...base, draft: false })).toEqual(["At least one Validation assertion did not pass."]);
  });
});
