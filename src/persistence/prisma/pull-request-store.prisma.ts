import type { Prisma } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import { eventHeadSha, pullRequestWorkflowId, type PullRequestEvent } from "~/domain/pull-requests/pull-request-event.js";
import type {
  AutoMergeState,
  AutoMergeUpdate,
  PublishedPullRequest,
  PullRequestSteeringFacts,
  PullRequestStore,
  RecordPublishedPullRequestInput,
} from "~/domain/pull-requests/pull-request-store.js";
import type { PullRequestState } from "~/domain/runs/issue-status.js";

const include = { repository: { select: { fullName: true } } } as const;

type Row = Prisma.PullRequestGetPayload<{ include: typeof include }>;

const stateOf = (value: string): PullRequestState => (value === "merged" || value === "closed" ? value : "open");

const autoMergeOf = (value: string): AutoMergeState =>
  value === "enabled" || value === "unavailable" || value === "stopped" ? value : "off";

const toRecord = (row: Row): PublishedPullRequest => ({
  id: row.id,
  tenantId: row.tenantId,
  repositoryId: row.repositoryId,
  repositoryFullName: row.repository.fullName,
  number: row.number,
  url: row.url,
  headBranch: row.headBranch,
  headSha: row.headSha,
  baseBranch: row.baseBranch,
  originRunId: row.originRunId,
  state: stateOf(row.state),
  mergeCommitSha: row.mergeCommitSha,
  reviewerFollowUps: row.reviewerFollowUps,
  contractRevision: row.contractRevision,
  autoMerge: autoMergeOf(row.autoMerge),
  autoMergeReason: row.autoMergeReason,
  verifiedHeadSha: row.verifiedHeadSha,
  autonomyLevel: row.autonomyLevel,
  autoMergeGateBase: row.autoMergeGateBase,
  workflowId: row.workflowId,
});

/** The facts an event moves on the record. Every other event changes no column. */
const factsOf = (event: PullRequestEvent): Prisma.PullRequestUpdateManyMutationInput | null => {
  switch (event.kind) {
    case "synchronized":
      return { headSha: event.headSha };
    case "reopened":
      return { state: "open", closedAt: null, mergeCommitSha: null, headSha: event.headSha };
    case "edited":
      return { baseBranch: event.baseBranch };
    default:
      return null;
  }
};

