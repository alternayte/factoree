import { describe, expect, it } from "vitest";
import { createProofPackActivities, type ProofPackActivityDependencies } from "~/activities/evidence.activities.js";
import { OWNED_BLOCK_START } from "~/domain/publishing/pull-request-body.js";
import type { PublishedPullRequest } from "~/domain/pull-requests/pull-request-store.js";

const HEAD = "d".repeat(40);

const storedInput = {
  runId: "run-1",
  workItem: { title: "Show a Configs heading", url: "https://linear.app/t/issue/FAC-21/show" },
  pullRequestUrl: "https://github.com/acme/web/pull/7",
  changeDescription: "The configs page shows a Configs heading.",
  assertions: [{ id: "VAL-1", requirement: "C1", statement: "The page shows Configs.", method: "browser", requiredEvidence: [], result: "PASS", reason: "", evidence: [] }],
  checks: [],
  reviewVerdict: "pass",
  reviewPasses: 1,
  findings: [],
  contextItems: [],
  discoverableItemCount: 0,
  conflicts: [],
  changedFiles: ["src/Configs.tsx"],
  patchByteLength: 10,
  checkPreviewUrl: null,
  baseSha: "b".repeat(40),
  patchSha256: "p".repeat(64),
  commitSha: HEAD,
  repairCount: 0,
  repairLimit: 3,
  visualEvidenceGap: null,
  whereToLook: [{ path: "src/Configs.tsx", startLine: 4, endLine: 9, reason: "The heading." }],
  bodyTargets: [
    {
      repositorySlug: "acme/web",
      pullRequestNumber: 7,
      pullRequestUrl: "https://github.com/acme/web/pull/7",
      githubInstallationId: "42",
      baseSha: "b".repeat(40),
      patchSha256: "p".repeat(64),
      changedFileCount: 1,
      commitSha: HEAD,
    },
  ],
};

const record = (over: Partial<PublishedPullRequest>): PublishedPullRequest =>
  ({
    id: "pr-1",
    tenantId: "t",
    repositoryFullName: "acme/web",
    number: 7,
    url: "https://github.com/acme/web/pull/7",
    headSha: HEAD,
    state: "open",
    originRunId: "run-1",
    verifiedRunId: "run-1",
    verifiedHeadSha: HEAD,
    previewUrl: "https://pr-7.preview.example",
    previewHeadSha: HEAD,
    ...over,
  }) as PublishedPullRequest;

const build = (pullRequest: PublishedPullRequest) => {
  const writes: string[] = [];
  const dependencies = {
    pullRequests: { find: () => Promise.resolve(pullRequest), findByNumber: () => Promise.resolve(pullRequest) },
    runs: { findById: () => Promise.resolve({ productId: "p", proofPackInput: storedInput }) },
    secrets: { list: () => Promise.resolve([]), listNames: () => Promise.resolve([]) },
    redactor: { redactText: (text: string) => text, addSecret: () => undefined },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    pullRequestBodies: {
      body: () => Promise.resolve(`Human note.\n\n${OWNED_BLOCK_START}\nold\n<!-- /factoree:body -->`),
      updateBody: (_slug: string, _number: number, body: string) => {
        writes.push(body);
        return Promise.resolve();
      },
    },
    runPageUrl: (runId: string) => `https://factoree.example/runs/${runId}`,
  } as unknown as ProofPackActivityDependencies;
  return { activities: createProofPackActivities(dependencies), writes };
};

/** docs/specs/pr-body-for-humans.md, DI-21.220. */
describe("the pull request preview link", () => {
  it("writes the body again with Needs your eye linking the preview of the verified head", async () => {
    const { activities, writes } = build(record({}));
    expect(await activities.writePullRequestPreviewBody({ tenantId: "t", pullRequestId: "pr-1" })).toEqual({ written: true });
    const body = writes[0] ?? "";
    expect(body.startsWith("Human note.")).toBe(true);
    expect(body).toContain("### Needs your eye");
    expect(body).toContain("[Open the pull request preview](https://pr-7.preview.example)");
    expect(body).toContain("The heading.");
  });

  it("writes nothing for a preview of an older head, or of a head Factoree did not verify", async () => {
    for (const over of [{ previewHeadSha: "old" }, { headSha: "e".repeat(40), previewHeadSha: "e".repeat(40) }, { previewUrl: null }]) {
      const { activities, writes } = build(record(over));
      expect(await activities.writePullRequestPreviewBody({ tenantId: "t", pullRequestId: "pr-1" })).toEqual({ written: false });
      expect(writes).toEqual([]);
    }
  });
});
