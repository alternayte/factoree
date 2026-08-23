import {
  ActivityCancellationType,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  ApplicationFailure,
  isCancellation,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { RunStatus } from "~/domain/runs/run-status.js";
import type { Activities } from "~/activities/index.js";
import type { PrepareSandboxActivityOutput } from "~/activities/sandbox.activities.js";
import type { ImplementActivityOutput } from "~/activities/agent.activities.js";
import type { VerifyActivityOutput } from "~/activities/verification.activities.js";
import type { ResolveContextActivityOutput } from "~/activities/context.activities.js";
import type { RecordedDecision } from "~/domain/refinement/refinement-engine.js";
import type { AgentSessionRef } from "~/domain/runs/agent-runner.js";

import { buildWorkflowId } from "../temporal/workflow-id.js";
// The workflow bundler resolves a relative path only, so this value import does not use the
// `~/` alias.
import { RUN_CONFIGURATION_ERROR_TYPE } from "../domain/runs/run-configuration-error.js";
// The workflow bundler resolves a relative path only, so this value import does not use the
// `~/` alias either.
import { buildRepositoryUrl } from "../domain/projects/repository-url.js";

export interface AgentRunProjectInput {
  primaryRepository: string;
  referenceRepositories: string[];
  defaultBranch: string;
  /** Turns an `owner/repo` slug into a clone URL until the Phase 9 GitHub adapter exists. */
  repositoryBaseUrl: string;
  /**
   * SDD section 15 and SDD section 57. The runtime configuration comes from
   * `.factoree/config.yaml` in the primary repository. The Project owns these two values, and a
   * repository must not widen them.
   */
  stagingRead: boolean;
  spriteRetentionHours: number;
  defaultAutonomy: string;
}

/** SDD section 7. The Work Item text, exactly as the author wrote it. */
export interface AgentRunWorkItemInput {
  issueId: string | null;
  title: string;
  description: string;
  url: string | null;
  labels: string[];
}

export interface AgentRunWorkflowInput {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  linearIssueId: string | null;
  agentSessionId: string;
  autonomyLevel: string;
  maxRunMinutes: number;
  workItem: AgentRunWorkItemInput;
  project: AgentRunProjectInput;
}

export interface AgentRunWorkflowResult {
  runId: string;
  status: RunStatus;
}

export interface RunSnapshot {
  runId: string | null;
  status: RunStatus;
  humanInputs: string[];
  spriteId: string | null;
  /**
   * SDD section 53. The SHA-256 of the latest context resolution of this Run. SDD section 21
   * freezes that resolution only after no unresolved conflict remains, so an earlier value is
   * the hash of a draft.
   */
  contextContractVersion: string | null;
  /** SDD section 23. The one question Factoree waits on, or null. */
  openQuestion: string | null;
}

export const stopSignal = defineSignal("stop");
export const humanInputSignal = defineSignal<[string]>("humanInput");
export const runStatusQuery = defineQuery<RunSnapshot>("runStatus");

const activities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, initialInterval: "1 second", backoffCoefficient: 2 },
});

/**
 * Refinement is a pure computation, so it is fast, and a retry costs nothing. One minute is
 * ample for it.
 */
const refineActivities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3, initialInterval: "1 second", backoffCoefficient: 2 },
});

/** The longest one context resolution attempt can take. */
const RESOLVE_ATTEMPT_TIMEOUT_MS = 30 * 60_000;

/**
 * Context resolution clones and reads repositories, so it takes minutes. The remaining Run
 * budget bounds it, in the same way it bounds preparation.
 */
const buildContextActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${Math.min(RESOLVE_ATTEMPT_TIMEOUT_MS, budgetMs)} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs} milliseconds`,
    retry: { maximumAttempts: 3, initialInterval: "5 seconds", backoffCoefficient: 2 },
  });

/**
 * SDD section 8 and SDD section 23 put no bound on the elicitation loop. An unbounded loop is a
 * workflow that never ends. Five rounds cover a realistic clarification, and then Factoree stops.
 * Refinement and conflict resolution share the five rounds. The Run budget of SDD section 50
 * bounds the loop as well. See controller decision 6.
 */
export const MAX_QUESTION_ROUNDS = 5;

/** The longest one preparation attempt can take. A retry gets its own attempt of this length. */
const PREPARE_ATTEMPT_TIMEOUT_MS = 30 * 60_000;

/**
 * Preparation clones every repository and runs the bootstrap command, so it takes minutes.
 * `scheduleToCloseTimeout` bounds every attempt together, so the retry policy cannot spend more
 * than the remaining Run budget.
 */
const buildSandboxActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${Math.min(PREPARE_ATTEMPT_TIMEOUT_MS, budgetMs)} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs} milliseconds`,
    // SDD section 49: a semantic failure must not consume the infrastructure retry policy. A
    // configuration fault repeats on every attempt, so it fails fast.
    retry: {
      maximumAttempts: 3,
      initialInterval: "5 seconds",
      backoffCoefficient: 2,
      nonRetryableErrorTypes: [RUN_CONFIGURATION_ERROR_TYPE],
    },
  });

