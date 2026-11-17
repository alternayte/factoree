import { describe, expect, it } from "vitest";
import { PrismaPullRequestStore } from "~/persistence/prisma/pull-request-store.prisma.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import type { PullRequestEvent } from "~/domain/pull-requests/pull-request-event.js";
import { withDatabase, seedTenantProjectAndRun } from "./support/database.js";

const synchronize = (deliveryId: string, headSha: string): PullRequestEvent => ({
  kind: "synchronized",
  deliveryId,
  headSha,
  beforeSha: "head-1",
  senderLogin: "dana",
});

/** docs/specs/pr-review-merge-and-deploy.md, D3, DI-21.99, DI-21.100. */
describe("PrismaPullRequestStore", () => {
  it("records a published pull request, takes each delivery once, and closes through the origin run", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, productId, runId } = await seedTenantProjectAndRun(prisma);
      const repository = await prisma.repository.create({
        data: { tenantId, productId, fullName: "Acme/API", configSha: "c", githubInstallationId: "42" },
      });
      await prisma.runTarget.create({
        data: { tenantId, runId, repositoryId: repository.id, selectionReason: "only", pullRequestNumber: 12, pullRequestUrl: "u", pullRequestState: "open" },
      });
      const store = new PrismaPullRequestStore(prisma);

      const publication = {
        tenantId,
        runId,
        repositoryId: repository.id,
        number: 12,
        url: "https://github.com/Acme/API/pull/12",
        headBranch: "factoree/run-1",
        headSha: "head-1",
        baseBranch: "main",
        autonomyLevel: "L4",
        baseSha: "base-1",
      };
      const recorded = await store.recordPublished(publication);
      expect(recorded).toMatchObject({
        state: "open",
        contractRevision: 1,
        reviewerFollowUps: 0,
        autoMerge: "off",
        originRunId: runId,
        verifiedHeadSha: "head-1",
        autonomyLevel: "L4",
        autoMergeGateBase: null,
        verifiedBaseSha: "base-1",
        verifiedRunId: runId,
      });
      expect(recorded.workflowId).toBe(`pr:${tenantId}:Acme/API#12`);
      // DI-9.8. A second publication of the same pull request keeps the record and its origin run.
      expect((await store.recordPublished(publication)).id).toBe(recorded.id);

      const first = await store.recordEvent(tenantId, recorded.id, synchronize("github:d-1", "head-2"));
      expect(first.isNew).toBe(true);
      expect(first.pullRequest.headSha).toBe("head-2");
      const again = await store.recordEvent(tenantId, recorded.id, synchronize("github:d-1", "head-3"));
      expect(again.isNew).toBe(false);
      expect(again.pullRequest.headSha).toBe("head-2");
      expect(await prisma.pullRequestEvent.count({ where: { pullRequestId: recorded.id } })).toBe(1);

      expect((await store.findByNumber(tenantId, "acme/api", 12))?.id).toBe(recorded.id);
      expect((await store.findByCommit(tenantId, "acme/api", "head-2")).map((entry) => entry.id)).toEqual([recorded.id]);

      // DI-21.104, DI-21.106. The L4 gate state answers the record before the write, and the product
      // page lists only the open pull requests of that product whose gate failed.
      expect(await store.steeringFacts(tenantId, recorded.id)).toMatchObject({ productId, githubInstallationId: "42" });
      const before = await store.setAutoMerge(tenantId, recorded.id, { state: "unavailable", reason: "no rule", gateBase: "main" });
      expect(before.autoMerge).toBe("off");
      expect((await store.listAutoMergeUnavailable(tenantId, productId)).map((entry) => [entry.id, entry.autoMergeGateBase])).toEqual([
        [recorded.id, "main"],
      ]);

      // DI-21.114. The count takes each run id once, so a retry after a successful write counts nothing.
      expect(await store.countReviewerFollowUp(tenantId, recorded.id, "run-2")).toBe(1);
      expect(await store.countReviewerFollowUp(tenantId, recorded.id, "run-2")).toBe(1);
      expect(await store.countReviewerFollowUp(tenantId, recorded.id, "run-3")).toBe(2);
      // DI-21.117. A push to the base branch reaches each open pull request that targets it.
      expect((await store.listOpenByBase(tenantId, "acme/api", "main")).map((entry) => entry.id)).toEqual([recorded.id]);
      expect(await store.listOpenByBase(tenantId, "acme/api", "develop")).toEqual([]);

      const closed = await store.markClosed(tenantId, recorded.id, { merged: true, mergeCommitSha: "merge-1", closedAt: new Date() });
      expect(closed.state).toBe("merged");
      expect((await store.findByCommit(tenantId, "acme/api", "merge-1")).map((entry) => entry.id)).toEqual([recorded.id]);

      const run = await new PrismaRunRepository(prisma).closePullRequest(tenantId, "acme/api", 12, "merged", runId);
      expect(run?.runId).toBe(runId);
      expect(run?.pullRequestStates).toEqual(["merged"]);
    });
  });
});
