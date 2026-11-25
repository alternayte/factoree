import { describe, expect, it } from "vitest";
import { createPullRequestActivities } from "~/activities/pull-request.activities.js";
import type { AutoMergeGate, AutoMergePort, MergeMethod, PullRequestOnGitHub } from "~/domain/pull-requests/auto-merge.js";
import type { AutoMergeUpdate, PublishedPullRequest, PullRequestStore } from "~/domain/pull-requests/pull-request-store.js";
import type { ProductRecord } from "~/domain/products/product-registry.js";
import type { ChangeSet } from "~/domain/pull-requests/change-set-status.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";

const reject = () => Promise.reject(new Error("not used"));

const build = (
  options: {
    gate?: AutoMergeGate;
    github?: Partial<PullRequestOnGitHub>;
    autoMerge?: PublishedPullRequest["autoMerge"];
    behindBy?: number;
    /** docs/specs/change-sets.md. The state of the provider pull request of a set where this one is the consumer. */
    provider?: PublishedPullRequest["state"];
    /** docs/specs/pr-feedback-loop.md, DI-21.212. The conclusion of the review app sayso's check on the head, or none. */
    sayso?: string | null;
  } = {},
) => {
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
    reviewerFollowUps: 0,
    contractRevision: 1,
    autoMerge: options.autoMerge ?? "off",
    autoMergeReason: null,
    verifiedHeadSha: "head-1",
    autonomyLevel: "L4",
    autoMergeGateBase: null,
    verifiedBaseSha: "base-1",
    verifiedRunId: "run-1",
    reviewerHandledKey: null,
    reviewerFollowUpKeys: [],
    answeredFindingFingerprints: [],
    reviewAppNoticeKey: null,
    previewUrl: null,
    previewHeadSha: null,
    bringCurrentHeadSha: null,
    workflowId: "pr:tenant-1:acme/api#12",
  };
  const github: PullRequestOnGitHub = {
    nodeId: "PR_1",
    headSha: "head-1",
    open: true,
    draft: false,
    mergeableState: "blocked",
    mergeable: true,
    autoMergeEnabled: false,
    baseBranch: "main",
    ...options.github,
  };
  const calls: string[] = [];
  const said: string[] = [];
  const counted: string[] = [];
  const store: PullRequestStore = {
    recordPublished: reject,
    listOpenByAgentSession: reject,
    findByNumber: reject,
    findByCommit: reject,
    recordEvent: reject,
    markClosed: reject,
    listAutoMergeUnavailable: reject,
    originFacts: reject,
    markReviewerHandled: reject,
    addAnsweredFingerprints: reject,
    markReviewAppNotice: reject,
    countReviewerFollowUp: (_tenantId: string, _id: string, key: string) => {
      counted.push(key);
      record.reviewerFollowUps += 1;
      record.reviewerFollowUpKeys = [...record.reviewerFollowUpKeys, key];
      return Promise.resolve(record.reviewerFollowUps);
    },
    markBringCurrentTried: reject,
    listOpenByBase: reject,
    listEvents: reject,
    listMergedForDeploy: reject,
    listDeploys: reject,
    recordDeploy: reject,
    setDeployIssueMove: reject,
    openDeployFailure: reject,
    markDeployFollowedUp: reject,
    find: () => Promise.resolve({ ...record }),
    steeringFacts: () => Promise.resolve({ productId: "product-1", githubInstallationId: "42", linearAgentSessionId: "session-1" }),
    setAutoMerge: (_tenantId: string, _id: string, update: AutoMergeUpdate) => {
      const before = { ...record };
      record.autoMerge = update.state;
      record.autoMergeReason = update.reason;
      if (update.gateBase !== undefined) record.autoMergeGateBase = update.gateBase;
      return Promise.resolve(before);
    },
  };
  const port: AutoMergePort = {
    pullRequest: () => Promise.resolve({ ...github }),
    gate: () =>
      Promise.resolve(
        options.gate ?? {
          settings: { allowAutoMerge: true, allowSquash: true, allowMergeCommit: true, allowRebase: false },
          baseRequirements: ["pull_request"],
          requiresUpToDate: false,
        },
      ),
    reviews: () => Promise.resolve([]),
    enable: (_slug: string, pullRequest: PullRequestOnGitHub, method: MergeMethod) => {
      calls.push(`enable ${pullRequest.headSha} ${method}`);
      github.autoMergeEnabled = true;
      return Promise.resolve({ kind: "enabled" });
    },
    disable: () => {
      calls.push("disable");
      github.autoMergeEnabled = false;
      return Promise.resolve();
    },
    behindBy: () => Promise.resolve(options.behindBy ?? 0),
    merge: (_slug: string, _number: number, sha: string, method: MergeMethod) => {
      calls.push(`merge ${sha} ${method}`);
      return Promise.resolve({ kind: "merged" });
    },
  };
  // docs/specs/change-sets.md, DI-21.157. With `provider`, this pull request consumes one provider pull request.
  const changeSet: ChangeSet | null =
    options.provider === undefined
      ? null
      : {
          originRunId: "run-1",
          targets: ["acme/api", "acme/core"],
          members: [
            { repositoryId: "repo-1", repositoryFullName: "acme/api", githubInstallationId: "1", number: 12, url: record.url, workflowId: record.workflowId, record, statusKey: null },
            {
              repositoryId: "repo-2",
              repositoryFullName: "acme/core",
              githubInstallationId: "1",
              number: 3,
              url: "https://github.com/acme/core/pull/3",
              workflowId: "pr:tenant-1:acme/core#3",
              record: { ...record, id: "pr-2", repositoryId: "repo-2", repositoryFullName: "acme/core", number: 3, state: options.provider },
              statusKey: null,
            },
          ],
          edges: [{ provider: "acme/core", consumer: "acme/api" }],
        };
  const activities = createPullRequestActivities({
    pullRequests: store,
    close: { closeOfRecord: reject, afterFailedDeploy: reject },
    logger: createLogger({ level: "error", redactor: new Redactor() }),
    autoMerge: port,
    deploys: { contains: reject, previousSuccess: reject },
    products: { findById: () => Promise.resolve({ reviewAppDenyList: [], automaticFollowUpLimit: 3 } as unknown as ProductRecord) },
    agentSession: {
      respond: (_sessionId: string, body: string) => {
        said.push(body);
        return Promise.resolve();
      },
    },
    reviews: {
      review: reject,
      canWrite: reject,
      reply: reject,
      comment: reject,
      reviews: () =>
        Promise.resolve(
          options.sayso === undefined ? [] : [{ reviewId: 1, authorLogin: "sayso[bot]", authorType: "Bot", state: "COMMENTED", commitSha: "head-1", body: "" }],
        ),
      checksOnCommit: () =>
        Promise.resolve(
          options.sayso === undefined || options.sayso === null
            ? []
            : [
                {
                  kind: "check_run" as const,
                  id: 1,
                  name: "sayso",
                  appSlug: "sayso",
                  creatorLogin: null,
                  completed: true,
                  conclusion: options.sayso,
                  title: null,
                  summary: null,
                  text: null,
                  detailsUrl: null,
                },
              ],
        ),
      annotations: reject,
      reviewThreads: () => Promise.resolve([]),
      jobLog: reject,
      react: reject,
    },
    repositories: { listByProduct: reject },
    workItems: { facts: reject },
    repositoryBaseUrl: () => Promise.resolve("https://github.com"),
    // docs/specs/change-sets.md. The pull request belongs to no change set.
    changeSets: {
      changeSetOfPullRequest: () => Promise.resolve(changeSet),
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
  const steer = (trigger: "start" | "new_head" | "auto_merge_disabled" | "event" | "base_moved", eventHeadSha: string | null = null) =>
    activities.steerAutoMerge({ tenantId: "tenant-1", pullRequestId: "pr-1", trigger, eventHeadSha });
  return { steer, record, github, calls, said, counted, activities };
};

/** docs/specs/pr-review-merge-and-deploy.md, D5, DI-21.104 to DI-21.106. */
describe("steerAutoMerge", () => {
  it("turns on auto-merge with squash, pinned to the verified head, and says so once", async () => {
    const { steer, calls, said, record } = build();
    expect(await steer("start")).toEqual({ state: "enabled" });
    expect(await steer("event")).toEqual({ state: "enabled" });
    expect(calls).toEqual(["enable head-1 squash"]);
    expect(said).toHaveLength(1);
    expect(record.autoMergeGateBase).toBe("main");
  });

  // docs/specs/pr-feedback-loop.md, DI-21.212.
  it("turns on no auto-merge while a review app's check on the verified head is not success, and names the app", async () => {
    const neutral = build({ sayso: "neutral" });
    expect(await neutral.steer("start")).toEqual({ state: "off" });
    expect(neutral.calls).toEqual([]);
    expect(neutral.record.autoMergeReason).toContain("The check of the review app sayso did not pass");
    const passed = build({ sayso: "success" });
    expect(await passed.steer("start")).toEqual({ state: "enabled" });
    expect(passed.calls).toEqual(["enable head-1 squash"]);
  });

  it("keeps the pull request as L3 and posts Needs your attention once when the gate fails", async () => {
    const { steer, calls, said } = build({
      gate: { settings: { allowAutoMerge: false, allowSquash: true, allowMergeCommit: false, allowRebase: false }, baseRequirements: [], requiresUpToDate: false },
    });
    expect(await steer("start")).toEqual({ state: "unavailable" });
    expect(await steer("event")).toEqual({ state: "unavailable" });
    expect(calls).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Needs your attention");
    expect(said[0]).toContain("Allow auto-merge");
  });

  it("turns auto-merge off on a head Factoree did not verify, and on again for a new verified head", async () => {
    const { steer, calls, github, record } = build();
    await steer("start");
    github.headSha = "head-2";
    expect(await steer("new_head")).toEqual({ state: "off" });
    record.verifiedHeadSha = "head-3";
    github.headSha = "head-3";
    expect(await steer("new_head")).toEqual({ state: "enabled" });
    expect(calls).toEqual(["enable head-1 squash", "disable", "enable head-3 squash"]);
  });

  it("never turns auto-merge on again after a human turned it off", async () => {
    const { steer, calls, github } = build();
    await steer("start");
    github.autoMergeEnabled = false;
    expect(await steer("auto_merge_disabled", "head-1")).toEqual({ state: "stopped" });
    expect(await steer("event")).toEqual({ state: "stopped" });
    expect(calls).toEqual(["enable head-1 squash"]);
  });

  // docs/specs/pr-review-merge-and-deploy.md, D7, DI-21.157.
  it("holds a consumer of a change set until every provider pull request merged", async () => {
    const waiting = build({ provider: "open" });
    expect(await waiting.steer("start")).toEqual({ state: "off" });
    expect(waiting.calls).toEqual([]);
    const merged = build({ provider: "merged" });
    expect(await merged.steer("start")).toEqual({ state: "enabled" });
    expect(merged.calls).toEqual(["enable head-1 squash"]);
  });

  it("merges at once, pinned to the head, when GitHub can merge it now", async () => {
    const { steer, calls } = build({ github: { mergeableState: "clean" } });
    await steer("start");
    expect(calls).toEqual(["merge head-1 squash"]);
  });

  // docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.115.
  it("asks for a bring-current update before an L4 merge when the base requires the branch up to date", async () => {
    const strict = {
      settings: { allowAutoMerge: true, allowSquash: true, allowMergeCommit: false, allowRebase: false },
      baseRequirements: ["required_status_checks"],
      requiresUpToDate: true,
    };
    const behind = build({ gate: strict, behindBy: 2 });
    expect(await behind.steer("start")).toEqual({ state: "off", bringCurrent: "up_to_date" });
    expect(behind.calls).toEqual([]);

    const current = build({ gate: strict, behindBy: 0 });
    expect(await current.steer("start")).toEqual({ state: "enabled" });
    expect(current.calls).toEqual(["enable head-1 squash"]);
  });

  it("asks for a bring-current update instead of a merge when the branch conflicts", async () => {
    const { steer, calls } = build({ github: { mergeable: false, mergeableState: "dirty" } });
    expect(await steer("start")).toEqual({ state: "off", bringCurrent: "conflict" });
    expect(calls).toEqual([]);
  });

  it("checks an auto-merge that is on again when the base branch moves", async () => {
    const strict = {
      settings: { allowAutoMerge: true, allowSquash: true, allowMergeCommit: false, allowRebase: false },
      baseRequirements: ["required_status_checks"],
      requiresUpToDate: true,
    };
    const built = build({ gate: strict });
    await built.steer("start");
    built.github.mergeableState = "behind";
    expect(await built.steer("event")).toEqual({ state: "enabled" });
    expect(await built.steer("base_moved")).toEqual({ state: "enabled", bringCurrent: "up_to_date" });
  });
});

/** DI-21.114. An activity retry after a successful write must not count a PR reviewer follow-up run twice. */
describe("countReviewerFollowUp", () => {
  it("counts one PR follow-up run once per run id", async () => {
    const { activities, counted } = build();
    const count = (runId: string) => activities.countReviewerFollowUp({ tenantId: "tenant-1", pullRequestId: "pr-1", runId });
    expect(await count("run-2")).toEqual({ count: 1 });
    expect(await count("run-2")).toEqual({ count: 1 });
    expect(await count("run-3")).toEqual({ count: 2 });
    expect(counted).toEqual(["run-2", "run-3"]);
  });
});
