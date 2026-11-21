import { ActivityFailure, ApplicationFailure, deprecatePatch, isCancellation, patched } from "@temporalio/workflow";
import type { PrepareCheckSandboxActivityOutput } from "~/activities/sandbox.activities.js";
import type { UserValidateActivityOutput } from "~/activities/validation.activities.js";
import type { VerifyActivityOutput } from "~/activities/verification.activities.js";
import type { ImplementActivityOutput } from "~/activities/agent.activities.js";
import type { AgentSessionRef } from "~/domain/runs/agent-runner.js";
import type { FactoreeDecision } from "~/domain/runs/factoree-decision.js";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import { describeSpentRepairBudget } from "../../../domain/runs/repair-budget.js";
import { targetResultsSentence } from "../../../domain/publishing/change-set.js";
import { buildVerifyActivities, cancelActivities, validationActivities } from "../activities.js";
import { causeOf, SANDBOX_FAULT_SENTENCE } from "../failures.js";
import { PATCH } from "../patches.js";
import type { Run } from "../run.js";
import {
  failHung,
  failProviderUnreachable,
  hangOf,
  PROVIDER_UNREACHABLE_ATTEMPTS,
  providerUnreachableOf,
  reportHang,
  retryWhileUnreachable,
  runImplementer,
  runUserValidate,
  spriteOf,
} from "../sessions.js";
import { dropReviewSpriteBuild, prepareCheckSprite, startReviewSpriteBuild } from "./checks.js";
import type { ResolvedContext } from "./context.js";
import type { Workspace } from "./preparation.js";
import { awaitReview, startReview, type CheckBrief } from "./review.js";
import type { ValidationContract } from "./validation-contract.js";

/**
 * docs/specs/check-faults.md. True when every FAIL of the pass is a flip, and nothing else keeps the
 * pass from an unstable-only result: no blocked or manual assertion and no failed in-between check.
 */
const flipsCoverFailures = (validation: UserValidateActivityOutput): boolean => {
  const flipped = new Set((validation.flipped ?? []).map((flip) => flip.assertionId));
  const failed = validation.results.filter((result) => result.result === "FAIL");
  return (
    flipped.size > 0 &&
    failed.length > 0 &&
    failed.every((result) => flipped.has(result.assertionId)) &&
    !validation.hasBlocked &&
    !validation.hasManual &&
    (validation.inBetweenFailedConsumers ?? []).length === 0
  );
};

/** The pass with its flipped FAIL results as UNSTABLE, as the result rows now hold them. */
const withFlipsUnstable = (validation: UserValidateActivityOutput): UserValidateActivityOutput => {
  const flipped = new Set((validation.flipped ?? []).map((flip) => flip.assertionId));
  return {
    ...validation,
    results: validation.results.map((result) => (flipped.has(result.assertionId) ? { ...result, result: "UNSTABLE" } : result)),
    hasFailure: false,
    hasUnstable: true,
    failures: [],
  };
};

/** What the passing attempt proved. Publication and the Proof Pack read it. */
export interface Verified {
  checked: PrepareCheckSandboxActivityOutput;
  changedFiles: string[];
  verificationSummary: string;
  /** The git tree the review examined. The publication refuses a tree that differs. */
  worktreeSha: string;
  verificationPassed: boolean;
  validationPassed: boolean;
  /** docs/specs/run-recovery.md. The only unproven assertions are unstable, so the run publishes a draft. */
  validationUnstableOnly: boolean;
  blockingCount: number;
  reviewVerdict: "pass" | "fail";
  reviewPasses: number;
  /** The attempt of the last Reviewer session. A passing review writes no finding row that names it. */
  reviewAttempt: number;
  previewUrl: string | null;
  fakes: Array<{ service: string; name: string; target?: string }>;
  /** DI-21.148. The pairs the last set check tested alone, with the reason. */
  setCheckNotes: string[];
  changeDescription: string;
  repairCount: number;
  repairLimit: number;
  /** SDD sections 24 and 68. The moment the first Implementer attempt started. */
  implementationStartedAt: string | null;
}

export interface AttemptPlan {
  workspace: Workspace;
  context: ResolvedContext;
  validation: ValidationContract;
  brief: Omit<CheckBrief, "attempt">;
  /** The findings the first attempt repairs: kept PR reviewer findings, a base update, a failed deploy. */
  initialFindings: string[];
}

