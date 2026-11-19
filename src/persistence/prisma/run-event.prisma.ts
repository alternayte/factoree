import type { Prisma} from "@prisma/client";
import { type PrismaClient } from "@prisma/client";
import {
  runEventDetailSchemas,
  type NewRunEvent,
  type RunEvent,
  type RunEventKind,
  type RunEventPage,
  type RunEventPageQuery,
  type RunEventStore,
  type RunEventSubject,
} from "~/domain/diagnostics/run-event.js";

type Row = Prisma.RunEventGetPayload<object>;

const subjectWhere = (tenantId: string, subject: RunEventSubject) =>
  subject.runId !== undefined ? { tenantId, runId: subject.runId } : { tenantId, setupId: subject.setupId };

/**
 * A row this store wrote parses. A row whose detail no longer matches its kind is dropped from a
 * read, so the API only ever returns the typed shape.
 */
const toEvent = (row: Row): RunEvent | null => {
  const kind = row.kind as RunEventKind;
  const schema = runEventDetailSchemas[kind] as (typeof runEventDetailSchemas)[RunEventKind] | undefined;
  if (schema === undefined) return null;
  const detail = schema.safeParse(row.detail);
  if (!detail.success) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    subject: row.runId !== null ? { runId: row.runId } : { setupId: row.setupId ?? "" },
    stage: row.stage,
    attempt: row.attempt,
    role: row.role,
    kind,
    message: row.message,
    detail: detail.data,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  } as RunEvent;
};

/** docs/specs/run-diagnostics.md. The `run_event` table. */
export class PrismaRunEventStore implements RunEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async record(event: NewRunEvent): Promise<void> {
    const data = {
      tenantId: event.tenantId,
      runId: event.subject.runId ?? null,
      setupId: event.subject.setupId ?? null,
      stage: event.stage,
      attempt: event.attempt,
      role: event.role,
      kind: event.kind,
      message: event.message,
      detail: event.detail as Prisma.InputJsonValue,
      idempotencyKey: event.idempotencyKey,
    };
    // A Temporal retry of the activity presents the same key, and the first row stands.
    await this.prisma.runEvent.upsert({
      where: { tenantId_idempotencyKey: { tenantId: event.tenantId, idempotencyKey: event.idempotencyKey } },
      create: data,
      update: {},
    });
  }

  async list(query: RunEventPageQuery): Promise<RunEventPage> {
    // The tenant filter is part of the query. SDD section 52 forbids relying on the caller.
    const rows = await this.prisma.runEvent.findMany({
      where: subjectWhere(query.tenantId, query.subject),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
    });
    const page = rows.slice(0, query.limit);
    const next = rows.length > query.limit ? (page.at(-1)?.id ?? null) : null;
    return { items: page.map(toEvent).filter((event): event is RunEvent => event !== null), nextCursor: next };
  }

  async newest(tenantId: string, subject: RunEventSubject, kinds: readonly RunEventKind[]): Promise<RunEvent | null> {
    const row = await this.prisma.runEvent.findFirst({
      where: { ...subjectWhere(tenantId, subject), kind: { in: [...kinds] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return row === null ? null : toEvent(row);
  }

  async find(tenantId: string, id: string): Promise<RunEvent | null> {
    const row = await this.prisma.runEvent.findFirst({ where: { tenantId, id } });
    return row === null ? null : toEvent(row);
  }
}
