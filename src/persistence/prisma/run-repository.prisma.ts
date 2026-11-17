import { Prisma } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import type { FactoreeDecision } from "~/domain/runs/factoree-decision.js";
import type { DeliveredContextEntry } from "~/domain/context/context-delivery.js";
import type {
  CreateRunInput,
  CreateRunTargetInput,
  ExpiredSandboxRun,
  PreviewTarget,
  RunSandboxPatch,
  RunTargetPatch,
  RunTargetRecord,
  SupersededSandbox,
  RunRecord,
  RunRepository,
  RunStatusPatch,
  TargetPatch,
  TargetPublication,
} from "~/domain/runs/run-repository.js";
import { TERMINAL_RUN_STATUSES, type RunFailureReason, type RunStatus } from "~/domain/runs/run-status.js";
import type { RunFailureCategory } from "~/domain/runs/failure-category.js";
import { pullRequestNumberOf, type IssueStateRecord, type PullRequestState } from "~/domain/runs/issue-status.js";
import type { ClosedPullRequestRun } from "~/domain/runs/run-repository.js";

type RunRow = Awaited<ReturnType<FactoreePrismaClient["run"]["findFirst"]>>;

const toRecord = (row: NonNullable<RunRow>): RunRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  productId: row.productId,
  linearIssueId: row.linearIssueId,
  linearAgentSessionId: row.linearAgentSessionId,
  temporalWorkflowId: row.temporalWorkflowId,
  status: row.status as RunStatus,
  failureReason: (row.failureReason as RunFailureReason | null) ?? null,
  failureCategory: (row.failureCategory as RunFailureCategory | null) ?? null,
  autonomyLevel: row.autonomyLevel,
  implementerRunner: row.implementerRunner,
  validatorRunner: row.validatorRunner,
  reviewerRunner: row.reviewerRunner,
  spriteId: row.spriteId,
  spriteAdapter: row.spriteAdapter,
  sandboxProviderId: row.sandboxProviderId,
  spriteRetainUntil: row.spriteRetainUntil,
  contextContractVersion: row.contextContractVersion,
  validationContractVersion: row.validationContractVersion,
  organizationSkillsSha: row.organizationSkillsSha ?? null,
  proofPackSha256: row.proofPackSha256,
  proofPackPostedAt: row.proofPackPostedAt,
  proofPackDocument: (row.proofPackDocument as Record<string, unknown> | null) ?? null,
  proofPackInput: (row.proofPackInput as Record<string, unknown> | null) ?? null,
  decisions: (row.decisions as unknown as FactoreeDecision[] | null) ?? [],
  repairCount: row.repairCount,
  createdAt: row.createdAt,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
  issueStateFromId: row.issueStateFromId ?? null,
  issueStateSetId: row.issueStateSetId ?? null,
});

const pullRequestStateOf = (value: string | null): PullRequestState =>
  value === "merged" || value === "closed" ? value : "open";

