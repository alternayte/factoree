import { describe, expect, it } from "vitest";
import { buildPullRequestBody, buildPullRequestTitle } from "~/domain/publishing/pull-request.js";

const input = {
  workItemTitle: "Add a health endpoint",
  workItemUrl: "https://linear.app/acme/issue/ACME-1",
  runId: "run-1",
  baseSha: "a".repeat(40),
  patchSha256: "b".repeat(64),
  verificationSummary: "Every verification command passed.",
  changedFileCount: 2,
  repairCount: 1,
};

describe("the pull request body (AT-29)", () => {
  it("names the Work Item, the Run identifier, the base SHA, the patch hash, and the verification summary", () => {
    const body = buildPullRequestBody(input);
    expect(body).toContain("https://linear.app/acme/issue/ACME-1");
    expect(body).toContain("run-1");
    expect(body).toContain("a".repeat(40));
    expect(body).toContain("b".repeat(64));
    expect(body).toContain("Every verification command passed.");
  });

  it("states that no Work Item URL exists rather than printing an empty link", () => {
    expect(buildPullRequestBody({ ...input, workItemUrl: null })).toContain("no Work Item URL");
  });

  it("keeps the title short and carries the Work Item title", () => {
    const title = buildPullRequestTitle({ workItemTitle: "x".repeat(300) });
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.startsWith("Factoree: ")).toBe(true);
  });
});
