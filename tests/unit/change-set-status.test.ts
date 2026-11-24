import { describe, expect, it } from "vitest";
import { decideChangeSetStatuses, providersNotMerged, type ChangeSet, type ChangeSetMember } from "~/domain/pull-requests/change-set-status.js";
import type { PublishedPullRequest } from "~/domain/pull-requests/pull-request-store.js";

const member = (repository: string, number: number, record: Partial<PublishedPullRequest> | null = {}): ChangeSetMember => {
  const head = `${String(number).repeat(40)}`.slice(0, 40);
  return {
    repositoryId: `repo-${repository}`,
    repositoryFullName: repository,
    githubInstallationId: "1",
    number,
    url: `https://github.com/${repository}/pull/${String(number)}`,
    workflowId: `pr:t:${repository}#${String(number)}`,
    statusKey: null,
    record:
      record === null
        ? null
        : {
            id: `pr-${repository}`,
            tenantId: "t",
            repositoryId: `repo-${repository}`,
            repositoryFullName: repository,
            number,
            url: `https://github.com/${repository}/pull/${String(number)}`,
            headBranch: "factoree/run-1",
            headSha: head,
            baseBranch: "main",
            originRunId: "run-1",
            state: "open",
            mergeCommitSha: null,
            closedAt: null,
            reviewerFollowUps: 0,
            contractRevision: 1,
            autoMerge: "off",
            autoMergeReason: null,
            verifiedHeadSha: head,
            autonomyLevel: "L3",
            autoMergeGateBase: null,
            verifiedBaseSha: "b".repeat(40),
            verifiedRunId: "run-1",
            reviewerHandledKey: null,
            reviewerFollowUpKeys: [],
            answeredFindingFingerprints: [],
            reviewAppNoticeKey: null,
            bringCurrentHeadSha: null,
            workflowId: `pr:t:${repository}#${String(number)}`,
            ...record,
          },
  };
};

const setOf = (provider: ChangeSetMember, consumer: ChangeSetMember, extraEdges: ChangeSet["edges"] = []): ChangeSet => ({
  originRunId: "run-1",
  targets: [provider.repositoryFullName, consumer.repositoryFullName],
  members: [provider, consumer],
  edges: [{ provider: provider.repositoryFullName, consumer: consumer.repositoryFullName }, ...extraEdges],
});

describe("decideChangeSetStatuses (docs/specs/change-sets.md, DI-21.155)", () => {
  it("holds the consumer pending while the provider pull request is open, on the consumer head", () => {
    const statuses = decideChangeSetStatuses(setOf(member("acme/api", 1), member("acme/web", 2)));
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ state: "pending", sha: "2".repeat(40), targetUrl: "https://github.com/acme/api/pull/1" });
    expect(statuses[0]?.description).toBe("Merge acme/api#1 first.");
  });

  it("turns to success when every provider merged", () => {
    const statuses = decideChangeSetStatuses(setOf(member("acme/api", 1, { state: "merged" }), member("acme/web", 2)));
    expect(statuses.map((status) => status.state)).toEqual(["success"]);
  });

  it("turns to failure when a provider closes unmerged", () => {
    const statuses = decideChangeSetStatuses(setOf(member("acme/api", 1, { state: "closed" }), member("acme/web", 2)));
    expect(statuses[0]?.state).toBe("failure");
    expect(statuses[0]?.description).toContain("closed without a merge");
  });

  it("turns to failure on a provider head that Factoree did not push after a set check, and keeps pending on one it did", () => {
    const human = decideChangeSetStatuses(setOf(member("acme/api", 1, { headSha: "c".repeat(40) }), member("acme/web", 2)));
    expect(human[0]?.state).toBe("failure");
    expect(human[0]?.description).toContain("ccccccc");
    const pushed = decideChangeSetStatuses(setOf(member("acme/api", 1, { headSha: "d".repeat(40), verifiedHeadSha: "d".repeat(40) }), member("acme/web", 2)));
    expect(pushed[0]?.state).toBe("pending");
  });

  it("sets no status for a cycle, nor before every record exists", () => {
    const provider = member("acme/api", 1);
    const consumer = member("acme/web", 2);
    expect(decideChangeSetStatuses(setOf(provider, consumer, [{ provider: "acme/web", consumer: "acme/api" }]))).toEqual([]);
    expect(decideChangeSetStatuses(setOf(provider, member("acme/web", 2, null)))).toEqual([]);
  });

  it("holds consumer auto-merge until every provider merged", () => {
    const open = setOf(member("acme/api", 1), member("acme/web", 2));
    expect(providersNotMerged(open, "pr-acme/web")).toContain("acme/api#1");
    expect(providersNotMerged(open, "pr-acme/api")).toBeNull();
    expect(providersNotMerged(setOf(member("acme/api", 1, { state: "merged" }), member("acme/web", 2)), "pr-acme/web")).toBeNull();
  });
});
