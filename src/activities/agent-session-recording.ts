import type { Logger } from "~/telemetry/logger.js";
import { recordStage, type RunStageStore } from "~/domain/runs/run-stage.js";
import type { AgentRunResult } from "~/domain/runs/agent-runner.js";
import {
  combineUsage,
  totalTokens,
  type AgentSessionOutcome,
  type AgentSessionRole,
  type AgentSessionStore,
} from "~/domain/runs/agent-session.js";

export interface AgentSessionRecordingDependencies {
  sessions: AgentSessionStore;
  logger: Logger;
  /** docs/specs/run-speed.md. Each agent session is one stage of the run. */
  stages?: RunStageStore | undefined;
}

export interface AgentSessionContext {
  tenantId: string;
  productId: string;
  runId: string;
  role: AgentSessionRole;
  attempt: number;
  runner: string;
  idempotencyKey: string;
  /** The sandbox the session ran in, for its run stage row. */
  sandboxId?: string;
}

/** The hang an activity reports to the workflow, or null. */
export type AgentHang = { silenceLimitMs: number } | null;

/** The hang of one session, from all its invocations. */
export const hangOf = (results: ReadonlyArray<AgentRunResult>): AgentHang => {
  const hung = results.find((result) => result.outcome === "hung");
  return hung === undefined ? null : { silenceLimitMs: hung.silenceLimitMs };
};

/**
 * docs/specs/agent-session-usage-and-hangs.md. Writes the `AgentSession` row of one session and
 * logs "agent session finished". `results` holds every invocation of the session in order: the
 * first run, then each reminder that resumed it. The row sums their usage.
 *
 * Cost is a metric, not evidence. A missing usage record writes the row with null usage and logs
 * a warning, and a failed write logs an error. Neither fails the Run. DI-14.45.
 */
export const recordAgentSession = async (
  dependencies: AgentSessionRecordingDependencies,
  context: AgentSessionContext,
  results: ReadonlyArray<AgentRunResult>,
): Promise<void> => {
  const first = results[0];
  if (first === undefined) return;
  const usage = combineUsage(results.map((result) => result.usage));
  const outcome: AgentSessionOutcome = results.some((result) => result.outcome === "hung")
    ? "hung"
    : (results.at(-1)?.outcome ?? first.outcome);
  // A runner names the session by its process when the CLI never named one, and that is no
  // CLI session identifier.
  const cliSessionId = first.session.sessionId === first.session.processId ? null : first.session.sessionId;
  const durationMs = results.reduce((sum, result) => sum + result.durationMs, 0);
  const model = results.find((result) => result.model !== null)?.model ?? null;
  const fields = {
    tenant_id: context.tenantId,
    product_id: context.productId,
    run_id: context.runId,
    step: "agent_session",
    role: context.role,
    attempt: context.attempt,
    runner: context.runner,
  };

  if (usage === null) {
    dependencies.logger.warn("the agent CLI left no usage record for the session", {
      ...fields,
      cli_session_id: cliSessionId,
    });
  }

  try {
    await dependencies.sessions.record({
      tenantId: context.tenantId,
      runId: context.runId,
      role: context.role,
      attempt: context.attempt,
      runner: context.runner,
      cliSessionId,
      model,
      effort: first.effort,
      usage,
      durationMs,
      outcome,
      idempotencyKey: context.idempotencyKey,
    });
  } catch (error) {
    dependencies.logger.error("the agent session row was not written", { ...fields, error: String(error) });
  }

  // The session ended now, and its invocations ran one after another.
  const endedAt = new Date();
  await recordStage(dependencies.stages, dependencies.logger, {
    tenantId: context.tenantId,
    runId: context.runId,
    stage: context.role,
    attempt: context.attempt,
    sandboxId: context.sandboxId ?? null,
    startedAt: new Date(endedAt.getTime() - durationMs),
    endedAt,
  });

  dependencies.logger.info("agent session finished", {
    ...fields,
    outcome,
    model,
    effort: first.effort,
    duration_ms: durationMs,
    tokens: usage === null ? null : totalTokens(usage),
    input_tokens: usage?.inputTokens ?? null,
    output_tokens: usage?.outputTokens ?? null,
    reasoning_tokens: usage?.reasoningTokens ?? null,
    cache_read_tokens: usage?.cacheReadTokens ?? null,
    cache_write_tokens: usage?.cacheWriteTokens ?? null,
    cost_usd: usage?.costUsd ?? null,
    turns: usage?.turns ?? null,
    longest_turn_ms: usage?.longestTurnMs ?? null,
    model_ms: usage?.modelMs ?? null,
    tool_ms: usage?.toolMs ?? null,
  });
};