/**
 * SDD section 42. One repair budget covers the Run. The reviewer branch and the release of a dropped
 * reviewer sprite run beside the attempt loop, so the loop keeps the awaits it had when the open runs
 * of this release were recorded: no helper adds a microtask turn before a command, or the commands
 * of the two paths reach the history in another order and an open run no longer replays.
 */
class Attempts {
  attempt = 1;
  repairCount = 0;
  repairFindings: string[];
  /** DI-21.142. The repositories outside the frozen set an implementer named, and the finding each later attempt reads. */
  readonly outsideSet = new Set<string>();
  readonly outsideSetFindings: string[] = [];
  /** docs/specs/agent-session-usage-and-hangs.md. The hung session the next attempt resumes. One step allows one hang. */
  continueSession: AgentSessionRef | null = null;
  resumedAfterHang = false;
  /** docs/specs/provider-unreachable.md. The consecutive implementer sessions that could not reach the provider. */
  unreachableRetries = 0;
  reviewPasses = 0;
  implementationStartedAt: string | null = null;
  readonly limit: number;
  /** Issue #43, DI-21.67. A spent budget names its size and where it comes from. */
  readonly spent: { clause: string; hint: string };

  constructor(
    private readonly run: Run,
    private readonly plan: AttemptPlan,
  ) {
    this.repairFindings = plan.initialFindings;
    this.limit = plan.workspace.work.runtime.repairMaxAttempts;
    this.spent = describeSpentRepairBudget(this.limit, plan.workspace.work.runtime.repairBudgetSource);
  }

  private count(): void {
    this.repairCount += 1;
    this.run.repairs = this.repairCount;
    this.attempt += 1;
  }

  /**
   * SDD section 42. A failed check enters repair while budget and time remain, else the Run ends
   * with the reason of the check. The REPAIRING write is the first await.
   */
  async repair(
    failed: { reason: "VERIFICATION_FAILED" | "VALIDATION_FAILED" | "REVIEW_BLOCKING_FINDINGS"; sentence: string; detail: string },
    repairReason: "VERIFICATION" | "VALIDATION" | "REVIEW",
    because: string,
    findings: string[],
  ): Promise<void> {
    if (this.repairCount >= this.limit) {
      await this.run.fail(failed.reason, `${failed.sentence}, and ${this.spent.clause}. ${this.spent.hint} ${failed.detail}Factoree published nothing.`);
    }
    if (this.run.remainingMs() === 0) await this.run.timeout();
    this.count();
    this.repairFindings = [...this.outsideSetFindings, ...findings];
    await this.run.enter("REPAIRING", { repairCount: this.repairCount, repairReason });
    await this.announce(because);
  }

  /** Tells the human that a repair starts, why, and what the implementer receives, so a long repair never looks dead. */
  private async announce(because: string): Promise<void> {
    deprecatePatch(PATCH.repairProgress);
    const total = this.repairFindings.length;
    await this.run.progress(
      `Factoree starts repair ${this.repairCount} of ${this.limit}, because ${because}. ` +
        `The implementer receives ${total} ${total === 1 ? "finding" : "findings"}. Factoree posts again when it checks the new change.`,
    );
  }

  /** docs/specs/change-sets.md, DI-21.154. A change set that fails its checks names the result of each target. */
  setResults(results: Parameters<typeof targetResultsSentence>[1]): string {
    const sentence = targetResultsSentence(this.plan.workspace.bases.map((target) => target.fullName), results);
    return sentence === "" ? "" : `${sentence} `;
  }

  /**
   * DI-21.142. The set froze with the Validation Contract. A repository the implementer names
   * outside it is a new criterion: Factoree lists it as not built, and each later attempt reads it.
   * It answers the decision of each new name.
   */
  outsideSetDecisions(implementation: ImplementActivityOutput | null): FactoreeDecision[] {
    const decisions: FactoreeDecision[] = [];
    for (const missing of implementation?.missingRepositories ?? []) {
      const name = missing.repository.trim();
      const key = name.toLowerCase();
      if (name === "" || this.outsideSet.has(key) || this.plan.workspace.bases.some((target) => target.slug.toLowerCase() === key)) continue;
      this.outsideSet.add(key);
      const reason = missing.reason.trim().replace(/[.\s]+$/, "");
      decisions.push({
        kind: "not_built",
        statement: `did not build the change to ${name}`,
        reason: `the targets froze with the Validation Contract, and a change to another repository is a new criterion${reason === "" ? "" : `: ${reason}`}`,
      });
      this.outsideSetFindings.push(
        `${name} is not a target of this Run, and the targets froze with the Validation Contract. Make the change work in the targets alone. Factoree lists ${name} as not built.`,
      );
    }
    return decisions;
  }