export class PrismaRunRepository implements RunRepository {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async createIfAbsent(input: CreateRunInput): Promise<{ run: RunRecord; created: boolean }> {
    try {
      const row = await this.prisma.run.create({
        data: {
          tenantId: input.tenantId,
          productId: input.productId,
          linearIssueId: input.linearIssueId,
          linearAgentSessionId: input.linearAgentSessionId,
          temporalWorkflowId: input.temporalWorkflowId,
          autonomyLevel: input.autonomyLevel,
          workItemTitle: input.workItemTitle ?? null,
          workItemUrl: input.workItemUrl ?? null,
          followUpOfRunId: input.followUpOfRunId ?? null,
          status: "RECEIVED",
        },
      });
      return { run: toRecord(row), created: true };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // One workflow makes one run, so a retried create finds the row of its own workflow.
        const existing = await this.prisma.run.findUnique({
          where: { temporalWorkflowId: input.temporalWorkflowId },
        });
        if (existing) return { run: toRecord(existing), created: false };
      }
      throw error;
    }
  }

  async adoptWaiting(temporalWorkflowId: string): Promise<RunRecord | null> {
    // The status condition makes the adoption and the cancel of a stop exclude each other.
    const { count } = await this.prisma.run.updateMany({
      where: { temporalWorkflowId, status: "WAITING_FOR_BLOCKERS" },
      data: { status: "RECEIVED" },
    });
    if (count === 0) return null;
    const row = await this.prisma.run.findUnique({ where: { temporalWorkflowId } });
    return row ? toRecord(row) : null;
  }

  async findById(tenantId: string, id: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findFirst({ where: { id, tenantId } });
    return row ? toRecord(row) : null;
  }

  async findByAgentSession(tenantId: string, agentSessionId: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findFirst({
      where: { tenantId, linearAgentSessionId: agentSessionId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return row ? toRecord(row) : null;
  }

  /**
   * docs/specs/change-sets.md. The run target of one repository. GitHub names a repository with its
   * own case, so the match ignores case. The tenant filter is part of the query (SDD section 52).
   */
  private targetWhere(tenantId: string, runId: string, repositoryFullName: string) {
    return {
      tenantId,
      runId,
      repository: { fullName: { equals: repositoryFullName, mode: "insensitive" as const } },
    };
  }

  async recordLastPatch(
    tenantId: string,
    runId: string,
    repositoryFullName: string,
    patchBase64: string,
    attempt: number,
  ): Promise<void> {
    const updated = await this.prisma.runTarget.updateMany({
      where: this.targetWhere(tenantId, runId, repositoryFullName),
      data: { lastPatchBase64: patchBase64, lastPatchAttempt: attempt },
    });
    if (updated.count === 0) {
      throw new Error(`no RunTarget of run "${runId}" and repository "${repositoryFullName}" received the last patch`);
    }
  }

  async lastPatch(tenantId: string, runId: string, repositoryFullName: string): Promise<string | null> {
    const row = await this.prisma.runTarget.findFirst({
      where: this.targetWhere(tenantId, runId, repositoryFullName),
      select: { lastPatchBase64: true },
    });
    return row?.lastPatchBase64 ?? null;
  }

  async lastPatches(tenantId: string, runId: string): Promise<TargetPatch[]> {
    const rows = await this.prisma.runTarget.findMany({
      where: { tenantId, runId, lastPatchBase64: { not: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { lastPatchBase64: true, lastPatchAttempt: true, repository: { select: { fullName: true } } },
    });
    return rows.flatMap((row) =>
      row.lastPatchBase64 === null
        ? []
        : [{ repositoryFullName: row.repository.fullName, patchBase64: row.lastPatchBase64, attempt: row.lastPatchAttempt }],
    );
  }

  async updateStatus(id: string, status: RunStatus, patch: RunStatusPatch = {}): Promise<RunRecord> {
    // docs/specs/sandbox-provider-spillover.md. A terminal run gives back the held slots that no
    // sandbox uses, in the same step. A retained work sprite keeps its lease until its delete.
    if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(status)) {
      const [row] = await this.prisma.$transaction([
        this.prisma.run.update({ where: { id }, data: this.statusData(status, patch) }),
        this.prisma.sandboxLease.deleteMany({ where: { runId: id, held: true, sandboxId: null } }),
      ]);
      return toRecord(row);
    }
    const row = await this.prisma.run.update({ where: { id }, data: this.statusData(status, patch) });
    return toRecord(row);
  }

  private statusData(status: RunStatus, patch: RunStatusPatch) {
    return {
      status,
      ...(patch.failureReason === undefined ? {} : { failureReason: patch.failureReason }),
      ...(patch.failureCategory === undefined ? {} : { failureCategory: patch.failureCategory }),
      ...(patch.startedAt === undefined ? {} : { startedAt: patch.startedAt }),
      ...(patch.completedAt === undefined ? {} : { completedAt: patch.completedAt }),
      ...(patch.waitedMs === undefined ? {} : { waitedMs: patch.waitedMs }),
      ...(patch.repairCount === undefined ? {} : { repairCount: patch.repairCount }),
      ...(patch.failureMessage === undefined ? {} : { failureMessage: patch.failureMessage }),
    };
  }

  async setSandboxProvider(tenantId: string, runId: string, providerId: string | null): Promise<void> {
    // The tenant filter is part of the query. SDD section 52 forbids a write across the boundary.
    await this.prisma.run.updateMany({ where: { id: runId, tenantId }, data: { sandboxProviderId: providerId } });
  }

  async setSandbox(
    tenantId: string,
    runId: string,
    sandbox: RunSandboxPatch,
  ): Promise<SupersededSandbox> {
    // The row lock makes the read and the write one atomic step. Two concurrent activity
    // attempts therefore see different previous values, and each deletes only the sandbox it
    // really replaced. The tenant filter is part of the query. SDD section 52 forbids relying
    // on the caller.
    return await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ spriteId: string | null; spriteAdapter: string | null }>>`
        SELECT "spriteId", "spriteAdapter" FROM "Run"
        WHERE "id" = ${runId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      const previous = rows[0];
      const updated = await tx.run.updateMany({
        where: { id: runId, tenantId },
        data: {
          spriteId: sandbox.spriteId,
          spriteAdapter: sandbox.adapter,
          spriteRetainUntil: sandbox.retainUntil,
          implementerRunner: sandbox.implementerRunner,
          ...(sandbox.organizationSkillsSha === undefined
            ? {}
            : { organizationSkillsSha: sandbox.organizationSkillsSha }),
        },
      });
      // A write that reaches no row must not report success. The Run would then hold no
      // reference to the sandbox, the activity would report a prepared sandbox anyway, and the
      // reaper could never find it. A wrong Run or a wrong tenant lands here.
      if (updated.count === 0) {
        throw new Error(`no Run "${runId}" of tenant "${tenantId}" received the sandbox reference`);
      }
      return {
        spriteId: previous?.spriteId ?? null,
        adapter: previous?.spriteAdapter ?? null,
      };
    });
  }

  async setDeliveredContext(tenantId: string, runId: string, entries: DeliveredContextEntry[]): Promise<void> {
    // The tenant filter is part of the query. SDD section 52 forbids a write across the boundary.
    const updated = await this.prisma.run.updateMany({
      where: { id: runId, tenantId },
      data: { deliveredContext: entries as unknown as Prisma.InputJsonValue },
    });
    if (updated.count === 0) {
      throw new Error(`no Run "${runId}" of tenant "${tenantId}" received the delivered context`);
    }
  }

  async clearSandbox(tenantId: string, runId: string): Promise<void> {
    await this.prisma.run.updateMany({
      where: { id: runId, tenantId },
      data: { spriteId: null, spriteAdapter: null, spriteRetainUntil: null },
    });
  }

  async setContextContractVersion(tenantId: string, runId: string, version: string): Promise<void> {
    // The tenant filter is part of the query. SDD section 52 forbids a write across the boundary.
    const updated = await this.prisma.run.updateMany({
      where: { id: runId, tenantId },
      data: { contextContractVersion: version },
    });
    // A write that reaches no row must not report success. This value is the only record the
    // Phase 4 exit evidence reads off the Run. A wrong Run or a wrong tenant is a caller defect.
    // A silent success makes a Run that holds a frozen contract report that it holds none.
    if (updated.count === 0) {
      throw new Error(
        `no Run "${runId}" of tenant "${tenantId}" received the Context Contract version`,
      );
    }
  }

  async setValidationContractVersion(tenantId: string, runId: string, version: string): Promise<void> {
    // The tenant filter is part of the query. SDD section 52 forbids a write across the boundary.
    const updated = await this.prisma.run.updateMany({
      where: { id: runId, tenantId },
      data: { validationContractVersion: version },
    });
    // A write that reaches no row must not report success. This value names the exact frozen
    // Validation Contract the Run must satisfy. A wrong Run or a wrong tenant is a caller defect.
    // A silent success makes a Run that holds a frozen contract report that it holds none.
    if (updated.count === 0) {
      throw new Error(
        `no Run "${runId}" of tenant "${tenantId}" received the Validation Contract version`,
      );
    }
  }

  async setPublication(
    tenantId: string,
    runId: string,
    repositoryFullName: string,
    publication: TargetPublication,
  ): Promise<void> {
    // DI-21.51. The pull request number matches the pull_request event, and a published pull
    // request is open, as `updateRunTarget` records it.
    const updated = await this.prisma.runTarget.updateMany({
      where: this.targetWhere(tenantId, runId, repositoryFullName),
      data: {
        patchSha256: publication.patchSha256,
        commitSha: publication.commitSha,
        pullRequestUrl: publication.pullRequestUrl,
        pullRequestNumber: pullRequestNumberOf(publication.pullRequestUrl),
        pullRequestState: "open",
      },
    });
    // A write that reaches no row must not report success. These values name the exact
    // publication facts of the target. A wrong Run, repository or tenant is a caller defect. A
    // silent success makes a target that holds publication facts report that it holds none.
    if (updated.count === 0) {
      throw new Error(
        `no RunTarget of run "${runId}" and repository "${repositoryFullName}" of tenant "${tenantId}" received the publication facts`,
      );
    }
  }

  async setProofPack(
    tenantId: string,
    runId: string,
    proofPack: { sha256: string; postedAt: Date; document: Record<string, unknown>; input?: Record<string, unknown> },
  ): Promise<void> {
    // The tenant filter is part of the query. SDD section 52 forbids a write across the boundary.
    const updated = await this.prisma.run.updateMany({
      where: { id: runId, tenantId },
      data: {
        proofPackSha256: proofPack.sha256,
        proofPackPostedAt: proofPack.postedAt,
        proofPackDocument: proofPack.document as Prisma.InputJsonObject,
        ...(proofPack.input === undefined ? {} : { proofPackInput: proofPack.input as Prisma.InputJsonObject }),
      },
    });
    // SDD section 68 reads this value to decide whether the Run can complete. A silent success
    // makes a Run that posted a Proof Pack report that it posted none.
    if (updated.count === 0) {
      throw new Error(`no Run "${runId}" of tenant "${tenantId}" received the Proof Pack facts`);
    }
  }

  async setAutonomyLevel(tenantId: string, runId: string, level: string): Promise<void> {
    // The tenant filter is part of the query. SDD section 52 forbids a write across the boundary.
    const updated = await this.prisma.run.updateMany({
      where: { id: runId, tenantId },
      data: { autonomyLevel: level },
    });
    // A write that reaches no row must not report success. SDD section 28 makes this value the
    // cap on what the Run can do without a human. A wrong Run or a wrong tenant is a caller
    // defect, and a silent success leaves the Run at an uncapped level.
    if (updated.count === 0) {
      throw new Error(`no Run "${runId}" of tenant "${tenantId}" received the autonomy level`);
    }
  }

  async createRunTarget(input: CreateRunTargetInput): Promise<{ id: string }> {
    try {
      const row = await this.prisma.runTarget.create({
        data: {
          tenantId: input.tenantId,
          runId: input.runId,
          repositoryId: input.repositoryId,
          selectionReason: input.selectionReason,
        },
      });
      return { id: row.id };
    } catch (error) {
      // An activity retry after a lost reply finds the row its first attempt wrote.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.runTarget.findFirst({
          where: { tenantId: input.tenantId, runId: input.runId, repositoryId: input.repositoryId },
          select: { id: true },
        });
        if (existing !== null) return existing;
      }
      throw error;
    }
  }

  async updateRunTarget(
    tenantId: string,
    runId: string,
    repositoryId: string,
    patch: RunTargetPatch,
  ): Promise<void> {
    // The tenant filter is part of the query. SDD section 52 forbids a write across the boundary.
    // DI-21.51. The pull request number matches the pull_request event, and a new pull request is open.
    const number = patch.pullRequestUrl === undefined ? null : pullRequestNumberOf(patch.pullRequestUrl);
    const updated = await this.prisma.runTarget.updateMany({
      where: { runId, repositoryId, tenantId },
      data: {
        ...patch,
        ...(patch.pullRequestUrl === undefined ? {} : { pullRequestNumber: number, pullRequestState: "open" }),
      },
    });
    // A write that reaches no row must not report success. A wrong Run, repository, or tenant is
    // a caller defect, and a silent success leaves the RunTarget facts unrecorded.
    if (updated.count === 0) {
      throw new Error(
        `no RunTarget for run "${runId}" and repository "${repositoryId}" of tenant "${tenantId}" received the update`,
      );
    }
  }

  async listRunTargets(tenantId: string, runId: string): Promise<RunTargetRecord[]> {
    const rows = await this.prisma.runTarget.findMany({
      where: { runId, tenantId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { repository: { select: { fullName: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      runId: row.runId,
      repositoryId: row.repositoryId,
      selectionReason: row.selectionReason,
      baseSha: row.baseSha,
      patchSha256: row.patchSha256,
      commitSha: row.commitSha,
      pullRequestUrl: row.pullRequestUrl,
      previewUrl: row.previewUrl,
      repositoryFullName: row.repository.fullName,
      pullRequestState: row.pullRequestState === null ? null : pullRequestStateOf(row.pullRequestState),
      configSha: row.configSha,
      mergeOrder: row.mergeOrder,
    }));
  }

  async appendDecision(tenantId: string, runId: string, decision: FactoreeDecision): Promise<void> {
    // The tenant filter is part of the query. SDD section 52 forbids a write across the boundary.
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.run.findFirst({ where: { id: runId, tenantId }, select: { decisions: true } });
      if (row === null) throw new Error(`no Run "${runId}" of tenant "${tenantId}" took the decision`);
      const decisions = (row.decisions as unknown as FactoreeDecision[] | null) ?? [];
      const same = (other: FactoreeDecision): boolean =>
        other.kind === decision.kind && other.statement === decision.statement && other.reason === decision.reason;
      if (decisions.some(same)) return;
      await tx.run.update({
        where: { id: runId },
        data: { decisions: [...decisions, decision] as unknown as Prisma.InputJsonArray },
      });
    });
  }

  async setPullRequestPreview(
    tenantId: string,
    repositoryFullName: string,
    commitSha: string,
    previewUrl: string,
  ): Promise<PreviewTarget | null> {
    // The tenant filter is part of the query. SDD section 52 forbids a read across the boundary.
    const target = await this.prisma.runTarget.findFirst({
      where: { tenantId, commitSha, repository: { fullName: repositoryFullName } },
      select: { id: true, previewUrl: true, run: { select: { id: true, linearAgentSessionId: true } } },
    });
    if (target === null) return null;
    await this.prisma.runTarget.update({ where: { id: target.id }, data: { previewUrl } });
    return {
      runId: target.run.id,
      linearAgentSessionId: target.run.linearAgentSessionId,
      changed: target.previewUrl !== previewUrl,
    };
  }

  async setConfigSha(tenantId: string, runId: string, repositoryFullName: string, sha: string): Promise<void> {
    const updated = await this.prisma.runTarget.updateMany({
      where: this.targetWhere(tenantId, runId, repositoryFullName),
      data: { configSha: sha },
    });
    // A write that reaches no row must not report success. This value names the exact identity
    // file the target checked. A wrong Run, repository or tenant is a caller defect.
    if (updated.count === 0) {
      throw new Error(
        `no RunTarget of run "${runId}" and repository "${repositoryFullName}" of tenant "${tenantId}" received the config SHA`,
      );
    }
  }

  async setIssueState(tenantId: string, runId: string, state: IssueStateRecord): Promise<void> {
    // The tenant filter is part of the query. SDD section 52 forbids a write across the boundary.
    const updated = await this.prisma.run.updateMany({
      where: { id: runId, tenantId },
      data: { issueStateFromId: state.fromId, issueStateSetId: state.setId },
    });
    if (updated.count === 0) throw new Error(`no Run "${runId}" of tenant "${tenantId}" received the issue state`);
  }

  async closePullRequest(
    tenantId: string,
    repositoryFullName: string,
    number: number,
    state: "merged" | "closed",
    originRunId?: string,
  ): Promise<ClosedPullRequestRun | null> {
    // GitHub names a repository with its own case, so the match ignores case. The tenant filter is
    // part of the query, and the newest target wins when a number was reused across a rename.
    const where = {
      tenantId,
      pullRequestNumber: number,
      repository: { fullName: { equals: repositoryFullName, mode: "insensitive" as const } },
    };
    let runId: string;
    if (originRunId === undefined) {
      const target = await this.prisma.runTarget.findFirst({
        where,
        orderBy: { createdAt: "desc" },
        select: { id: true, runId: true },
      });
      if (target === null) return null;
      await this.prisma.runTarget.update({ where: { id: target.id }, data: { pullRequestState: state } });
      runId = target.runId;
    } else {
      // docs/specs/pr-review-merge-and-deploy.md, D3. The pull request record names the origin run.
      await this.prisma.runTarget.updateMany({ where, data: { pullRequestState: state } });
      runId = originRunId;
    }
    const run = await this.prisma.run.findFirstOrThrow({
      where: { id: runId, tenantId },
      select: {
        id: true,
        linearIssueId: true,
        linearAgentSessionId: true,
        issueStateFromId: true,
        issueStateSetId: true,
        targets: { where: { pullRequestUrl: { not: null } }, select: { pullRequestState: true } },
      },
    });
    return {
      runId: run.id,
      linearIssueId: run.linearIssueId,
      linearAgentSessionId: run.linearAgentSessionId,
      issueStateFromId: run.issueStateFromId,
      issueStateSetId: run.issueStateSetId,
      pullRequestStates: run.targets.map((entry) => pullRequestStateOf(entry.pullRequestState)),
    };
  }

  async countByProduct(tenantId: string, productId: string): Promise<number> {
    return this.prisma.run.count({ where: { tenantId, productId } });
  }

  async listExpiredSandboxes(now: Date, limit: number): Promise<ExpiredSandboxRun[]> {
    const rows = await this.prisma.run.findMany({
      where: { spriteId: { not: null }, spriteRetainUntil: { lte: now } },
      orderBy: { spriteRetainUntil: "asc" },
      take: limit,
      select: { id: true, tenantId: true, spriteId: true, spriteAdapter: true },
    });
    const expired: ExpiredSandboxRun[] = [];
    for (const row of rows) {
      // A Run without a recorded adapter cannot be reaped. The reaper leaves it alone, and an
      // operator can then see the row and act on it.
      if (row.spriteId === null || row.spriteAdapter === null) continue;
      expired.push({
        tenantId: row.tenantId,
        runId: row.id,
        spriteId: row.spriteId,
        adapter: row.spriteAdapter,
      });
    }
    return expired;
  }
}
