import { Context } from "@temporalio/activity";
import type { Logger } from "~/telemetry/logger.js";
import type { AgentExecutionRepository } from "~/domain/runs/agent-execution.js";
import type { AgentRunResult, AgentRunner, AgentRunnerRegistry, AgentSessionRef } from "~/domain/runs/agent-runner.js";
import { AgentSessionUnavailableError } from "~/domain/runs/agent-runner.js";
import { agentSessionKey, type AgentSessionStore } from "~/domain/runs/agent-session.js";
import { hangOf, recordAgentSession, type AgentHang } from "./agent-session-recording.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import { registerProjectSecrets } from "~/domain/products/redaction-loader.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { buildImplementerInput } from "~/domain/runs/implementer-input.js";
import type { VerificationCommand } from "~/domain/runs/project-runtime-config.js";
import { attachRunnerEnvironment } from "~/domain/products/runner-credentials.js";
import type { EvidenceStore } from "~/domain/evidence/evidence.js";
import { canonicalEvidenceHash } from "~/domain/evidence/evidence.js";
import { metrics } from "~/telemetry/metrics.js";
import type { Redactor } from "~/telemetry/redaction.js";
import type { RunStageStore } from "~/domain/runs/run-stage.js";
import type { RunSkillStore } from "~/domain/runs/run-skill.js";
import type { SkillRegistrySettings } from "~/domain/runs/skill-registry.js";
import { recordSessionActivations, type SkillRegistryFactory } from "./skill-registry.activities.js";

export interface AgentActivityDependencies {
  runners: AgentRunnerRegistry;
  sandbox: Sandbox;
  executions: AgentExecutionRepository;
  /** docs/specs/agent-session-usage-and-hangs.md. One row per agent session. */
  sessions: AgentSessionStore;
  /** docs/specs/run-speed.md. The stage rows of each run. */
  stages?: RunStageStore | undefined;
  secrets: SecretStore;
  redactor: Redactor;
  logger: Logger;
  evidence: EvidenceStore;
  /** docs/specs/skill-registry.md. The skills of each run, and the adapter of each registry kind. */
  skills?: RunSkillStore | undefined;
  registries?: SkillRegistryFactory | undefined;
}

export interface ImplementActivityInput {
  runId: string;
  tenantId: string;
  productId: string;
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
  /**
   * docs/specs/skill-registry.md. The skill registry of the Product, or null. Absent in a history
   * recorded before the registry existed.
   */
  skillRegistry?: SkillRegistrySettings | null;
  /** docs/specs/skill-registry.md. True when the Product has a source that takes a skill proposal. */
  skillProposals?: boolean;
  repairFindings: string[];
  stagingRead: boolean;
  /**
   * docs/specs/implementer-self-check.md. The checks Factoree runs after the implementer
   * finishes. Absent in a history recorded before the prompt stated them.
   */
  verifyCommands?: VerificationCommand[];
  /**
   * docs/specs/implementer-self-check.md. True when the work sprite holds agent-browser. An
   * activity scheduled before this change carries the old preview object, which means the same.
   */
  selfCheck?: boolean | { previewCommand: string; readyUrl: string } | null;

  timeoutMs: number;
  /**
   * The ordinal of this Implementer attempt within the Run. The workflow counts it, so the
   * value stays the same across every Temporal retry of one activity and changes only for a
   * genuinely distinct attempt, for example a later repair loop attempt.
   */
  attempt: number;
  /**
   * docs/specs/agent-session-usage-and-hangs.md. The session that hung in the previous attempt.
   * This attempt resumes it with "continue" instead of starting a fresh session. Null or absent
   * starts a fresh session.
   */
  continueSession?: AgentSessionRef | null;
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
  /** docs/specs/agent-session-usage-and-hangs.md. Set when the session wrote no output for the silence limit. */
  hang: AgentHang;
}

