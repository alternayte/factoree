import { FAULT_KINDS, type Diagnosis, type RunEvent, type RunEventStore } from "./run-event.js";

const FAILED_RUN_STATUSES = new Set(["FAILED", "FAILED_CONFIGURATION", "FAILED_REVIEW"]);
const FAILED_SETUP_STATUSES = new Set(["failed", "partial"]);

/**
 * docs/specs/run-diagnostics.md. The diagnosis of a failed run: how it ended and the fault event
 * that caused it. Null for a run that did not fail. A run that ended before run events existed
 * still gets its failure message, with no cause.
 */
export const runDiagnosisOf = async (
  events: RunEventStore,
  tenantId: string,
  run: { id: string; status: string; failureReason: string | null; failureMessage: string | null },
): Promise<Diagnosis | null> => {
  if (!FAILED_RUN_STATUSES.has(run.status)) return null;
  const subject = { runId: run.id };
  const ended = await events.newest(tenantId, subject, ["run_ended"]);
  const endDetail = ended?.kind === "run_ended" ? ended.detail : null;
  let cause: RunEvent | null = null;
  if (endDetail !== null) {
    cause = endDetail.causeEventId === null ? null : await events.find(tenantId, endDetail.causeEventId);
  } else {
    cause = await events.newest(tenantId, subject, FAULT_KINDS);
  }
  return {
    status: run.status,
    reason: run.failureReason,
    stage: endDetail?.lastStatus ?? cause?.stage ?? null,
    attempt: cause?.attempt ?? null,
    message: run.failureMessage ?? ended?.message ?? `The run ended ${run.status}.`,
    cause,
  };
};

/** The diagnosis of a failed or partial setup run, with its newest fault event as the cause. */
export const setupDiagnosisOf = async (
  events: RunEventStore,
  tenantId: string,
  setup: { id: string; status: string; failureMessage: string | null },
): Promise<Diagnosis | null> => {
  if (!FAILED_SETUP_STATUSES.has(setup.status)) return null;
  const cause = await events.newest(tenantId, { setupId: setup.id }, FAULT_KINDS);
  return {
    status: setup.status,
    reason: null,
    stage: cause?.stage ?? null,
    attempt: cause?.attempt ?? null,
    message: setup.failureMessage ?? `The setup ended ${setup.status}.`,
    cause,
  };
};
