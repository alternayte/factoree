import { z } from "zod";
import {
  RUN_EVENT_KINDS,
  runEventDetailSchemas,
  type Diagnosis,
  type RunEvent,
  type RunEventKind,
} from "~/domain/diagnostics/run-event.js";

/** The most run events one page returns. */
export const MAX_EVENTS_PER_PAGE = 200;

export const eventsQuerySchema = z.object({
  linearWorkspaceId: z.string().min(1),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_EVENTS_PER_PAGE).default(100),
});

const eventOf = <K extends RunEventKind>(kind: K) =>
  z.object({
    id: z.string(),
    stage: z.string(),
    attempt: z.number(),
    role: z.string().nullable(),
    kind: z.literal(kind),
    message: z.string(),
    detail: runEventDetailSchemas[kind],
    createdAt: z.string(),
  });

/**
 * docs/specs/run-diagnostics.md. One run event, typed by its kind. `hostHints` are host names in
 * the output tail that the allow list does not hold: a guess, never evidence. `egress` says whether
 * the sandbox provider recorded egress at all.
 */
export const runEventSchema = z
  .discriminatedUnion(
    "kind",
    RUN_EVENT_KINDS.map((kind) => eventOf(kind)) as unknown as [ReturnType<typeof eventOf>, ...Array<ReturnType<typeof eventOf>>],
  )
  .describe("One fault or one Factoree decision of a run or a setup run.");

export const runEventPageSchema = z.object({ items: z.array(runEventSchema), nextCursor: z.string().nullable() });

/** How a failed run or setup ended, and the run event that caused it. Null when it did not fail. */
export const diagnosisSchema = z
  .object({
    status: z.string(),
    reason: z.string().nullable(),
    /** The run status, or the setup step, the failure happened in. */
    stage: z.string().nullable(),
    attempt: z.number().nullable(),
    message: z.string(),
    cause: runEventSchema.nullable(),
  })
  .nullable();

export const toEventJson = (event: RunEvent) => ({
  id: event.id,
  stage: event.stage,
  attempt: event.attempt,
  role: event.role,
  kind: event.kind,
  message: event.message,
  detail: event.detail,
  createdAt: event.createdAt.toISOString(),
});

export const toDiagnosisJson = (diagnosis: Diagnosis | null) =>
  diagnosis === null ? null : { ...diagnosis, cause: diagnosis.cause === null ? null : toEventJson(diagnosis.cause) };
