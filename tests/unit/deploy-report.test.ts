import { describe, expect, it } from "vitest";
import { createPullRequestActivities } from "~/activities/pull-request.activities.js";
import type { PublishedPullRequest, PullRequestStore } from "~/domain/pull-requests/pull-request-store.js";
import type { DeployPort, PullRequestDeployRecord, RecordDeployInput } from "~/domain/pull-requests/deploys.js";
import type { PullRequestEvent } from "~/domain/pull-requests/pull-request-event.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import { PullRequestCloseHandler } from "~/domain/runs/pull-request-close.js";
import type { IssueStatusPort, IssueWorkflowState } from "~/domain/runs/issue-status.js";

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

const TODO: IssueWorkflowState = { id: "state-todo", name: "Todo", type: "unstarted", position: 1 };
const DONE: IssueWorkflowState = { id: "state-done", name: "Done", type: "completed", position: 3 };

const build = (options: { previousSuccess?: string | null; failIssueMoveWrites?: number } = {}) => {
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
  const posted: string[] = [];
  // The origin run completed the issue at the merge: it moved it from Todo to Done.
  const run = { id: "run-1", linearIssueId: "issue-1", issueStateFromId: TODO.id, issueStateSetId: DONE.id };
  const issue = { state: DONE };
  const issues: IssueStatusPort = {
    read: () => Promise.resolve({ state: issue.state, teamStates: [TODO, DONE] }),
    move: (_issueId, stateId) => {
      moves.push(stateId);
      issue.state = stateId === TODO.id ? TODO : DONE;
      return Promise.resolve();
    },
    attachPullRequest: reject,
  };
  const close = new PullRequestCloseHandler({
    webhookLog: { recordIfNew: reject, remove: reject },
    runs: {
      closePullRequest: reject,
      findById: () => Promise.resolve({ ...run }) as never,
      setIssueState: (_tenantId, _runId, state) => {
        run.issueStateSetId = state.setId ?? run.issueStateSetId;
        return Promise.resolve();
      },
    },
    issues: () => Promise.resolve(issues),
    respond: reject,
    logger: createLogger({ level: "error", redactor: new Redactor() }),
  });
  let failIssueMoveWrites = options.failIssueMoveWrites ?? 0;
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
      deploys.push({
        id: `deploy-${String(deploys.length + 1)}`,
        resolvedAt: null,
        followUpWorkflowId: null,
        issueMove: null,
        issueStateName: null,
        createdAt: new Date(),
        pullRequestId: input.pullRequestId,
        runId: input.runId,
        environment: input.environment,
        state: input.state,
        deploymentId: input.deploymentId,
        sha: input.sha,
        previousSha: input.previousSha,
        logUrl: input.logUrl,
        environmentUrl: input.environmentUrl,
        deliveryId: input.deliveryId,
      });
      return Promise.resolve(true);
    },
    setDeployIssueMove: (_tenantId, deployId, move, stateName) => {
      // The final write fails as often as the test asks, after the Linear move.
      if (move !== "moving" && failIssueMoveWrites > 0) {
        failIssueMoveWrites -= 1;
        return Promise.reject(new Error("the database is gone"));
      }
      const deploy = deploys.find((row) => row.id === deployId);
      if (deploy !== undefined) Object.assign(deploy, { issueMove: move, issueStateName: stateName });
      return Promise.resolve();
    },
  };
  const port: DeployPort = {
    contains: (_slug, ancestor, descendant) => Promise.resolve((history[descendant] ?? []).includes(ancestor)),
    previousSuccess: () => Promise.resolve(options.previousSuccess ?? null),
  };
  const activities = createPullRequestActivities({
    pullRequests: store,
    close,
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
  return { take, deployment, deploys, moves, posted, issue };
};

/** docs/specs/pr-review-merge-and-deploy.md, slice 5, DI-21.120 to DI-21.122. */
describe("takeDeployment", () => {
  it("records a successful deploy of a later base commit once per environment, for the run of the verified head", async () => {
    const { take, deployment, deploys } = build();
    const taken = await take(deployment("success", LATER));
    expect(taken.kind).toBe("recorded");
    if (taken.kind !== "recorded") return;
    expect(taken.notice).toBe(`Deployed to \`production\` at commit \`${LATER.slice(0, 12)}\`. The proof pack is updated.`);
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
    expect(moves).toEqual([TODO.id]);
    expect(deploys).toEqual([expect.objectContaining({ state: "failure", previousSha: EARLIER, sha: LATER, runId: "run-2" })]);
    expect(taken.notice).toContain(`${EARLIER.slice(0, 12)}..${LATER.slice(0, 12)}`);
    expect(taken.notice).toContain("https://github.com/acme/api/actions/runs/9");
    expect(taken.notice).toContain("moved the issue back to Todo");
  });

  it("answers the same issue move and notice when a retry follows a failed write after the move (DI-21.126)", async () => {
    const { take, deployment, deploys, moves, issue } = build({ previousSuccess: EARLIER, failIssueMoveWrites: 1 });
    await expect(take(deployment("failure", LATER))).rejects.toThrow("the database is gone");
    expect(issue.state).toBe(TODO);
    const retried = await take(deployment("failure", LATER));
    expect(retried.kind).toBe("recorded");
    if (retried.kind !== "recorded") return;
    expect(retried.notice).toContain("Factoree moved the issue back to Todo.");
    expect(moves).toEqual([TODO.id]);
    expect(deploys).toEqual([expect.objectContaining({ issueMove: "moved", issueStateName: "Todo" })]);
    // A third attempt of the same delivery reads the stored move and gives the same notice.
    const again = await take(deployment("failure", LATER));
    expect(again.kind === "recorded" ? again.notice : null).toBe(retried.notice);
  });

  it("takes nothing from another delivery of a recorded failed deployment", async () => {
    const { take, deployment } = build({ previousSuccess: EARLIER });
    expect((await take(deployment("failure", LATER))).kind).toBe("recorded");
    const other = { ...deployment("failure", LATER), deliveryId: "github:error-9" };
    expect(await take(other)).toEqual({ kind: "none", reason: "the failed deployment is recorded already" });
  });

  it("says the issue did not move when an earlier failed deploy moved it back already", async () => {
    const { take, deployment, moves } = build({ previousSuccess: EARLIER });
    await take(deployment("failure", LATER, 9));
    const second = await take(deployment("failure", LATER, 10));
    expect(second.kind === "recorded" ? second.notice : "").toContain("Factoree did not move the issue.");
    expect(moves).toEqual([TODO.id]);
  });

  it("takes no failed deploy when the previous successful deploy held the change already", async () => {
    const { take, deployment, deploys, moves } = build({ previousSuccess: MERGE });
    expect(await take(deployment("failure", LATER))).toEqual({ kind: "none", reason: "an earlier successful deploy holds the change" });
    expect(deploys).toEqual([]);
    expect(moves).toEqual([]);
  });
});
