import { describe, expect, it } from "vitest";
import { createPullRequestActivities } from "~/activities/pull-request.activities.js";
import type { PublishedPullRequest, PullRequestStore } from "~/domain/pull-requests/pull-request-store.js";
import type { DeployPort, PullRequestDeployRecord, RecordDeployInput } from "~/domain/pull-requests/deploys.js";
import type { PullRequestEvent } from "~/domain/pull-requests/pull-request-event.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";

const reject = () => Promise.reject(new Error("not used"));

const MERGE = "m".repeat(40);
const EARLIER = "e".repeat(40);
const LATER = "l".repeat(40);
const PREVIEW = "p".repeat(40);

/**
 * The history of the base branch `main`: EARLIER, then the merge commit MERGE, then LATER. PREVIEW is
 * the head of another pull request and is not in `main`.
 */
const history: Record<string, string[]> = {
  main: [EARLIER, MERGE, LATER],
  [LATER]: [EARLIER, MERGE, LATER],
  [MERGE]: [EARLIER, MERGE],
  [EARLIER]: [EARLIER],
  [PREVIEW]: [EARLIER, MERGE, PREVIEW],
};

const build = (options: { previousSuccess?: string | null } = {}) => {
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
    state: "merged",
    mergeCommitSha: MERGE,
    closedAt: new Date(),
    reviewerFollowUps: 0,
    contractRevision: 2,
    autoMerge: "off",
    autoMergeReason: null,
    verifiedHeadSha: "head-1",
    autonomyLevel: "L3",
    autoMergeGateBase: null,
    verifiedBaseSha: "base-1",
    verifiedRunId: "run-2",
    reviewerHandledKey: null,
    reviewerFollowUpKeys: [],
    bringCurrentHeadSha: null,
    workflowId: "pr:tenant-1:acme/api#12",
  };
  const deploys: PullRequestDeployRecord[] = [];
  const moves: string[] = [];
  const store: PullRequestStore = {
    recordPublished: reject,
    findByNumber: reject,
    findByCommit: reject,
    recordEvent: reject,
    markClosed: reject,
    listAutoMergeUnavailable: reject,
    markReviewerHandled: reject,
    countReviewerFollowUp: reject,
    markBringCurrentTried: reject,
    listOpenByBase: reject,
    listEvents: reject,
    steeringFacts: reject,
    setAutoMerge: reject,
    listMergedForDeploy: reject,
    openDeployFailure: reject,
    markDeployFollowedUp: reject,
    find: () => Promise.resolve({ ...record }),
    originFacts: () =>
      Promise.resolve({
        productId: "product-1",
        githubInstallationId: "42",
        originWorkflowId: "linear:workspace-1:session-1",
        linearAgentSessionId: "session-1",
        linearIssueId: "issue-1",
        workItemTitle: "Title",
        workItemUrl: null,
      }),
    listDeploys: () => Promise.resolve([...deploys]),
    recordDeploy: (input: RecordDeployInput) => {
      deploys.push({ id: `deploy-${String(deploys.length + 1)}`, resolvedAt: null, followUpWorkflowId: null, createdAt: new Date(), ...input });
      return Promise.resolve(true);
    },
  };
  const port: DeployPort = {
    contains: (_slug, ancestor, descendant) => Promise.resolve((history[descendant] ?? []).includes(ancestor)),
    previousSuccess: () => Promise.resolve(options.previousSuccess ?? null),
  };
  const activities = createPullRequestActivities({
    pullRequests: store,
    close: {
      closeOfRecord: reject,
      afterFailedDeploy: (input) => {
        moves.push(input.originRunId);
        return Promise.resolve({ move: "moved", stateName: "Todo" });
      },
    },
    logger: createLogger({ level: "error", redactor: new Redactor() }),
    autoMerge: { pullRequest: reject, gate: reject, reviewerVerdict: reject, reviews: reject, enable: reject, disable: reject, behindBy: reject, merge: reject },
    deploys: port,
    products: { findById: reject },
    agentSession: { respond: reject },
    reviews: { reviewerFindings: reject, review: reject, canWrite: reject, reply: reject, comment: reject },
    repositories: { listByProduct: reject },
    workItems: { facts: reject },
    repositoryBaseUrl: () => Promise.resolve("https://github.com"),
  });
  const deployment = (state: string, sha: string, deploymentId = 9): PullRequestEvent => ({
    kind: "deployment_status",
    deliveryId: `github:${state}-${String(deploymentId)}`,
    deploymentId,
    environment: "production",
    state,
    sha,
    ref: "main",
    environmentUrl: null,
    logUrl: "https://github.com/acme/api/actions/runs/9",
  });
  const take = (event: PullRequestEvent) => activities.takeDeployment({ tenantId: "tenant-1", pullRequestId: "pr-1", event });
  return { take, deployment, deploys, moves };
};

/** docs/specs/pr-review-merge-and-deploy.md, slice 5, DI-21.120 to DI-21.122. */
describe("takeDeployment", () => {
  it("records a successful deploy of a later base commit once per environment, for the run of the verified head", async () => {
    const { take, deployment, deploys } = build();
    const taken = await take(deployment("success", LATER));
    expect(taken.kind).toBe("recorded");
    if (taken.kind !== "recorded") return;
    expect(taken.notice).toContain("`production`");
    expect(taken.notice).toContain(LATER.slice(0, 12));
    expect(taken.amend.runId).toBe("run-2");
    expect(taken.amend.afterPublication.deploys).toEqual([expect.objectContaining({ environment: "production", state: "success", sha: LATER })]);
    expect(await take(deployment("success", LATER, 10))).toEqual({ kind: "none", reason: "the environment holds the change already" });
    expect(deploys).toHaveLength(1);
  });

  it("takes no deploy of a commit outside the base branch, nor one that does not hold the merge commit", async () => {
    const { take, deployment, deploys } = build();
    expect((await take(deployment("success", PREVIEW))).kind).toBe("none");
    expect((await take(deployment("success", EARLIER))).kind).toBe("none");
    expect((await take(deployment("in_progress", LATER))).kind).toBe("none");
    expect(deploys).toEqual([]);
  });

  it("marks a failed deploy whose range holds the merge commit, moves the issue back and names the range and the log", async () => {
    const { take, deployment, deploys, moves } = build({ previousSuccess: EARLIER });
    const taken = await take(deployment("failure", LATER));
    expect(taken.kind).toBe("recorded");
    if (taken.kind !== "recorded") return;
    expect(moves).toEqual(["run-1"]);
    expect(deploys).toEqual([expect.objectContaining({ state: "failure", previousSha: EARLIER, sha: LATER, runId: "run-2" })]);
    expect(taken.notice).toContain(`${EARLIER.slice(0, 12)}..${LATER.slice(0, 12)}`);
    expect(taken.notice).toContain("https://github.com/acme/api/actions/runs/9");
    expect(taken.notice).toContain("moved the issue back to Todo");
  });

  it("takes no failed deploy when the previous successful deploy held the change already", async () => {
    const { take, deployment, deploys, moves } = build({ previousSuccess: MERGE });
    expect(await take(deployment("failure", LATER))).toEqual({ kind: "none", reason: "an earlier successful deploy holds the change" });
    expect(deploys).toEqual([]);
    expect(moves).toEqual([]);
  });
});
