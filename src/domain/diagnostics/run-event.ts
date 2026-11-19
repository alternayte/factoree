import { z } from "zod";
import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { MAX_RETAINED_LOG_BYTES } from "~/domain/runs/retained-log.js";

/**
 * docs/specs/run-diagnostics.md. One fault or one Factoree decision of a run or a setup run, in
 * order. Factoree stores the raw redacted output and the facts it knows itself: the command, the
 * exit code, the allow list. It never parses the error format of one language or tool.
 */

/**
 * Whether the sandbox provider recorded egress: `recorded` on Kiln, `not_recorded` on a provider
 * with no egress log (E2B and Sprites, both docs read 2026-11-19), `unreadable` when the read failed.
 */
const egress = z.enum(["recorded", "not_recorded", "unreadable"]);

/** The hosts the egress log of the sandbox denied. Empty unless `egress` is `recorded`. */
const deniedHosts = z.array(z.string());

/** Host names in the output tail that the effective allow list does not hold. A guess, never evidence. */
const hostHints = z.array(z.string());

const commandDetail = z.object({
  /** bootstrap, warm, verify, seed, preview, services or setup_proof. */
  step: z.string(),
  command: z.string(),
  exitCode: z.number().nullable(),
  durationMs: z.number().nullable(),
  /** The redacted output tail of `buildRetainedLog`, or null when the command wrote nothing. */
  log: z.string().nullable(),
  egress,
  deniedHosts,
  hostHints,
});

const sessionDetail = z.object({
  runner: z.string(),
  model: z.string().nullable(),
  exitCode: z.number().nullable(),
  /** What the runner reported last, redacted. An agent claim, shown as such. */
  summary: z.string(),
  log: z.string().nullable(),
  egress,
  deniedHosts,
  hostHints,
});

export const runEventDetailSchemas = {
  session_failed: sessionDetail,
  session_hung: z.object({ runner: z.string(), silenceLimitMs: z.number() }),
  command_failed: commandDetail,
  plan_rejected: z.object({ problems: z.array(z.string()), round: z.enum(["first", "correction"]) }),
  proposal_rejected: z.object({ problem: z.string() }),
  selector_recheck: z.object({ assertionKeys: z.array(z.string()) }),
  check_unstable: z.object({ assertionKey: z.string(), reason: z.string() }),
  retry_started: z.object({ what: z.string(), reason: z.string() }),
  repair_started: z.object({ repair: z.number(), reason: z.string() }),
  run_ended: z.object({
    status: z.string(),
    reason: z.string().nullable(),
    /** The run status before the end, so the stage the run failed in. */
    lastStatus: z.string().nullable(),
    /** The newest fault event of the run, or null when Factoree recorded none. */
    causeEventId: z.string().nullable(),
  }),
} as const;

export type RunEventKind = keyof typeof runEventDetailSchemas;
export const RUN_EVENT_KINDS = Object.keys(runEventDetailSchemas) as RunEventKind[];
export type RunEventDetail<K extends RunEventKind> = z.infer<(typeof runEventDetailSchemas)[K]>;

/** The kinds that name a fault. The diagnosis takes its cause from the newest of them. */
export const FAULT_KINDS: readonly RunEventKind[] = [
  "session_failed",
  "session_hung",
  "command_failed",
  "plan_rejected",
  "proposal_rejected",
];

/** The run or the setup run an event belongs to. Exactly one. */
export type RunEventSubject = { runId: string; setupId?: never } | { setupId: string; runId?: never };

export type NewRunEvent = {
  [K in RunEventKind]: {
    tenantId: string;
    subject: RunEventSubject;
    /** A run status or a setup step, such as PREPARING or setup_proof. */
    stage: string;
    attempt: number;
    /** The agent role, or null for a Factoree step. */
    role: string | null;
    kind: K;
    message: string;
    detail: RunEventDetail<K>;
    /** The activity key, the kind and an ordinal, so a Temporal retry writes no second row. */
    idempotencyKey: string;
  };
}[RunEventKind];

export type RunEvent = NewRunEvent & { id: string; createdAt: Date };

export interface RunEventPageQuery {
  tenantId: string;
  subject: RunEventSubject;
  cursor?: string;
  limit: number;
}

export interface RunEventPage {
  items: RunEvent[];
  nextCursor: string | null;
}

/** The `run_event` table. */
export interface RunEventStore {
  /** Writes one event. A second write with the same idempotency key changes nothing. */
  record(event: NewRunEvent): Promise<void>;
  list(query: RunEventPageQuery): Promise<RunEventPage>;
  /** The newest event of the subject whose kind is in `kinds`, or null. */
  newest(tenantId: string, subject: RunEventSubject, kinds: readonly RunEventKind[]): Promise<RunEvent | null>;
  find(tenantId: string, id: string): Promise<RunEvent | null>;
}

/** The longest message an event keeps. */
export const MAX_EVENT_MESSAGE_CHARACTERS = 2_000;

const capText = (text: string, max: number): string => (text.length <= max ? text : `…${text.slice(-max)}`);

/** Redacts every string of a detail, and caps each at the retained log size. */
const redactDeep = (value: unknown, redactor: Redactor): unknown => {
  if (typeof value === "string") return capText(redactor.redactText(value), MAX_RETAINED_LOG_BYTES);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redactor));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, redactor)]));
  }
  return value;
};

/** The dependencies of a writer of run events. Absent in a test that records none. */
export interface RunEventRecorder {
  store: RunEventStore;
  redactor: Redactor;
  logger: Logger;
}

/**
 * Writes one event. Redaction runs on every string first (SDD section 60). A failed write is
 * logged and dropped, because diagnostics must not end a run.
 */
export const recordRunEvent = async (recorder: RunEventRecorder | undefined, event: NewRunEvent): Promise<void> => {
  if (recorder === undefined) return;
  try {
    const detail = runEventDetailSchemas[event.kind].parse(redactDeep(event.detail, recorder.redactor));
    await recorder.store.record({
      ...event,
      message: capText(recorder.redactor.redactText(event.message), MAX_EVENT_MESSAGE_CHARACTERS),
      detail,
    } as NewRunEvent);
  } catch (error) {
    recorder.logger.error("the run event was not written", {
      tenant_id: event.tenantId,
      ...("runId" in event.subject && event.subject.runId !== undefined ? { run_id: event.subject.runId } : {}),
      ...("setupId" in event.subject && event.subject.setupId !== undefined ? { setup_id: event.subject.setupId } : {}),
      kind: event.kind,
      error: String(error),
    });
  }
};

/** The diagnosis of a failed run or setup: how it ended and the fault event that caused it. */
export interface Diagnosis {
  status: string;
  reason: string | null;
  stage: string | null;
  attempt: number | null;
  message: string;
  cause: RunEvent | null;
}
