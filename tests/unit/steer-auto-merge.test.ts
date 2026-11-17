import { describe, expect, it } from "vitest";
import { createPullRequestActivities } from "~/activities/pull-request.activities.js";
import type { AutoMergeGate, AutoMergePort, MergeMethod, PullRequestOnGitHub } from "~/domain/pull-requests/auto-merge.js";
import type { AutoMergeUpdate, PublishedPullRequest, PullRequestStore } from "~/domain/pull-requests/pull-request-store.js";
import type { ProductRecord } from "~/domain/products/product-registry.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";

const reject = () => Promise.reject(new Error("not used"));

const build = (
  options: { gate?: AutoMergeGate; github?: Partial<PullRequestOnGitHub>; autoMerge?: PublishedPullRequest["autoMerge"]; behindBy?: number } = {},
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
    findByNumber: reject,
    findByCommit: reject,
    recordEvent: reject,
    markClosed: reject,
    listAutoMergeUnavailable: reject,
    originFacts: reject,
    markReviewerHandled: reject,
    countReviewerFollowUp: (_tenantId: string, _id: string, key: string) => {
      counted.push(key);
      record.reviewerFollowUps += 1;
      record.reviewerFollowUpKeys = [...record.reviewerFollowUpKeys, key];
      return Promise.resolve(record.reviewerFollowUps);
    },
    markBringCurrentTried: reject,
    listOpenByBase: reject,
    listEvents: reject,
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
    reviewerVerdict: () => Promise.resolve("passed"),
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
  const activities = createPullRequestActivities({
    pullRequests: store,
    close: { closeOfRecord: reject },
    logger: createLogger({ level: "error", redactor: new Redactor() }),
    autoMerge: port,
    products: { findById: () => Promise.resolve({ prReviewer: { appSlug: "review-bot", checkName: "Code review" } } as ProductRecord) },
    agentSession: {
      respond: (_sessionId: string, body: string) => {
        said.push(body);
        return Promise.resolve();
      },
    },
    reviews: { reviewerFindings: reject, review: reject, canWrite: reject, reply: reject, comment: reject },
    repositories: { listByProduct: reject },
    workItems: { facts: reject },
    repositoryBaseUrl: () => Promise.resolve("https://github.com"),
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
