import {
  ApplicationFailure,
  CancellationScope,
  condition,
  deprecatePatch,
  isCancellation,
  sleep,
  TemporalFailure,
} from "@temporalio/workflow";
import type { Activities } from "~/activities/index.js";
import type { PrepareCheckSandboxActivityOutput, PrepareSandboxActivityOutput } from "~/activities/sandbox.activities.js";
import type { RunFailureReason, RunStatus } from "~/domain/runs/run-status.js";
import type { RecordedDecision } from "~/domain/refinement/refinement-engine.js";
import type { SkillRegistrySettings } from "~/domain/runs/skill-registry.js";
import type { AgentSessionRef } from "~/domain/runs/agent-runner.js";
import type { AuthorityDomain } from "~/domain/context/authority.js";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import { stopResponse, type StopRequest } from "../../domain/runs/run-stop.js";
import { INTERNAL_ERROR_SENTENCE } from "../../domain/runs/failure-cause.js";
import { queuedMessage } from "../../domain/runs/run-slots.js";
import { endsWithoutPullRequest } from "../../domain/runs/issue-status.js";
import { describeDecision, type FactoreeDecision } from "../../domain/runs/factoree-decision.js";
import { activities, cancelActivities } from "./activities.js";
import { isConfigurationFault, isSandboxFault, isSandboxSlotUnavailable, notify, SANDBOX_FAULT_SENTENCE, withCause } from "./failures.js";
import { PATCH } from "./patches.js";
import type { AgentRunWorkflowInput, AgentRunWorkflowResult, RunSnapshot } from "./types.js";

/**
 * SDD section 8 and SDD section 23 put no bound on the elicitation loop. Five rounds cover a
 * realistic clarification, and then Factoree stops. Refinement and conflict resolution share the
 * five rounds. See DI-4.6.
 */
export const MAX_QUESTION_ROUNDS = 5;

/** docs/specs/release-0-1-0.md, DI-15.13. How often a queued Run asks for a slot of its Product. */
const RUN_SLOT_POLL_MS = 20_000;
/** DI-15.14. How long a Run waits before it asks the sandbox provider for a slot again. */
const SANDBOX_SLOT_POLL_MS = 30_000;

const TIMEOUT_MESSAGE = "Factoree stopped the Run because it reached the maximum Run duration.";

/**
 * Thrown once the Run is terminal: its row is written and its Linear post is sent. The story that
 * runs the Run returns its result. Every `catch` in a story or a stage rethrows it.
 */
export class RunEnded extends Error {
  constructor(public result: AgentRunWorkflowResult) {
    super(`the run ended ${result.status}`);
    this.name = "RunEnded";
  }
}

/** Rethrows what no stage may handle: the end of the Run and a cancellation. */
export const rethrowControl = (error: unknown): void => {
  if (error instanceof RunEnded || isCancellation(error)) throw error;
};

/** The state that a signal or the query reads. It exists before the Run row. */
export class RunControl {
  runId: string | null = null;
  status: RunStatus = "RECEIVED";
  readonly humanInputs: string[] = [];
  stopRequested = false;
  /** Issue #45. Where the first stop came from, or null for a stop with no payload. */
  stopRequest: StopRequest | null = null;
  workSprite: PrepareSandboxActivityOutput | null = null;
  /** SDD section 21. Only a frozen Context Contract has a version. */
  contextContractVersion: string | null = null;
  validationContractVersion: string | null = null;
  openQuestion: string | null = null;

  snapshot(): RunSnapshot {
    return {
      runId: this.runId,
      status: this.status,
      humanInputs: this.humanInputs,
      spriteId: this.workSprite?.spriteId ?? null,
      contextContractVersion: this.contextContractVersion,
      validationContractVersion: this.validationContractVersion,
      openQuestion: this.openQuestion,
    };
  }
}