/**
 * Reports whether a failure, or any cause below it, is the configuration error of the domain.
 * Temporal wraps an activity error, so the type appears on a cause rather than on the top error.
 */
const isConfigurationFault = (error: unknown): boolean => {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof ApplicationFailure && current.type === RUN_CONFIGURATION_ERROR_TYPE) return true;
  }
  return false;
};

/**
 * The margin the Implementer activity keeps after the Run budget ends. It covers the
 * cancellation of the agent process and the write of the AgentExecution row.
 */
const IMPLEMENT_MARGIN_MS = 5 * 60_000;

/** The interval between two heartbeats of the Implementer activity. */
const IMPLEMENT_HEARTBEAT_TIMEOUT_MS = 120_000;

/**
 * The Implementer activity is bounded by the remaining Run budget, not by a fixed timeout, so
 * the maximum Run duration really bounds the Run. The activity heartbeats, so Temporal can
 * deliver a cancellation to it. SDD section 49: a semantic failure must not consume the
 * infrastructure retry policy. The Implementer reports a failed attempt as a result, so one
 * attempt is correct here.
 */
const buildImplementActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${budgetMs + IMPLEMENT_MARGIN_MS} milliseconds`,
    // Every attempt together stays inside the Run budget plus the margin. One attempt is allowed,
    // so the two timeouts agree, and the bound holds even if the retry policy changes.
    scheduleToCloseTimeout: `${budgetMs + IMPLEMENT_MARGIN_MS} milliseconds`,
    heartbeatTimeout: `${IMPLEMENT_HEARTBEAT_TIMEOUT_MS} milliseconds`,
    // The workflow waits for the cancelled activity, so the evidence the agent already produced
    // still reaches the AgentExecution row.
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
  });

/** The longest one verification pass can take. A retry gets its own attempt of this length. */
const VERIFY_ATTEMPT_TIMEOUT_MS = 60 * 60_000;

/**
 * Verification runs the project build and test commands, so it takes minutes. It is bounded by
 * the remaining Run budget. SDD section 49: a semantic failure must not consume the
 * infrastructure retry policy. A failing check is a semantic outcome, and the activity returns
 * it as a result, so a retry here covers only a transport fault.
 */
const buildVerifyActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${Math.min(VERIFY_ATTEMPT_TIMEOUT_MS, budgetMs)} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs} milliseconds`,
    retry: { maximumAttempts: 3, initialInterval: "5 seconds", backoffCoefficient: 2 },
  });

// The cancellation of a live Implementer session runs after the Run budget has ended, so it
// needs its own short timeout.
const cancelActivities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3, initialInterval: "1 second", backoffCoefficient: 2 },
});

// The first Implementer attempt of a Run. A later repair loop attempt increments this value, so
// each attempt writes its own AgentExecution row.
const FIRST_IMPLEMENTER_ATTEMPT = 1;

