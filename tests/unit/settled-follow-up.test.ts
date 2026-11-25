import { describe, expect, it } from "vitest";
import { createPullRequestActivities } from "~/activities/pull-request.activities.js";
import type { PublishedPullRequest, PullRequestStore } from "~/domain/pull-requests/pull-request-store.js";
import type { ProductRecord } from "~/domain/products/product-registry.js";
import type { PullRequestReviewPort } from "~/domain/pull-requests/pr-follow-up.js";
import type { DecisionEvent } from "~/domain/pull-requests/pr-follow-up.js";
import type { CheckOnCommit, ReviewThreadOnGitHub } from "~/domain/pull-requests/review-apps.js";
import { unthreadedFindingFingerprintText } from "~/domain/pull-requests/review-apps.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createHash } from "node:crypto";
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

const build = (options: { followUps?: number; saysoConclusion?: string; answered?: string[]; level?: string; ciPasses?: boolean; threadsAnswered?: boolean } = {}) => {
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
    autonomyLevel: options.level ?? "L3",
    autoMergeGateBase: null,
    verifiedBaseSha: "base-1",
    verifiedRunId: "run-1",
    reviewerHandledKey: null,
    reviewerFollowUpKeys: [],
    answeredFindingFingerprints: options.answered ?? [],
    reviewAppNoticeKey: null,
    previewUrl: null,
    previewHeadSha: null,
    bringCurrentHeadSha: null,
    workflowId: "pr:tenant-1:acme/api#12",
  };
  const said: string[] = [];
  const commented: string[] = [];
  const replied: Array<{ commentId: number | null; body: string }> = [];
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
    markReviewAppNotice: (_tenantId: string, _id: string, key: string) => {
      if (record.reviewAppNoticeKey === key) return Promise.resolve(false);
      record.reviewAppNoticeKey = key;
      return Promise.resolve(true);
    },
    addAnsweredFingerprints: (_tenantId: string, _id: string, fingerprints: readonly string[]) => {
      record.answeredFindingFingerprints = [...new Set([...record.answeredFindingFingerprints, ...fingerprints])];
      return Promise.resolve();
    },
  } as unknown as PullRequestStore;
  const threads: ReviewThreadOnGitHub[] = [
    {
      isResolved: false,
      path: "src/page.tsx",
      line: 4,
      comments: [
        { commentId: 7, authorLogin: "sayso[bot]", body: "S-1 · blocker", url: null },
        ...(options.threadsAnswered === true ? [{ commentId: 10, authorLogin: "factoreetemp[bot]", body: "Factoree triaged this finding and did not act on it.", url: null }] : []),
      ],
    },
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
    review: reject,
    canWrite: reject,
    reply: (_slug, _number, finding, body) => {
      replied.push({ commentId: finding.commentId, body });
      return Promise.resolve();
    },
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
          ? [
              check("sayso", "sayso", options.saysoConclusion ?? "neutral", 1),
              check("test", "github-actions", options.ciPasses === true ? "success" : "failure", 2),
              check("lint", "github-actions", "failure", 3),
            ]
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
    autoMerge: { pullRequest: reject, gate: reject, reviews: reject, enable: reject, disable: reject, behindBy: reject, merge: reject },
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
  return { plan, said, commented, replied, record, activities };
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

  // DI-21.214. An answered annotation starts nothing until its text changes.
  it("skips an annotation whose fingerprint Factoree answered", async () => {
    const answered = createHash("sha256")
      .update(unthreadedFindingFingerprintText({ appSlug: "sayso", path: "src/api.ts", line: 40, body: "S-3 · blocker:  The caller passes null." }))
      .digest("hex");
    const { plan } = build({ answered: [answered] });
    const planned = await plan();
    expect(planned.kind).toBe("start");
    if (planned.kind !== "start") return;
    expect(planned.input.prFollowUp?.reviewAppFindings?.map((finding) => finding.key)).toEqual(["comment-7"]);
  });

  // DI-21.212. A settled L4 head that a review app holds back, with nothing left to act on, needs a human.
  it("names the holding review app once per head when an L4 head leaves nothing to act on", async () => {
    const answered = createHash("sha256")
      .update(unthreadedFindingFingerprintText({ appSlug: "sayso", path: "src/api.ts", line: 40, body: "S-3 · blocker: The caller passes null." }))
      .digest("hex");
    const { plan, said, commented } = build({ answered: [answered], level: "L4", ciPasses: true, threadsAnswered: true });
    expect(await plan()).toEqual({ kind: "none", reason: "nothing to act on" });
    expect(await plan()).toEqual({ kind: "none", reason: "nothing to act on" });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("The check of the review app sayso did not pass");
    expect(commented).toEqual(said);
  });
});

