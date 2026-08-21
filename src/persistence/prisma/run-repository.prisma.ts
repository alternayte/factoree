import { Prisma } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import type {
  CreateRunInput,
  RunRecord,
  RunRepository,
  RunStatusPatch,
} from "~/domain/runs/run-repository.js";
import type { RunFailureReason, RunStatus } from "~/domain/runs/run-status.js";

type RunRow = Awaited<ReturnType<FactoreePrismaClient["run"]["findFirst"]>>;

const toRecord = (row: NonNullable<RunRow>): RunRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  projectId: row.projectId,
  linearIssueId: row.linearIssueId,
  linearAgentSessionId: row.linearAgentSessionId,
  temporalWorkflowId: row.temporalWorkflowId,
  status: row.status as RunStatus,
  failureReason: (row.failureReason as RunFailureReason | null) ?? null,
  autonomyLevel: row.autonomyLevel,
  implementerRunner: row.implementerRunner,
  validatorRunner: row.validatorRunner,
  reviewerRunner: row.reviewerRunner,
  spriteId: row.spriteId,
  baseSha: row.baseSha,
  patchSha256: row.patchSha256,
  commitSha: row.commitSha,
  pullRequestUrl: row.pullRequestUrl,
  contextContractVersion: row.contextContractVersion,
  validationContractVersion: row.validationContractVersion,
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
          projectId: input.projectId,
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
        ...(patch.startedAt === undefined ? {} : { startedAt: patch.startedAt }),
        ...(patch.completedAt === undefined ? {} : { completedAt: patch.completedAt }),
        ...(patch.repairCount === undefined ? {} : { repairCount: patch.repairCount }),
      },
    });
    return toRecord(row);
  }
}
