import { Prisma } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import type {
  CreateRunInput,
  CreateRunTargetInput,
  ExpiredSandboxRun,
  RunSandboxPatch,
  SupersededSandbox,
  RunRecord,
  RunRepository,
  RunStatusPatch,
} from "~/domain/runs/run-repository.js";
import type { RunFailureReason, RunStatus } from "~/domain/runs/run-status.js";
import type { RunFailureCategory } from "~/domain/runs/failure-category.js";

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
  spriteRetainUntil: row.spriteRetainUntil,
  baseSha: row.baseSha,
  patchSha256: row.patchSha256,
  commitSha: row.commitSha,
  pullRequestUrl: row.pullRequestUrl,
  contextContractVersion: row.contextContractVersion,
  validationContractVersion: row.validationContractVersion,
  organizationSkillsSha: row.organizationSkillsSha ?? null,
  proofPackSha256: row.proofPackSha256,
  proofPackPostedAt: row.proofPackPostedAt,
  repairCount: row.repairCount,
  createdAt: row.createdAt,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
});

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
          status: "RECEIVED",
        },
      });
      return { run: toRecord(row), created: true };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.run.findUnique({
          where: { linearAgentSessionId: input.linearAgentSessionId },
        });
        if (existing) return { run: toRecord(existing), created: false };
      }
      throw error;
    }
  }

  async findById(tenantId: string, id: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findFirst({ where: { id, tenantId } });
    return row ? toRecord(row) : null;
  }

  async findByAgentSession(tenantId: string, agentSessionId: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findFirst({
      where: { tenantId, linearAgentSessionId: agentSessionId },
    });
    return row ? toRecord(row) : null;
  }

  async updateStatus(id: string, status: RunStatus, patch: RunStatusPatch = {}): Promise<RunRecord> {
    const row = await this.prisma.run.update({
      where: { id },
      data: {
        status,
        ...(patch.failureReason === undefined ? {} : { failureReason: patch.failureReason }),
        ...(patch.failureCategory === undefined ? {} : { failureCategory: patch.failureCategory }),
        ...(patch.startedAt === undefined ? {} : { startedAt: patch.startedAt }),
        ...(patch.completedAt === undefined ? {} : { completedAt: patch.completedAt }),
        ...(patch.repairCount === undefined ? {} : { repairCount: patch.repairCount }),
      },
    });
    return toRecord(row);
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
          baseSha: sandbox.baseSha,
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
    publication: { patchSha256: string; commitSha: string; pullRequestUrl: string },
  ): Promise<void> {
    // The tenant filter is part of the query. SDD section 52 forbids a write across the boundary.
    const updated = await this.prisma.run.updateMany({
      where: { id: runId, tenantId },
      data: {
        patchSha256: publication.patchSha256,
        commitSha: publication.commitSha,
        pullRequestUrl: publication.pullRequestUrl,
      },
    });
    // A write that reaches no row must not report success. These values name the exact
    // publication facts of the Run. A wrong Run or a wrong tenant is a caller defect. A silent
    // success makes a Run that holds publication facts report that it holds none.
    if (updated.count === 0) {
      throw new Error(`no Run "${runId}" of tenant "${tenantId}" received the publication facts`);
    }
  }

  async setProofPack(
    tenantId: string,
    runId: string,
    proofPack: { sha256: string; postedAt: Date },
  ): Promise<void> {
    // The tenant filter is part of the query. SDD section 52 forbids a write across the boundary.
    const updated = await this.prisma.run.updateMany({
      where: { id: runId, tenantId },
      data: { proofPackSha256: proofPack.sha256, proofPackPostedAt: proofPack.postedAt },
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
    const row = await this.prisma.runTarget.create({
      data: {
        tenantId: input.tenantId,
        runId: input.runId,
        repositoryId: input.repositoryId,
        selectionReason: input.selectionReason,
        mergeOrder: input.mergeOrder,
      },
    });
    return { id: row.id };
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
