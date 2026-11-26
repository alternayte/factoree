import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { Prisma } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import { isAgentRunnerName } from "~/domain/products/agent-settings.js";
import { defaultRetroSettings, RETRO_SCHEDULES, type RetroSchedule, type RetroSettings, type RetroSettingsInput } from "~/domain/retro/retro-settings.js";
import { signalQuerySchema, type SignalSourceInput, type SignalSourceKind, type SignalSourceRecord } from "~/domain/retro/signal-source.js";
import type { CheckedFinding, RetroFindingKind, RetroFindingStatus } from "~/domain/retro/retro-finding.js";
import { titleKeyOf } from "~/domain/retro/retro-finding.js";
import type { RetroMetrics, RetroRunExport } from "~/domain/retro/retro-export.js";
import type { FetchedSignal } from "~/domain/retro/signal-fetch.js";
import { transcriptObjectKey, type KeptTranscript, type TranscriptStore } from "~/domain/retro/transcript.js";
import type { ObjectStore } from "~/adapters/s3/s3-object-store.js";
import { TERMINAL_RUN_STATUSES } from "~/domain/runs/run-status.js";

/** docs/specs/retro-agent.md. The retro settings of a tenant. A tenant with no row has the defaults. */
export class PrismaRetroSettingsStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  private toSettings(row: Prisma.RetroSettingsGetPayload<object>): RetroSettings {
    return {
      tenantId: row.tenantId,
      schedule: (RETRO_SCHEDULES as readonly string[]).includes(row.schedule) ? (row.schedule as RetroSchedule) : "off",
      weekday: row.weekday,
      hour: row.hour,
      timeZone: row.timeZone,
      productIds: row.productIds,
      runner: row.runner !== null && isAgentRunnerName(row.runner) ? row.runner : null,
      model: row.model,
      effort: row.effort,
      costCapUsd: row.costCapUsd,
    };
  }

  /** True when the tenant saved its retro settings at least once. */
  async saved(tenantId: string): Promise<boolean> {
    return (await this.prisma.retroSettings.count({ where: { tenantId } })) > 0;
  }

  async read(tenantId: string): Promise<RetroSettings> {
    const row = await this.prisma.retroSettings.findUnique({ where: { tenantId } });
    return row === null ? defaultRetroSettings(tenantId) : this.toSettings(row);
  }

  async write(tenantId: string, input: RetroSettingsInput): Promise<RetroSettings> {
    const row = await this.prisma.retroSettings.upsert({ where: { tenantId }, create: { tenantId, ...input }, update: input });
    return this.toSettings(row);
  }

  /** Every stored settings row, for the schedule reconcile at worker start. */
  async listAll(): Promise<RetroSettings[]> {
    return (await this.prisma.retroSettings.findMany()).map((row) => this.toSettings(row));
  }
}

const toSignalSource = (row: Prisma.SignalSourceGetPayload<object>): SignalSourceRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  productId: row.productId,
  name: row.name,
  kind: row.kind === "analytics" ? "analytics" : "errors",
  endpoint: row.endpoint,
  secretName: row.secretName,
  enabled: row.enabled,
  // A stored query that no longer parses is left out: it cannot run.
  queries: (Array.isArray(row.queries) ? row.queries : []).flatMap((query) => {
    const parsed = signalQuerySchema.safeParse(query);
    return parsed.success ? [parsed.data] : [];
  }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** docs/specs/retro-agent.md. The signal sources of a product. */
export class PrismaSignalSourceStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async list(tenantId: string, productId: string): Promise<SignalSourceRecord[]> {
    const rows = await this.prisma.signalSource.findMany({ where: { tenantId, productId }, orderBy: { createdAt: "asc" } });
    return rows.map(toSignalSource);
  }

  async create(tenantId: string, productId: string, input: SignalSourceInput): Promise<SignalSourceRecord> {
    const row = await this.prisma.signalSource.create({
      data: { tenantId, productId, ...input, queries: input.queries as Prisma.InputJsonValue },
    });
    return toSignalSource(row);
  }

  async update(tenantId: string, productId: string, id: string, input: SignalSourceInput): Promise<SignalSourceRecord | null> {
    const updated = await this.prisma.signalSource.updateMany({
      where: { id, tenantId, productId },
      data: { ...input, queries: input.queries as Prisma.InputJsonValue },
    });
    if (updated.count === 0) return null;
    return toSignalSource(await this.prisma.signalSource.findUniqueOrThrow({ where: { id } }));
  }

  async remove(tenantId: string, productId: string, id: string): Promise<boolean> {
    return (await this.prisma.signalSource.deleteMany({ where: { id, tenantId, productId } })).count > 0;
  }
}

