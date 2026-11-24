import { describe, expect, it } from "vitest";
import { createPullRequestActivities } from "~/activities/pull-request.activities.js";
import type { PublishedPullRequest, PullRequestStore } from "~/domain/pull-requests/pull-request-store.js";
import type { ProductRecord } from "~/domain/products/product-registry.js";
import type { PullRequestReviewPort } from "~/domain/pull-requests/pr-follow-up.js";
import type { DecisionEvent } from "~/domain/pull-requests/pr-follow-up.js";
import type { CheckOnCommit, ReviewThreadOnGitHub } from "~/domain/pull-requests/review-apps.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";

const reject = () => Promise.reject(new Error("not used"));

const check = (name: string, appSlug: string, conclusion: string, id: number): CheckOnCommit => ({
  kind: "check_run",
  id,
  name,
  appSlug,
  creatorLogin: null,
  completed: true,
  conclusion,
  title: `${name} ${conclusion}`,
  summary: null,
  text: null,
  detailsUrl: null,
});

const build = (options: { followUps?: number; saysoConclusion?: string } = {}) => {
  const record: PublishedPullRequest = {
    id: "pr-1",
    tenantId: "tenant-1",
    repositoryId: "repo-1",
    repositoryFullName: "acme/api",
    number: 12,
    url: "https://github.com/acme/api/pull/12",
    headBranch: "factoree/run-1",
    headSha: "head-1",
    baseBranch: "main",
    originRunId: "run-1",
    state: "open",
    mergeCommitSha: null,
    closedAt: null,
    reviewerFollowUps: options.followUps ?? 0,
    contractRevision: 1,
    autoMerge: "off",
    autoMergeReason: null,
    verifiedHeadSha: "head-1",
    autonomyLevel: "L3",
    autoMergeGateBase: null,
    verifiedBaseSha: "base-1",
    verifiedRunId: "run-1",
    reviewerHandledKey: null,
    reviewerFollowUpKeys: [],
    bringCurrentHeadSha: null,
    workflowId: "pr:tenant-1:acme/api#12",
  };
  const said: string[] = [];
  const commented: string[] = [];
  const store = {
    find: () => Promise.resolve({ ...record }),
    originFacts: () =>
      Promise.resolve({
        productId: "product-1",
        githubInstallationId: "42",
        originWorkflowId: "linear:workspace-1:session-1",
        linearAgentSessionId: "session-1",
        linearIssueId: null,
        workItemTitle: "Name the loading state",
        workItemUrl: null,
      }),
    markReviewerHandled: (_tenantId: string, _id: string, key: string) => {
      if (record.reviewerHandledKey === key) return Promise.resolve(false);
      record.reviewerHandledKey = key;
      return Promise.resolve(true);
    },
  } as unknown as PullRequestStore;
  const threads: ReviewThreadOnGitHub[] = [
    { isResolved: false, path: "src/page.tsx", line: 4, comments: [{ commentId: 7, authorLogin: "sayso[bot]", body: "S-1 · blocker", url: null }] },
    {
      isResolved: false,
      path: "src/page.tsx",
      line: 9,
      comments: [
        { commentId: 8, authorLogin: "sayso[bot]", body: "S-2 · nit", url: null },
        { commentId: 9, authorLogin: "factoreetemp[bot]", body: "Factoree triaged this finding and did not act on it.", url: null },
      ],
    },
  ];
  const reviews: PullRequestReviewPort = {
    reviewerFindings: reject,
    review: reject,
    canWrite: reject,
    reply: reject,
    comment: (_slug, _number, body) => {
      commented.push(body);
      return Promise.resolve();
    },
    reviews: () =>
      Promise.resolve([
        { reviewId: 1, authorLogin: "sayso[bot]", authorType: "Bot", state: "COMMENTED", commitSha: "head-0", body: "" },
        { reviewId: 2, authorLogin: "dana", authorType: "User", state: "COMMENTED", commitSha: "head-1", body: "Looks fine." },
      ]),
    checksOnCommit: (_slug, sha) =>
      Promise.resolve(
        sha === "head-1"
          ? [check("sayso", "sayso", options.saysoConclusion ?? "neutral", 1), check("test", "github-actions", "failure", 2), check("lint", "github-actions", "failure", 3)]
          : [check("test", "github-actions", "success", 4), check("lint", "github-actions", "failure", 5)],
      ),
    annotations: (_slug, checkRunId) =>
      Promise.resolve(checkRunId === 1 ? [{ path: "src/api.ts", startLine: 40, level: "failure", title: "S-3 · blocker", message: "The caller passes null." }] : []),
    reviewThreads: () => Promise.resolve(threads),
    jobLog: () => Promise.resolve(null),
    react: reject,
  };
  const activities = createPullRequestActivities({
    pullRequests: store,
    close: { closeOfRecord: reject, afterFailedDeploy: reject },
    logger: createLogger({ level: "error", redactor: new Redactor() }),
    autoMerge: { pullRequest: reject, gate: reject, reviewerVerdict: reject, reviews: reject, enable: reject, disable: reject, behindBy: reject, merge: reject },
    deploys: { contains: reject, previousSuccess: reject },
    products: {
      findById: () =>
        Promise.resolve({
          id: "product-1",
          slug: "web",
          status: "active",
          defaultAutonomy: "L3",
          maxRunMinutes: 60,
          reviewAppDenyList: [],
          automaticFollowUpLimit: 3,
        } as unknown as ProductRecord),
    },
    agentSession: {
      respond: (_sessionId: string, body: string) => {
        said.push(body);
        return Promise.resolve();
      },
    },
    reviews,
    repositories: { listByProduct: () => Promise.resolve([]) },
    workItems: { facts: reject },
    repositoryBaseUrl: () => Promise.resolve("https://github.com"),
    changeSets: {
      changeSetOfPullRequest: () => Promise.resolve(null),
      changeSetOfRun: () => Promise.resolve(null),
      markChangeSetStatus: reject,
      changeSetLock: reject,
      acquireChangeSetLock: reject,
      releaseChangeSetLock: reject,
      recordCheckedHead: reject,
    },
    commitStatuses: { setStatus: reject },
    factoreeAppSlug: () => Promise.resolve("factoreetemp"),
  });
  const plan = (decisions: DecisionEvent[] = []) =>
    activities.planSettledFollowUp({ tenantId: "tenant-1", pullRequestId: "pr-1", decisions, settleKey: "github:check-1" });
  return { plan, said, commented, record };
};

