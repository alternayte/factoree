import type { Logger } from "~/telemetry/logger.js";

/**
 * docs/specs/run-speed.md. Factoree records the start and the end of each stage of a run, so an
 * operator finds the slow stage with plain SQL. A stage time is a metric, never evidence, so a
 * failed write never fails a run.
 */
export type RunStageName =
  | "prepare_sandbox"
  | "prepare_check_sprite"
  | "verify"
  | "preview_build"
  | "browser_assertions"
  | "refiner"
  | "implementer"
  | "validator"
  | "reviewer"
  | "warm_snapshot"
  | "publish";

export interface RunStageSpan {
  tenantId: string;
  runId: string;
  stage: RunStageName;
  attempt: number;
  /** The sandbox the stage ran in, or null for a stage outside a sandbox. */
  sandboxId: string | null;
  startedAt: Date;
  endedAt: Date;
}

/** The `run_stage` table. A retried activity writes a second row, because it spent the time again. */
export interface RunStageStore {
  record(span: RunStageSpan): Promise<void>;
  listForRun(tenantId: string, runId: string): Promise<RunStageSpan[]>;
}

/** The parts of a span the caller knows before the stage starts. */
export type RunStageStart = Omit<RunStageSpan, "startedAt" | "endedAt">;

/**
 * Writes one span. A failed write is logged and dropped, because a stage time is a metric and
 * must not fail the run.
 */
export const recordStage = async (
  store: RunStageStore | undefined,
  logger: Logger,
  span: RunStageSpan,
): Promise<void> => {
  if (store === undefined) return;
  try {
    await store.record(span);
  } catch (error) {
    logger.error("the run stage row was not written", {
      tenant_id: span.tenantId,
      run_id: span.runId,
      stage: span.stage,
      attempt: span.attempt,
      error: String(error),
    });
  }
};

/**
 * Runs one stage and records its span, on success and on failure alike. `sandboxIdOf` names the
 * sandbox from the result, for a stage that creates its sandbox.
 */
export const timeStage = async <T>(
  store: RunStageStore | undefined,
  logger: Logger,
  start: RunStageStart,
  run: () => Promise<T>,
  sandboxIdOf?: (result: T) => string,
): Promise<T> => {
  const startedAt = new Date();
  let sandboxId = start.sandboxId;
  try {
    const result = await run();
    if (sandboxIdOf !== undefined) sandboxId = sandboxIdOf(result);
    return result;
  } finally {
    await recordStage(store, logger, { ...start, sandboxId, startedAt, endedAt: new Date() });
  }
};
