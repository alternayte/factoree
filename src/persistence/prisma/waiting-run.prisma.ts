import { Prisma } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import type { Blocker, CreateWaitingRunInput, WaitingRun, WaitingRunStore } from "~/domain/runs/blocker-wait.js";
import type { StopRequest } from "~/domain/runs/run-stop.js";
import { failureCategoryOf } from "~/domain/runs/failure-category.js";
import type { AgentRunWorkflowInput } from "~/workflows/agent-run.workflow.js";

const WAITING = "WAITING_FOR_BLOCKERS";

const waitingSelect = {
  id: true,
  tenantId: true,
  productId: true,
  linearIssueId: true,
  linearAgentSessionId: true,
  temporalWorkflowId: true,
  blockers: true,
  waitingStartInput: true,
} satisfies Prisma.RunSelect;

type WaitingRow = Prisma.RunGetPayload<{ select: typeof waitingSelect }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The stored blockers, or null for a run whose blockers were never read. */
export const blockersFromJson = (value: Prisma.JsonValue | null): Blocker[] | null => {
  if (!Array.isArray(value)) return null;
  return (value as unknown[]).flatMap((entry) => (isRecord(entry) ? [entry] : [])).map((entry) => ({
    issueId: typeof entry["issueId"] === "string" ? entry["issueId"] : "",
    identifier: typeof entry["identifier"] === "string" ? entry["identifier"] : "",
    url: typeof entry["url"] === "string" ? entry["url"] : null,
    state: typeof entry["state"] === "string" ? entry["state"] : "unknown",
    pullRequestUrl: typeof entry["pullRequestUrl"] === "string" ? entry["pullRequestUrl"] : null,
  }));
};

const toWaiting = (row: WaitingRow): WaitingRun | null =>
  isRecord(row.waitingStartInput)
    ? {
        id: row.id,
        tenantId: row.tenantId,
        productId: row.productId,
        linearIssueId: row.linearIssueId,
        linearAgentSessionId: row.linearAgentSessionId,
        temporalWorkflowId: row.temporalWorkflowId,
        blockers: blockersFromJson(row.blockers),
        startInput: row.waitingStartInput as unknown as AgentRunWorkflowInput,
      }
    : null;

const json = (blockers: Blocker[] | null): string | null => (blockers === null ? null : JSON.stringify(blockers));

/** docs/specs/blocked-by-wait.md. The waiting record is the Run row. */
export class PrismaWaitingRunStore implements WaitingRunStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async createWaiting(input: CreateWaitingRunInput): Promise<{ runId: string; created: boolean }> {
    try {
      const row = await this.prisma.run.create({
        data: {
          tenantId: input.tenantId,
          productId: input.productId,
          linearIssueId: input.linearIssueId,
          linearAgentSessionId: input.linearAgentSessionId,
          temporalWorkflowId: input.temporalWorkflowId,
          autonomyLevel: input.autonomyLevel,
          workItemTitle: input.workItemTitle,
          workItemUrl: input.workItemUrl,
          status: WAITING,
          blockers: input.blockers === null ? Prisma.DbNull : (input.blockers as unknown as Prisma.InputJsonValue),
          waitingStartInput: input.startInput as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return { runId: row.id, created: true };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.run.findUnique({
          where: { temporalWorkflowId: input.temporalWorkflowId },
          select: { id: true },
        });
        if (existing) return { runId: existing.id, created: false };
      }
      throw error;
    }
  }

  async listWaiting(tenantId?: string): Promise<WaitingRun[]> {
    const rows = await this.prisma.run.findMany({
      where: { status: WAITING, ...(tenantId === undefined ? {} : { tenantId }) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: waitingSelect,
    });
    return rows.flatMap((row) => toWaiting(row) ?? []);
  }

  async findWaiting(tenantId: string, runId: string): Promise<WaitingRun | null> {
    const row = await this.prisma.run.findFirst({ where: { tenantId, id: runId, status: WAITING }, select: waitingSelect });
    return row === null ? null : toWaiting(row);
  }

  async replaceBlockers(runId: string, previous: Blocker[] | null, next: Blocker[]): Promise<boolean> {
    // DI-21.89. jsonb equality ignores key order, and IS NOT DISTINCT FROM matches a null never read.
    const count = await this.prisma.$executeRaw`
      UPDATE "Run" SET "blockers" = ${json(next)}::jsonb
      WHERE "id" = ${runId} AND "status" = ${WAITING} AND "blockers" IS NOT DISTINCT FROM ${json(previous)}::jsonb`;
    return count === 1;
  }

  async cancel(tenantId: string, runId: string, request: StopRequest, at: Date): Promise<WaitingRun | null> {
    const row = await this.prisma.run.findFirst({ where: { tenantId, id: runId, status: WAITING }, select: waitingSelect });
    if (row === null) return null;
    // DI-21.90. The status condition makes the cancel and the adoption by the workflow exclude each other.
    const { count } = await this.prisma.run.updateMany({
      where: { tenantId, id: runId, status: WAITING },
      data: {
        status: "CANCELLED",
        failureReason: "STOPPED_BY_HUMAN",
        failureCategory: failureCategoryOf("STOPPED_BY_HUMAN"),
        completedAt: at,
        stopRequestedAt: at,
        stopSource: request.source,
        stopRequestedBy: request.by ?? null,
      },
    });
    return count === 1 ? toWaiting(row) : null;
  }

  async pullRequestsOf(tenantId: string, issueIds: readonly string[]): Promise<Map<string, string>> {
    if (issueIds.length === 0) return new Map();
    const rows = await this.prisma.run.findMany({
      where: { tenantId, linearIssueId: { in: [...issueIds] }, pullRequestUrl: { not: null } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { linearIssueId: true, pullRequestUrl: true },
    });
    const urls = new Map<string, string>();
    for (const row of rows) {
      if (row.linearIssueId !== null && row.pullRequestUrl !== null && !urls.has(row.linearIssueId)) {
        urls.set(row.linearIssueId, row.pullRequestUrl);
      }
    }
    return urls;
  }
}
