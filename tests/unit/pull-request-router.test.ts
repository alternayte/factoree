import { describe, expect, it } from "vitest";
import { PullRequestEventRouter, type PullRequestSignal } from "~/domain/pull-requests/pull-request-router.js";
import type { PublishedPullRequest } from "~/domain/pull-requests/pull-request-store.js";
import type { PullRequestEvent } from "~/domain/pull-requests/pull-request-event.js";
import { missingGitHubAccess } from "~/adapters/github/app-manifest.js";
import type { Logger } from "~/telemetry/logger.js";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

const pullRequest = (overrides: Partial<PublishedPullRequest> = {}): PublishedPullRequest => ({
  id: "pr-1",
  tenantId: "tenant-1",
  repositoryId: "repository-1",
  repositoryFullName: "acme/api",
  number: 12,
  url: "https://github.com/acme/api/pull/12",
  headBranch: "factoree/run-1",
  headSha: "head-sha",
  baseBranch: "main",
  originRunId: "run-1",
  state: "open",
  mergeCommitSha: null,
  reviewerFollowUps: 0,
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
  ...overrides,
});

const statusEvent: PullRequestEvent = {
  kind: "commit_status",
  deliveryId: "github:d-1",
  sha: "head-sha",
  context: "Code review",
  state: "success",
  targetUrl: null,
  senderLogin: null,
};

const build = (records: PublishedPullRequest[]) => {
  const signals: PullRequestSignal[] = [];
  const recorded: { pullRequestId: string; event: PullRequestEvent }[] = [];
  const router = new PullRequestEventRouter({
    pullRequests: {
      findByNumber: (_tenantId, _repository, number) => Promise.resolve(records.find((record) => record.number === number) ?? null),
      findByCommit: (_tenantId, _repository, sha) =>
        Promise.resolve(records.filter((record) => record.headSha === sha || record.mergeCommitSha === sha)),
      listOpenByBase: (_tenantId, _repository, baseBranch) =>
        Promise.resolve(records.filter((record) => record.state === "open" && record.baseBranch === baseBranch)),
      recordEvent: (_tenantId, pullRequestId, event) => {
        recorded.push({ pullRequestId, event });
        return Promise.resolve({ isNew: true, pullRequest: records.find((record) => record.id === pullRequestId) as PublishedPullRequest });
      },
    },
    signal: (input) => {
      signals.push(input);
      return Promise.resolve();
    },
    logger,
  });
  return { router, signals, recorded };
};

describe("PullRequestEventRouter (docs/specs/pr-review-merge-and-deploy.md, DI-21.101)", () => {
  it("signals the PR workflow of an open pull request", async () => {
    const { router, signals, recorded } = build([pullRequest()]);
    expect(await router.byCommit("tenant-1", "acme/api", "head-sha", statusEvent)).toBe("routed");
    expect(signals).toEqual([{ workflowId: "pr:tenant-1:acme/api#12", tenantId: "tenant-1", pullRequestId: "pr-1", event: statusEvent }]);
    expect(recorded).toEqual([]);
  });

  it("records an event of a merged pull request and starts no workflow", async () => {
    const { router, signals, recorded } = build([pullRequest({ state: "merged", mergeCommitSha: "merge-sha" })]);
    const deploy: PullRequestEvent = {
      kind: "deployment_status",
      deliveryId: "github:d-2",
      deploymentId: 4,
      environment: "production",
      state: "success",
      sha: "merge-sha",
      ref: "main",
      environmentUrl: null,
      logUrl: "https://ci.example/4",
    };
    expect(await router.byCommit("tenant-1", "acme/api", "merge-sha", deploy)).toBe("recorded");
    expect(signals).toEqual([]);
    expect(recorded).toEqual([{ pullRequestId: "pr-1", event: deploy }]);
  });

  it("starts the PR workflow again on a reopen of a closed pull request", async () => {
    const { router, signals } = build([pullRequest({ state: "closed" })]);
    const reopen: PullRequestEvent = { kind: "reopened", deliveryId: "github:d-3", headSha: "head-sha" };
    expect(await router.byNumber("tenant-1", "acme/api", 12, reopen)).toBe("routed");
    expect(signals.map((signal) => signal.event.kind)).toEqual(["reopened"]);
  });

  it("answers unmatched for a pull request with no record", async () => {
    const { router, signals } = build([pullRequest()]);
    expect(await router.byNumber("tenant-1", "acme/api", 99, statusEvent)).toBe("unmatched");
    expect(signals).toEqual([]);
  });
});

describe("missingGitHubAccess (docs/specs/pr-review-merge-and-deploy.md, D4)", () => {
  it("names each permission below the manifest level and each event the installation did not accept", () => {
    const missing = missingGitHubAccess({
      permissions: { contents: "write", pull_requests: "read", workflows: "write", issues: "write", deployments: "read", metadata: "read" },
      events: ["push", "deployment_status", "pull_request"],
    });
    expect(missing.permissions).toEqual([
      { name: "pull_requests", required: "write", granted: "read" },
      { name: "checks", required: "read", granted: null },
      { name: "statuses", required: "read", granted: null },
    ]);
    expect(missing.events).toEqual(["pull_request_review", "check_run", "status"]);
  });
});