/** docs/specs/agent-session-usage-and-hangs.md. The whole prompt of the resume after a hang. */
export const CONTINUE_PROMPT = "continue";

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
      input.productId,
      dependencies.logger,
    );

    // SDD section 30: a non-production test secret reaches the Implementer only when the
    // operator injects it explicitly. The mark on the secret is that explicit act. Every other
    // Project secret stays out of the sandbox, and the redactor above still holds its value.
    // `buildImplementerInput` keeps its own rejection of forbidden material as the last control.
    const descriptors = await dependencies.secrets.list(input.tenantId, input.productId);
    const projectTestSecrets: Record<string, string> = {};
    for (const descriptor of descriptors) {
      // A credential of another kind reaches its carrier by its own path, never this map.
      if (descriptor.kind !== "test" || !descriptor.injectIntoImplementer) continue;
      const value = await dependencies.secrets.get(input.tenantId, input.productId, descriptor.name);
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
      skillProposals: input.skillProposals === true,
      actionPolicy,
      repairFindings: input.repairFindings,
      projectTestSecrets,
      verifyCommands: input.verifyCommands ?? [],
      selfCheck: input.selfCheck !== undefined && input.selfCheck !== null && input.selfCheck !== false,
    });

    // SDD section 30. The runner credential is attached again here, because the attachment lives
    // in the worker process that made it, and another worker can run this activity. It reaches
    // the agent process environment, never the prompt and never `ImplementerInput`.
    await attachRunnerEnvironment(
      dependencies.sandbox,
      { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath },
      dependencies.secrets,
      input.tenantId,
      input.productId,
    );

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

    const runFresh = (): Promise<AgentRunResult> =>
      runner.run({
        runId: input.runId,
        tenantId: input.tenantId,
        role: "implementer",
        sandbox: dependencies.sandbox,
        ref: { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath },
        workingDirectory: input.primaryPath,
        repositoryPath: input.primaryPath,
        prompt: implementerInput.prompt,
        promptVersion: implementerInput.promptVersion,
        environment: implementerInput.environment,
        actionPolicy,
        timeoutMs: input.timeoutMs,
      });

    // docs/specs/agent-session-usage-and-hangs.md. After a hang the Implementer resumes its own
    // session with "continue", so the work it already did stays in its context. A session the
    // CLI never named, or one this worker does not hold, cannot resume, so a fresh session with
    // the whole prompt takes its place. DI-14.46.
    const resumeAfterHang = async (session: AgentSessionRef): Promise<AgentRunResult> => {
      if (session.sessionId === session.processId) return await runFresh();
      try {
        return await runner.resume(session, { prompt: CONTINUE_PROMPT, timeoutMs: input.timeoutMs });
      } catch (error) {
        if (!(error instanceof AgentSessionUnavailableError)) throw error;
        dependencies.logger.warn("the hung Implementer session cannot resume here, starting a fresh one", {
          tenant_id: input.tenantId,
          run_id: input.runId,
          runner: runner.name,
          session_id: session.sessionId,
        });
        return await runFresh();
      }
    };

    let result: AgentRunResult;
    try {
      const hung = input.continueSession ?? null;
      result = hung === null ? await runFresh() : await resumeAfterHang(hung);
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

    // SDD section 39. An implementation that did not finish leaves one immutable artifact, so the
    // reason outlives the sandbox. SDD section 51 destroys the sandbox after its retention window,
    // and the process files of the agent go with it. A finished implementation writes no row: its
    // outcome is the patch, and the verification evidence covers the rest.
    if (!result.completed && result.failureLog !== null) {
      await dependencies.evidence.record({
        tenantId: input.tenantId,
        runId: input.runId,
        validationAssertionId: null,
        kind: "command-output",
        source: `implement:${runner.name}`,
        sha256: canonicalEvidenceHash({
          runner: runner.name,
          attempt: input.attempt,
          exitCode: result.exitCode,
          summary: result.summary,
          log: result.failureLog,
        }),
        metadata: {
          runner: runner.name,
          attempt: input.attempt,
          exitCode: result.exitCode,
          cancelled: result.cancelled,
          durationMs: result.durationMs,
          sessionRef: result.session.sessionId,
          summary: result.summary,
          // The retained, redacted log of SDD section 61. It is bounded and it is never a full
          // transcript.
          log: result.failureLog,
        },
        // A Temporal retry of this activity writes nothing new, and a repair attempt carries its
        // own ordinal and writes its own row.
        idempotencyKey: `run:${input.runId}:implement:${input.attempt}`,
      });
    }

    await recordAgentSession(
      { sessions: dependencies.sessions, logger: dependencies.logger, stages: dependencies.stages },
      {
        tenantId: input.tenantId,
        productId: input.productId,
        runId: input.runId,
        role: "implementer",
        attempt: input.attempt,
        runner: runner.name,
        idempotencyKey: agentSessionKey(input.runId, "implementer", input.attempt, false),
        sandboxId: input.spriteId,
      },
      [result],
    );

    // docs/specs/skill-registry.md. Which skills the session loaded. A fault here is logged and
    // never fails the session.
    await recordSessionActivations(
      {
        secrets: dependencies.secrets,
        redactor: dependencies.redactor,
        logger: dependencies.logger,
        skills: dependencies.skills,
        registries: dependencies.registries,
      },
      {
        tenantId: input.tenantId,
        productId: input.productId,
        runId: input.runId,
        attempt: input.attempt,
        runner: runner.name,
        skillRegistry: input.skillRegistry ?? null,
        githubInstallationId: "",
        toolInputs: result.toolInputs ?? [],
      },
    );

    metrics.implementationDuration.observe(
      { tenant_id: input.tenantId, product_id: input.productId, runner: runner.name },
      result.durationMs / 1000,
    );
    dependencies.logger.info("implementation finished", {
      tenant_id: input.tenantId,
      product_id: input.productId,
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
      hang: hangOf([result]),
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