/** How a failed Run of one kind talks to Linear. The story chooses it. */
export interface RunEnding {
  /**
   * Null for a run that takes a Linear reply: the post describes the failure and Factoree offers a
   * draft. A PR follow-up run and a bring-current run name the pull request they left unchanged.
   */
  failureNote: string | null;
  /** The internal error path offers a draft of the last patch. */
  draftOnInternalError: boolean;
}

export interface SkillSources {
  skillRegistry: SkillRegistrySettings | null;
  organizationSkills: { slug: string; repository: { url: string; ref: string } } | null;
  githubInstallationId: string;
}

type FailureReason = Exclude<RunFailureReason, "STOPPED_BY_HUMAN" | "INTERNAL_ERROR">;
type CompleteArgs = Omit<Parameters<Activities["completeRun"]>[0], "tenantId" | "runId" | "status" | "completedAt" | "waitedMs">;

/**
 * One Run after its row exists: the state that the end of the Run reads, and the steps every story
 * shares. A terminal step writes the row, posts to Linear and throws `RunEnded`.
 */
export class Run {
  /** DI-15.13. A wait in QUEUED or for a sandbox slot is no work, so it moves the deadline. */
  deadline: number;
  /** DI-21.56. The total wait. completeRun records it, and the shown duration leaves it out. */
  waitedMs = 0;
  /** SDD section 23. Every answer a human gave to a question Factoree asked in this Run. */
  readonly decisions: RecordedDecision[] = [];
  /** docs/specs/own-proposals-and-parallel-runs.md. Every proposal Factoree took without asking. */
  readonly factoreeDecisions: FactoreeDecision[] = [];
  private questionRounds = 0;
  implementerSession: AgentSessionRef | null = null;
  /** True once the implement activity itself has cancelled the live session. */
  implementerCancelled = false;
  /** DI-21.50. True once this run moved, or tried to move, its issue to started. */
  issueStatusTracked = false;
  /** docs/specs/check-isolation.md. The check sprite of the current attempt. */
  checkSprite: PrepareCheckSandboxActivityOutput | null = null;
  /** docs/specs/run-speed.md. The reviewer's check sprite of the current attempt. */
  reviewSprite: PrepareCheckSandboxActivityOutput | null = null;
  /** docs/specs/early-review-sprite.md. The reviewer's sprite build that the end of the Run waits for. */
  reviewBuild: Promise<unknown> | null = null;
  /** docs/specs/run-speed.md. The reviewer that runs beside user validation. */
  liveReview: { scope: CancellationScope; branch: Promise<unknown> } | null = null;
  skillSources: SkillSources | null = null;
  skillProposalsSent = false;
  repairs = 0;
  reviewVerdict: string | null = null;
  /** docs/specs/change-sets.md. A stop or timeout message must not claim that nothing was published. */
  readonly publishedPullRequestUrls: string[] = [];

  constructor(
    readonly id: string,
    readonly input: AgentRunWorkflowInput,
    readonly control: RunControl,
    readonly ending: RunEnding,
  ) {
    // `maxRunMinutes` can be a fraction. A whole number of milliseconds, with a floor of one
    // second, keeps every derived Temporal duration valid.
    this.deadline = Date.now() + Math.max(1_000, Math.round(input.maxRunMinutes * 60_000));
  }

