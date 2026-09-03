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
  sleep,
} from "@temporalio/workflow";
import type { RunStatus } from "~/domain/runs/run-status.js";
import type { Activities } from "~/activities/index.js";
import type { PrepareSandboxActivityOutput } from "~/activities/sandbox.activities.js";
import type { ImplementActivityOutput } from "~/activities/agent.activities.js";
import type { VerifyActivityOutput } from "~/activities/verification.activities.js";
import type { UserValidateActivityOutput } from "~/activities/validation.activities.js";
import type { ReviewActivityOutput } from "~/activities/review.activities.js";
import type { ResolveContextActivityOutput } from "~/activities/context.activities.js";
import type {
  CheckBaseActivityOutput,
  PublishActivityOutput,
} from "~/activities/publishing.activities.js";
import type { PublishProofPackActivityOutput } from "~/activities/evidence.activities.js";
import type { RecordedDecision } from "~/domain/refinement/refinement-engine.js";
import type { AgentSessionRef } from "~/domain/runs/agent-runner.js";
import type { AuthorityDomain } from "~/domain/context/authority.js";

import { buildWorkflowId } from "../temporal/workflow-id.js";
// The workflow bundler resolves a relative path only, so this value import does not use the
// `~/` alias.
import { RUN_CONFIGURATION_ERROR_TYPE } from "../domain/runs/run-configuration-error.js";
// The workflow bundler resolves a relative path only, so this value import does not use the
// `~/` alias either.
import { buildRepositoryUrl } from "../domain/projects/repository-url.js";
// The workflow bundler resolves a relative path only, so this value import does not use the
// `~/` alias either.
import { renderRisks } from "../domain/refinement/risk.js";
// The workflow bundler resolves a relative path only, so this value import does not use the
// `~/` alias either.
import { completionInvariantFailures } from "../domain/runs/completion-invariant.js";

/** One member repository of a Product, as the workflow needs to see it. */
export interface AgentRunProductRepositoryInput {
  id: string;
  fullName: string;
  defaultBranch: string;
}

export interface AgentRunProductInput {
  productId: string;
  productSlug: string;
  defaultAutonomy: string;
  /**
   * Every repository the Product owns. Task 10 selects the target repository of the Run from
   * this list. Until then, the workflow treats the first entry as the target.
   */
  repositories: AgentRunProductRepositoryInput[];
  /** Turns an `owner/repo` slug into a clone URL until the Phase 9 GitHub adapter exists. */
  repositoryBaseUrl: string;
  /**
   * SDD section 15 and SDD section 57. The runtime configuration comes from
   * `.factoree/config.yaml` in the target repository. The Product owns these two values, and a
   * repository must not widen them.
   */
  stagingRead: boolean;
  spriteRetentionHours: number;
  /** SDD section 16. The organization skills repository slug of the Product, or null. */
  organizationSkillsRepository: string | null;
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
  product: AgentRunProductInput;
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
  /**
   * SDD section 53. The SHA-256 of the frozen Validation Contract of this Run, or null while no
   * contract is frozen. SDD section 25 makes this value stable once it is set.
   */
  validationContractVersion: string | null;
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

/**
 * The Validation Contract build is a pure computation plus one database write, so it is fast and
 * a retry costs nothing. One minute is ample for it.
 */
const validationActivities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, initialInterval: "1 second", backoffCoefficient: 2 },
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
    // SDD section 49: a semantic failure must not consume the infrastructure retry policy. A
    // repository reference that resolves to nothing repeats on every attempt, so it fails fast.
    retry: {
      maximumAttempts: 3,
      initialInterval: "5 seconds",
      backoffCoefficient: 2,
      nonRetryableErrorTypes: [RUN_CONFIGURATION_ERROR_TYPE],
    },
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
 * Maps a publication failure to its SDD failure reason. The error crosses the activity boundary,
 * so the workflow sees the Temporal `ApplicationFailure` shape and must read the type name.
 */
const publicationFailureReasonOf = (
  error: unknown,
): "PATCH_HASH_MISMATCH" | "EMPTY_PATCH" | "PUBLICATION_FAILED" => {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof ApplicationFailure) {
      if (current.type === "PATCH_HASH_MISMATCH") return "PATCH_HASH_MISMATCH";
      if (current.type === "EMPTY_PATCH") return "EMPTY_PATCH";
    }
  }
  return "PUBLICATION_FAILED";
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

/**
 * The User Validator activity runs a fresh agent session against a live preview, the same way
 * the Implementer runs one against the sandbox. SDD section 36 puts it inside the same bounded
 * loop, so it takes the same long-activity options as `buildImplementActivities`: the remaining
 * Run budget bounds it, one attempt is allowed, and a heartbeat lets Temporal deliver a
 * cancellation to the live session.
 */
const buildUserValidateActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${budgetMs + IMPLEMENT_MARGIN_MS} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs + IMPLEMENT_MARGIN_MS} milliseconds`,
    heartbeatTimeout: `${IMPLEMENT_HEARTBEAT_TIMEOUT_MS} milliseconds`,
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
  });

/**
 * The Reviewer activity runs a fresh agent session against the source diff, the same way the
 * User Validator runs one against the preview. SDD section 42 puts it inside the same bounded
 * loop, so it takes the same long-activity options.
 */
const buildReviewActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${budgetMs + IMPLEMENT_MARGIN_MS} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs + IMPLEMENT_MARGIN_MS} milliseconds`,
    heartbeatTimeout: `${IMPLEMENT_HEARTBEAT_TIMEOUT_MS} milliseconds`,
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

/**
 * SDD section 46. The publication clones the repository, applies the patch, pushes, and calls
 * GitHub. A slow network must not fail it, and every step of it is idempotent, so a retry is
 * safe. Controller decision 8 keeps the branch name and the pull request lookup deterministic.
 * SDD section 49 forbids a semantic failure to consume the infrastructure retry policy, so the
 * four semantic types below fail fast.
 */
const publishingActivities = proxyActivities<Activities>({
  startToCloseTimeout: "15 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [
      RUN_CONFIGURATION_ERROR_TYPE,
      "PATCH_HASH_MISMATCH",
      "EMPTY_PATCH",
      "PUBLICATION_FAILED",
    ],
  },
});

/**
 * SDD section 47. The Proof Pack reads five stores and posts one Linear response. It is not a
 * fast activity, and a missing input is the only failure a retry cannot repair.
 */