const mention: DecisionEvent = {
  kind: "comment",
  deliveryId: "github:comment-1",
  commentId: 50,
  authorLogin: "dana",
  authorType: "User",
  body: "@factoreetemp rename the prop to label",
  mentions: true,
  url: null,
};

// docs/specs/pr-feedback-loop.md, DI-21.206 to DI-21.210.
describe("planSettledFollowUp", () => {
  it("takes the unanswered threads and annotations of a neutral review app and the CI checks that pass on the base", async () => {
    const { plan } = build();
    const planned = await plan();
    expect(planned.kind).toBe("start");
    if (planned.kind !== "start") return;
    const followUp = planned.input.prFollowUp;
    expect(followUp?.trigger).toBe("automatic");
    expect(followUp?.reviewAppFindings?.map((finding) => finding.key)).toEqual(["comment-7", "annotation-1-0"]);
    expect(followUp?.ciFindings?.map((finding) => finding.name)).toEqual(["test"]);
    expect(followUp?.decisions).toEqual([]);
  });

  it("acts on no finding of a review app whose check passed", async () => {
    const { plan } = build({ saysoConclusion: "success" });
    const planned = await plan();
    expect(planned.kind).toBe("start");
    if (planned.kind !== "start") return;
    expect(planned.input.prFollowUp?.reviewAppFindings).toEqual([]);
    expect(planned.input.prFollowUp?.ciFindings?.map((finding) => finding.name)).toEqual(["test"]);
  });

  it("starts no automatic run at the product limit, and posts Needs your attention once per head", async () => {
    const { plan, said, commented } = build({ followUps: 3 });
    expect(await plan()).toEqual({ kind: "none", reason: "the automatic follow-up limit holds" });
    expect(await plan()).toEqual({ kind: "none", reason: "the limit notice of this head was posted" });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("sayso, test still fail");
    expect(commented).toEqual(said);
  });

  it("starts a run for a human decision at the limit, with the automatic findings of the head", async () => {
    const { plan, said } = build({ followUps: 3 });
    const planned = await plan([mention]);
    expect(planned.kind).toBe("start");
    if (planned.kind !== "start") return;
    expect(planned.input.prFollowUp?.trigger).toBe("human");
    expect(planned.input.prFollowUp?.decisions?.map((decision) => decision.key)).toEqual(["issue-comment-50"]);
    expect(planned.input.prFollowUp?.ciFindings).toHaveLength(1);
    expect(said).toEqual([]);
  });
});
