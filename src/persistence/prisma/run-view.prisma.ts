import type { Prisma } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import {
  decodeRunCursor,
  encodeRunCursor,
  type RunDetail,
  type RunListItem,
  type RunListPage,
  type RunListQuery,
  type RunViewReader,
} from "~/domain/runs/run-view.js";
import { isTerminalRunStatus, type RunStatus } from "~/domain/runs/run-status.js";
import { takesFollowUp } from "~/domain/runs/run-recovery.js";
import { decideDraft } from "~/domain/runs/run-draft.js";
import { PrismaRunDraftStore } from "./run-draft.prisma.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The repair limit a proof pack recorded, under `run.repairLimit`. */
const repairLimitOf = (document: Prisma.JsonValue | null): number | null => {
  if (!isRecord(document)) return null;
  const run = document["run"];
  return isRecord(run) && typeof run["repairLimit"] === "number" ? run["repairLimit"] : null;
};

/** The work item a proof pack recorded, for a run from before the work item columns. */
const workItemOf = (document: Prisma.JsonValue | null): { title: string | null; url: string | null } => {
  const item = isRecord(document) ? document["workItem"] : null;
  return {
    title: isRecord(item) && typeof item["title"] === "string" ? item["title"] : null,
    url: isRecord(item) && typeof item["url"] === "string" ? item["url"] : null,
  };
};

const runSelect = {
  id: true,
  productId: true,
  status: true,
  failureReason: true,
  failureMessage: true,
  workItemTitle: true,
  workItemUrl: true,
  pullRequestUrl: true,
  repairCount: true,
  proofPackDocument: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  waitedMs: true,
  sandboxProviderId: true,
  product: { select: { slug: true, name: true } },
} satisfies Prisma.RunSelect;

type RunRow = Prisma.RunGetPayload<{ select: typeof runSelect }>;

const toListItem = (row: RunRow, costUsd: number | null, providerNames: ReadonlyMap<string, string> = new Map()): RunListItem => ({
  id: row.id,
  productId: row.productId,
  productSlug: row.product.slug,
  productName: row.product.name,
  status: row.status,
  failureReason: row.failureReason,
  failureMessage: row.failureMessage,
  workItemTitle: row.workItemTitle ?? workItemOf(row.proofPackDocument).title,
  workItemUrl: row.workItemUrl ?? workItemOf(row.proofPackDocument).url,
  pullRequestUrl: row.pullRequestUrl,
  repairCount: row.repairCount,
  repairLimit: repairLimitOf(row.proofPackDocument),
  costUsd,
  createdAt: row.createdAt,
  completedAt: row.completedAt,
  durationMs:
    row.completedAt === null
      ? null
      : Math.max(0, row.completedAt.getTime() - (row.startedAt ?? row.createdAt).getTime() - row.waitedMs),
  waitedMs: row.waitedMs,
  sandboxProvider: row.sandboxProviderId === null ? null : (providerNames.get(row.sandboxProviderId) ?? row.sandboxProviderId),
});

