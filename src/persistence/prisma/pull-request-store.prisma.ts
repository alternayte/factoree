import type { Prisma } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import { eventHeadSha, pullRequestWorkflowId, type PullRequestEvent } from "~/domain/pull-requests/pull-request-event.js";
import type {
  PullRequestOriginFacts,
  AutoMergeState,
  AutoMergeUpdate,
  PublishedPullRequest,
  PullRequestSteeringFacts,
  PullRequestStore,
  RecordPublishedPullRequestInput,
} from "~/domain/pull-requests/pull-request-store.js";
import type { PullRequestState } from "~/domain/runs/issue-status.js";
import type { ChangeSet, ChangeSetLock, ChangeSetMember, ChangeSetStore } from "~/domain/pull-requests/change-set-status.js";
import { deployKeyOf, type DeployIssueMoveState, type OpenDeployFailure, type PullRequestDeployRecord, type RecordDeployInput } from "~/domain/pull-requests/deploys.js";

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
  closedAt: row.closedAt,
  reviewerFollowUps: row.reviewerFollowUps,
  contractRevision: row.contractRevision,
  autoMerge: autoMergeOf(row.autoMerge),
  autoMergeReason: row.autoMergeReason,
  verifiedHeadSha: row.verifiedHeadSha,
  autonomyLevel: row.autonomyLevel,
  autoMergeGateBase: row.autoMergeGateBase,
  verifiedBaseSha: row.verifiedBaseSha,
  verifiedRunId: row.verifiedRunId,
  reviewerHandledKey: row.reviewerHandledKey,
  reviewerFollowUpKeys: row.reviewerFollowUpKeys,
  bringCurrentHeadSha: row.bringCurrentHeadSha,
  answeredFindingFingerprints: row.answeredFindingFingerprints,
  reviewAppNoticeKey: row.reviewAppNoticeKey,
  previewUrl: row.previewUrl,
  previewHeadSha: row.previewHeadSha,
  workflowId: row.workflowId,
});

/**
 * The facts an event moves on the record. Every other event changes no column. DI-21.220: a new head
 * clears the preview, and a successful deployment with an environment URL on the head of an open
 * pull request is its preview. A deployment of any other commit, such as a deploy of the merge
 * commit, is no preview.
 */
const factsOf = (event: PullRequestEvent, current: { state: string; headSha: string }): Prisma.PullRequestUpdateManyMutationInput | null => {
  switch (event.kind) {
    case "synchronized":
      return { headSha: event.headSha, previewUrl: null, previewHeadSha: null };
    case "reopened":
      return { state: "open", closedAt: null, mergeCommitSha: null, headSha: event.headSha, ...(event.headSha === current.headSha ? {} : { previewUrl: null, previewHeadSha: null }) };
    case "deployment_status":
      return current.state === "open" && event.state === "success" && event.sha === current.headSha && event.environmentUrl !== null && /^https?:\/\//.test(event.environmentUrl)
        ? { previewUrl: event.environmentUrl, previewHeadSha: event.sha }
        : null;
    case "edited":
      return { baseBranch: event.baseBranch };
    case "base_pushed":
      // DI-21.118. A moved base may resolve what an earlier update could not.
      return { bringCurrentHeadSha: null };
    default:
      return null;
  }
};

type DeployRow = Prisma.PullRequestDeployGetPayload<object>;

const toDeploy = (row: DeployRow): PullRequestDeployRecord => ({
  id: row.id,
  pullRequestId: row.pullRequestId,
  runId: row.runId,
  environment: row.environment,
  state: row.state === "success" ? "success" : "failure",
  deploymentId: row.deploymentId,
  sha: row.sha,
  previousSha: row.previousSha,
  logUrl: row.logUrl,
  environmentUrl: row.environmentUrl,
  resolvedAt: row.resolvedAt,
  followUpWorkflowId: row.followUpWorkflowId,
  deliveryId: row.deliveryId,
  issueMove: isDeployIssueMove(row.issueMove) ? row.issueMove : null,
  issueStateName: row.issueStateName,
  createdAt: row.createdAt,
});

const DEPLOY_ISSUE_MOVES: readonly string[] = ["moving", "moved", "human_moved", "not_moved"] satisfies DeployIssueMoveState[];
const isDeployIssueMove = (value: string | null): value is DeployIssueMoveState => value !== null && DEPLOY_ISSUE_MOVES.includes(value);