  get stopped(): boolean {
    return this.control.stopRequested;
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  // `enter` and `progress` return the activity promise itself. An extra async layer would add a
  // microtask turn, and the reviewer branch and the sprite release run beside the main path: one
  // more turn on one side changes which command reaches the history first, so an open run would
  // no longer replay.
  enter(status: RunStatus, extra: { startedAt?: string; repairCount?: number; repairReason?: string } = {}): Promise<void> {
    this.control.status = status;
    return activities.setRunStatus({ runId: this.id, status, ...extra } as Parameters<Activities["setRunStatus"]>[0]);
  }

  progress(message: string): Promise<void> {
    return notify(() => activities.postProgress({ sessionId: this.input.agentSessionId, message }));
  }

  /** Ends the Run on its deadline when no time remains. */
  async ensureTime(): Promise<void> {
    if (this.remainingMs() === 0) await this.timeout();
  }

  /** A stop ends the Run CANCELLED, and a spent budget ends it RUN_TIMEOUT. */
  async checkpoint(): Promise<void> {
    if (this.stopped) await this.cancel();
    await this.ensureTime();
  }

  timeout(): Promise<never> {
    return this.fail("RUN_TIMEOUT", TIMEOUT_MESSAGE);
  }

  /**
   * The common end of a failed step: a configuration fault ends FAILED_CONFIGURATION with the
   * sentence and the cause, a spent budget ends RUN_TIMEOUT, and any other error stays an error.
   */
  async failFrom(error: unknown, configurationSentence: string): Promise<never> {
    rethrowControl(error);
    // docs/specs/sandbox-memory-and-size.md. A sandbox fault names itself, not the step's configuration.
    if (isConfigurationFault(error)) {
      return await this.fail("CONFIGURATION_INVALID", withCause(isSandboxFault(error) ? SANDBOX_FAULT_SENTENCE : configurationSentence, error));
    }
    if (this.remainingMs() > 0) throw error;
    return await this.timeout();
  }

  /** A step bounded by the Run budget: an error after the budget ran out is a Run timeout, not a fault. */
  async timeoutFrom(error: unknown): Promise<never> {
    rethrowControl(error);
    if (this.remainingMs() > 0) throw error;
    return await this.timeout();
  }

  /**
   * A terminal write must run even when the workflow scope is cancelled, or the Run row stays in
   * a working state while the workflow has already ended.
   */
  private complete(status: RunStatus, args: CompleteArgs = {}): Promise<void> {
    this.control.status = status;
    return CancellationScope.nonCancellable(async () => {
      // docs/specs/run-speed.md. A reviewer that still runs has no use once the Run ends.
      const review = this.liveReview;
      this.liveReview = null;
      if (review !== null) {
        review.scope.cancel();
        await review.branch;
      }
      // docs/specs/early-review-sprite.md. A reviewer's check sprite that still builds ends first.
      const pendingBuild = this.reviewBuild;
      this.reviewBuild = null;
      if (pendingBuild !== null) await pendingBuild;
      for (const check of [this.checkSprite, this.reviewSprite]) {
        if (check === null) continue;
        await notify(() =>
          cancelActivities.releaseCheckSandbox({ runId: this.id, spriteId: check.spriteId, adapter: check.adapter, workspacePath: check.workspacePath }),
        );
      }
      // docs/specs/skill-registry.md. The proposal leaves the work sprite before the Run ends.
      const sources = this.skillSources;
      const work = this.control.workSprite;
      if (sources !== null && work !== null) {
        deprecatePatch(PATCH.skillRegistry);
        if (!this.skillProposalsSent) await notify(() => this.sendSkillProposals(sources, work));
      }
      await activities.completeRun({
        tenantId: this.input.tenantId,
        runId: this.id,
        status,
        ...args,
        completedAt: new Date(Date.now()).toISOString(),
        waitedMs: this.waitedMs,
      });
      // DI-21.50. A run that ends with no pull request moves its issue back.
      if (this.issueStatusTracked && endsWithoutPullRequest(status) && this.publishedPullRequestUrls.length === 0) {
        await notify(() => activities.restoreIssueStatus({ tenantId: this.input.tenantId, runId: this.id }));
      }
      if (sources !== null) {
        deprecatePatch(PATCH.skillRegistry);
        await notify(() =>
          activities.reportSkillOutcome({
            tenantId: this.input.tenantId,
            productId: this.input.productId,
            runId: this.id,
            ...sources,
            outcome: status === "READY_FOR_HUMAN" ? "succeeded" : status === "CANCELLED" ? "cancelled" : "failed",
            repairs: this.repairs,
            reviewVerdict: this.reviewVerdict,
            evidenceUrl: this.input.workItem.url,
          }),
        );
      }
    });
  }

  sendSkillProposals(sources: SkillSources, work: PrepareSandboxActivityOutput): Promise<void> {
    return activities.submitSkillProposals({
      tenantId: this.input.tenantId,
      productId: this.input.productId,
      runId: this.id,
      ...sources,
      runLink: this.input.workItem.url,
      work: { spriteId: work.spriteId, adapter: work.adapter, workspacePath: work.workspacePath, primaryPath: work.primaryPath },
    });
  }

  private ended(): RunEnded {
    return new RunEnded({ runId: this.id, status: this.control.status });
  }

  async fail(failureReason: FailureReason, message: string): Promise<never> {
    // SDD section 50 obligation 1. The live implementer session goes, unless its activity cancelled it.
    const live = this.implementerSession;
    if (live !== null && !this.implementerCancelled) {
      await notify(() => cancelActivities.cancelImplementer({ runnerName: live.runner, session: live }));
    }
    // SDD section 48. A blocking review finding has its own terminal state.
    const status: RunStatus =
      failureReason === "CONFIGURATION_INVALID" ? "FAILED_CONFIGURATION" : failureReason === "REVIEW_BLOCKING_FINDINGS" ? "FAILED_REVIEW" : "FAILED";
    // Write the durable terminal state first. A Linear outage must not leave the Run open.
    await this.complete(status, { failureReason, failureMessage: message });
    const note = this.ending.failureNote;
    let post = note === null ? message : `${message}\n\n${note}`;
    // docs/specs/run-recovery.md. A run that can take a follow-up says what blocked it and how to reply.
    const kind = note !== null ? null : status === "FAILED" || status === "FAILED_REVIEW" ? "run" : status === "FAILED_CONFIGURATION" ? "configuration" : null;
    if (kind === "run") deprecatePatch(PATCH.failurePost);
    if (kind === "configuration") deprecatePatch(PATCH.configurationFailurePost);
    if (kind !== null) {
      try {
        post = await activities.describeRunFailure({ tenantId: this.input.tenantId, runId: this.id, message, kind });
      } catch (error) {
        if (isCancellation(error)) throw error;
      }
    }
    await notify(() => activities.postError({ sessionId: this.input.agentSessionId, message: post }));
    if (note === null) await this.offerDraft();
    throw this.ended();
  }

  private async offerDraft(): Promise<void> {
    deprecatePatch(PATCH.draftOffer);
    await notify(() => activities.offerDraft({ tenantId: this.input.tenantId, runId: this.id, sessionId: this.input.agentSessionId }));
  }

  /** SDD section 50. A stop terminates the active agent process, and no change is published. */
  async cancel(): Promise<never> {
    // SDD section 50 obligation 1. The live implementer session goes, unless its activity cancelled it.
    const live = this.implementerSession;
    if (live !== null && !this.implementerCancelled) {
      await notify(() => cancelActivities.cancelImplementer({ runnerName: live.runner, session: live }));
    }
    await this.complete("CANCELLED", { failureReason: "STOPPED_BY_HUMAN" });
    await notify(() =>
      activities.postFinalResponse({
        sessionId: this.input.agentSessionId,
        body: stopResponse(this.control.stopRequest, this.publishedPullRequestUrls),
      }),
    );
    throw this.ended();
  }

  /** docs/specs/autonomy-levels.md. The Run posts its report as the final response and ends REPORTED. */
  async report(body: string): Promise<never> {
    await this.complete("REPORTED", { finalResponse: body });
    await notify(() => activities.postFinalResponse({ sessionId: this.input.agentSessionId, body }));
    throw this.ended();
  }

  /**
   * docs/specs/pr-feedback-loop.md, DI-21.215. A PR follow-up run whose human decisions only asked
   * questions answered each one, pushed no commit, and ends ANSWERED. The body is its final response.
   */
  async answer(body: string): Promise<never> {
    await this.complete("ANSWERED", { finalResponse: body });
    await notify(() => activities.postFinalResponse({ sessionId: this.input.agentSessionId, body }));
    throw this.ended();
  }

  /**
   * Specification sections 8 and 17. A repository that claims a different Product at the base
   * commit is a binding problem that only an operator can settle.
   */
  async routingMismatch(declaredProductSlug: string): Promise<never> {
    await this.complete("BLOCKED_ROUTING");
    await notify(() =>
      activities.postError({
        sessionId: this.input.agentSessionId,
        message:
          "Factoree stopped, because the target repository names a different Product at its " +
          `base commit. Routing used "${this.input.product.productSlug}". The repository names ` +
          `"${declaredProductSlug}". An operator must resolve this binding. Factoree published ` +
          "nothing.",
      }),
    );
    throw this.ended();
  }

  /** SDD section 48. The one success terminal state. The completion invariant is its only gate. */
  async succeed(): Promise<never> {
    await this.complete("READY_FOR_HUMAN");
    throw this.ended();
  }

  /** Any unhandled failure still drives the Run to a terminal state, and ends the workflow. */
  async failInternally(error: unknown): Promise<never> {
    // docs/specs/run-failure-detail.md. The row and the agent session keep the cause.
    const message = withCause(INTERNAL_ERROR_SENTENCE, error);
    await this.complete("FAILED", { failureReason: "INTERNAL_ERROR", failureMessage: message });
    deprecatePatch(PATCH.internalErrorPost);
    await CancellationScope.nonCancellable(async () => {
      let post = message;
      try {
        post = await activities.describeRunFailure({ tenantId: this.input.tenantId, runId: this.id, message });
      } catch {
        // The post falls back to the message when the facts cannot be read.
      }
      await notify(() => activities.postError({ sessionId: this.input.agentSessionId, message: post }));
      if (this.ending.draftOnInternalError) await this.offerDraft();
    });
    // A plain error fails the workflow task, and Temporal retries that task for ever while the
    // row says FAILED. A Temporal failure ends the workflow.
    if (error instanceof TemporalFailure) throw error;
    throw ApplicationFailure.fromError(error, { nonRetryable: true });
  }

  /**
   * SDD section 23. One focused question, one human input, recorded against that question. The
   * remaining Run budget bounds the wait, and a stop ends it. An unanswered question ends the Run
   * with the reason and the message the caller names. It answers the reply.
   */
  async ask(
    question: { id: string; question: string; subject?: string; domain?: AuthorityDomain; waitingStatus?: RunStatus },
    unanswered: { reason: FailureReason; message: string },
  ): Promise<string> {
    const answered = await this.askAndWait(question);
    if (this.stopped) await this.cancel();
    if (!answered) {
      await this.ensureTime();
      await this.fail(unanswered.reason, unanswered.message);
    }
    return this.decisions[this.decisions.length - 1]?.answer ?? "";
  }

  private async askAndWait(question: { id: string; question: string; subject?: string; domain?: AuthorityDomain; waitingStatus?: RunStatus }): Promise<boolean> {
    if (this.questionRounds >= MAX_QUESTION_ROUNDS) return false;
    // The count is read before the first await, so an answer that arrives before the
    // elicitation reaches Linear still answers this question.
    const answersBefore = this.control.humanInputs.length;
    this.questionRounds += 1;
    this.control.openQuestion = question.question;
    // Specification section 10. The target-selection gate reports BLOCKED_TARGET while it waits.
    await this.enter(question.waitingStatus ?? "WAITING_FOR_INPUT");
    await notify(() => activities.postElicitation({ sessionId: this.input.agentSessionId, question: question.question }));
    const answered = await condition(() => this.stopped || this.control.humanInputs.length > answersBefore, this.remainingMs());
    this.control.openQuestion = null;
    if (!answered || this.stopped) return false;
    // SDD section 23 permits one question at a time, so the last input belongs to this question.
    this.decisions.push({
      questionId: question.id,
      question: question.question,
      answer: this.control.humanInputs[this.control.humanInputs.length - 1] ?? "",
      ...(question.subject === undefined ? {} : { subject: question.subject }),
      ...(question.domain === undefined ? {} : { domain: question.domain }),
    });
    return true;
  }

  /** docs/specs/own-proposals-and-parallel-runs.md. Takes a determined proposal without asking. */
  async takeDecision(decision: FactoreeDecision): Promise<void> {
    this.factoreeDecisions.push(decision);
    await activities.recordDecision({ tenantId: this.input.tenantId, runId: this.id, decision });
    await this.progress(describeDecision(decision));
  }

  /**
   * SDD section 50. Runs one long agent activity in a cancellable scope that a stop cancels. The
   * result is null when the activity was cancelled. Every agent stage uses it, so the ordering
   * rules below hold for all of them.
   */
  async agentActivity<T>(start: () => Promise<T>): Promise<T | null> {
    // A stop before the stage must not schedule the activity: a cancel in the same activation
    // can race the schedule at the server, and WAIT_CANCELLATION_COMPLETED would wait for ever.
    if (this.stopped) return null;
    const scope = new CancellationScope({ cancellable: true });
    const running = scope.run(start);
    // This durable timer flushes the schedule command in its own activation, before any cancel.
    await sleep(1);
    const watching = scope
      .run(() => condition(() => this.stopped))
      .then(() => scope.cancel())
      .catch(() => undefined);
    try {
      return await running;
    } catch (error) {
      // A cancelled agent activity is the stop path, not a fault.
      if (!isCancellation(error)) throw error;
      return null;
    } finally {
      // The activity has settled. This cancel ends the watcher's own `condition` and sends no
      // command, because the SDK cancels only a pending activity.
      scope.cancel();
      await watching;
    }
  }

  /**
   * docs/specs/release-0-1-0.md, DI-15.13. A Run over its Product's maxConcurrentRuns waits in
   * QUEUED. Linear shows its position when it changes. A stop ends the Run CANCELLED.
   */
  async waitForRunSlot(): Promise<void> {
    let queuedSince: number | null = null;
    let shownAhead: number | null = null;
    for (;;) {
      const claim = await activities.claimRunSlot({ runId: this.id });
      if (claim.granted) break;
      if (queuedSince === null) {
        queuedSince = Date.now();
        // The claim wrote QUEUED to the row in the same transaction that counted the queue.
        this.control.status = "QUEUED";
      }
      if (claim.ahead !== shownAhead) {
        shownAhead = claim.ahead;
        await this.progress(queuedMessage(claim.ahead));
      }
      if (await condition(() => this.stopped, RUN_SLOT_POLL_MS)) await this.cancel();
    }
    if (queuedSince !== null) this.addWait(Date.now() - queuedSince);
  }

  private addWait(waited: number): void {
    this.deadline += waited;
    this.waitedMs += waited;
  }

  /**
   * DI-15.14. A preparation that finds every provider at its live sandbox limit waits here and
   * asks again. Only a stop or the Run budget ends the wait, and then the answer is null.
   */
  async withSandboxSlot<T>(prepare: (budgetMs: number) => Promise<T>): Promise<T | null> {
    let told = false;
    for (;;) {
      if (this.remainingMs() === 0) return null;
      try {
        return await prepare(this.remainingMs());
      } catch (error) {
        if (!isSandboxSlotUnavailable(error)) throw error;
      }
      if (!told) {
        told = true;
        await this.progress(
          "Every sandbox provider this run may use runs its limit of live sandboxes, and none of " +
            "them is retained for inspection. Factoree waits for a free sandbox.",
        );
      }
      const waitStarted = Date.now();
      const stopped = await condition(() => this.stopped, Math.max(1, Math.min(SANDBOX_SLOT_POLL_MS, this.remainingMs())));
      deprecatePatch(PATCH.sandboxSlotWait);
      this.addWait(Date.now() - waitStarted);
      if (stopped) return null;
    }
  }

  /** A sprite prepare that a stop or the deadline ended with no sprite ends the Run. */
  async required<T>(prepared: T | null): Promise<T> {
    if (prepared !== null) return prepared;
    if (this.stopped) await this.cancel();
    return await this.timeout();
  }
}