export class PrismaPullRequestStore implements PullRequestStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async recordPublished(input: RecordPublishedPullRequestInput): Promise<PublishedPullRequest> {
    // The tenant filter is part of the query. SDD section 52 forbids a read across the boundary.
    const repository = await this.prisma.repository.findFirst({
      where: { id: input.repositoryId, tenantId: input.tenantId },
      select: { fullName: true },
    });
    if (repository === null) {
      throw new Error(`no repository "${input.repositoryId}" of tenant "${input.tenantId}" holds the pull request`);
    }
    const row = await this.prisma.pullRequest.upsert({
      where: { tenantId_repositoryId_number: { tenantId: input.tenantId, repositoryId: input.repositoryId, number: input.number } },
      create: {
        tenantId: input.tenantId,
        repositoryId: input.repositoryId,
        number: input.number,
        url: input.url,
        headBranch: input.headBranch,
        headSha: input.headSha,
        baseBranch: input.baseBranch,
        originRunId: input.runId,
        verifiedHeadSha: input.headSha,
        autonomyLevel: input.autonomyLevel,
        workflowId: pullRequestWorkflowId(input.tenantId, repository.fullName, input.number),
      },
      // DI-9.8. The pull request existed. The origin run and the workflow id stay. The pushed head
      // is verified, so it and the level of its run replace the old ones (DI-21.104).
      update: { headSha: input.headSha, url: input.url, verifiedHeadSha: input.headSha, autonomyLevel: input.autonomyLevel },
      include,
    });
    return toRecord(row);
  }

  async find(tenantId: string, id: string): Promise<PublishedPullRequest | null> {
    const row = await this.prisma.pullRequest.findFirst({ where: { id, tenantId }, include });
    return row === null ? null : toRecord(row);
  }

  async findByNumber(tenantId: string, repositoryFullName: string, number: number): Promise<PublishedPullRequest | null> {
    const row = await this.prisma.pullRequest.findFirst({
      where: { tenantId, number, repository: { fullName: { equals: repositoryFullName, mode: "insensitive" } } },
      include,
    });
    return row === null ? null : toRecord(row);
  }

  async findByCommit(tenantId: string, repositoryFullName: string, sha: string): Promise<PublishedPullRequest[]> {
    const rows = await this.prisma.pullRequest.findMany({
      where: {
        tenantId,
        repository: { fullName: { equals: repositoryFullName, mode: "insensitive" } },
        OR: [{ headSha: sha }, { mergeCommitSha: sha }],
      },
      orderBy: { createdAt: "asc" },
      include,
    });
    return rows.map(toRecord);
  }

  async recordEvent(
    tenantId: string,
    pullRequestId: string,
    event: PullRequestEvent,
  ): Promise<{ isNew: boolean; pullRequest: PublishedPullRequest }> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.pullRequest.findFirst({ where: { id: pullRequestId, tenantId }, include });
      if (current === null) throw new Error(`no pull request "${pullRequestId}" of tenant "${tenantId}" took the event`);
      // DI-21.100. ON CONFLICT DO NOTHING: a redelivery, or a second signal of one delivery, changes
      // nothing and leaves the transaction usable.
      const inserted = await tx.pullRequestEvent.createMany({
        data: [
          {
            tenantId,
            pullRequestId,
            deliveryId: event.deliveryId,
            kind: event.kind,
            headSha: eventHeadSha(event),
            payload: event as unknown as Prisma.InputJsonObject,
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 0) return { isNew: false, pullRequest: toRecord(current) };
      const facts = factsOf(event);
      if (facts === null) return { isNew: true, pullRequest: toRecord(current) };
      const updated = await tx.pullRequest.update({ where: { id: pullRequestId }, data: facts, include });
      return { isNew: true, pullRequest: toRecord(updated) };
    });
  }

  async markClosed(
    tenantId: string,
    pullRequestId: string,
    close: { merged: boolean; mergeCommitSha: string | null; closedAt: Date },
  ): Promise<PublishedPullRequest> {
    const updated = await this.prisma.pullRequest.updateMany({
      where: { id: pullRequestId, tenantId },
      data: { state: close.merged ? "merged" : "closed", mergeCommitSha: close.mergeCommitSha, closedAt: close.closedAt },
    });
    if (updated.count === 0) throw new Error(`no pull request "${pullRequestId}" of tenant "${tenantId}" closed`);
    const row = await this.prisma.pullRequest.findFirstOrThrow({ where: { id: pullRequestId, tenantId }, include });
    return toRecord(row);
  }

  async steeringFacts(tenantId: string, pullRequestId: string): Promise<PullRequestSteeringFacts> {
    const row = await this.prisma.pullRequest.findFirst({
      where: { id: pullRequestId, tenantId },
      select: {
        repository: { select: { productId: true, githubInstallationId: true } },
        originRun: { select: { linearAgentSessionId: true } },
      },
    });
    if (row === null) throw new Error(`no pull request "${pullRequestId}" of tenant "${tenantId}"`);
    return {
      productId: row.repository.productId,
      githubInstallationId: row.repository.githubInstallationId,
      linearAgentSessionId: row.originRun.linearAgentSessionId,
    };
  }

  async setAutoMerge(tenantId: string, pullRequestId: string, update: AutoMergeUpdate): Promise<PublishedPullRequest> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.pullRequest.findFirst({ where: { id: pullRequestId, tenantId }, include });
      if (before === null) throw new Error(`no pull request "${pullRequestId}" of tenant "${tenantId}"`);
      await tx.pullRequest.update({
        where: { id: pullRequestId },
        data: {
          autoMerge: update.state,
          autoMergeReason: update.reason,
          ...(update.gateBase === undefined ? {} : { autoMergeGateBase: update.gateBase }),
        },
      });
      return toRecord(before);
    });
  }

  async listAutoMergeUnavailable(tenantId: string, productId: string): Promise<PublishedPullRequest[]> {
    const rows = await this.prisma.pullRequest.findMany({
      where: { tenantId, state: "open", autoMerge: "unavailable", repository: { productId } },
      orderBy: { createdAt: "desc" },
      take: 50,
      include,
    });
    return rows.map(toRecord);
  }
}