export async function agentRunWorkflow(
  input: AgentRunWorkflowInput,
): Promise<AgentRunWorkflowResult> {
  let runId: string | null = null;
  let status: RunStatus = "RECEIVED";
  const humanInputs: string[] = [];
  let stopRequested = false;
  let sprite: PrepareSandboxActivityOutput | null = null;
  let implementerSession: AgentSessionRef | null = null;
  /** True once the implement activity itself has cancelled the live session. */
  let implementerCancelled = false;
  /** SDD section 23. Every answer a human gave to a question Factoree asked in this Run. */
  const decisions: RecordedDecision[] = [];
  let openQuestion: string | null = null;
  let contextContractVersion: string | null = null;
  let questionRounds = 0;

  setHandler(stopSignal, () => {
    stopRequested = true;
  });
  setHandler(humanInputSignal, (body: string) => {
    humanInputs.push(body);
  });
  setHandler(runStatusQuery, () => ({
    runId,
    status,
    humanInputs,
    spriteId: sprite?.spriteId ?? null,
    contextContractVersion,
    openQuestion,
  }));

  const created = await activities.createRun({
    tenantId: input.tenantId,
    projectId: input.projectId,
    linearIssueId: input.linearIssueId,
    linearAgentSessionId: input.agentSessionId,
    temporalWorkflowId: buildWorkflowId(input.workspaceId, input.agentSessionId),
    autonomyLevel: input.autonomyLevel,
  });
  runId = created.runId;
  // A const holds the identifier, because narrowing of a let does not survive into a closure.
  const id = created.runId;

  // The Run budget starts here. Every later step reads the remaining time from this deadline, so
  // preparation and implementation consume the same budget as the wait does.
  // `maxRunMinutes` can be a fraction. A whole number of milliseconds, with a floor of one
  // second, keeps every derived Temporal duration valid.
  const runBudgetMs = Math.max(1_000, Math.round(input.maxRunMinutes * 60_000));
  const deadline = Date.now() + runBudgetMs;
  const remainingMs = (): number => Math.max(0, deadline - Date.now());

  const failRun = async (
    failureReason:
      | "RUN_TIMEOUT"
      | "IMPLEMENTATION_FAILED"
      | "CONFIGURATION_INVALID"
      | "VERIFICATION_FAILED"
      | "REFINEMENT_UNRESOLVED"
      | "CONTEXT_UNRESOLVED",
    message: string,
  ): Promise<AgentRunWorkflowResult> => {
    status = failureReason === "CONFIGURATION_INVALID" ? "FAILED_CONFIGURATION" : "FAILED";
    // Write the durable terminal state first. A Linear outage must not leave the Run open.
    await activities.completeRun({
      tenantId: input.tenantId,
      runId: id,
      status,
      failureReason,
      completedAt: new Date(Date.now()).toISOString(),
    });
    await notify(() => activities.postError({ sessionId: input.agentSessionId, message }));
    return { runId: id, status };
  };

  const timeoutMessage = "Factoree stopped the Run because it reached the maximum Run duration.";

  /**
   * SDD section 23 requires one focused question. The workflow asks that question. It waits for
   * exactly one human input. It records the answer against that question. The result is false
   * when the Run must end instead, so every caller must check the result. The remaining Run
   * budget bounds the wait, and a stop signal ends it as well.
   */
  const askAndWait = async (questionId: string, question: string): Promise<boolean> => {
    if (questionRounds >= MAX_QUESTION_ROUNDS) return false;
    // The count is read before the first await. A human can answer as soon as the Run reports
    // WAITING_FOR_INPUT, which happens before the elicitation reaches Linear. An answer that
    // arrives in that moment answers this question, and the wait does not miss it.
    const answersBefore = humanInputs.length;
    questionRounds += 1;
    openQuestion = question;
    status = "WAITING_FOR_INPUT";
    await activities.setRunStatus({ runId: id, status });
    await notify(() => activities.postElicitation({ sessionId: input.agentSessionId, question }));

    const answered = await condition(
      () => stopRequested || humanInputs.length > answersBefore,
      remainingMs(),
    );
    openQuestion = null;
    if (!answered || stopRequested) return false;
    // One human input answers the open question only. SDD section 23 permits one question at a
    // time, so the last input belongs to this question.
    decisions.push({ questionId, question, answer: humanInputs[humanInputs.length - 1] ?? "" });
    return true;
  };

  /**
   * One Implementer attempt. The cancellation scope, the stop watcher, and the session
   * bookkeeping are unchanged from Phase 2. It returns null when the activity was cancelled.
   */
  const runImplementer = async (attemptInput: {
    prepared: PrepareSandboxActivityOutput;
    goal: string;
    attempt: number;
    repairFindings: string[];
    /**
     * SDD section 21 and AT-09. The prompt carries the rendered contract and the
     * required-context lines. No file body reaches it.
     */
    contextContract: string;
    requiredContext: string[];
  }): Promise<ImplementActivityOutput | null> => {
    const budgetMs = remainingMs();
    const implementActivities = buildImplementActivities(budgetMs);
    const scope = new CancellationScope({ cancellable: true });
    const running = scope.run(() =>
      implementActivities.implement({
        runId: id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        runnerName: attemptInput.prepared.runtime.implementerRunner,
        spriteId: attemptInput.prepared.spriteId,
        adapter: attemptInput.prepared.adapter,
        workspacePath: attemptInput.prepared.workspacePath,
        primaryPath: attemptInput.prepared.primaryPath,
        referencePaths: attemptInput.prepared.referencePaths,
        goal: attemptInput.goal,
        contextContract: attemptInput.contextContract,
        requiredContext: attemptInput.requiredContext,
        humanDecisions: humanInputs,
        repositoryInstructions: attemptInput.prepared.repositoryInstructions,
        repairFindings: attemptInput.repairFindings,
        stagingRead: attemptInput.prepared.runtime.stagingRead,
        timeoutMs: budgetMs,
        attempt: attemptInput.attempt,
      }),
    );
    // SDD section 50: a stop must reach the running agent process. The scope cancellation
    // travels to the activity, and the activity stops the live session.
    const watching = scope
      .run(() => condition(() => stopRequested))
      .then(() => {
        scope.cancel();
      })
      .catch(() => undefined);

    let implementation: ImplementActivityOutput | null = null;
    try {
      implementation = await running;
    } catch (error) {
      // A cancelled Implementer is the stop path, not a fault. Every other error stays a fault.
      if (!isCancellation(error)) throw error;
    } finally {
      scope.cancel();
      await watching;
    }

    if (implementation !== null) {
      // The fallback below runs unless the activity itself really cancelled the session. A
      // session lookup that gave up, or a cancel that failed, still needs the fallback.
      implementerCancelled = implementation.cancelledSession;
      implementerSession = {
        sessionId: implementation.sessionId,
        processId: implementation.processId,
        runner: implementation.runner,
      };
    }
    return implementation;
  };

  // SDD section 50: a stop must terminate the active agent process, and no change is published.
  const cancelRun = async (): Promise<AgentRunWorkflowResult> => {
    const session = implementerSession;
    // The implement activity cancels its own live session when the scope cancellation reaches
    // it. A second cancellation is needed only for a session the activity did not cancel.
    if (session !== null && !implementerCancelled) {
      await notify(() =>
        cancelActivities.cancelImplementer({ runnerName: session.runner, session }),
      );
    }
    status = "CANCELLED";
    await activities.completeRun({
      tenantId: input.tenantId,
      runId: id,
      status,
      failureReason: "STOPPED_BY_HUMAN",
      completedAt: new Date(Date.now()).toISOString(),
    });
    await notify(() =>
      activities.postFinalResponse({
        sessionId: input.agentSessionId,
        body: "Factoree stopped this Run at your request. No change was published.",
      }),
    );
    return { runId: id, status };
  };

  try {
    await activities.acknowledgeSession({
      sessionId: input.agentSessionId,
      message: "Factoree accepted the work and started a Run.",
    });

    status = "RECEIVED";
    await activities.setRunStatus({ runId: id, status, startedAt: new Date(Date.now()).toISOString() });

    {
      // A Run whose budget has already passed must not start work it cannot finish.
      if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

      // SDD section 8. Refinement reads the Work Item and the Project record only. It reaches no
      // repository and no sandbox, so it runs before preparation.
      const refinementInput = () => ({
        runId: id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        source: input.workItem,
        project: {
          primaryRepository: input.project.primaryRepository,
          referenceRepositories: input.project.referenceRepositories,
          defaultAutonomy: input.project.defaultAutonomy,
        },
        decisions,
      });

      status = "REFINING";
      await activities.setRunStatus({ runId: id, status });
      let refined = await refineActivities.refine(refinementInput());

      // SDD section 8. A material product question blocks the Run. The rounds are bounded, so
      // this loop always ends.
      while (refined.status === "needs_input") {
        const question = refined.unresolvedQuestions[0];
        if (question === undefined) break;
        const proceeded = await askAndWait(question.id, question.question);
        if (stopRequested) return await cancelRun();
        if (!proceeded) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          return await failRun(
            "REFINEMENT_UNRESOLVED",
            "Factoree could not start, because a material product decision is still open: " +
              `${question.question} Factoree must not invent product behavior, ` +
              "so it published nothing.",
          );
        }
        status = "REFINING";
        await activities.setRunStatus({ runId: id, status });
        refined = await refineActivities.refine(refinementInput());
      }

      // SDD section 20. Discovery pins one SHA for each repository. The ref below is the ref
      // discovery starts from. The checkout later uses the pinned SHA.
      const repositoryRef = (slug: string) => ({
        slug,
        url: buildRepositoryUrl(input.project.repositoryBaseUrl, slug),
        ref: input.project.defaultBranch,
      });

      // SDD section 23. A conflict without an authority winner blocks the Run. The bounded
      // rounds end this loop, and the Run budget ends it as well.
      let resolvedContext: ResolveContextActivityOutput;
      for (;;) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "RESOLVING_CONTEXT";
        await activities.setRunStatus({ runId: id, status });

        resolvedContext = await buildContextActivities(remainingMs()).resolveContext({
          runId: id,
          tenantId: input.tenantId,
          projectId: input.projectId,
          goal: refined.goal,
          acceptanceCriteria: refined.acceptanceCriteria,
          primaryRepository: repositoryRef(refined.primaryRepository),
          referenceRepositories: refined.referenceRepositories.map(repositoryRef),
          workItemReferences: refined.workItemReferences,
          decisions,
        });
        contextContractVersion = resolvedContext.sha256;

        await notify(() =>
          activities.postProgress({
            sessionId: input.agentSessionId,
            message: resolvedContext.summary,
          }),
        );

        const conflict = resolvedContext.unresolvedConflict;
        if (conflict === null) break;

        // SDD section 23. No safe resolution exists, so implementation must not start.
        const proceeded = await askAndWait(conflict.id, conflict.question);
        if (stopRequested) return await cancelRun();
        if (!proceeded) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          return await failRun(
            "CONTEXT_UNRESOLVED",
            "Factoree could not start, because two equally authoritative sources disagree: " +
              `${conflict.question} Factoree published nothing.`,
          );
        }
      }

      // A stop that arrived during the context work must prevent preparation.
      if (stopRequested) return await cancelRun();
      if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

      // SDD section 15. The runtime configuration comes from `.factoree/config.yaml` in the
      // primary repository. Only the values a repository must not own travel from here.
      const sandbox = {
        primary: {
          url: buildRepositoryUrl(input.project.repositoryBaseUrl, resolvedContext.primary.slug),
          // SDD section 20. The checkout lands on the SHA discovery pinned. A branch name can
          // point to a new commit at any time, so the workflow must not use one here. The Run
          // and the Context Contract then read one state of the repository.
          ref: resolvedContext.primary.sha,
        },
        references: resolvedContext.references.map((repository) => ({
          url: buildRepositoryUrl(input.project.repositoryBaseUrl, repository.slug),
          ref: repository.sha,
        })),
        defaults: {
          stagingRead: input.project.stagingRead,
          spriteRetentionHours: input.project.spriteRetentionHours,
        },
        goal: refined.goal,
      };

      status = "PREPARING";
      await activities.setRunStatus({ runId: id, status });

      const sandboxActivities = buildSandboxActivities(remainingMs());

      // SDD section 32. The sandbox stays after the Run ends. `SpriteReaper` deletes it once the
      // retention window of SDD section 51 has passed.
      // A const holds the prepared sandbox, because narrowing of a let does not survive into a
      // closure.
      let preparedSandbox: PrepareSandboxActivityOutput;
      try {
        preparedSandbox = await sandboxActivities.prepareSandbox({
          runId: id,
          tenantId: input.tenantId,
          projectId: input.projectId,
          primary: sandbox.primary,
          references: sandbox.references,
          defaults: sandbox.defaults,
          environment: {},
        });
      } catch (error) {
        // A configuration fault is not an infrastructure fault. The Run ends in
        // `FAILED_CONFIGURATION`, and the retry policy already denied a second attempt.
        if (isConfigurationFault(error)) {
          return await failRun(
            "CONFIGURATION_INVALID",
            "Factoree could not prepare the sandbox, because the Run configuration is invalid. " +
              "Repair the repository reference, the reference repositories, or the bootstrap command.",
          );
        }
        // Preparation is bounded by the remaining budget. A budget that ran out during
        // preparation is a Run timeout, not an internal fault.
        if (remainingMs() > 0) throw error;
        return await failRun("RUN_TIMEOUT", timeoutMessage);
      }
      sprite = preparedSandbox;

      // A stop that arrived during preparation must prevent the Implementer from starting.
      if (stopRequested) return await cancelRun();
      // Preparation can consume the whole budget. The Run must end here rather than start work
      // it cannot finish.
      if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

      // One Implementer attempt plus its verification. SDD section 42 bounds the number of
      // repairs, so the loop can never run without end.
      let attempt = FIRST_IMPLEMENTER_ATTEMPT;
      let repairFindings: string[] = [];
      let repairCount = 0;
      const maxRepairs = preparedSandbox.runtime.repairMaxAttempts;

      for (;;) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "IMPLEMENTING";
        await activities.setRunStatus({ runId: id, status });

        const implementation = await runImplementer({
          prepared: preparedSandbox,
          goal: sandbox.goal,
          attempt,
          repairFindings,
          contextContract: resolvedContext.document,
          requiredContext: resolvedContext.requiredContext,
        });

        // A stop that arrived while the Implementer ran must end the Run here.
        if (stopRequested) return await cancelRun();

        // SDD section 49: a semantic outcome drives a workflow decision. A failed attempt must
        // not fall into the wait and become a timeout.
        if (implementation === null || !implementation.completed) {
          // SDD section 50: a Run that reaches the maximum duration fails with `RUN_TIMEOUT`.
          // The runner reports a cancelled agent process as an incomplete attempt, so the
          // deadline decides which of the two outcomes this is.
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          return await failRun(
            "IMPLEMENTATION_FAILED",
            "The Implementer did not complete the change. Factoree ended the Run.",
          );
        }

        // SDD section 35. The agent has now claimed success. The claim does not decide what
        // follows. Only the configured commands do.
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "VERIFYING";
        await activities.setRunStatus({ runId: id, status });

        const verifyActivities = buildVerifyActivities(remainingMs());
        let verification: VerifyActivityOutput;
        try {
          verification = await verifyActivities.verify({
            runId: id,
            tenantId: input.tenantId,
            projectId: input.projectId,
            spriteId: preparedSandbox.spriteId,
            adapter: preparedSandbox.adapter,
            workspacePath: preparedSandbox.workspacePath,
            primaryPath: preparedSandbox.primaryPath,
            commands: preparedSandbox.verifyCommands,
            timeoutMs: remainingMs(),
            attempt,
          });
        } catch (error) {
          // Verification is bounded by the remaining budget, the same way preparation is. A
          // budget that ran out during verification is a Run timeout, not an internal fault.
          if (remainingMs() > 0) throw error;
          return await failRun("RUN_TIMEOUT", timeoutMessage);
        }

        await notify(() =>
          activities.postProgress({
            sessionId: input.agentSessionId,
            message: verification.summary,
          }),
        );

        if (stopRequested) return await cancelRun();
        if (verification.passed) break;

        // SDD section 42. A failing check enters repair while budget remains. No third repair
        // occurs when the limit is two.
        if (repairCount >= maxRepairs) {
          return await failRun(
            "VERIFICATION_FAILED",
            "Deterministic verification did not pass, and the repair budget is spent. " +
              `${verification.summary} Factoree published nothing.`,
          );
        }
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        repairCount += 1;
        attempt += 1;
        repairFindings = verification.failures;
        status = "REPAIRING";
        await activities.setRunStatus({ runId: id, status, repairCount });
      }
    }

    // Deterministic verification passed. The next state of SDD section 49 is USER_VALIDATING,
    // and Phase 7 builds it. Until then the Run stays open for a stop signal, for human input,
    // or until the Run budget ends it. SDD section 68 forbids READY_FOR_HUMAN without a
    // Validation Contract, a PR, and a Proof Pack, so Phase 3 invents no success terminal state.
    const stopped = await condition(() => stopRequested, remainingMs());

    if (!stopped) return await failRun("RUN_TIMEOUT", timeoutMessage);

    return await cancelRun();
  } catch (error) {
    // Any unhandled activity failure must still drive the Run to a terminal state.
    status = "FAILED";
    await activities.completeRun({
      tenantId: input.tenantId,
      runId: id,
      status,
      failureReason: "INTERNAL_ERROR",
      completedAt: new Date(Date.now()).toISOString(),
    });
    throw error;
  }
}

// A Linear notification failure must not abort the workflow after the durable state is written.
const notify = async (send: () => Promise<void>): Promise<void> => {
  try {
    await send();
  } catch {
    // The Run is already terminal in the database. The Linear post is best effort.
  }
};
