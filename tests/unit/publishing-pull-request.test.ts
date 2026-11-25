import { describe, expect, it } from "vitest";
import { buildPullRequestBody, buildPullRequestTitle } from "~/domain/publishing/pull-request.js";
import {
  issueKeyOf,
  keptPartsOf,
  OWNED_BLOCK_END,
  OWNED_BLOCK_START,
  renderOwnedBlock,
  withOwnedBlock,
  type PullRequestBodyFacts,
} from "~/domain/publishing/pull-request-body.js";
import { guideOfChangedFiles } from "~/domain/review/review-report.js";

const facts = (over: Partial<PullRequestBodyFacts> = {}): PullRequestBodyFacts => ({
  workItemTitle: "Add a health endpoint",
  workItemUrl: "https://linear.app/acme/issue/ACME-1/add-a-health-endpoint",
  runId: "run-1",
  baseSha: "a".repeat(40),
  patchSha256: "b".repeat(64),
  changedFileCount: 2,
  repairCount: 1,
  contractRevision: 1,
  verification: ["Every verification command passed."],
  summary: "The API answers GET /health with 200 and the build version, so the load balancer can probe it.",
  whereToLook: [
    { path: "src/health.ts", startLine: 3, endLine: 18, reason: "The handler and its version read." },
    { path: "tests/health.test.ts", startLine: null, endLine: null, reason: "The test of the handler." },
  ],
  linkTarget: { repositoryUrl: "https://github.com/acme/app", commitSha: "c".repeat(40) },
  proof: {
    criteria: [{ statement: "GET /health answers 200.", result: "PASS", reason: "", evidence: [{ label: "http log", url: "https://files.example/log" }] }],
    implied: [],
    notBuilt: ["a readiness endpoint"],
    forYourEye: [],
    notProven: [],
    sinceLastCommit: null,
    proofPackUrl: "https://factoree.example/runs/run-1",
  },
  ...over,
});

describe("the pull request body (AT-29, docs/specs/pr-body-for-humans.md)", () => {
  it("keeps the AT-29 fields in the run metadata", () => {
    const body = buildPullRequestBody(facts());
    for (const expected of ["https://linear.app/acme/issue/ACME-1", "run-1", "a".repeat(40), "b".repeat(64), "Every verification command passed."]) {
      expect(body).toContain(expected);
    }
    expect(body.indexOf("<summary>Run metadata</summary>")).toBeGreaterThan(body.indexOf("### What Factoree did not prove"));
  });

  it("puts the summary and the guide first, in the reviewer's order, with line links", () => {
    const body = renderOwnedBlock(facts());
    expect(body.startsWith(OWNED_BLOCK_START)).toBe(true);
    expect(body.endsWith(OWNED_BLOCK_END)).toBe(true);
    const order = ["### Summary", "### Where to look", "### What was asked", "### What Factoree did not prove", "Fixes ACME-1"].map((heading) => body.indexOf(heading));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain(`https://github.com/acme/app/blob/${"c".repeat(40)}/src/health.ts#L3-L18`);
    expect(body.indexOf("src/health.ts")).toBeLessThan(body.indexOf("tests/health.test.ts"));
    expect(body).toContain("It is a guide, not evidence.");
    expect(body).toContain("- a readiness endpoint");
    expect(body).toContain("Nothing.");
  });

  it("leaves out an empty section, but always states what Factoree did not prove", () => {
    const body = renderOwnedBlock(facts({ summary: "", whereToLook: [] }));
    expect(body).not.toContain("### Summary");
    expect(body).not.toContain("### Where to look");
    expect(body).not.toContain("### Needs your eye");
    expect(body).toContain("### What Factoree did not prove");
  });

  it("states that no Work Item URL exists rather than printing an empty link", () => {
    expect(buildPullRequestBody(facts({ workItemUrl: null }))).toContain("no Work Item URL");
  });
});

describe("the owned block (DI-21.217)", () => {
  it("replaces only the owned block and keeps a human's text outside it", () => {
    const first = `Human note above.\n\n${renderOwnedBlock(facts({ repairCount: 0 }))}\n\nHuman note below.`;
    const next = withOwnedBlock(first, renderOwnedBlock(facts({ repairCount: 3 })));
    expect(next.startsWith("Human note above.")).toBe(true);
    expect(next.endsWith("Human note below.")).toBe(true);
    expect(next).toContain("Repair count: 3");
    expect(next).not.toContain("Repair count: 0");
  });

  it("puts the block above a body with no markers and keeps the old text", () => {
    const next = withOwnedBlock("## Factoree change\n\nRun ID: old", renderOwnedBlock(facts()));
    expect(next.startsWith(OWNED_BLOCK_START)).toBe(true);
    expect(next).toContain("Run ID: old");
  });

  it("keeps the draft warning and the change set section that the publication wrote", () => {
    const block = renderOwnedBlock(
      facts({ draftWarning: "> [!WARNING]\n> **Factoree did not prove this change.**", changeSet: ["### Change set", "", "Merge order: 1. acme/api"] }),
    );
    const kept = keptPartsOf(`intro\n${block}`);
    expect(kept.draftWarning).toBe("> [!WARNING]\n> **Factoree did not prove this change.**");
    expect(kept.changeSet).toEqual(["### Change set", "", "Merge order: 1. acme/api"]);
    expect(keptPartsOf(renderOwnedBlock(facts()))).toEqual({ draftWarning: null, changeSet: null });
  });
});

describe("the title and the guide (DI-21.218, DI-21.219)", () => {
  it("names the work item and its Linear key, with no prefix, in at most 120 characters", () => {
    expect(buildPullRequestTitle({ workItemTitle: "name what the configs page is loading", workItemUrl: "https://linear.app/t/issue/FAC-73/name" })).toBe(
      "name what the configs page is loading (FAC-73)",
    );
    const long = buildPullRequestTitle({ workItemTitle: "x".repeat(300), workItemUrl: "https://linear.app/t/issue/FAC-73" });
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith(" (FAC-73)")).toBe(true);
    expect(issueKeyOf(null)).toBeNull();
  });

  it("drops a guide entry whose path the change did not touch", () => {
    const guide = guideOfChangedFiles(
      [
        { path: "./src/a.ts", startLine: 9, endLine: 2, reason: "core" },
        { path: "src/untouched.ts", startLine: null, endLine: null, reason: "not changed" },
      ],
      ["src/a.ts"],
    );
    expect(guide).toEqual([{ path: "src/a.ts", startLine: 9, endLine: null, reason: "core" }]);
  });
});