/** docs/specs/run-visibility.md. Every query carries the tenant. SDD section 52. */
export class PrismaRunViewReader implements RunViewReader {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  /** docs/specs/sandbox-provider-spillover.md. The name of each sandbox provider, by id. */
  private async providerNames(): Promise<Map<string, string>> {
    const rows = await this.prisma.sandboxProvider.findMany({ select: { id: true, name: true } });
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private async costs(tenantId: string, runIds: string[]): Promise<Map<string, number | null>> {
    const sums = await this.prisma.agentSession.groupBy({
      by: ["runId"],
      where: { tenantId, runId: { in: runIds } },
      _sum: { costUsd: true },
    });
    return new Map(sums.map((sum) => [sum.runId, sum._sum.costUsd]));
  }

  async list(query: RunListQuery): Promise<RunListPage> {
    const cursor = query.cursor === undefined ? null : decodeRunCursor(query.cursor);
    const rows = await this.prisma.run.findMany({
      where: {
        tenantId: query.tenantId,
        ...(query.productId === undefined ? {} : { productId: query.productId }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(cursor === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      select: runSelect,
    });
    const page = rows.slice(0, query.limit);
    const costs = await this.costs(
      query.tenantId,
      page.map((row) => row.id),
    );
    const names = await this.providerNames();
    const last = page.at(-1);
    return {
      items: page.map((row) => toListItem(row, costs.get(row.id) ?? null, names)),
      nextCursor: rows.length > query.limit && last !== undefined ? encodeRunCursor(last.createdAt, last.id) : null,
    };
  }

  /** docs/specs/draft-of-failed-run.md. Only a failed run can qualify, so only it reads the facts. */
  private async draftQualifies(tenantId: string, runId: string, status: string): Promise<boolean> {
    if (!takesFollowUp(status)) return false;
    const facts = await new PrismaRunDraftStore(this.prisma).facts(tenantId, runId);
    return facts !== null && decideDraft(facts).kind === "qualifies";
  }

  async detail(tenantId: string, runId: string): Promise<RunDetail | null> {
    const row = await this.prisma.run.findFirst({
      where: { tenantId, id: runId },
      select: {
        ...runSelect,
        temporalWorkflowId: true,
        autonomyLevel: true,
        followUpOfRunId: true,
        baseSha: true,
        commitSha: true,
        patchSha256: true,
        skillRegistrySet: true,
        skillResolutionId: true,
        proofPackPostedAt: true,
        stopRequestedAt: true,
        stopSource: true,
        stopRequestedBy: true,
        draftRequestedAt: true,
        draftSource: true,
        draftRequestedBy: true,
        product: { select: { slug: true, name: true, sandboxRetentionHours: true } },
      },
    });
    if (row === null) return null;
    const where = { tenantId, runId };
    const [costs, stages, sessions, results, findings, skills, proposals] = await Promise.all([
      this.costs(tenantId, [runId]),
      this.prisma.runStage.findMany({ where, orderBy: [{ startedAt: "asc" }, { id: "asc" }] }),
      this.prisma.agentSession.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
      this.prisma.validationAssertionResult.findMany({
        where,
        orderBy: [{ attempt: "asc" }, { assertionKey: "asc" }],
        include: { assertion: { select: { method: true, statement: true } } },
      }),
      this.prisma.reviewFinding.findMany({ where, orderBy: [{ attempt: "asc" }, { findingKey: "asc" }] }),
      this.prisma.runSkill.findMany({ where, orderBy: [{ name: "asc" }] }),
      this.prisma.runSkillProposal.findMany({ where, orderBy: { createdAt: "asc" } }),
    ]);
    return {
      ...toListItem(row, costs.get(runId) ?? null, await this.providerNames()),
      temporalWorkflowId: row.temporalWorkflowId,
      terminal: isTerminalRunStatus(row.status as RunStatus),
      stopRequestedAt: row.stopRequestedAt,
      stopSource: row.stopSource,
      stopRequestedBy: row.stopRequestedBy,
      draftQualifies: await this.draftQualifies(tenantId, runId, row.status),
      draftRequestedAt: row.draftRequestedAt,
      draftSource: row.draftSource,
      draftRequestedBy: row.draftRequestedBy,
      sandboxRetentionHours: row.product.sandboxRetentionHours,
      autonomyLevel: row.autonomyLevel,
      followUpOfRunId: row.followUpOfRunId,
      baseSha: row.baseSha,
      commitSha: row.commitSha,
      patchSha256: row.patchSha256,
      skillRegistrySet: row.skillRegistrySet,
      skillResolutionId: row.skillResolutionId,
      proofPackPostedAt: row.proofPackPostedAt,
      proofPackDocument: row.proofPackDocument,
      stages: stages.map((stage) => ({
        stage: stage.stage,
        attempt: stage.attempt,
        sandboxId: stage.sandboxId,
        startedAt: stage.startedAt,
        endedAt: stage.endedAt,
      })),
      sessions: sessions.map((session) => ({
        role: session.role,
        attempt: session.attempt,
        runner: session.runner,
        model: session.model,
        effort: session.effort,
        outcome: session.outcome,
        durationMs: session.durationMs,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        reasoningTokens: session.reasoningTokens,
        cacheReadTokens: session.cacheReadTokens,
        costUsd: session.costUsd,
        turns: session.turns,
        modelMs: session.modelMs,
        toolMs: session.toolMs,
        createdAt: session.createdAt,
      })),
      assertions: results.map((result) => ({
        key: result.assertionKey,
        attempt: result.attempt,
        method: result.assertion.method,
        statement: result.assertion.statement,
        result: result.result,
        reason: result.reason,
      })),
      findings: findings.map((finding) => ({
        attempt: finding.attempt,
        key: finding.findingKey,
        severity: finding.severity,
        category: finding.category,
        evidence: finding.evidence,
        description: finding.description,
        blocking: finding.blocking,
        decisionReason: finding.decisionReason,
      })),
      skills: skills.map((skill) => ({
        source: skill.source,
        name: skill.name,
        version: skill.version,
        listed: skill.listed,
        activated: skill.activated,
      })),
      skillProposals: proposals.map((proposal) => ({
        name: proposal.name,
        source: proposal.source,
        state: proposal.state,
        url: proposal.url,
        reason: proposal.reason,
      })),
    };
  }
}
