import { describe, expect, it } from "vitest";
import { buildReviewerInput } from "~/domain/review/reviewer-input.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";

const base = {
  goal: "Reject an expired token.",
  validationContract: "# Validation Contract\n\nVAL-API-001 answers 401.\n",
  contextContract: "# Context Contract\n\nADR-4 is authoritative.\n",
  constraints: ["Do not change the public route table."],
  sourceDiff: "diff --git a/src/auth.ts b/src/auth.ts\n+const ok = true;\n",
  diffTruncated: false,
  changedFiles: ["src/auth.ts"],
  verificationSummary: "Every configured check passed.",
  validationEvidence: ["VAL-API-001: PASS. The response status was 401."],
  repositoryInstructions: "Use the shared logger.",
  reportPath: "/workspace/review/report.json",
  actionPolicy: buildActionPolicy({ role: "reviewer" }),
  projectTestSecrets: {},
};

describe("buildReviewerInput", () => {
  it("carries every SDD section 40 input", () => {
    const built = buildReviewerInput(base);
    expect(built.prompt).toContain("Reject an expired token.");
    expect(built.prompt).toContain("VAL-API-001 answers 401.");
    expect(built.prompt).toContain("ADR-4 is authoritative.");
    expect(built.prompt).toContain("Do not change the public route table.");
    expect(built.prompt).toContain("diff --git a/src/auth.ts");
    expect(built.prompt).toContain("src/auth.ts");
    expect(built.prompt).toContain("Every configured check passed.");
    expect(built.prompt).toContain("The response status was 401.");
    expect(built.prompt).toContain("Use the shared logger.");
    expect(built.prompt).toContain("/workspace/review/report.json");
  });

  it("states plainly that the session is fresh", () => {
    expect(buildReviewerInput(base).prompt).toContain("fresh context");
  });

  it("states plainly that the diff was truncated", () => {
    const built = buildReviewerInput({ ...base, diffTruncated: true });
    expect(built.prompt).toContain("Factoree truncated");
  });

  it("denies the primary worktree write in the described policy", () => {
    expect(buildReviewerInput(base).prompt).toContain("deny: write the primary worktree");
  });

  it("carries the prompt version", () => {
    expect(buildReviewerInput(base).promptVersion).toBe("reviewer@2");
  });

  it("refuses a forbidden credential in the environment", () => {
    expect(() =>
      buildReviewerInput({
        ...base,
        projectTestSecrets: { GITHUB_TOKEN: "ghp_realtokenvalue00000000000000000000" },
      }),
    ).toThrow();
  });
});