export type RetroStatus = "running" | "succeeded" | "failed";

export interface RetroEvent {
  kind: "signal_skipped" | "session_failed" | "session_skipped" | "finding_dropped";
  productId: string | null;
  message: string;
  /** When Factoree recorded the event. Null on an event recorded before 0.23.1. */
  at: string | null;
}

export interface RetroSessionRecord {
  productId: string;
  productName: string;
  status: string;
  runCount: number;
  runner: string | null;
  model: string | null;
  effort: string | null;
  outcome: string | null;
  costUsd: number | null;
  durationMs: number | null;
  metrics: RetroMetrics | null;
  failureMessage: string | null;
}

export interface RetroFindingRecord {
  id: string;
  retroId: string;
  productId: string;
  productName: string;
  kind: RetroFindingKind;
  title: string;
  description: string;
  runIds: string[];
  signalResultIds: string[];
  repositories: string[];
  status: RetroFindingStatus;
  duplicateOfId: string | null;
  /** The retro of the finding that this one repeats, or null. */
  duplicateOfRetroId: string | null;
  linearIssueIdentifier: string | null;
  linearIssueUrl: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

export interface RetroRecord {
  id: string;
  tenantId: string;
  workflowId: string;
  trigger: string;
  status: RetroStatus;
  windowStart: Date | null;
  windowEnd: Date;
  promptVersion: string;
  productIds: string[];
  costUsd: number | null;
  findingCount: number;
  failureMessage: string | null;
  events: RetroEvent[];
  startedAt: Date;
  endedAt: Date | null;
}

export interface RetroDetail extends RetroRecord {
  sessions: RetroSessionRecord[];
  findings: RetroFindingRecord[];
  signalResults: Array<{ id: string; productId: string; sourceName: string; sourceKind: SignalSourceKind; queryName: string; bytes: number }>;
}

const toStatus = (value: string): RetroStatus => (value === "succeeded" || value === "failed" ? value : "running");

const toRetro = (row: Prisma.RetroGetPayload<object>): RetroRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  workflowId: row.workflowId,
  trigger: row.trigger,
  status: toStatus(row.status),
  windowStart: row.windowStart,
  windowEnd: row.windowEnd,
  promptVersion: row.promptVersion,
  productIds: row.productIds,
  costUsd: row.costUsd,
  findingCount: row.findingCount,
  failureMessage: row.failureMessage,
  events: Array.isArray(row.events)
    ? (row.events as unknown as Array<Omit<RetroEvent, "at"> & { at?: string }>).map((event) => ({ ...event, at: event.at ?? null }))
    : [],
  startedAt: row.startedAt,
  endedAt: row.endedAt,
});

const toFinding = (row: Prisma.RetroFindingGetPayload<{ include: { product: { select: { name: true } } } }>): RetroFindingRecord => ({
  id: row.id,
  retroId: row.retroId,
  productId: row.productId,
  productName: row.product.name,
  kind: row.kind as RetroFindingKind,
  title: row.title,
  description: row.description,
  runIds: row.runIds,
  signalResultIds: row.signalResultIds,
  repositories: row.repositories,
  status: row.status as RetroFindingStatus,
  duplicateOfId: row.duplicateOfId,
  duplicateOfRetroId: null,
  linearIssueIdentifier: row.linearIssueIdentifier,
  linearIssueUrl: row.linearIssueUrl,
  decidedBy: row.decidedBy,
  decidedAt: row.decidedAt,
  createdAt: row.createdAt,
});

