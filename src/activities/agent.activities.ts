import { Context } from "@temporalio/activity";
import type { Logger } from "~/telemetry/logger.js";
import type { AgentExecutionRepository } from "~/domain/runs/agent-execution.js";
import type { AgentRunner, AgentRunnerRegistry, AgentSessionRef } from "~/domain/runs/agent-runner.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import { registerProjectSecrets } from "~/domain/projects/redaction-loader.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { buildImplementerInput } from "~/domain/runs/implementer-input.js";
import { metrics } from "~/telemetry/metrics.js";
import type { Redactor } from "~/telemetry/redaction.js";

export interface AgentActivityDependencies {
  runners: AgentRunnerRegistry;
  sandbox: Sandbox;
  executions: AgentExecutionRepository;
  secrets: SecretStore;
  redactor: Redactor;
  logger: Logger;
}

export interface ImplementActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  runnerName: string;
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  referencePaths: string[];
  goal: string;
  /** SDD section 21. The rendered Context Contract of this Run. */
  contextContract: string | null;
  /**
   * SDD section 34. The frozen Validation Contract. The Implementer receives it and receives no
   * authority to change it. By the time the Implementer runs, a frozen contract always exists.
   */
  validationContract: string;
  /** SDD section 21 and AT-09. The required-context lines. No file body travels with them. */
  requiredContext: string[];
  humanDecisions: string[];
  repositoryInstructions: string;
  /** SDD sections 16 and 34. The applicable skills, as prompt lines. */
  skills: string[];
  repairFindings: string[];
  stagingRead: boolean;
  timeoutMs: number;
  /**
   * The ordinal of this Implementer attempt within the Run. The workflow counts it, so the
   * value stays the same across every Temporal retry of one activity and changes only for a
   * genuinely distinct attempt, for example a later repair loop attempt.
   */
  attempt: number;
}

export interface ImplementActivityOutput {
  sessionId: string;
  processId: string;
  runner: string;
  completed: boolean;
  exitCode: number;
  cancelled: boolean;
  summary: string;
  durationMs: number;
  /** True when this activity really cancelled the live session of the runner. */
  cancelledSession: boolean;
}

/**
 * The interval between two heartbeats. A heartbeat is the only way Temporal can deliver a
 * cancellation to a long activity, so the Implementer activity must send one.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The time the cancel path waits for the live session to appear. A cancellation can arrive
 * before the runner has started the process, so the first lookup can give nothing.
 */
const SESSION_LOOKUP_TIMEOUT_MS = 60_000;

/** The delay between two lookups of the live session. */
const SESSION_LOOKUP_INTERVAL_MS = 100;

/** The time one call of `cancel` on the runner gets before the activity gives up on it. */
const CANCEL_TIMEOUT_MS = 30_000;

/**
 * A runner that can name the live session of one Run. SDD section 33 fixes the `AgentRunner`
 * port, so this capability stays outside it. `OpenCodeRunner` provides it, and the activity
 * uses it only when the runner has it.
 */
interface RunnerWithActiveSession {
  activeSession(runId: string): AgentSessionRef | undefined;
}

const activeSessionOf = (runner: AgentRunner, runId: string): AgentSessionRef | undefined => {
  const candidate = runner as Partial<RunnerWithActiveSession>;
  if (typeof candidate.activeSession !== "function") return undefined;
  return candidate.activeSession(runId);
};