  /**
   * docs/specs/provider-unreachable.md. The first retry is a fresh session in the same sandbox, the
   * second one runs in a fresh sandbox while the Run holds no earlier change, and a third failure
   * ends the Run. None of them uses the repair budget.
   */
  async retryUnreachable(unreachable: { summary: string }): Promise<void> {
    const run = this.run;
    if (run.remainingMs() === 0) await run.timeout();
    if (this.unreachableRetries >= PROVIDER_UNREACHABLE_ATTEMPTS - 1) await failProviderUnreachable(run, "implementer", unreachable);
    this.unreachableRetries += 1;
    const freshSandbox = this.unreachableRetries === 2 && this.repairCount === 0;
    await run.progress(
      `The Implementer session could not reach the model provider, so Factoree starts one fresh session ` +
        `${freshSandbox ? "in a fresh sandbox" : "in the same sandbox"} (retry ${this.unreachableRetries} of ${PROVIDER_UNREACHABLE_ATTEMPTS - 1}).`,
    );
    if (!freshSandbox) return;
    await run.enter("PREPARING");
    const old = this.plan.workspace.work;
    // The old work sandbox goes before the fresh one is built, so the run never holds a fourth live
    // sandbox. The release is best effort: an ActivityFailure means it failed for good, and the
    // preparation below releases the superseded sandbox.
    try {
      await cancelActivities.destroySandbox({
        tenantId: run.input.tenantId,
        runId: run.id,
        spriteId: old.spriteId,
        adapter: old.adapter,
        workspacePath: old.workspacePath,
        reason: "SUPERSEDED",
      });
    } catch (error) {
      if (isCancellation(error) || !(error instanceof ActivityFailure)) throw error;
      const releaseCause = causeOf(error).trim().slice(0, 1_000);
      await run.progress(
        `Factoree could not release the old work sandbox ${old.spriteId}. It continues, ` +
          `because the next preparation releases the superseded sandbox.${releaseCause === "" ? "" : ` Cause: ${releaseCause}`}`,
      );
    }
    await this.plan.workspace.prepare(this.plan.workspace.workInput(true));
    await run.checkpoint();
  }

  /**
   * docs/specs/agent-session-usage-and-hangs.md. The first hang resumes the session once with
   * "continue", and that attempt uses the repair budget. A second hang in the same step ends the Run.
   */
  async resumeHang(implementation: ImplementActivityOutput, hang: { silenceLimitMs: number }): Promise<void> {
    const run = this.run;
    if (run.remainingMs() === 0) await run.timeout();
    if (this.resumedAfterHang) await failHung(run, "implementer", hang);
    if (this.repairCount >= this.limit) await failHung(run, "implementer", hang, `and ${this.spent.clause}, so Factoree cannot resume it`, this.spent.hint);
    await reportHang(run, "implementer", hang, "resumes it once");
    this.count();
    this.resumedAfterHang = true;
    this.continueSession = { sessionId: implementation.sessionId, processId: implementation.processId, runner: implementation.runner };
    await run.enter("REPAIRING", { repairCount: this.repairCount, repairReason: "AGENT_HUNG" });
  }
}

/**
 * SDD sections 35 to 49. One Implementer attempt, then verification, user validation and review
 * in check sprites, each failure a repair while the budget lasts. The agent's claim never decides
 * what follows; only the checks do.
 */