const OPEN_FINDING: RetroFindingStatus[] = ["proposed"];

/** docs/specs/retro-agent.md. Retros, their sessions, signal results and findings. */
export class PrismaRetroStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async running(tenantId: string): Promise<RetroRecord | null> {
    const row = await this.prisma.retro.findFirst({ where: { tenantId, status: "running" }, orderBy: { startedAt: "desc" } });
    return row === null ? null : toRetro(row);
  }

  async lastSuccessful(tenantId: string): Promise<RetroRecord | null> {
    const row = await this.prisma.retro.findFirst({ where: { tenantId, status: "succeeded" }, orderBy: { windowEnd: "desc" } });
    return row === null ? null : toRetro(row);
  }

  async latest(tenantId: string): Promise<RetroRecord | null> {
    const row = await this.prisma.retro.findFirst({ where: { tenantId }, orderBy: { startedAt: "desc" } });
    return row === null ? null : toRetro(row);
  }

  /** The retro of one workflow. A Temporal retry of the start reads the same row. */
  async start(input: {
    tenantId: string;
    workflowId: string;
    trigger: string;
    windowStart: Date | null;
    windowEnd: Date;
    promptVersion: string;
    productIds: string[];
  }): Promise<RetroRecord> {
    const row = await this.prisma.retro.upsert({
      where: { workflowId: input.workflowId },
      create: { ...input, status: "running" },
      update: {},
    });
    return toRetro(row);
  }

  async findByWorkflow(workflowId: string): Promise<RetroRecord | null> {
    const row = await this.prisma.retro.findUnique({ where: { workflowId } });
    return row === null ? null : toRetro(row);
  }

  async addEvents(retroId: string, events: ReadonlyArray<Omit<RetroEvent, "at">>): Promise<void> {
    if (events.length === 0) return;
    const at = new Date().toISOString();
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.retro.findUniqueOrThrow({ where: { id: retroId }, select: { events: true } });
      const current = Array.isArray(row.events) ? row.events : [];
      const stamped = events.map((event) => ({ ...event, at }));
      await tx.retro.update({ where: { id: retroId }, data: { events: [...current, ...stamped] } });
    });
  }

  async recordSession(input: {
    tenantId: string;
    retroId: string;
    productId: string;
    status: "finished" | "failed" | "skipped";
    runCount: number;
    runner: string | null;
    model: string | null;
    effort: string | null;
    outcome: string | null;
    costUsd: number | null;
    durationMs: number | null;
    metrics: RetroMetrics | null;
    failureMessage: string | null;
  }): Promise<void> {
    const data = { ...input, metrics: input.metrics === null ? Prisma.DbNull : (input.metrics as unknown as Prisma.InputJsonValue) };
    await this.prisma.retroSession.upsert({
      where: { retroId_productId: { retroId: input.retroId, productId: input.productId } },
      create: data,
      update: data,
    });
  }

  /** The cost the sessions of a retro spent so far. */
  async spent(retroId: string): Promise<number> {
    const sum = await this.prisma.retroSession.aggregate({ where: { retroId }, _sum: { costUsd: true } });
    return sum._sum.costUsd ?? 0;
  }

  /**
   * Stores the signal results of one product session and returns each with its id. A retry of the
   * session replaces the results it stored before, so the ids the prompt names are the stored ones.
   */
  async storeSignalResults(tenantId: string, retroId: string, productId: string, results: readonly FetchedSignal[]): Promise<Array<FetchedSignal & { id: string }>> {
    const rows = results.map((result) => ({ ...result, id: randomUUID() }));
    await this.prisma.$transaction([
      this.prisma.signalResult.deleteMany({ where: { retroId, productId } }),
      this.prisma.signalResult.createMany({ data: rows.map((row) => ({ ...row, tenantId, retroId, productId })) }),
    ]);
    return rows;
  }

  async signalResult(tenantId: string, id: string) {
    return this.prisma.signalResult.findFirst({ where: { id, tenantId } });
  }

  /** The open findings of a product by title key, so a repeated title reads as already proposed. */
  async openFindingsByTitle(tenantId: string, productId: string): Promise<Map<string, string>> {
    const rows = await this.prisma.retroFinding.findMany({ where: { tenantId, productId, status: { in: OPEN_FINDING } }, select: { id: true, title: true } });
    return new Map(rows.map((row) => [titleKeyOf(row.title), row.id]));
  }

  /** Stores the checked findings of one product session. A retry replaces them. */
  async storeFindings(input: {
    tenantId: string;
    retroId: string;
    productId: string;
    findings: ReadonlyArray<CheckedFinding & { duplicateOfId: string | null }>;
  }): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.retroFinding.deleteMany({ where: { retroId: input.retroId, productId: input.productId } }),
      this.prisma.retroFinding.createMany({
        data: input.findings.map((finding) => ({
          tenantId: input.tenantId,
          retroId: input.retroId,
          productId: input.productId,
          kind: finding.kind,
          title: finding.title,
          description: finding.description,
          runIds: finding.runIds,
          signalResultIds: finding.signalResultIds,
          repositories: finding.repositories,
          status: finding.duplicateOfId === null ? "proposed" : "already_proposed",
          duplicateOfId: finding.duplicateOfId,
        })),
      }),
    ]);
  }

  async finish(retroId: string, status: "succeeded" | "failed", failureMessage: string | null): Promise<void> {
    const [cost, findings] = await Promise.all([
      this.prisma.retroSession.aggregate({ where: { retroId }, _sum: { costUsd: true } }),
      this.prisma.retroFinding.count({ where: { retroId, status: "proposed" } }),
    ]);
    await this.prisma.retro.update({
      where: { id: retroId },
      data: { status, failureMessage, costUsd: cost._sum.costUsd, findingCount: findings, endedAt: new Date() },
    });
  }

  /** One page of the tenant's retros, newest first. The cursor is the id of the last retro of the page before. */
  async list(tenantId: string, limit: number, cursor?: string): Promise<{ items: RetroRecord[]; nextCursor: string | null }> {
    if (cursor !== undefined && (await this.prisma.retro.count({ where: { id: cursor, tenantId } })) === 0) {
      return { items: [], nextCursor: null };
    }
    const rows = await this.prisma.retro.findMany({
      where: { tenantId },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    const items = rows.slice(0, limit).map(toRetro);
    return { items, nextCursor: rows.length > limit ? (items[items.length - 1]?.id ?? null) : null };
  }

  async detail(tenantId: string, id: string): Promise<RetroDetail | null> {
    const row = await this.prisma.retro.findFirst({
      where: { id, tenantId },
      include: {
        sessions: { include: { product: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
        findings: { include: { product: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
        signalResults: { select: { id: true, productId: true, sourceName: true, sourceKind: true, queryName: true, bytes: true }, orderBy: { createdAt: "asc" } },
      },
    });
    if (row === null) return null;
    const duplicateOfIds = [...new Set(row.findings.flatMap((finding) => (finding.duplicateOfId === null ? [] : [finding.duplicateOfId])))];
    const originals =
      duplicateOfIds.length === 0
        ? []
        : await this.prisma.retroFinding.findMany({ where: { tenantId, id: { in: duplicateOfIds } }, select: { id: true, retroId: true } });
    const retroOf = new Map(originals.map((original) => [original.id, original.retroId]));
    return {
      ...toRetro(row),
      sessions: row.sessions.map((session) => ({
        productId: session.productId,
        productName: session.product.name,
        status: session.status,
        runCount: session.runCount,
        runner: session.runner,
        model: session.model,
        effort: session.effort,
        outcome: session.outcome,
        costUsd: session.costUsd,
        durationMs: session.durationMs,
        metrics: (session.metrics as unknown as RetroMetrics | null) ?? null,
        failureMessage: session.failureMessage,
      })),
      findings: row.findings.map((finding) => ({
        ...toFinding(finding),
        duplicateOfRetroId: finding.duplicateOfId === null ? null : (retroOf.get(finding.duplicateOfId) ?? null),
      })),
      signalResults: row.signalResults.map((result) => ({ ...result, sourceKind: result.sourceKind === "analytics" ? "analytics" : "errors" })),
    };
  }

  async finding(tenantId: string, id: string): Promise<RetroFindingRecord | null> {
    const row = await this.prisma.retroFinding.findFirst({ where: { id, tenantId }, include: { product: { select: { name: true } } } });
    return row === null ? null : toFinding(row);
  }

  /** Marks a proposed finding as created. False when another request decided it first. */
  async markCreated(tenantId: string, id: string, issue: { id: string; identifier: string; url: string }, by: string): Promise<boolean> {
    const updated = await this.prisma.retroFinding.updateMany({
      where: { id, tenantId, status: "proposed" },
      data: { status: "created", linearIssueId: issue.id, linearIssueIdentifier: issue.identifier, linearIssueUrl: issue.url, decidedBy: by, decidedAt: new Date() },
    });
    return updated.count > 0;
  }

  async dismiss(tenantId: string, id: string, by: string): Promise<boolean> {
    const updated = await this.prisma.retroFinding.updateMany({
      where: { id, tenantId, status: "proposed" },
      data: { status: "dismissed", decidedBy: by, decidedAt: new Date() },
    });
    return updated.count > 0;
  }

  /**
   * The ended runs of a product in the window, newest first, at most `limit`, as the retro agent
   * reads them. Every text here is a redacted record Factoree wrote itself.
   */
  async exportRuns(tenantId: string, productId: string, windowStart: Date | null, windowEnd: Date, limit: number): Promise<Omit<RetroRunExport, "transcripts">[]> {
    const rows = await this.prisma.run.findMany({
      where: {
        tenantId,
        productId,
        status: { in: [...TERMINAL_RUN_STATUSES] },
        completedAt: { lte: windowEnd, ...(windowStart === null ? {} : { gt: windowStart }) },
      },
      orderBy: { completedAt: "desc" },
      take: limit,
      include: {
        stages: { orderBy: { startedAt: "asc" } },
        events: { orderBy: { createdAt: "asc" } },
        reviewFindings: { orderBy: [{ attempt: "asc" }, { findingKey: "asc" }] },
        agentSessions: { orderBy: { createdAt: "asc" } },
        targets: { include: { repository: { select: { fullName: true } } } },
      },
    });
    return rows.map((run) => ({
      id: run.id,
      status: run.status,
      workItemTitle: run.workItemTitle,
      workItemUrl: run.workItemUrl,
      autonomyLevel: run.autonomyLevel,
      failureReason: run.failureReason,
      failureMessage: run.failureMessage,
      repairCount: run.repairCount,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      followUpOfRunId: run.followUpOfRunId,
      followUpReply: run.followUpReply,
      repositories: [...new Set(run.targets.map((target) => target.repository.fullName))],
      stages: run.stages.map((stage) => ({ stage: stage.stage, attempt: stage.attempt, durationMs: stage.endedAt.getTime() - stage.startedAt.getTime() })),
      events: run.events.map((event) => ({ stage: event.stage, attempt: event.attempt, role: event.role, kind: event.kind, message: event.message, detail: event.detail })),
      reviewFindings: run.reviewFindings.map((finding) => ({
        attempt: finding.attempt,
        severity: finding.severity,
        category: finding.category,
        description: finding.description,
        blocking: finding.blocking,
        decisionReason: finding.decisionReason,
      })),
      sessions: run.agentSessions.map((session) => ({
        role: session.role,
        attempt: session.attempt,
        runner: session.runner,
        model: session.model,
        outcome: session.outcome,
        costUsd: session.costUsd,
        durationMs: session.durationMs,
      })),
    }));
  }

  /**
   * docs/specs/retro-agent.md, SDD section 51. Deletes the kept transcripts and signal results of
   * each product older than its retro data retention. Bucket objects go first, so a failed delete
   * leaves the row and the next pass tries again.
   */
  async deleteExpired(now: Date, bucket: ObjectStore | null): Promise<{ transcripts: number; signalResults: number }> {
    const products = await this.prisma.product.findMany({ select: { id: true, retroRetentionDays: true } });
    let transcripts = 0;
    let signalResults = 0;
    for (const product of products) {
      const before = new Date(now.getTime() - product.retroRetentionDays * 24 * 60 * 60_000);
      const stored = await this.prisma.agentTranscript.findMany({ where: { productId: product.id, createdAt: { lt: before } }, select: { id: true, objectKey: true } });
      const removable: string[] = [];
      for (const row of stored) {
        if (row.objectKey !== null) {
          if (bucket === null) continue;
          try {
            await bucket.delete(row.objectKey);
          } catch {
            continue;
          }
        }
        removable.push(row.id);
      }
      transcripts += (await this.prisma.agentTranscript.deleteMany({ where: { id: { in: removable } } })).count;
      signalResults += (await this.prisma.signalResult.deleteMany({ where: { productId: product.id, createdAt: { lt: before } } })).count;
    }
    return { transcripts, signalResults };
  }
}

/**
 * docs/specs/retro-agent.md. Kept transcripts, gzipped in Postgres, or in the bucket when one is
 * set. The bucket is read for each write, so a change in Settings applies to the next transcript.
 */
export class PrismaTranscriptStore implements TranscriptStore {
  constructor(
    private readonly prisma: FactoreePrismaClient,
    private readonly bucket: () => Promise<ObjectStore | null>,
  ) {}

  async keep(transcript: KeptTranscript): Promise<void> {
    const gzip = gzipSync(Buffer.from(transcript.text, "utf8"));
    const id = randomUUID();
    const bucket = await this.bucket();
    const objectKey = bucket === null ? null : transcriptObjectKey(transcript.tenantId, transcript.runId, id);
    if (bucket !== null && objectKey !== null) await bucket.put(objectKey, gzip, "application/gzip");
    const data = {
      tenantId: transcript.tenantId,
      productId: transcript.productId,
      runId: transcript.runId,
      role: transcript.role,
      attempt: transcript.attempt,
      bytes: gzip.byteLength,
      gzip: objectKey === null ? new Uint8Array(gzip) : null,
      objectKey,
      idempotencyKey: transcript.idempotencyKey,
    };
    await this.prisma.agentTranscript.upsert({
      where: { tenantId_idempotencyKey: { tenantId: transcript.tenantId, idempotencyKey: transcript.idempotencyKey } },
      create: { id, ...data },
      update: data,
    });
  }

  async forRun(tenantId: string, runId: string): Promise<Array<{ role: string; attempt: number; text: string }>> {
    const rows = await this.prisma.agentTranscript.findMany({ where: { tenantId, runId }, orderBy: { createdAt: "asc" } });
    const bucket = rows.some((row) => row.objectKey !== null) ? await this.bucket() : null;
    const texts: Array<{ role: string; attempt: number; text: string }> = [];
    for (const row of rows) {
      const bytes = row.gzip !== null ? Buffer.from(row.gzip) : row.objectKey !== null && bucket !== null ? await bucket.get(row.objectKey).catch(() => null) : null;
      if (bytes === null) continue;
      texts.push({ role: row.role, attempt: row.attempt, text: gunzipSync(bytes).toString("utf8") });
    }
    return texts;
  }
}

