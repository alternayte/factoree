import type {
  NewRunEvent,
  RunEvent,
  RunEventKind,
  RunEventPage,
  RunEventPageQuery,
  RunEventStore,
  RunEventSubject,
} from "~/domain/diagnostics/run-event.js";

const sameSubject = (left: RunEventSubject, right: RunEventSubject): boolean =>
  left.runId !== undefined ? left.runId === right.runId : left.setupId === right.setupId;

/** An in-memory `run_event` table, with the idempotency rule of the Prisma store. */
export class MemoryRunEventStore implements RunEventStore {
  readonly events: RunEvent[] = [];
  private clock = 0;

  record(event: NewRunEvent): Promise<void> {
    const exists = this.events.some((stored) => stored.tenantId === event.tenantId && stored.idempotencyKey === event.idempotencyKey);
    if (!exists) {
      this.clock += 1;
      this.events.push({ ...event, id: `event-${String(this.events.length + 1)}`, createdAt: new Date(this.clock) });
    }
    return Promise.resolve();
  }

  list(query: RunEventPageQuery): Promise<RunEventPage> {
    const all = this.events.filter((event) => event.tenantId === query.tenantId && sameSubject(query.subject, event.subject));
    const start = query.cursor === undefined ? 0 : all.findIndex((event) => event.id === query.cursor) + 1;
    const items = all.slice(start, start + query.limit);
    return Promise.resolve({ items, nextCursor: start + query.limit < all.length ? (items.at(-1)?.id ?? null) : null });
  }

  newest(tenantId: string, subject: RunEventSubject, kinds: readonly RunEventKind[]): Promise<RunEvent | null> {
    const found = this.events.filter((event) => event.tenantId === tenantId && sameSubject(subject, event.subject) && kinds.includes(event.kind));
    return Promise.resolve(found.at(-1) ?? null);
  }

  find(tenantId: string, id: string): Promise<RunEvent | null> {
    return Promise.resolve(this.events.find((event) => event.tenantId === tenantId && event.id === id) ?? null);
  }
}