const proofPackActivities = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1 second",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [RUN_CONFIGURATION_ERROR_TYPE, "PROOF_PACK_INPUT_MISSING"],
  },
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
  let validationContractVersion: string | null = null;
  let questionRounds = 0;

  // Task 10 selects the target repository of the Run from `input.product.repositories`. Until
  // then, the workflow treats the first member repository as the sole target, and every other
  // member repository as a reference repository.
  const targetRepositories = input.product.repositories;
  const primaryRepositorySlug = targetRepositories[0]?.fullName ?? "";
  const referenceRepositorySlugs = targetRepositories.slice(1).map((repository) => repository.fullName);
  const defaultBranchForSlug = (slug: string) =>
    targetRepositories.find((repository) => repository.fullName === slug)?.defaultBranch ??
    targetRepositories[0]?.defaultBranch ??
    "main";

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
    validationContractVersion,
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
      | "CONTEXT_UNRESOLVED"
      | "VALIDATION_UNRESOLVED"
      | "VALIDATION_FAILED"
      | "VALIDATION_BLOCKED"
      | "VALIDATION_MANUAL_REQUIRED"
      | "REVIEW_BLOCKING_FINDINGS"
      | "REVIEW_UNAVAILABLE"
      | "PATCH_HASH_MISMATCH"
      | "EMPTY_PATCH"
      | "PUBLICATION_FAILED"
      | "COMPLETION_INVARIANT_UNMET",
    message: string,
  ): Promise<AgentRunWorkflowResult> => {
    // SDD section 50 obligation 1. A Run that ends on its deadline must cancel the active agent
    // process. The implement activity cancels its own live session when a scope cancellation
    // reaches it. The workflow must cancel again only when the activity did not already cancel the session.
    const live = implementerSession;
    if (live !== null && !implementerCancelled) {
      await notify(() =>
        cancelActivities.cancelImplementer({ runnerName: live.runner, session: live }),
      );
    }

    // SDD section 48. A blocking review finding has its own terminal state. Every other reason
    // except a configuration fault ends the Run in `FAILED`.
    status =
      failureReason === "CONFIGURATION_INVALID"
        ? "FAILED_CONFIGURATION"
        : failureReason === "REVIEW_BLOCKING_FINDINGS"
          ? "FAILED_REVIEW"
          : "FAILED";
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

  /**
   * SDD section 45 and section 48. A moved target branch is not a failure of the change, so it
   * carries no failure reason. Version 1 must not rebase automatically, so the Run ends here and
   * publishes nothing. The base SHA arrives as an argument, because the prepared sandbox is out
   * of scope at this point of the file.
   */
  const endStale = async (
    runBaseSha: string,
    currentTargetSha: string,
  ): Promise<AgentRunWorkflowResult> => {
    status = "STALE_BASE";
    await activities.completeRun({
      tenantId: input.tenantId,
      runId: id,
      status,
      completedAt: new Date(Date.now()).toISOString(),
    });
    await notify(() =>
      activities.postError({
        sessionId: input.agentSessionId,
        message:
          "The target branch moved while Factoree worked, so the verified change no longer " +
          `applies to it. The Run started at ${runBaseSha} and the ` +
          `branch now points at ${currentTargetSha}. Factoree published nothing, and it did not ` +
          "rebase. Delegate the Work Item again to rerun it against the new base.",
      }),
    );
    return { runId: id, status };
  };

  const timeoutMessage = "Factoree stopped the Run because it reached the maximum Run duration.";

  /**
   * The pull request URL of a successful publication, or null while nothing is published. A stop
   * message and a timeout message must not claim that nothing was published once it exists. The
   * Run status does not change, because SDD section 68 forbids a success terminal state before
   * Phase 10 builds the Proof Pack.
   */
  let publishedPullRequestUrl: string | null = null;

  /**
   * SDD section 23 requires one focused question. The workflow asks that question. It waits for
   * exactly one human input. It records the answer against that question. The result is false
   * when the Run must end instead, so every caller must check the result. The remaining Run
   * budget bounds the wait, and a stop signal ends it as well.
   */
  const askAndWait = async (
    questionId: string,
    question: string,
    /**
     * SDD section 23. The conflict subject this question asks about. The answer settles that
     * subject only. A refinement question settles no conflict, so the caller passes no subject.
     */
    subject?: string,
    /**
     * SDD section 22. The authority domain of the conflict. The answer settles that domain with
     * that subject, and no other pair. A refinement question carries no domain.
     */
    domain?: AuthorityDomain,
  ): Promise<boolean> => {
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
    decisions.push({
      questionId,
      question,
      answer: humanInputs[humanInputs.length - 1] ?? "",
      ...(subject === undefined ? {} : { subject }),
      ...(domain === undefined ? {} : { domain }),
    });
    return true;
  };

  /**
   * Run one long agent activity under a stop signal. SDD section 50 requires a stop to reach
   * the live agent process, so the activity runs inside a cancellable scope, and a watcher
   * coroutine cancels that scope when the stop arrives. The result is null when the activity
   * was cancelled. Every long agent stage uses this helper, so the ordering rules below stay
   * the same for all of them.
   */
  const runAgentActivity = async <T>(start: () => Promise<T>): Promise<T | null> => {
    // A stop that arrived before this stage started must not schedule the activity at all.
    // The scope would then be cancelled in the same workflow activation that created it, and
    // the cancel command can race the schedule command at the server. The activity options use
    // `WAIT_CANCELLATION_COMPLETED`, so the workflow would then wait forever for a
    // cancellation report from an activity that no worker ever started.
    if (stopRequested) return null;

    const scope = new CancellationScope({ cancellable: true });
    const running = scope.run(start);
    // The schedule command above must reach the server in its own workflow activation, before
    // any cancel command can follow it. This durable timer blocks the main coroutine, so the
    // schedule command flushes first, and the two commands can never share one activation.
    await sleep(1);
    const watching = scope
      .run(() => condition(() => stopRequested))
      .then(() => {
        scope.cancel();
      })
      .catch(() => undefined);

    let result: T | null = null;
    try {
      result = await running;
    } catch (error) {
      // A cancelled agent activity is the stop path, not a fault. Every other error is a fault.
      if (!isCancellation(error)) throw error;
    } finally {
      // The activity has settled by now. This cancel unblocks the watcher's own pending
      // `condition`, which never settles on its own when no stop arrives. The cancel reaches
      // no live activity. The SDK sends a cancel command only while the activity is still
      // pending, so a cancel after the activity settled produces no command.
      scope.cancel();
      await watching;
    }
    return result;
  };

  /**
   * One Implementer attempt. The session bookkeeping is unchanged from Phase 2. It returns
   * null when the activity was cancelled.
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
    /**
     * SDD section 34. The Implementer receives the frozen Validation Contract. SDD section 25
     * denies it the authority to change the contract, which the store enforces, not this prompt.
     */
    validationContract: string;
  }): Promise<ImplementActivityOutput | null> => {
    const budgetMs = remainingMs();
    const implementActivities = buildImplementActivities(budgetMs);
    const implementation = await runAgentActivity(() =>
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
        validationContract: attemptInput.validationContract,
        requiredContext: attemptInput.requiredContext,
        humanDecisions: humanInputs,
        repositoryInstructions: attemptInput.prepared.repositoryInstructions,
        skills: attemptInput.prepared.skills,
        repairFindings: attemptInput.repairFindings,
        stagingRead: attemptInput.prepared.runtime.stagingRead,
        timeoutMs: budgetMs,
        attempt: attemptInput.attempt,
      }),
    );

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

  /**
   * One User Validator pass. SDD section 36 places it inside the same bounded loop the
   * Implementer and deterministic verification use. It shares `runAgentActivity` with
   * `runImplementer`, because the same long-activity options apply. The activity cancels its
   * own live validator session when the scope cancellation reaches it.
   */
  const runUserValidate = async (attemptInput: {
    prepared: PrepareSandboxActivityOutput;
    goal: string;
    attempt: number;
  }): Promise<UserValidateActivityOutput | null> => {
    const budgetMs = remainingMs();
    const userValidateActivities = buildUserValidateActivities(budgetMs);
    return await runAgentActivity(() =>
      userValidateActivities.userValidate({
        runId: id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        runnerName: attemptInput.prepared.runtime.validatorRunner,
        spriteId: attemptInput.prepared.spriteId,
        adapter: attemptInput.prepared.adapter,
        workspacePath: attemptInput.prepared.workspacePath,
        primaryPath: attemptInput.prepared.primaryPath,
        goal: attemptInput.goal,
        preview: attemptInput.prepared.preview,
        timeoutMs: budgetMs,
        attempt: attemptInput.attempt,
      }),
    );
  };

  /**
   * One Reviewer pass. SDD section 40 and section 42. Every pass starts a new session, so no
   * session reference passes between attempts. See controller decision 11.
   */
  const runReview = async (attemptInput: {
    prepared: PrepareSandboxActivityOutput;
    goal: string;
    attempt: number;
    contextContract: string | null;
    constraints: string[];
    verificationSummary: string;
    validationEvidence: string[];
  }): Promise<ReviewActivityOutput | null> => {
    const budgetMs = remainingMs();
    const reviewActivities = buildReviewActivities(budgetMs);
    return await runAgentActivity(() =>
      reviewActivities.review({
        runId: id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        runnerName: attemptInput.prepared.runtime.reviewerRunner,
        spriteId: attemptInput.prepared.spriteId,
        adapter: attemptInput.prepared.adapter,
        workspacePath: attemptInput.prepared.workspacePath,
        primaryPath: attemptInput.prepared.primaryPath,
        baseSha: attemptInput.prepared.baseSha,
        goal: attemptInput.goal,
        contextContract: attemptInput.contextContract,
        constraints: attemptInput.constraints,
        verificationSummary: attemptInput.verificationSummary,
        validationEvidence: attemptInput.validationEvidence,
        repositoryInstructions: attemptInput.prepared.repositoryInstructions,
        timeoutMs: budgetMs,
        attempt: attemptInput.attempt,
      }),
    );
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
        body:
          publishedPullRequestUrl === null
            ? "Factoree stopped this Run at your request. No change was published."
            : "Factoree stopped this Run at your request. The verified change is already " +
              `published and waits for a human. Pull request: ${publishedPullRequestUrl}.`,
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

      // SDD section 28. The webhook carries no label, so the labels come from the Linear API
      // before Refinement classifies the risk of this Work Item. A read that never recovers,
      // after the activity's own retry policy is exhausted, must not fail the Run: it yields no
      // label, and the Run then runs at its Project default, the same as an issue with no label
      // does. A cancellation is not a label-read fault, so it still propagates.
      let labels = input.workItem.labels;
      const issueId = input.workItem.issueId;
      if (issueId !== null) {
        try {
          labels = await activities.fetchWorkItemLabels({ sessionId: input.agentSessionId, issueId });
        } catch (error) {
          if (isCancellation(error)) throw error;
          // The webhook labels are never worse than an empty list, so the fallback keeps them.
          labels = input.workItem.labels;
          // The cap of SDD section 28 is a security control, so a degraded cap must be visible.
          // A Linear fault must not fail the Run either, so the post stays inside `notify`.
          await notify(() =>
            activities.postProgress({
              sessionId: input.agentSessionId,
              message:
                "Factoree could not read the labels of this Work Item. The risk cap of the " +
                "autonomy level could not be applied. The Run continues at the autonomy level " +
                "of the Project.",
            }),
          );
        }
      }

      // SDD section 8. Refinement reads the Work Item and the Project record only. It reaches no
      // repository and no sandbox, so it runs before preparation.
      const refinementInput = () => ({
        runId: id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        source: { ...input.workItem, labels },
        project: {
          primaryRepository: primaryRepositorySlug,
          referenceRepositories: referenceRepositorySlugs,
          defaultAutonomy: input.product.defaultAutonomy,
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

      // SDD section 28. Refinement caps the autonomy level of the Run. The Run row was created
      // before Refinement ran, so it still holds the raw Project default. The capped level is
      // the level that governs the Run, so it reaches the row here.
      await activities.setRunAutonomyLevel({
        tenantId: input.tenantId,
        runId: id,
        autonomyLevel: refined.autonomyLevel,
      });

      // SDD section 8. Refinement reports a risk that a human must see. Factoree does not block
      // the Run on one, so the report is the only place a human learns of it. An empty list
      // produces no message.
      const riskMessage = renderRisks(refined.risks);
      if (riskMessage !== null) {
        await notify(() =>
          activities.postProgress({ sessionId: input.agentSessionId, message: riskMessage }),
        );
      }

      // SDD section 20. Discovery pins one SHA for each repository. The ref below is the ref
      // discovery starts from. The checkout later uses the pinned SHA.
      const repositoryRef = (slug: string) => ({
        slug,
        url: buildRepositoryUrl(input.product.repositoryBaseUrl, slug),
        ref: defaultBranchForSlug(slug),
      });

      // SDD section 23. A conflict without an authority winner blocks the Run. The bounded
      // rounds end this loop, and the Run budget ends it as well.
      let resolvedContext: ResolveContextActivityOutput;
      for (;;) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "RESOLVING_CONTEXT";
        await activities.setRunStatus({ runId: id, status });

        try {
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
        } catch (error) {
          // SDD section 49. A repository reference that resolves to nothing is a semantic
          // failure, so it drives a workflow decision. The retry policy already denied a second
          // attempt. A transport fault is not this type, so it still retries.
          if (isConfigurationFault(error)) {
            return await failRun(
              "CONFIGURATION_INVALID",
              "Factoree could not resolve the context, because the Run configuration is invalid. " +
                "Repair the repository reference, the reference repositories, or the default branch.",
            );
          }
          throw error;
        }
        // SDD section 21. Only a frozen Context Contract has a version. A resolution that still
        // holds an unresolved conflict stored nothing, so the snapshot reports no version.
        contextContractVersion =
          resolvedContext.unresolvedConflict === null ? resolvedContext.sha256 : null;

        await notify(() =>
          activities.postProgress({
            sessionId: input.agentSessionId,
            message: resolvedContext.summary,
          }),
        );

        const conflict = resolvedContext.unresolvedConflict;
        if (conflict === null) break;

        // SDD section 23. No safe resolution exists, so implementation must not start.
        const proceeded = await askAndWait(
          conflict.id,
          conflict.question,
          conflict.subject,
          conflict.domain,
        );
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

      // SDD section 49 places the Validation Contract between context resolution and sandbox
      // preparation. SDD section 24 requires the contract to freeze before implementation starts.
      // The loop ends because `askAndWait` is bounded by the question rounds and by the budget.
      const validationAnswers: string[] = [];
      let validation: Awaited<ReturnType<Activities["buildValidationContract"]>>;
      for (;;) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "BUILDING_VALIDATION_CONTRACT";
        await activities.setRunStatus({ runId: id, status });

        validation = await validationActivities.buildValidationContract({
          runId: id,
          tenantId: input.tenantId,
          projectId: input.projectId,
          workItem: input.workItem.issueId ?? id,
          goal: refined.goal,
          acceptanceCriteria: refined.criteria,
          humanAssertions: validationAnswers,
        });

        if (validation.status === "ready") {
          // The output type permits a `ready` result with a null `sha256`. The workflow must not
          // start implementation on that combination, because no confirmed frozen contract exists.
          if (validation.sha256 === null) {
            return await failRun(
              "VALIDATION_UNRESOLVED",
              "Factoree could not confirm the Validation Contract froze, so it published nothing.",
            );
          }
          validationContractVersion = validation.sha256;
          break;
        }

        await notify(() =>
          activities.postProgress({
            sessionId: input.agentSessionId,
            message: validation.summary,
          }),
        );

        // SDD section 9 item 5. No observable success assertion exists, so implementation must
        // not start. The human states one, and it becomes an assertion of the contract.
        const question = validation.question;
        if (question === null) {
          return await failRun(
            "VALIDATION_UNRESOLVED",
            "Factoree could not define success for this Work Item, and it published nothing.",
          );
        }
        const proceeded = await askAndWait(question.id, question.question);
        if (stopRequested) return await cancelRun();
        if (!proceeded) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          return await failRun(
            "VALIDATION_UNRESOLVED",
            "Factoree could not start, because this Work Item states no observable success " +
              "assertion. Factoree must not invent product behavior, so it published nothing.",
          );
        }
        const answer = decisions[decisions.length - 1]?.answer ?? "";
        if (answer.trim() !== "") validationAnswers.push(answer);
      }

      await notify(() =>
        activities.postProgress({ sessionId: input.agentSessionId, message: validation.summary }),
      );

      // A stop that arrived while the contract was built must prevent preparation.
      if (stopRequested) return await cancelRun();
      if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

      // SDD section 15. The runtime configuration comes from `.factoree/config.yaml` in the
      // primary repository. Only the values a repository must not own travel from here.
      const sandbox = {
        primary: {
          url: buildRepositoryUrl(input.product.repositoryBaseUrl, resolvedContext.primary.slug),
          // SDD section 20. The checkout lands on the SHA discovery pinned. A branch name can
          // point to a new commit at any time, so the workflow must not use one here. The Run
          // and the Context Contract then read one state of the repository.
          ref: resolvedContext.primary.sha,
        },
        references: resolvedContext.references.map((repository) => ({
          url: buildRepositoryUrl(input.product.repositoryBaseUrl, repository.slug),
          ref: repository.sha,
        })),
        defaults: {
          stagingRead: input.product.stagingRead,
          spriteRetentionHours: input.product.spriteRetentionHours,
        },
        organizationSkills:
          input.product.organizationSkillsRepository === null
            ? null
            : {
                url: buildRepositoryUrl(
                  input.product.repositoryBaseUrl,
                  input.product.organizationSkillsRepository,
                ),
                // No discovery step resolves a skills repository, so the target repository default
                // branch is the only defined ref. See controller decision 3.
                ref: defaultBranchForSlug(primaryRepositorySlug),
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
          organizationSkills: sandbox.organizationSkills,
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

      // SDD section 46 needs these two values after the loop ends, and the loop scope does not
      // survive the `break`. The successful pass writes them just before it breaks.
      let publishedChangedFiles: string[] = [];
      let publishedVerificationSummary = "";
      // The git tree the independent review examined. The publication refuses a tree that
      // differs, so a write after the review can never reach GitHub.
      let publishedWorktreeSha = "";
      // SDD section 68 and section 47 need these values after the loop ends. The successful pass
      // writes them just before it breaks, exactly as the three values above do.
      let publishedVerificationPassed = false;
      let publishedValidationPassed = false;
      let publishedBlockingCount = 0;
      let publishedReviewVerdict: "pass" | "fail" = "fail";
      let publishedReviewPasses = 0;
      // The attempt number of the last Reviewer session. The Proof Pack needs it, because a
      // passing review writes no finding row and the stored rows cannot name that pass.
      let publishedReviewAttempt = 0;
      // SDD section 24 and section 68. The moment the FIRST Implementer attempt started. The
      // completion invariant compares it with the freeze moment, because the clause names an
      // order. A later repair attempt must not move it.
      let implementationStartedAt: string | null = null;
      // The number of Reviewer sessions this Run ran. The attempt counter is not the same value,
      // because a repair that verification or validation asked for raises the attempt without
      // reaching a review. The Proof Pack reports this count to a human, so it must be exact.
      let reviewPasses = 0;
      let publishedPreviewUrl: string | null = null;

      for (;;) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "IMPLEMENTING";
        if (implementationStartedAt === null) {
          implementationStartedAt = new Date(Date.now()).toISOString();
        }
        await activities.setRunStatus({ runId: id, status });

        const implementation = await runImplementer({
          prepared: preparedSandbox,
          goal: sandbox.goal,
          attempt,
          repairFindings,
          contextContract: resolvedContext.document,
          requiredContext: resolvedContext.requiredContext,
          validationContract: validation.document,
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

        if (!verification.passed) {
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
          await activities.setRunStatus({
            runId: id,
            status,
            repairCount,
            repairReason: "VERIFICATION",
          });
          continue;
        }

        // SDD section 48 and SDD section 49. Deterministic verification passed, so the Run
        // enters USER_VALIDATING. A fresh validator session checks the frozen Validation
        // Contract, inside the same bounded loop, with the current implementation attempt.
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "USER_VALIDATING";
        await activities.setRunStatus({ runId: id, status });

        let userValidation: UserValidateActivityOutput;
        try {
          const result = await runUserValidate({
            prepared: preparedSandbox,
            goal: sandbox.goal,
            attempt,
          });
          // A stop that arrived while the validator ran must end the Run here.
          if (stopRequested) return await cancelRun();
          if (result === null) {
            // The pass ended with no result and no stop signal. The budget decides why.
            if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
            throw new Error("the userValidate activity returned no result");
          }
          userValidation = result;
        } catch (error) {
          // User validation is bounded by the remaining budget, the same way verification is. A
          // budget that ran out during the pass is a Run timeout, not an internal fault.
          if (isCancellation(error)) throw error;
          // A validator runner the Project names but no worker registers is a configuration
          // fault. The Run ends in `FAILED_CONFIGURATION`, not in an internal error.
          if (isConfigurationFault(error)) {
            return await failRun(
              "CONFIGURATION_INVALID",
              "Factoree could not start the User Validator, because the Run configuration is " +
                "invalid. Repair `validator_runner` in `.factoree/config.yaml`.",
            );
          }
          if (remainingMs() > 0) throw error;
          return await failRun("RUN_TIMEOUT", timeoutMessage);
        }

        await notify(() =>
          activities.postProgress({
            sessionId: input.agentSessionId,
            message: userValidation.summary,
          }),
        );

        if (stopRequested) return await cancelRun();

        if (!userValidation.passed) {
          // SDD section 36. Only a failing assertion can be repaired. A blocked check, or a check
          // that needs a human, cannot be fixed by another Implementer attempt.
          if (userValidation.hasFailure) {
            // SDD section 42 bounds repairs per Run, and the repair shares the budget
            // deterministic verification already counts.
            if (repairCount >= maxRepairs) {
              return await failRun(
                "VALIDATION_FAILED",
                "User validation did not pass, and the repair budget is spent. " +
                  `${userValidation.summary} Factoree published nothing.`,
              );
            }
            if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

            repairCount += 1;
            attempt += 1;
            repairFindings = userValidation.failures;
            status = "REPAIRING";
            await activities.setRunStatus({
              runId: id,
              status,
              repairCount,
              repairReason: "VALIDATION",
            });
            continue;
          }

          if (userValidation.hasBlocked) {
            return await failRun(
              "VALIDATION_BLOCKED",
              "Factoree could not run at least one user validation check, so it proved nothing. " +
                `${userValidation.summary} A repair cannot help. Factoree published nothing.`,
            );
          }

          // SDD section 36 forbids completion of an L3 Run without a human. The Run must say so
          // now, rather than wait for the residual wait to end it with a timeout.
          if (userValidation.hasManual) {
            return await failRun(
              "VALIDATION_MANUAL_REQUIRED",
              "At least one user validation assertion needs a human, so Factoree cannot complete " +
                `this Run on its own. ${userValidation.summary} Factoree published nothing.`,
            );
          }

          // A pass that did not pass must report at least one failed, blocked, or manual
          // assertion. Any other output is an internal fault, not a validation outcome.
          throw ApplicationFailure.nonRetryable(
            "User validation did not pass, and reported no failed, blocked, or manual assertion.",
            "USER_VALIDATION_INCONSISTENT",
          );
        }

        // SDD section 40 and section 49. User validation passed, so a fresh Reviewer session
        // examines the change against the fixed review baseline of SDD section 43.
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "REVIEWING";
        await activities.setRunStatus({ runId: id, status });
        reviewPasses += 1;

        let review: ReviewActivityOutput;
        try {
          const result = await runReview({
            prepared: preparedSandbox,
            goal: sandbox.goal,
            attempt,
            contextContract: resolvedContext.document,
            constraints: refined.constraints,
            verificationSummary: verification.summary,
            validationEvidence: userValidation.results.map(
              (entry) => `${entry.assertionId}: ${entry.result}. ${entry.reason}`,
            ),
          });
          if (stopRequested) return await cancelRun();
          if (result === null) {
            if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
            throw new Error("the review activity returned no result");
          }
          review = result;
        } catch (error) {
          if (isCancellation(error)) throw error;
          // A reviewer runner the Project names but no worker registers is a configuration
          // fault, exactly as the validator runner is.
          if (isConfigurationFault(error)) {
            return await failRun(
              "CONFIGURATION_INVALID",
              "Factoree could not start the Reviewer, because the Run configuration is " +
                "invalid. Repair `reviewer_runner` in `.factoree/config.yaml`.",
            );
          }
          if (remainingMs() > 0) throw error;
          return await failRun("RUN_TIMEOUT", timeoutMessage);
        }

        await notify(() =>
          activities.postProgress({ sessionId: input.agentSessionId, message: review.summary }),
        );

        if (stopRequested) return await cancelRun();

        // Controller decision 7. A report Factoree cannot read proves nothing, and a repair
        // cannot fix it. SDD section 68 forbids completion without a review, so the Run ends.
        if (!review.reportUsable) {
          return await failRun(
            "REVIEW_UNAVAILABLE",
            "Factoree could not obtain a usable independent review, so it proved nothing about " +
              `this change. ${review.reportProblem ?? ""} Factoree published nothing.`.trim(),
          );
        }

        if (review.passed) {
          publishedChangedFiles = review.changedFiles;
          publishedVerificationSummary = verification.summary;
          publishedWorktreeSha = review.worktreeSha;
          publishedVerificationPassed = verification.passed;
          publishedValidationPassed = userValidation.passed;
          publishedBlockingCount = review.blockingCount;
          publishedReviewVerdict = review.verdict;
          publishedReviewPasses = reviewPasses;
          publishedReviewAttempt = attempt;
          publishedPreviewUrl = userValidation.previewUrl;
          break;
        }

        // SDD section 42. A blocking finding enters the same bounded repair loop.
        if (repairCount >= maxRepairs) {
          return await failRun(
            "REVIEW_BLOCKING_FINDINGS",
            "The independent review rejected this change, and the repair budget is spent. " +
              `${review.summary} Factoree published nothing.`,
          );
        }
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        repairCount += 1;
        attempt += 1;
        repairFindings = review.failures;
        status = "REPAIRING";
        await activities.setRunStatus({ runId: id, status, repairCount, repairReason: "REVIEW" });
        continue;
      }

      // SDD section 49. The independent review passed, so Factoree captures the verified patch,
      // proves the target branch has not moved, and publishes. SDD section 46 keeps every step of
      // the publication on the control plane, because SDD section 29 denies git remote write from
      // an agent.
      if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
      if (stopRequested) return await cancelRun();

      status = "PUBLISHING";
      await activities.setRunStatus({ runId: id, status });

      const publishInput = {
        runId: id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        spriteId: preparedSandbox.spriteId,
        adapter: preparedSandbox.adapter,
        workspacePath: preparedSandbox.workspacePath,
        primaryPath: preparedSandbox.primaryPath,
        repositorySlug: resolvedContext.primary.slug,
        repositoryBaseUrl: input.product.repositoryBaseUrl,
        baseBranch: defaultBranchForSlug(resolvedContext.primary.slug),
        baseSha: preparedSandbox.baseSha,
        reviewedChangedFiles: publishedChangedFiles,
        reviewedWorktreeSha: publishedWorktreeSha,
        workItemTitle: input.workItem.title,
        workItemUrl: input.workItem.url,
        verificationSummary: publishedVerificationSummary,
        repairCount,
      };

      // SDD section 45. The stale-base check runs before any write, so a moved branch reaches no
      // remote.
      // SDD section 50. A stop that arrives during the base read must end the Run CANCELLED,
      // because Factoree published nothing.
      let baseCheck: CheckBaseActivityOutput;
      try {
        baseCheck = await publishingActivities.checkBase({
          runId: id,
          tenantId: input.tenantId,
          projectId: input.projectId,
          repositorySlug: publishInput.repositorySlug,
          repositoryBaseUrl: publishInput.repositoryBaseUrl,
          branch: publishInput.baseBranch,
          baseSha: publishInput.baseSha,
        });
      } catch (error) {
        if (isCancellation(error)) throw error;
        if (stopRequested) return await cancelRun();
        return await failRun(
          "PUBLICATION_FAILED",
          "Factoree could not read the target branch, so it published nothing.",
        );
      }

      // A stop that arrives during the base read must not end the Run STALE_BASE.
      if (stopRequested) return await cancelRun();

      if (!baseCheck.fresh) return await endStale(publishInput.baseSha, baseCheck.currentTargetSha);

      if (stopRequested) return await cancelRun();

      let publication: PublishActivityOutput;
      try {
        publication = await publishingActivities.publish(publishInput);
      } catch (error) {
        if (isCancellation(error)) throw error;
        // SDD section 50. A human stop is never a configuration fault. It is never a publication
        // failure either, because this path published nothing.
        if (stopRequested) return await cancelRun();
        if (isConfigurationFault(error)) {
          return await failRun(
            "CONFIGURATION_INVALID",
            "Factoree could not publish, because the Run configuration is invalid. Add a " +
              "`GITHUB_TOKEN` Project secret that carries write access and that no agent session " +
              "receives.",
          );
        }
        const reason = publicationFailureReasonOf(error);
        return await failRun(
          reason,
          reason === "PATCH_HASH_MISMATCH"
            ? "The patch of the trusted checkout did not equal the verified patch, so Factoree " +
                "published nothing. SDD section 46 blocks publication on a hash mismatch."
            : reason === "EMPTY_PATCH"
              ? "Every check passed and the change holds no file, so Factoree had nothing to " +
                  "publish."
              : "Factoree could not publish the verified change. Factoree created no pull request " +
                  "for it.",
        );
      }

      await notify(() =>
        activities.postProgress({
          sessionId: input.agentSessionId,
          message:
            `Factoree published the verified change. Pull request: ${publication.pullRequestUrl}. ` +
            `Base SHA: ${publishInput.baseSha}. Patch SHA-256: ${publication.patchSha256}.`,
        }),
      );

      // The publication succeeded. A later stop message and a later timeout message read this
      // value, so neither one claims that Factoree published nothing.
      publishedPullRequestUrl = publication.pullRequestUrl;

      // SDD section 50. A stop that arrived during the publication ends the Run CANCELLED. The
      // pull request already exists, and the stop message names it.
      if (stopRequested) return await cancelRun();

      // SDD section 47. One Proof Pack, built from persisted state, posted as the Linear final
      // response. SDD section 68 forbids READY_FOR_HUMAN without it.
      let proofPack: PublishProofPackActivityOutput;
      try {
        proofPack = await proofPackActivities.publishProofPack({
          runId: id,
          tenantId: input.tenantId,
          projectId: input.projectId,
          sessionId: input.agentSessionId,
          workItem: { title: input.workItem.title, url: input.workItem.url },
          pullRequestUrl: publication.pullRequestUrl,
          commitSha: publication.commitSha,
          patchSha256: publication.patchSha256,
          baseSha: publishInput.baseSha,
          changedFiles: publishedChangedFiles,
          patchByteLength: publication.patchByteLength,
          previewUrl: publishedPreviewUrl,
          repairCount,
          repairLimit: maxRepairs,
          reviewVerdict: publishedReviewVerdict,
          reviewPasses: publishedReviewPasses,
          reviewAttempt: publishedReviewAttempt,
        });
      } catch (error) {
        if (isCancellation(error)) throw error;
        if (stopRequested) return await cancelRun();
        // SDD section 68. The change is published, and Factoree cannot prove it to a human. It
        // must never report a success it cannot prove, so the Run fails and names the pull
        // request a human must now read by hand.
        return await failRun(
          "COMPLETION_INVARIANT_UNMET",
          "Factoree published the verified change and could not post the Proof Pack. Review the " +
            `pull request by hand. Pull request: ${publication.pullRequestUrl}.`,
        );
      }

      if (stopRequested) return await cancelRun();

      // SDD section 68. Every clause is checked from recorded facts, immediately before the one
      // state that claims success. No agent claim reaches this check.
      const unmet = completionInvariantFailures({
        workItemReady: refined.status === "ready",
        contextContractVersion,
        unresolvedConflict: resolvedContext.unresolvedConflict !== null,
        validationContractVersion,
        validationContractFrozenAt: validation.frozenAt,
        implementationStartedAt,
        validationPassed: publishedValidationPassed,
        verificationPassed: publishedVerificationPassed,
        blockingFindingCount: publishedBlockingCount,
        repairCount,
        repairLimit: maxRepairs,
        patchSha256: publication.patchSha256,
        baseUnchanged: baseCheck.fresh,
        pullRequestUrl: publication.pullRequestUrl,
        proofPackSha256: proofPack.sha256,
      });

      if (unmet.length > 0) {
        return await failRun(
          "COMPLETION_INVARIANT_UNMET",
          "Factoree published the verified change and cannot report it complete. " +
            `${unmet.join(" ")} Pull request: ${publication.pullRequestUrl}.`,
        );
      }

      // SDD section 48. The Run is complete. This is the one success terminal state, and the
      // completion invariant above is the only gate that reaches it.
      status = "READY_FOR_HUMAN";
      await activities.completeRun({
        tenantId: input.tenantId,
        runId: id,
        status,
        completedAt: new Date(Date.now()).toISOString(),
      });
      return { runId: id, status };
    }

    // Every path of the block above reaches a terminal state of SDD section 48. Phase 9 kept a
    // residual wait here, because no success terminal state existed yet. The Proof Pack of
    // SDD section 47 now completes a proved Run, so that wait is gone.
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