export const runAttempts = async (run: Run, plan: AttemptPlan): Promise<Verified> => {
  const { workspace, context, validation } = plan;
  const state = new Attempts(run, plan);
  for (;;) {
    if (run.remainingMs() === 0) await run.timeout();
    state.implementationStartedAt ??= new Date(Date.now()).toISOString();
    await run.enter("IMPLEMENTING");
    const implementation = await runImplementer(run, {
      prepared: workspace.work,
      goal: workspace.goal,
      attempt: state.attempt,
      unreachableRetry: state.unreachableRetries,
      repairFindings: state.repairFindings,
      contextContract: context.document,
      requiredContext: context.requiredContext,
      validationContract: validation.document,
      continueSession: state.continueSession,
    });
    state.continueSession = null;
    if (run.stopped) await run.cancel();
    // DI-21.48. A host the implementer named and the allow list does not hold ends the Run.
    const missingHosts = implementation?.missingHosts ?? [];
    if (missingHosts.length > 0) await workspace.failMissingHosts("implementer", missingHosts, context.primary.slug);
    deprecatePatch(PATCH.changeSetRefiner);
    for (const decision of state.outsideSetDecisions(implementation)) await run.takeDecision(decision);
    const unreachable = providerUnreachableOf(implementation);
    if (implementation !== null && unreachable !== null) {
      await state.retryUnreachable(unreachable);
      continue;
    }
    state.unreachableRetries = 0;
    const hang = hangOf(implementation);
    if (implementation !== null && hang !== null) {
      await state.resumeHang(implementation, hang);
      continue;
    }
    state.resumedAfterHang = false;
    if (implementation === null || !implementation.completed) {
      // SDD section 50. The runner reports a cancelled process as an incomplete attempt, so the deadline decides.
      if (run.remainingMs() === 0) await run.timeout();
      deprecatePatch(PATCH.providerUnreachable);
      // docs/specs/provider-unreachable.md. The message carries the agent's own output, capped at 1000 characters.
      const cause = (implementation?.summary ?? "").trim().slice(0, 1_000);
      return await run.fail(
        "IMPLEMENTATION_FAILED",
        `The Implementer did not complete the change. Factoree ended the Run.${cause === "" ? "" : ` Agent output: ${cause}`}`,
      );
    }
    if (run.remainingMs() === 0) await run.timeout();

    // docs/specs/check-isolation.md. The Implementer controlled the work sprite, so every check runs in a new sprite.
    let checked: PrepareCheckSandboxActivityOutput;
    try {
      const check = await prepareCheckSprite(run, workspace, run.checkSprite, state.attempt);
      if (check === null) return await (run.stopped ? run.cancel() : run.timeout());
      checked = check;
    } catch (error) {
      return await run.failFrom(
        error,
        "Factoree could not prepare the check sandbox, because the Run configuration is invalid. Repair the bootstrap command or the repository reference.",
      );
    }
    run.checkSprite = checked;
    if (run.stopped) await run.cancel();
    if (run.remainingMs() === 0) await run.timeout();
    await run.enter("VERIFYING");
    const reviewSprite = await startReviewSpriteBuild(run, workspace, state.attempt, checked);
    let verification: VerifyActivityOutput;
    try {
      verification = await buildVerifyActivities(run.remainingMs()).verify({
        runId: run.id,
        tenantId: run.input.tenantId,
        productId: run.input.productId,
        ...spriteOf(checked),
        commands: checked.verifyCommands,
        timeoutMs: run.remainingMs(),
        attempt: state.attempt,
        // DI-21.146. Each target of a change set verifies with its own stack.
        ...(checked.setCheck === undefined
          ? {}
          : { stacks: checked.setCheck.targets.map((target) => ({ repository: target.repository, path: target.path, services: target.services })) }),
      });
    } catch (error) {
      // docs/specs/sandbox-memory-and-size.md. A sandbox fault ends the run FAILED_CONFIGURATION.
      return await run.failFrom(error, SANDBOX_FAULT_SENTENCE);
    }
    await run.progress(verification.summary);
    if (!verification.passed) dropReviewSpriteBuild(run, reviewSprite.build);
    if (run.stopped) await run.cancel();
    if (!verification.passed) {
      await state.repair(
        {
          reason: "VERIFICATION_FAILED",
          sentence: "Deterministic verification did not pass",
          detail: `${verification.summary} ${state.setResults({ verification: verification.checks })}`,
        },
        "VERIFICATION",
        "deterministic verification did not pass",
        verification.failures,
      );
      continue;
    }
    if (run.remainingMs() === 0) await run.timeout();

    // SDD sections 36, 48 and 49. The reviewer starts beside user validation, and a fresh validator
    // session checks the frozen Validation Contract in the check sprite of the attempt.
    const brief: CheckBrief = { ...plan.brief, attempt: state.attempt };
    state.reviewPasses += 1;
    const review = startReview(run, brief, reviewSprite.build, verification.summary);
    await run.enter("USER_VALIDATING");
    const validate = (afterHang: boolean, unreachableRetry: number) =>
      runUserValidate(run, { prepared: checked, goal: brief.goal, attempt: brief.attempt, forYourEye: brief.forYourEye, edges: brief.edges, afterHang, unreachableRetry });
    let userValidation: UserValidateActivityOutput;
    try {
      let result = await validate(false, 0);
      if (run.stopped) await run.cancel();
      result = await retryWhileUnreachable(run, "validator", result, (retry) => validate(false, retry), 0);
      if (run.stopped) await run.cancel();
      const validatorHang = hangOf(result);
      if (validatorHang !== null && run.remainingMs() > 0) {
        await reportHang(run, "validator", validatorHang, "starts one fresh session");
        result = await validate(true, 0);
        result = await retryWhileUnreachable(run, "validator", result, (retry) => validate(true, retry), PROVIDER_UNREACHABLE_ATTEMPTS - 1);
        if (run.stopped) await run.cancel();
      }
      if (result === null) {
        if (run.remainingMs() === 0) await run.timeout();
        throw ApplicationFailure.nonRetryable("the userValidate activity returned no result");
      }
      userValidation = result;
    } catch (error) {
      return await run.failFrom(
        error,
        "Factoree could not start the User Validator, because the Run configuration is invalid. Repair `validator_runner` in `.factoree/config.yaml`.",
      );
    }
    const validatorUnreachable = providerUnreachableOf(userValidation);
    if (validatorUnreachable !== null) {
      if (run.remainingMs() === 0) await run.timeout();
      await failProviderUnreachable(run, "validator", validatorUnreachable);
    }
    const validatorHang = hangOf(userValidation);
    if (validatorHang !== null) {
      if (run.remainingMs() === 0) await run.timeout();
      await failHung(run, "validator", validatorHang);
    }
    await run.progress(userValidation.summary);
    if (run.stopped) await run.cancel();
    // docs/specs/run-recovery.md. When every assertion that did not pass is unstable, no repair can
    // help and nothing failed. The run continues to the review and a draft pull request.
    let unstableOnly =
      !userValidation.passed && userValidation.hasUnstable === true && !userValidation.hasFailure && !userValidation.hasBlocked && !userValidation.hasManual;
    if (unstableOnly) deprecatePatch(PATCH.unstableAssertion);
    if (!userValidation.passed && !unstableOnly) {
      // SDD section 36. Only a failing assertion can be repaired.
      if (userValidation.hasFailure) {
        // docs/specs/run-speed.md. The reviewer of the same attempt usually ended first. Its blockers
        // join the validation failures, so one repair fixes both. A reviewer that spent its retries
        // on an outage ends the Run, and never reads as "no findings".
        const parallel = await awaitReview(run, review);
        if (run.stopped) await run.cancel();
        if (parallel.kind === "review") {
          const reviewerUnreachable = providerUnreachableOf(parallel.review);
          if (reviewerUnreachable !== null) {
            if (run.remainingMs() === 0) await run.timeout();
            await failProviderUnreachable(run, "reviewer", reviewerUnreachable);
          }
        }
        const reviewFindings =
          parallel.kind === "review" && hangOf(parallel.review) === null && parallel.review.reportUsable && !parallel.review.passed ? parallel.review.failures : [];
        const inBetweenFailed = userValidation.inBetweenFailedConsumers;
        // docs/specs/check-faults.md, GitHub issue 49. Every failure is a check that passed in an
        // earlier attempt with the same plan entry, and the reviewer passed this change: no repair
        // can fix it, so the failures are UNSTABLE and the run goes on to a draft pull request.
        const reviewerPassed =
          parallel.kind === "review" && hangOf(parallel.review) === null && parallel.review.reportUsable && parallel.review.passed;
        if (reviewerPassed && flipsCoverFailures(userValidation) && patched(PATCH.crossAttemptUnstable)) {
          const flipped = userValidation.flipped ?? [];
          await validationActivities.markFlippedUnstable({ tenantId: run.input.tenantId, runId: run.id, attempt: state.attempt, flipped });
          userValidation = withFlipsUnstable(userValidation);
          unstableOnly = true;
          await run.progress(
            `${flipped.map((flip) => flip.assertionId).join(", ")} passed in an earlier attempt with the same check and failed now, while the reviewer passed the change. ` +
              "Factoree counts them as unstable, starts no repair, and offers the change as a draft pull request.",
          );
        } else {
          await state.repair(
            {
              reason: "VALIDATION_FAILED",
              sentence: "User validation did not pass",
              detail: `${userValidation.summary} ${state.setResults({ validation: userValidation.results, ...(inBetweenFailed === undefined ? {} : { inBetweenFailed }) })}`,
            },
            "VALIDATION",
            reviewFindings.length === 0 ? "user validation did not pass" : "user validation did not pass and the review found blocking findings",
            [...userValidation.failures, ...reviewFindings],
          );
          continue;
        }
      }
    }
    if (!userValidation.passed && !unstableOnly) {
      if (userValidation.hasBlocked) {
        return await run.fail(
          "VALIDATION_BLOCKED",
          `Factoree could not run at least one user validation check, so it proved nothing. ${userValidation.summary} A repair cannot help. Factoree published nothing.`,
        );
      }
      // SDD section 36 forbids completion of an L3 Run without a human.
      if (userValidation.hasManual) {
        return await run.fail(
          "VALIDATION_MANUAL_REQUIRED",
          `At least one user validation assertion needs a human, so Factoree cannot complete this Run on its own. ${userValidation.summary} Factoree published nothing.`,
        );
      }
      // A pass that did not pass must report a failed, blocked or manual assertion.
      throw ApplicationFailure.nonRetryable("User validation did not pass, and reported no failed, blocked, or manual assertion.", "USER_VALIDATION_INCONSISTENT");
    }

    // SDD sections 40 and 43. User validation passed, so the review of the attempt decides.
    if (run.remainingMs() === 0) await run.timeout();
    await run.enter("REVIEWING");
    const outcome = await awaitReview(run, review);
    if (run.stopped) await run.cancel();
    if (outcome.kind === "error") {
      return await run.failFrom(
        outcome.error,
        "Factoree could not start the Reviewer, because the Run configuration is invalid. Repair `reviewer_runner` in `.factoree/config.yaml`.",
      );
    }
    if (outcome.kind === "unavailable") {
      if (run.remainingMs() === 0) await run.timeout();
      throw ApplicationFailure.nonRetryable("the review activity returned no result");
    }
    const passed = outcome.review;
    const reviewerUnreachable = providerUnreachableOf(passed);
    if (reviewerUnreachable !== null) {
      if (run.remainingMs() === 0) await run.timeout();
      await failProviderUnreachable(run, "reviewer", reviewerUnreachable);
    }
    const reviewerHang = hangOf(passed);
    if (reviewerHang !== null) {
      if (run.remainingMs() === 0) await run.timeout();
      await failHung(run, "reviewer", reviewerHang);
    }
    await run.progress(passed.summary);
    if (run.stopped) await run.cancel();
    // DI-8.7. A report Factoree cannot read proves nothing, and a repair cannot fix it.
    if (!passed.reportUsable) {
      return await run.fail(
        "REVIEW_UNAVAILABLE",
        `Factoree could not obtain a usable independent review, so it proved nothing about this change. ${passed.reportProblem ?? ""} Factoree published nothing.`.trim(),
      );
    }
    if (passed.passed) {
      run.reviewVerdict = passed.verdict;
      return {
        checked,
        changedFiles: passed.changedFiles,
        verificationSummary: verification.summary,
        worktreeSha: passed.worktreeSha,
        verificationPassed: verification.passed,
        validationPassed: userValidation.passed,
        validationUnstableOnly: unstableOnly,
        blockingCount: passed.blockingCount,
        reviewVerdict: passed.verdict,
        reviewPasses: state.reviewPasses,
        reviewAttempt: state.attempt,
        previewUrl: userValidation.previewUrl,
        fakes: userValidation.fakes ?? [],
        setCheckNotes: userValidation.setCheckNotes ?? [],
        changeDescription: passed.changeDescription,
        repairCount: state.repairCount,
        repairLimit: state.limit,
        implementationStartedAt: state.implementationStartedAt,
      };
    }
    // SDD section 42. A blocking finding enters the same bounded repair loop.
    await state.repair(
      { reason: "REVIEW_BLOCKING_FINDINGS", sentence: "The independent review rejected this change", detail: `${passed.summary} ` },
      "REVIEW",
      "the independent review found blocking findings",
      passed.failures,
    );
  }
};