export class PrismaPullRequestStore implements PullRequestStore, ChangeSetStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  /**
   * docs/specs/change-sets.md, DI-21.155. The set of the run that opened the pull request: every run
   * target of that run with a pull request, joined to its record. A run with one pull request is no
   * set. The members come from the run targets, so a member whose record is not written yet is known.
   */
  async changeSetOfPullRequest(tenantId: string, pullRequestId: string): Promise<ChangeSet | null> {
    const row = await this.prisma.pullRequest.findFirst({ where: { id: pullRequestId, tenantId }, select: { originRunId: true } });
    return row === null ? null : await this.changeSetOfRun(tenantId, row.originRunId);
  }

  async changeSetOfRun(tenantId: string, originRunId: string): Promise<ChangeSet | null> {
    const targets = await this.prisma.runTarget.findMany({
      where: { tenantId, runId: originRunId },
      select: {
        repositoryId: true,
        pullRequestUrl: true,
        pullRequestNumber: true,
        repository: { select: { fullName: true, githubInstallationId: true } },
      },
    });
    const ordered = [...targets].sort((left, right) => left.repository.fullName.toLowerCase().localeCompare(right.repository.fullName.toLowerCase()));
    const opened = ordered.filter((target) => target.pullRequestUrl !== null && target.pullRequestNumber !== null);
    if (opened.length < 2) return null;
    const rows = await this.prisma.pullRequest.findMany({ where: { tenantId, originRunId }, include });
    const edges = await this.prisma.runTargetEdge.findMany({
      where: { tenantId, runId: originRunId },
      select: {
        provider: { select: { repository: { select: { fullName: true } } } },
        consumer: { select: { repository: { select: { fullName: true } } } },
      },
    });
    const members: ChangeSetMember[] = opened.map((target) => {
      const number = target.pullRequestNumber ?? 0;
      const record = rows.find((candidate) => candidate.repositoryId === target.repositoryId && candidate.number === number) ?? null;
      return {
        repositoryId: target.repositoryId,
        repositoryFullName: target.repository.fullName,
        githubInstallationId: target.repository.githubInstallationId,
        number,
        url: target.pullRequestUrl ?? "",
        workflowId: record?.workflowId ?? pullRequestWorkflowId(tenantId, target.repository.fullName, number),
        record: record === null ? null : toRecord(record),
        statusKey: record?.changeSetStatusKey ?? null,
      };
    });
    return {
      originRunId,
      targets: ordered.map((target) => target.repository.fullName),
      members,
      edges: edges.map((edge) => ({ provider: edge.provider.repository.fullName, consumer: edge.consumer.repository.fullName })),
    };
  }

  async markChangeSetStatus(tenantId: string, pullRequestId: string, key: string): Promise<void> {
    await this.prisma.pullRequest.updateMany({ where: { id: pullRequestId, tenantId }, data: { changeSetStatusKey: key } });
  }

  async changeSetLock(tenantId: string, originRunId: string): Promise<ChangeSetLock> {
    const row = await this.prisma.run.findFirst({
      where: { id: originRunId, tenantId },
      select: { changeSetLockHolder: true, changeSetLockRun: true, changeSetLockAt: true },
    });
    if (row === null) throw new Error(`no run "${originRunId}" of tenant "${tenantId}"`);
    return { holder: row.changeSetLockHolder, runWorkflowId: row.changeSetLockRun, at: row.changeSetLockAt };
  }

  async acquireChangeSetLock(
    tenantId: string,
    originRunId: string,
    lock: { holder: string; runWorkflowId: string | null; at: Date; replaces: string | null },
  ): Promise<boolean> {
    // DI-21.158. One conditional write, so two PR workflows of the set never both take it.
    const updated = await this.prisma.run.updateMany({
      where: {
        id: originRunId,
        tenantId,
        OR: [
          { changeSetLockHolder: null },
          { changeSetLockHolder: lock.holder },
          ...(lock.replaces === null ? [] : [{ changeSetLockHolder: lock.replaces }]),
        ],
      },
      data: { changeSetLockHolder: lock.holder, changeSetLockRun: lock.runWorkflowId, changeSetLockAt: lock.at },
    });
    return updated.count > 0;
  }

  async recordCheckedHead(
    tenantId: string,
    pullRequestId: string,
    head: { headSha: string; baseSha: string; runId: string; autonomyLevel: string },
  ): Promise<boolean> {
    const updated = await this.prisma.pullRequest.updateMany({
      where: { id: pullRequestId, tenantId, headSha: head.headSha, state: "open" },
      data: { verifiedHeadSha: head.headSha, verifiedBaseSha: head.baseSha, verifiedRunId: head.runId, autonomyLevel: head.autonomyLevel },
    });
    return updated.count > 0;
  }

  async releaseChangeSetLock(tenantId: string, originRunId: string, holder: string): Promise<void> {
    await this.prisma.run.updateMany({
      where: { id: originRunId, tenantId, changeSetLockHolder: holder },
      data: { changeSetLockHolder: null, changeSetLockRun: null, changeSetLockAt: null },
    });
  }

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
        verifiedBaseSha: input.baseSha,
        verifiedRunId: input.runId,
        workflowId: pullRequestWorkflowId(input.tenantId, repository.fullName, input.number),
      },
      // DI-9.8. The pull request existed. The origin run and the workflow id stay. The pushed head
      // is verified, so it, its base, its run and the level of its run replace the old ones
      // (DI-21.104). A PR follow-up run also moves the contract revision.
      update: {
        headSha: input.headSha,
        url: input.url,
        verifiedHeadSha: input.headSha,
        autonomyLevel: input.autonomyLevel,
        verifiedBaseSha: input.baseSha,
        verifiedRunId: input.runId,
        ...(input.contractRevision === undefined ? {} : { contractRevision: input.contractRevision }),
      },
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
      const facts = factsOf(event, current);
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

  async originFacts(tenantId: string, pullRequestId: string): Promise<PullRequestOriginFacts> {
    const row = await this.prisma.pullRequest.findFirst({
      where: { id: pullRequestId, tenantId },
      select: {
        repository: { select: { productId: true, githubInstallationId: true } },
        originRun: {
          select: { temporalWorkflowId: true, linearAgentSessionId: true, linearIssueId: true, workItemTitle: true, workItemUrl: true },
        },
      },
    });
    if (row === null) throw new Error(`no pull request "${pullRequestId}" of tenant "${tenantId}"`);
    return {
      productId: row.repository.productId,
      githubInstallationId: row.repository.githubInstallationId,
      originWorkflowId: row.originRun.temporalWorkflowId,
      linearAgentSessionId: row.originRun.linearAgentSessionId,
      linearIssueId: row.originRun.linearIssueId,
      workItemTitle: row.originRun.workItemTitle,
      workItemUrl: row.originRun.workItemUrl,
    };
  }

  async markReviewerHandled(tenantId: string, pullRequestId: string, key: string): Promise<boolean> {
    // One conditional write, so two deliveries of one check never both start a triage.
    const updated = await this.prisma.pullRequest.updateMany({
      where: { id: pullRequestId, tenantId, OR: [{ reviewerHandledKey: null }, { reviewerHandledKey: { not: key } }] },
      data: { reviewerHandledKey: key },
    });
    return updated.count > 0;
  }

  async addAnsweredFingerprints(tenantId: string, pullRequestId: string, fingerprints: readonly string[]): Promise<void> {
    if (fingerprints.length === 0) return;
    // One transaction: read the list and write the union, so a retry adds nothing twice.
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.pullRequest.findFirst({ where: { id: pullRequestId, tenantId }, select: { answeredFindingFingerprints: true } });
      if (row === null) throw new Error(`no pull request "${pullRequestId}" of tenant "${tenantId}"`);
      const known = new Set(row.answeredFindingFingerprints);
      const added = [...new Set(fingerprints)].filter((fingerprint) => !known.has(fingerprint));
      if (added.length === 0) return;
      await tx.pullRequest.updateMany({ where: { id: pullRequestId, tenantId }, data: { answeredFindingFingerprints: { push: added } } });
    });
  }

  async markReviewAppNotice(tenantId: string, pullRequestId: string, key: string): Promise<boolean> {
    const updated = await this.prisma.pullRequest.updateMany({
      where: { id: pullRequestId, tenantId, OR: [{ reviewAppNoticeKey: null }, { reviewAppNoticeKey: { not: key } }] },
      data: { reviewAppNoticeKey: key },
    });
    return updated.count > 0;
  }

  async countReviewerFollowUp(tenantId: string, pullRequestId: string, key: string): Promise<number> {
    // DI-21.114. One conditional write: the key joins the list and the count moves only when the
    // list does not hold the key yet, so a retry after a successful write counts nothing.
    await this.prisma.pullRequest.updateMany({
      where: { id: pullRequestId, tenantId, NOT: { reviewerFollowUpKeys: { has: key } } },
      data: { reviewerFollowUps: { increment: 1 }, reviewerFollowUpKeys: { push: key } },
    });
    const row = await this.prisma.pullRequest.findFirst({ where: { id: pullRequestId, tenantId }, select: { reviewerFollowUps: true } });
    if (row === null) throw new Error(`no pull request "${pullRequestId}" of tenant "${tenantId}"`);
    return row.reviewerFollowUps;
  }

  async markBringCurrentTried(tenantId: string, pullRequestId: string, headSha: string): Promise<void> {
    const updated = await this.prisma.pullRequest.updateMany({ where: { id: pullRequestId, tenantId }, data: { bringCurrentHeadSha: headSha } });
    if (updated.count === 0) throw new Error(`no pull request "${pullRequestId}" of tenant "${tenantId}"`);
  }

  async listOpenByAgentSession(tenantId: string, agentSessionId: string): Promise<PublishedPullRequest[]> {
    const rows = await this.prisma.pullRequest.findMany({
      where: { tenantId, state: "open", originRun: { linearAgentSessionId: agentSessionId } },
      orderBy: { createdAt: "asc" },
      take: 20,
      include,
    });
    return rows.map(toRecord);
  }

  async listOpenByBase(tenantId: string, repositoryFullName: string, baseBranch: string): Promise<PublishedPullRequest[]> {
    const rows = await this.prisma.pullRequest.findMany({
      where: { tenantId, state: "open", baseBranch, repository: { fullName: { equals: repositoryFullName, mode: "insensitive" } } },
      orderBy: { createdAt: "asc" },
      take: 200,
      include,
    });
    return rows.map(toRecord);
  }

  async listEvents(tenantId: string, pullRequestId: string, kind: PullRequestEvent["kind"]): Promise<PullRequestEvent[]> {
    const rows = await this.prisma.pullRequestEvent.findMany({
      where: { tenantId, pullRequestId, kind },
      orderBy: { receivedAt: "asc" },
      take: 500,
      select: { payload: true },
    });
    return rows.map((row) => row.payload as unknown as PullRequestEvent);
  }

  async listMergedForDeploy(tenantId: string, repositoryFullName: string, environment: string, since: Date): Promise<PublishedPullRequest[]> {
    const rows = await this.prisma.pullRequest.findMany({
      where: {
        tenantId,
        state: "merged",
        closedAt: { gte: since },
        repository: { fullName: { equals: repositoryFullName, mode: "insensitive" } },
        deploys: { none: { key: deployKeyOf({ state: "success", environment, deploymentId: "" }) } },
      },
      orderBy: { closedAt: "asc" },
      take: 200,
      include,
    });
    return rows.map(toRecord);
  }

  async listDeploys(tenantId: string, pullRequestId: string): Promise<PullRequestDeployRecord[]> {
    const rows = await this.prisma.pullRequestDeploy.findMany({ where: { tenantId, pullRequestId }, orderBy: { createdAt: "asc" }, take: 200 });
    return rows.map(toDeploy);
  }

  async recordDeploy(input: RecordDeployInput): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const owner = await tx.pullRequest.findFirst({ where: { id: input.pullRequestId, tenantId: input.tenantId }, select: { id: true } });
      if (owner === null) throw new Error(`no pull request "${input.pullRequestId}" of tenant "${input.tenantId}" took the deploy`);
      const inserted = await tx.pullRequestDeploy.createMany({
        data: [
          {
            tenantId: input.tenantId,
            pullRequestId: input.pullRequestId,
            runId: input.runId,
            key: deployKeyOf(input),
            environment: input.environment,
            state: input.state,
            deploymentId: input.deploymentId,
            sha: input.sha,
            previousSha: input.previousSha,
            logUrl: input.logUrl,
            environmentUrl: input.environmentUrl,
            deliveryId: input.deliveryId,
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 0) return false;
      if (input.state === "success") {
        await tx.pullRequestDeploy.updateMany({
          where: { tenantId: input.tenantId, pullRequestId: input.pullRequestId, environment: input.environment, state: "failure", resolvedAt: null },
          data: { resolvedAt: new Date() },
        });
      }
      return true;
    });
  }

  async setDeployIssueMove(tenantId: string, deployId: string, move: DeployIssueMoveState, stateName: string | null): Promise<void> {
    const updated = await this.prisma.pullRequestDeploy.updateMany({ where: { id: deployId, tenantId }, data: { issueMove: move, issueStateName: stateName } });
    if (updated.count === 0) throw new Error(`no deploy "${deployId}" of tenant "${tenantId}" took the issue move`);
  }

  async openDeployFailure(tenantId: string, agentSessionId: string): Promise<OpenDeployFailure | null> {
    const row = await this.prisma.pullRequestDeploy.findFirst({
      where: {
        tenantId,
        state: "failure",
        resolvedAt: null,
        followUpWorkflowId: null,
        pullRequest: { originRun: { linearAgentSessionId: agentSessionId } },
      },
      orderBy: { createdAt: "desc" },
      include: { pullRequest: { select: { url: true, mergeCommitSha: true } } },
    });
    if (row === null) return null;
    return {
      id: row.id,
      runId: row.runId,
      environment: row.environment,
      sha: row.sha,
      previousSha: row.previousSha,
      logUrl: row.logUrl,
      pullRequestUrl: row.pullRequest.url,
      mergeCommitSha: row.pullRequest.mergeCommitSha,
    };
  }

  async markDeployFollowedUp(tenantId: string, deployId: string, workflowId: string): Promise<boolean> {
    const updated = await this.prisma.pullRequestDeploy.updateMany({
      where: { id: deployId, tenantId, followUpWorkflowId: null },
      data: { followUpWorkflowId: workflowId },
    });
    return updated.count > 0;
  }
}
