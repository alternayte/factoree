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
import { recordRunEvent, type RunEventRecorder } from "~/domain/diagnostics/run-event.js";
import { faultEgressFacts, withDeniedHosts, type FaultSandbox } from "~/domain/diagnostics/egress-facts.js";

export interface AgentSessionRecordingDependencies {
  sessions: AgentSessionStore;
  logger: Logger;
  /** docs/specs/run-speed.md. Each agent session is one stage of the run. */
  stages?: RunStageStore | undefined;
  /** docs/specs/run-diagnostics.md. A session that did not finish writes a run event. */
  events?: RunEventRecorder | undefined;
}

export interface AgentSessionContext {
  tenantId: string;
  productId: string;
  runId: string;
  role: Exclude<AgentSessionRole, "retro">;
  attempt: number;
  runner: string;
  idempotencyKey: string;
  /** The sandbox the session ran in, for its run stage row. */
  sandboxId?: string;
  /**
   * docs/specs/run-diagnostics.md. The sandbox of the session and its effective allow list, for
   * the denied hosts and the host hints of a session that did not finish.
   */
  egress?: FaultSandbox | null;
}

/** The hang an activity reports to the workflow, or null. */
export type AgentHang = { silenceLimitMs: number } | null;

/** The hang of one session, from all its invocations. */
export const hangOf = (results: ReadonlyArray<AgentRunResult>): AgentHang => {
  const hung = results.find((result) => result.outcome === "hung");
  return hung === undefined ? null : { silenceLimitMs: hung.silenceLimitMs };
};

/**
 * docs/specs/provider-unreachable.md. The provider failure an activity reports to the workflow, or
 * null. `summary` is the redacted API error text, so the failure message can name it.
 */
export type AgentProviderUnreachable = { summary: string } | null;

/** The provider failure of one session, from all its invocations. */
export const providerUnreachableOf = (results: ReadonlyArray<AgentRunResult>): AgentProviderUnreachable => {
  const failed = results.find((result) => result.failureKind === "PROVIDER_UNREACHABLE");
  return failed === undefined ? null : { summary: failed.summary };
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

  await recordSessionFaults(dependencies.events, context, results);
};

/**
 * docs/specs/run-diagnostics.md. One run event per invocation that hung or did not finish. A
 * session that Factoree cancelled for a stop or a deadline is no fault: the end of the run says why.
 */
export const recordSessionFaults = async (
  events: RunEventRecorder | undefined,
  context: Pick<AgentSessionContext, "tenantId" | "runId" | "role" | "attempt" | "runner" | "idempotencyKey" | "egress"> & {
    /** The setup run of a setup session, which has no run. */
    setupId?: string;
  },
  results: ReadonlyArray<AgentRunResult>,
): Promise<void> => {
  if (events === undefined) return;
  const subject = context.setupId === undefined ? { runId: context.runId } : { setupId: context.setupId };
  for (const [index, result] of results.entries()) {
    const base = {
      tenantId: context.tenantId,
      subject,
      stage: context.role,
      attempt: context.attempt,
      role: context.role,
      idempotencyKey: `${context.idempotencyKey}:session:${String(index)}`,
    };
    if (result.outcome === "hung") {
      await recordRunEvent(events, {
        ...base,
        kind: "session_hung",
        message:
          (result.openToolCall === undefined
            ? `The ${context.role} session wrote no output for ${String(Math.round(result.silenceLimitMs / 1000))} seconds, so Factoree stopped it.`
            : `The ${context.role} session waited ${String(Math.round(result.openToolCall.runningMs / 60_000))} minutes on the ${result.openToolCall.name} call \`${result.openToolCall.input}\` with no output, so Factoree stopped it.`) +
          // GitHub issue 84. The CPU samples say whether the session processes still worked.
          (result.processActivity === "idle" ? " Its processes used no CPU time." : result.processActivity === "active" ? " Its processes still used CPU time." : ""),
        detail: {
          runner: result.session.runner,
          silenceLimitMs: result.silenceLimitMs,
          ...(result.openToolCall === undefined ? {} : { openToolCall: result.openToolCall }),
          ...(result.processActivity === undefined ? {} : { processActivity: result.processActivity }),
          log: result.failureLog,
        },
      });
      continue;
    }
    if (result.outcome === "unreachable") {
      // docs/specs/provider-unreachable.md. The fast-fail cancels the session, so this check
      // comes before the skip of a cancelled one.
      const facts = await faultEgressFacts(context.egress ?? null, result.failureLog);
      const summary = result.summary.trim();
      await recordRunEvent(events, {
        ...base,
        kind: "provider_unreachable",
        message: withDeniedHosts(
          `The ${context.role} session could not reach the model provider.${summary === "" ? "" : ` It reported: ${summary.slice(0, 500)}`}`,
          facts,
        ),
        detail: { runner: result.session.runner, model: result.model, exitCode: result.exitCode, summary, log: result.failureLog, ...facts },
      });
      continue;
    }
    if (result.completed || result.cancelled) continue;
    const facts = await faultEgressFacts(context.egress ?? null, result.failureLog);
    const summary = result.summary.trim();
    await recordRunEvent(events, {
      ...base,
      kind: "session_failed",
      message: withDeniedHosts(
        `The ${context.role} session exited ${String(result.exitCode)} without finishing.${summary === "" ? "" : ` It reported: ${summary.slice(0, 500)}`}`,
        facts,
      ),
      detail: {
        runner: result.session.runner,
        model: result.model,
        exitCode: result.exitCode,
        summary,
        log: result.failureLog,
        ...facts,
      },
    });
  }
};


/**
 * docs/specs/run-diagnostics.md. A role session that starts again writes `retry_started`: once
 * after a hang, and once per retry after an unreachable model provider
 * (docs/specs/provider-unreachable.md).
 */
export const recordSessionRetries = async (
  events: RunEventRecorder | undefined,
  input: { tenantId: string; runId: string; role: AgentSessionRole; attempt: number; stage: string; afterHang: boolean; unreachableRetry: number },
): Promise<void> => {
  const retry = (key: string, message: string, reason: string) =>
    recordRunEvent(events, {
      tenantId: input.tenantId,
      subject: { runId: input.runId },
      stage: input.stage,
      attempt: input.attempt,
      role: input.role,
      kind: "retry_started",
      message,
      detail: { what: `${input.role} session`, reason },
      idempotencyKey: `run:${input.runId}:${input.role}:${String(input.attempt)}:${key}`,
    });
  if (input.afterHang) await retry("hang-retry", `The ${input.role} session hung, so Factoree tries it once more.`, "the session hung");
  if (input.unreachableRetry > 0) {
    await retry(
      `unreachable-retry-${String(input.unreachableRetry)}`,
      `The ${input.role} session could not reach the model provider, so Factoree tries it again (retry ${String(input.unreachableRetry)}).`,
      "the model provider was unreachable",
    );
  }
};