export const createAgentActivities = (dependencies: AgentActivityDependencies) => ({
  async implement(input: ImplementActivityInput): Promise<ImplementActivityOutput> {
    // SDD section 60: every Project secret must reach the redactor before any output is captured.
    await registerProjectSecrets(
      dependencies.redactor,
      dependencies.secrets,
      input.tenantId,
      input.projectId,
      dependencies.logger,
    );

    // SDD section 30: a non-production test secret reaches the Implementer only when the
    // operator injects it explicitly. The mark on the secret is that explicit act. Every other
    // Project secret stays out of the sandbox, and the redactor above still holds its value.
    // `buildImplementerInput` keeps its own rejection of forbidden material as the last control.
    const descriptors = await dependencies.secrets.list(input.tenantId, input.projectId);
    const projectTestSecrets: Record<string, string> = {};
    for (const descriptor of descriptors) {
      if (!descriptor.injectIntoImplementer) continue;
      const value = await dependencies.secrets.get(input.tenantId, input.projectId, descriptor.name);
      if (value !== null) projectTestSecrets[descriptor.name] = value;
    }

    const actionPolicy = buildActionPolicy({ stagingRead: input.stagingRead });
    const implementerInput = buildImplementerInput({
      goal: input.goal,
      humanDecisions: input.humanDecisions,
      validationContract: input.validationContract,
      contextContract: input.contextContract,
      requiredContext: input.requiredContext,
      primaryRepositoryPath: input.primaryPath,
      referenceRepositoryPaths: input.referencePaths,
      repositoryInstructions: input.repositoryInstructions,
      skills: input.skills,
      actionPolicy,
      repairFindings: input.repairFindings,
      projectTestSecrets,
    });

    const runner = dependencies.runners.get(input.runnerName);
    const context = Context.current();

    // Only a heartbeat lets Temporal reach this activity with a cancellation.
    const heartbeat = setInterval(() => {
      context.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    // SDD section 50: a stop must cancel the active agent process. The workflow cancels this
    // activity, and the cancellation reaches the live session here, while the run still holds.
    let running = true;
    let cancelledSession = false;
    let pendingTimer: NodeJS.Timeout | null = null;

    const cancelLiveSession = async (): Promise<void> => {
      // The session appears only after the runner has started the process. A cancellation can
      // arrive before that moment, so the lookup repeats for a bounded time. The loop also ends
      // as soon as the run itself ends, and then there is nothing left to cancel.
      const deadline = Date.now() + SESSION_LOOKUP_TIMEOUT_MS;
      while (running && Date.now() < deadline) {
        const session = activeSessionOf(runner, input.runId);
        if (session !== undefined) {
          try {
            // A runner that never answers must not hold this activity open.
            const outcome = await Promise.race([
              runner.cancel(session),
              new Promise<never>((_resolve, reject) =>
                setTimeout(() => reject(new Error("the runner did not answer the cancel")), CANCEL_TIMEOUT_MS).unref(),
              ),
            ]);
            // This path runs in the same process that started the session, so the lookup above
            // already proves the session is live here. The outcome is "cancelled" in practice.
            cancelledSession = outcome === "cancelled";
          } catch (error) {
            dependencies.logger.error("the cancellation of the Implementer session failed", {
              tenant_id: input.tenantId,
              run_id: input.runId,
              runner: runner.name,
              error: String(error),
            });
          }
          return;
        }
        await new Promise((resolve) => {
          pendingTimer = setTimeout(resolve, SESSION_LOOKUP_INTERVAL_MS);
          pendingTimer.unref();
        });
      }
      if (running) {
        dependencies.logger.warn("no live Implementer session appeared for the cancellation", {
          tenant_id: input.tenantId,
          run_id: input.runId,
          runner: runner.name,
        });
      }
    };

    const onCancel = (): void => {
      void cancelLiveSession();
    };
    // A listener never fires on a signal that is already aborted, so the aborted case runs the
    // cancel path at once.
    if (context.cancellationSignal.aborted) onCancel();
    else context.cancellationSignal.addEventListener("abort", onCancel, { once: true });

    let result;
    try {
      result = await runner.run({
        runId: input.runId,
        tenantId: input.tenantId,
        role: "implementer",
        sandbox: dependencies.sandbox,
        ref: { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath },
        workingDirectory: input.primaryPath,
        prompt: implementerInput.prompt,
        promptVersion: implementerInput.promptVersion,
        environment: implementerInput.environment,
        actionPolicy,
        timeoutMs: input.timeoutMs,
      });
    } finally {
      running = false;
      clearInterval(heartbeat);
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      context.cancellationSignal.removeEventListener("abort", onCancel);
    }

    // The evidence of a cancelled run is kept. The activity returns the result of the runner
    // rather than a cancellation error, so the AgentExecution row still holds the summary.
    await dependencies.executions.record({
      tenantId: input.tenantId,
      runId: input.runId,
      role: "implementer",
      runner: runner.name,
      model: null,
      sessionRef: result.session.sessionId,
      promptVersion: implementerInput.promptVersion,
      durationMs: result.durationMs,
      finalResult: {
        completed: result.completed,
        exitCode: result.exitCode,
        cancelled: result.cancelled,
        summary: result.summary,
      },
      // A Temporal retry presents the same Run, the same role, and the same attempt ordinal, so
      // it upserts the one row. A later attempt carries a different ordinal and writes its own
      // row.
      idempotencyKey: `run:${input.runId}:implementer:${input.attempt}`,
    });

    metrics.implementationDuration.observe(
      { tenant_id: input.tenantId, project_id: input.projectId, runner: runner.name },
      result.durationMs / 1000,
    );
    dependencies.logger.info("implementation finished", {
      tenant_id: input.tenantId,
      project_id: input.projectId,
      run_id: input.runId,
      runner: runner.name,
      completed: result.completed,
      step: "implement",
    });

    return {
      sessionId: result.session.sessionId,
      processId: result.session.processId,
      runner: runner.name,
      completed: result.completed,
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      summary: result.summary,
      durationMs: result.durationMs,
      cancelledSession,
    };
  },

  async cancelImplementer(input: { runnerName: string; session: AgentSessionRef }): Promise<void> {
    // SDD section 50: a stop signal must cancel the active agent process. The task queue holds
    // more than one worker, and `CliAgentRunner` keeps its live sessions in process memory, so
    // this activity can run on a worker that never started the session. See SDD section 33.
    const outcome = await dependencies.runners.get(input.runnerName).cancel(input.session);
    if (outcome === "no-live-session") {
      dependencies.logger.error("this worker holds no live session for the cancellation", {
        runner: input.runnerName,
        session_id: input.session.sessionId,
        process_id: input.session.processId,
        message:
          "this worker holds no live session, so the agent process can still run on another worker",
      });
      // `cancelActivities` retries up to three attempts, so a retry can reach the worker that
      // owns the session. Both call sites wrap this activity in `notify()`, which swallows the
      // final exception, so a Run still reaches its terminal state and is never stranded. The
      // throw buys a real remediation attempt and costs nothing.
      throw new LiveSessionNotFoundError(input.runnerName, input.session);
    }
    dependencies.logger.info("the cancellation reached the live session", {
      runner: input.runnerName,
      session_id: input.session.sessionId,
      process_id: input.session.processId,
    });
  },
});

/** SDD section 50 obligation 1. This worker holds no live session for the given process id. */
export class LiveSessionNotFoundError extends Error {
  constructor(runnerName: string, session: AgentSessionRef) {
    super(
      `The runner "${runnerName}" holds no live session for process "${session.processId}" ` +
        `on this worker. The agent process can still run on another worker.`,
    );
    this.name = "LiveSessionNotFoundError";
  }
}