// docs/specs/pr-feedback-loop.md, DI-21.215 and DI-21.216. The replies a PR follow-up run sends on GitHub.
describe("the replies of a PR follow-up run", () => {
  const finding = (key: string, commentId: number | null, fingerprint?: string) => ({
    key,
    reviewId: 1,
    commentId,
    author: "sayso[bot]",
    path: "src/api.ts",
    line: 40,
    body: "S-3 · blocker. The caller passes null.",
    ...(fingerprint === undefined ? {} : { fingerprint }),
  });
  const decision = (key: string, commentId: number | null, source: "github" | "linear" = "github") => ({
    key,
    source,
    author: "dana",
    body: "@factoreetemp rename the prop to label",
    path: commentId === null ? null : "src/page.tsx",
    line: commentId === null ? null : 4,
    commentId,
    url: null,
  });

  it("replies Fixed to a kept thread finding, Done to a decision in a thread, and lists the rest in one comment", async () => {
    const { activities, replied, commented, record } = build();
    await activities.answerHandledThreads({
      tenantId: "tenant-1",
      pullRequestId: "pr-1",
      commitSha: "c".repeat(40),
      kept: [
        { finding: finding("comment-7", 7), defect: "The caller passes null to the parser." },
        { finding: finding("annotation-1", null, "f".repeat(64)), defect: "The handler drops the error." },
      ],
      decisions: [decision("review-comment-12", 12), decision("comment-50", null), decision("linear-1", null, "linear")],
    });
    expect(replied).toEqual([
      { commentId: 7, body: `Fixed in ${"c".repeat(12)}: The caller passes null to the parser.` },
      { commentId: 12, body: `Done in ${"c".repeat(12)}.` },
    ]);
    expect(commented).toHaveLength(1);
    expect(commented[0]).toContain(`Factoree pushed ${"c".repeat(12)}, which handles:`);
    expect(commented[0]).toContain("- Fixed: sayso[bot] at src/api.ts:40: The handler drops the error.");
    expect(commented[0]).toContain("- Done: dana in the pull request conversation: @factoreetemp rename the prop to label");
    expect(commented[0]).not.toContain("Linear");
    expect(record.answeredFindingFingerprints).toEqual(["f".repeat(64)]);
  });

  it("answers a question in its thread, quotes a conversation question, and leaves a Linear question to the session", async () => {
    const { activities, replied, commented } = build();
    await activities.answerHumanDecisions({
      tenantId: "tenant-1",
      pullRequestId: "pr-1",
      answers: [
        { decision: { ...decision("review-comment-12", 12), body: "why does this skip the cache?" }, answer: "A signed-in user skips it, see src/cache.ts:12." },
        { decision: { ...decision("comment-50", null), body: "why the new prop?" }, answer: "The page reads it, see src/page.tsx:4." },
        { decision: { ...decision("linear-1", null, "linear"), body: "why?" }, answer: "Because." },
      ],
    });
    expect(replied.map((entry) => entry.commentId)).toEqual([12]);
    expect(replied[0]?.body).toContain("A signed-in user skips it, see src/cache.ts:12.");
    expect(replied[0]?.body).toContain("Factoree answered this question and changed nothing.");
    expect(commented).toHaveLength(1);
    expect(commented[0]?.startsWith("> dana: why the new prop?")).toBe(true);
  });
});
