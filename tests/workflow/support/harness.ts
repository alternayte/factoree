/* eslint-disable @typescript-eslint/require-await -- test activity doubles intentionally return immediately */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { Worker } from "@temporalio/worker";
import { inject } from "vitest";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import type { WorkflowHandle } from "@temporalio/client";
import {
  agentRunWorkflow,
  runStatusQuery,
  type AgentRunWorkflowInput,
} from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import type {
  RefineActivityInput,
  RefineActivityOutput,
} from "~/activities/refinement.activities.js";
import type { ResolveContextActivityInput } from "~/activities/context.activities.js";
import { RefinementEngine } from "~/domain/refinement/refinement-engine.js";
import type {
  PrepareCheckSandboxActivityInput,
  PrepareSandboxActivityInput,
} from "~/activities/sandbox.activities.js";
import type { ImplementActivityInput } from "~/activities/agent.activities.js";
import type { VerifyActivityInput } from "~/activities/verification.activities.js";
import type {
  BuildValidationContractActivityInput,
  BuildValidationContractActivityOutput,
  UserValidateActivityInput,
  UserValidateActivityOutput,
} from "~/activities/validation.activities.js";
import type {
  ReviewActivityInput,
  ReviewActivityOutput,
} from "~/activities/review.activities.js";
import type {
  CheckBaseActivityInput,
  CheckBaseActivityOutput,
  PublishActivityInput,
  PublishActivityOutput,
} from "~/activities/publishing.activities.js";
import type {
  PublishProofPackActivityInput,
  PublishProofPackActivityOutput,
} from "~/activities/evidence.activities.js";
import { parseReviewReport, ReviewReportInvalidError } from "~/domain/review/review-report.js";
import { decideReview } from "~/domain/review/blocking.js";
import type { ReviewDecision } from "~/domain/review/blocking.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import type { ProjectRuntimeConfig, VerificationCommand } from "~/domain/runs/project-runtime-config.js";
import {
  DEFAULT_PROJECT_DEFAULTS,
  DEFAULT_PROJECT_RUNTIME_CONFIG,
} from "~/domain/runs/project-runtime-config.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import type { AuthorityDomain } from "~/domain/context/authority.js";

/** One conflict the context double reports. It carries the domain, the way a real record does. */
export interface HarnessConflict {
  id: string;
  subject: string;
  domain: AuthorityDomain;
  question: string;
  settledByDecision?: boolean;
}

/** One recorded `setRunStatus` call. The repair count is present only on a `REPAIRING` call. */
export interface StatusCall {
  runId: string;
  status: string;
  repairCount?: number;
  /** SDD section 42 and section 62. The stage that asked for this repair. */
  repairReason?: "VERIFICATION" | "VALIDATION" | "REVIEW";
}

/** One recorded `completeRun` call. */
export interface CompletionCall {
  runId: string;
  status: string;
  failureReason?: string;
}

/** The single verification command every Run of the harness gets by default. */
export const DEFAULT_VERIFY_COMMANDS: VerificationCommand[] = [{ name: "unit", run: "npm test" }];

/**
 * Caches the agent-run workflow bundle for this test process.
 *
 * `tests/workflow/support/global-setup.ts` builds the bundle once for the whole
 * suite and provides its file path over vitest's `provide`/`inject` channel.
 * Each test file runs in its own worker process, so this module reads the file
 * once per process and reuses the result for every `runWorker` call, instead
 * of asking `Worker.create` to bundle `workflowsPath` again on every call.
 */
let agentRunWorkflowBundlePromise: Promise<string> | undefined;
const loadAgentRunWorkflowBundle = async (): Promise<string> => {
  agentRunWorkflowBundlePromise ??= readFile(inject("agentRunWorkflowBundlePath"), "utf8");
  return agentRunWorkflowBundlePromise;
};

/** The frozen Validation Contract hash the double reports. */
export const VALIDATION_SHA = "c".repeat(64);

/** The frozen Validation Contract document the double reports. */
export const VALIDATION_DOCUMENT = "# Validation Contract\n\nThe health endpoint answers 200.\n";

/** The git tree the review double reports. The publish double accepts exactly this value. */
export const REVIEWED_WORKTREE_SHA = "b".repeat(40);

/** The failure text the review double reports when it blocks a change. */
export const REVIEW_FAILURE_TEXT =
  "REV-001: the change drops the retry of the delivery worker (blocking).";

/** The failure text the verify double reports when it fails a check. */
export const VERIFY_FAILURE_TEXT = 'Verification check "unit" failed with exit code 1.';

/**
 * The frozen Validation Contract `decideReview` checks a report's `requirement` field against.
 * SDD section 41 lets a Reviewer name an assertion of the frozen contract as the mandatory
 * requirement a finding breaks, so `decideReview` needs one contract, not the whole Run. This
 * one carries the single assertion the controller ruling B report uses.
 */
export const REVIEW_HARNESS_CONTRACT: ValidationContract = {
  version: 1,
  runId: "irrelevant-to-decideReview",
  workItem: "harness",
  goal: "harness",
  assertions: [
    {
      id: "VAL-API-001",
      requirement: "AC-1",
      statement: "The API rejects an expired token.",
      method: "http",
      evidence: ["request-response"],
      preconditions: [],
    },
  ],
};

/**
 * Builds the activity doubles and the recorded state of one workflow test file. Every test file
 * of the workflow suite uses this harness, so the doubles cannot drift apart.
 */
export const createWorkflowHarness = (environment: () => TestWorkflowEnvironment) => {
  const created: string[] = [];
  const acknowledged: string[] = [];
  const completions: CompletionCall[] = [];
  const statuses: string[] = [];
  const statusCalls: StatusCall[] = [];
  const failingSessions = new Set<string>();
  const prepared: PrepareSandboxActivityInput[] = [];
  const implementCalls: ImplementActivityInput[] = [];
  const verifyCalls: VerifyActivityInput[] = [];
  const cancelledSessions: Array<{ runnerName: string; session: { sessionId: string } }> = [];
  const destroyed: string[] = [];
  /** docs/specs/check-isolation.md. The check sprite preparations, and the check sprites released. */
  const checkPrepared: PrepareCheckSandboxActivityInput[] = [];
  const releasedChecks: string[] = [];
  /** A run id in this map holds preparation open until the test resolves the promise. */
  const heldPreparations = new Map<string, Promise<void>>();
  /** A run id in this map holds the Implementer open, the same way a real agent run does. */
  const heldImplementations = new Map<string, Promise<void>>();
  /** A run id in this map holds verification open, the same way a real build does. */
  const heldVerifications = new Map<string, Promise<void>>();
  /**
   * A `runId:status` key in this map holds that one `setRunStatus` call open until the test
   * resolves the promise. The call is recorded first, so a test can wait for it, act, and then
   * release the workflow while it is still inside that call.
   */
  const heldStatuses = new Map<string, Promise<void>>();
  /** The run ids whose Implementer double reports a failed attempt. */
  const failingImplementations = new Set<string>();
  /** The run ids whose live Implementer session the activity cancelled. */
  const cancelledLiveSessions: string[] = [];
  /** Every message the workflow posted to the human on the error path. */
  const postedErrors: string[] = [];
  /** Every message the workflow posted to the human on the progress path. */
  const postedProgress: string[] = [];
  /** Every final response body the workflow posted, in order. */
  const postedFinalResponses: string[] = [];
  /** The run ids whose preparation double raises a configuration fault. */
  const configurationFaults = new Set<string>();
  /** The run ids whose `userValidate` double raises a configuration fault. */
  const validatorConfigurationFaults = new Set<string>();
  /** The runtime values one run id overrides on the prepared sandbox. */
  const runtimeOverrides = new Map<string, Partial<ProjectRuntimeConfig>>();
  /** Reports whether the verification pass of one run id and one attempt passes. */
  const verifyOutcomes = new Map<string, (attempt: number) => boolean>();
  /** Every recorded `buildValidationContract` call, in order. */
  const validationCalls: BuildValidationContractActivityInput[] = [];
  /**
   * A run id in this map replaces the Validation Contract result. The function reads the number
   * of the call, which starts at one, so a test can answer `needs_input` first and `ready` next.
   */
  const validationOutcomes = new Map<
    string,
    (call: number) => BuildValidationContractActivityOutput
  >();
  /** A run id in this map holds the contract build open until the test resolves the promise. */
  const heldValidations = new Map<string, Promise<void>>();
  /** Every recorded `userValidate` call, in order. */
  const userValidateCalls: UserValidateActivityInput[] = [];
  /**
   * A run id in this map replaces the `userValidate` result. The function reads the attempt
   * number of the call, so a test can answer `FAIL` first and `PASS` next.
   */
  const userValidationOutcomes = new Map<
    string,
    (attempt: number) => UserValidateActivityOutput
  >();
  /** A run id in this map holds the user validation pass open until the test resolves the promise. */
  const heldUserValidations = new Map<string, Promise<void>>();
  /** The run ids whose live User Validator session the activity observed a cancellation for. */
  const cancelledLiveValidations: string[] = [];
  /** Every recorded `review` call, in order. */
  const reviewCalls: ReviewActivityInput[] = [];
  /**
   * A run id in this map replaces the `review` result. The function reads the attempt number of
   * the call, so a test can block first and pass next. The partial result overrides the passing
   * default field by field.
   */
  const reviewOutcomes = new Map<string, (attempt: number) => Partial<ReviewActivityOutput>>();
  /** A run id in this map holds the review pass open until the test resolves the promise. */
  const heldReviews = new Map<string, Promise<void>>();
  /** The run ids whose `review` double raises a configuration fault. */
  const reviewerConfigurationFaults = new Set<string>();
  /**
   * Controller ruling B. A run id in this map drives the real `parseReviewReport` and the real
   * `decideReview` instead of a scripted outcome. The function reads the report text and the
   * changed-file list for one attempt, the way the fixture report of AT-22, AT-23, and AT-24
   * arrives from a scripted Reviewer session in production.
   */
  const reviewReports = new Map<
    string,
    (attempt: number) => { text: string; changedFiles: string[] }
  >();
  /** Every real `ReviewDecision` the `review` double produced through `reviewReports`, in order. */
  const reviewDecisions = new Map<string, ReviewDecision[]>();
  /** The run ids whose live Reviewer session the activity observed a cancellation for. */
  const cancelledLiveReviews: string[] = [];
  /**
   * A run id in this map replaces the `checkBase` result. SDD section 45 ends a Run on a moved
   * target branch, so a test states a stale answer here.
   */
  const baseChecks = new Map<string, () => CheckBaseActivityOutput>();
  /**
   * A run id in this map replaces the `publish` result. The function can also throw, so a test
   * can drive the three semantic publication failures of SDD section 46.
   */
  const publishOutcomes = new Map<string, () => PublishActivityOutput>();
  /** Every recorded `publish` call, in order. */
  const publishCalls: PublishActivityInput[] = [];
  /** Every recorded `publishProofPack` call, in order. */
  const proofPackCalls: PublishProofPackActivityInput[] = [];
  /** A run id in this map replaces the `publishProofPack` result. The function can also throw. */
  const proofPackOutcomes = new Map<string, () => PublishProofPackActivityOutput>();
  /** A run id in this map holds `publishProofPack` until the promise resolves. */
  const heldProofPacks = new Map<string, Promise<void>>();
  /**
   * A run id in this map replaces the `verifyTargetIdentity` result. The default reports a
   * match, so a test that does not care about section 8 sees no gate.
   */
  const targetIdentityOutcomes = new Map<
    string,
    () => { configSha: string; matched: boolean; declaredProduct: string | null }
  >();
  /** Every recorded `verifyTargetIdentity` call, in order. */
  const targetIdentityCalls: Array<{
    tenantId: string;
    runId: string;
    productSlug: string;
    repositoryUrl: string;
    baseSha: string;
  }> = [];
  /** Every recorded `recordRunTarget` call, in order. */
  const recordRunTargetCalls: Array<{
    tenantId: string;
    runId: string;
    repositoryId: string;
    selectionReason: string;
    mergeOrder: number;
  }> = [];
  /** Every recorded `recordRunTargetFacts` call, in order. F2. */
  const recordRunTargetFactsCalls: Array<{
    tenantId: string;
    runId: string;
    repositoryId: string;
    baseSha?: string;
    patchSha256?: string;
    commitSha?: string;
    pullRequestUrl?: string;
  }> = [];
  /** Every recorded `postTargetNotice` call, in order. */
  const postTargetNoticeCalls: Array<{
    tenantId: string;
    runId: string;
    fullName: string;
    reason: string;
  }> = [];
  /** A run id in this map holds the publication open until the test resolves the promise. */
  const heldPublishes = new Map<string, Promise<void>>();
  /** Every activity name the workflow called, in order. */
  const activityOrder: string[] = [];
  /** Every question the workflow elicited, in order. */
  const elicitations: string[] = [];
  /** Every autonomy level the workflow wrote to the Run after Refinement, in order. */
  const autonomyLevels: string[] = [];
  /**
   * SDD section 28. The labels the fake Linear API reports for one session id. A session absent
   * from the map reports no label, the same way an issue with no label does in production.
   */
  const workItemLabels = new Map<string, string[]>();
  /**
   * The session ids whose label read the fake Linear API fails on every call, in the same way a
   * transport fault the retry policy has exhausted does in production.
   */
  const failingLabelReads = new Set<string>();
  /** Every recorded `refine` call. */
  const refineCalls: RefineActivityInput[] = [];
  /** Every recorded `resolveContext` call. */
  const contextCalls: ResolveContextActivityInput[] = [];
  /**
   * A run id in this map replaces the refinement result. The real engine answers every other
   * run id, so a test that states no override drives the real Refinement rules.
   */
  const refineOverrides = new Map<string, (input: RefineActivityInput) => RefineActivityOutput>();
  /**
   * The conflicts the context double reports for one run id, in order. It reports the first
   * conflict no recorded decision settles. A decision settles a conflict when it carries the
   * same authority domain and the same subject, which is the rule `detectConflicts` applies.
   * `tests/unit/context-conflicts.test.ts` proves that rule against the real domain. A conflict
   * marked `settledByDecision: false` survives every answer, which is the case the bounded
   * question rounds exist for.
   */
  const contextConflicts = new Map<string, HarnessConflict[]>();
  /**
   * The branch names no repository of the harness carries. The context double raises the domain
   * configuration error for one of them, in the same way the real discovery path does when
   * `git ls-remote` names no such ref.
   */
  const missingBranches = new Set<string>();
  /** The pinned SHA of the primary repository of a Run. Discovery reports it in production. */
  const PRIMARY_SHA = "b".repeat(40);

  const refinement = new RefinementEngine();

  const statusesOf = (runId: string): string[] =>
    statusCalls.filter((entry) => entry.runId === runId).map((entry) => entry.status);

  const activities = {
    createRun: async (input: { linearAgentSessionId: string }) => {
      created.push(input.linearAgentSessionId);
      return {
        runId: `run-${input.linearAgentSessionId}`,
        created: created.filter((id) => id === input.linearAgentSessionId).length === 1,
      };
    },
    setRunStatus: async (input: StatusCall) => {
      statuses.push(input.status);
      statusCalls.push(input);
      await heldStatuses.get(`${input.runId}:${input.status}`);
    },
    setRunAutonomyLevel: async (input: { autonomyLevel: string }) => {
      autonomyLevels.push(input.autonomyLevel);
    },
    completeRun: async (input: CompletionCall) => {
      completions.push(input);
    },
    acknowledgeSession: async (input: { sessionId: string }) => {
      if (failingSessions.has(input.sessionId)) throw new Error("Linear is down");
      acknowledged.push(input.sessionId);
    },
    postProgress: async (input: { message: string }) => {
      postedProgress.push(input.message);
    },
    postElicitation: async (input: { question: string }) => {
      elicitations.push(input.question);
    },
    refine: async (input: RefineActivityInput): Promise<RefineActivityOutput> => {
      refineCalls.push(input);
      const override = refineOverrides.get(input.runId);
      if (override !== undefined) return override(input);
      // The real Refinement engine holds no port, so a test double for it adds no fidelity.
      const output = refinement.refine({
        source: input.source,
        project: input.project,
        decisions: input.decisions,
      });
      return {
        status: output.status,
        goal: output.goal,
        primaryRepository: output.primaryRepository,
        referenceRepositories: output.referenceRepositories,
        acceptanceCriteria: output.proposedAcceptanceCriteria.map((entry) => entry.statement),
        criteria: output.proposedAcceptanceCriteria.map((entry) => ({
          id: entry.id,
          statement: entry.statement,
          source: entry.source,
        })),
        workItemReferences: output.workItem.references.map((entry) => entry.value),
        risks: output.risks,
        constraints: output.workItem.constraints,
        unresolvedQuestions: output.unresolvedQuestions,
        autonomyLevel: output.autonomyLevel,
      };
    },
    resolveContext: async (input: ResolveContextActivityInput) => {
      activityOrder.push("resolveContext");
      contextCalls.push(input);
      if (missingBranches.has(input.primaryRepository.ref)) {
        throw new RunConfigurationError(
          `the ref "${input.primaryRepository.ref}" of the primary repository does not resolve ` +
            "to a commit SHA.",
        );
      }
      const all = contextConflicts.get(input.runId) ?? [];
      const settled = (conflict: HarnessConflict): boolean =>
        conflict.settledByDecision !== false &&
        input.decisions.some(
          (decision) =>
            decision.subject === conflict.subject && decision.domain === conflict.domain,
        );
      const unresolvedConflict = all.find((conflict) => !settled(conflict)) ?? null;
      const document = `# Context Contract\n\nGoal: ${input.goal}\n`;
      return {
        sha256: createHash("sha256").update(`${input.runId}|${document}`, "utf8").digest("hex"),
        document,
        // The line carries the run id, so a test can prove the workflow forwarded the
        // resolution of this Run and not a constant.
        requiredContext: [
          `docs/ADR-031.md (accepted ADR, run ${input.runId}, sha256 ${"0".repeat(64)})`,
        ],
        primary: { slug: input.primaryRepository.slug, sha: PRIMARY_SHA },
        references: input.referenceRepositories.map((repository, index) => ({
          slug: repository.slug,
          sha: `${index}`.repeat(40),
        })),
        unresolvedConflict,
        conflictCount: all.length,
        summary:
          unresolvedConflict === null
            ? "Factoree resolved the context of this Run."
            : "Factoree did not freeze this Context Contract, because one conflict is unresolved.",
      };
    },
    buildValidationContract: async (
      activityInput: BuildValidationContractActivityInput,
    ): Promise<BuildValidationContractActivityOutput> => {
      activityOrder.push("buildValidationContract");
      validationCalls.push(activityInput);
      await heldValidations.get(activityInput.runId);
      const outcome = validationOutcomes.get(activityInput.runId);
      const call = validationCalls.filter((entry) => entry.runId === activityInput.runId).length;
      if (outcome !== undefined) return outcome(call);
      return {
        status: "ready",
        sha256: VALIDATION_SHA,
        document: VALIDATION_DOCUMENT,
        assertionCount: 1,
        frozenAt: "2026-01-01T00:00:00.000Z",
        question: null,
        summary: "Factoree froze the Validation Contract with 1 assertion.",
        manualAssertionIds: [],
      };
    },
    postFinalResponse: async (activityInput: { body: string }) => {
      postedFinalResponses.push(activityInput.body);
    },
    postError: async (activityInput: { message: string }) => {
      postedErrors.push(activityInput.message);
    },
    fetchWorkItemLabels: async (activityInput: { sessionId: string; issueId: string }) => {
      if (failingLabelReads.has(activityInput.sessionId)) throw new Error("Linear is down");
      return workItemLabels.get(activityInput.sessionId) ?? [];
    },
    prepareSandbox: async (activityInput: PrepareSandboxActivityInput) => {
      activityOrder.push("prepareSandbox");
      prepared.push(activityInput);
      if (configurationFaults.has(activityInput.runId)) {
        throw new RunConfigurationError("the bootstrap command failed with exit code 1: no such file");
      }
      await heldPreparations.get(activityInput.runId);
      return {
        spriteId: `sprite-${activityInput.runId}`,
        adapter: "fake",
        workspacePath: "/workspace",
        primaryPath: "/workspace/primary",
        baseSha: "a".repeat(40),
        referencePaths: [],
        referenceBaseShas: [],
        baselineCheckpointId: null,
        runtime: {
          ...DEFAULT_PROJECT_RUNTIME_CONFIG,
          ...(runtimeOverrides.get(activityInput.runId) ?? {}),
        },
        verifyCommands: DEFAULT_VERIFY_COMMANDS,
        preview: null,
        repositoryInstructions: "Use the existing test idiom.",
      };
    },
    // docs/specs/check-isolation.md. Every attempt gets its own check sprite, named after the
    // attempt, so a test can prove which sprite a later stage used.
    prepareCheckSandbox: async (activityInput: PrepareCheckSandboxActivityInput) => {
      activityOrder.push("prepareCheckSandbox");
      checkPrepared.push(activityInput);
      return {
        spriteId: `check-${activityInput.runId}-${activityInput.attempt}`,
        adapter: "fake",
        workspacePath: "/workspace",
        primaryPath: "/workspace/primary",
        baseSha: "a".repeat(40),
        referencePaths: [],
        referenceBaseShas: [],
        baselineCheckpointId: null,
        runtime: {
          ...DEFAULT_PROJECT_RUNTIME_CONFIG,
          ...(runtimeOverrides.get(activityInput.runId) ?? {}),
        },
        verifyCommands: DEFAULT_VERIFY_COMMANDS,
        preview: null,
        repositoryInstructions: "Use the existing test idiom.",
        skills: [],
        patchSha256: "d".repeat(64),
        treeSha: "b".repeat(40),
        changedFiles: ["src/a.ts"],
        checkDefiningFiles: [],
      };
    },
    releaseCheckSandbox: async (activityInput: { spriteId: string }) => {
      releasedChecks.push(activityInput.spriteId);
    },
    destroySandbox: async (activityInput: { spriteId: string }) => {
      destroyed.push(activityInput.spriteId);
    },
    reapExpiredSandboxes: async () => 0,
    implement: async (activityInput: ImplementActivityInput) => {
      activityOrder.push("implement");
      implementCalls.push(activityInput);
      const held = heldImplementations.get(activityInput.runId);
      if (held !== undefined) {
        // The real activity cancels the live agent session when Temporal cancels the activity.
        // This double records the same event and then returns its evidence.
        Context.current().cancellationSignal.addEventListener(
          "abort",
          () => cancelledLiveSessions.push(activityInput.runId),
          { once: true },
        );
        const heartbeat = setInterval(() => Context.current().heartbeat(), 100);
        try {
          await held;
        } finally {
          clearInterval(heartbeat);
        }
      }
      return {
        sessionId: "ses_fake",
        processId: "process-fake",
        runner: activityInput.runnerName,
        completed: !failingImplementations.has(activityInput.runId),
        exitCode: 0,
        cancelled: false,
        summary: "The change is applied. Every test passes.",
        durationMs: 10,
        cancelledSession: cancelledLiveSessions.includes(activityInput.runId),
      };
    },
    verify: async (activityInput: VerifyActivityInput) => {
      activityOrder.push("verify");
      verifyCalls.push(activityInput);
      await heldVerifications.get(activityInput.runId);
      const outcome = verifyOutcomes.get(activityInput.runId);
      const passed = outcome === undefined ? true : outcome(activityInput.attempt);
      return {
        passed,
        checks: [
          {
            name: "unit",
            command: "npm test",
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: "2026-01-01T00:00:05.000Z",
            exitCode: passed ? 0 : 1,
            stdoutSha256: "0".repeat(64),
            stderrSha256: "0".repeat(64),
            log: passed ? null : "the unit suite reported one failure",
            timedOut: false,
            durationMs: 5,
            passed,
          },
        ],
        summary: passed
          ? "Every verification check passed."
          : "One verification check failed: unit.",
        failures: passed ? [] : [VERIFY_FAILURE_TEXT],
      };
    },
    cancelImplementer: async (activityInput: { runnerName: string; session: { sessionId: string } }) => {
      cancelledSessions.push(activityInput);
    },
    userValidate: async (
      activityInput: UserValidateActivityInput,
    ): Promise<UserValidateActivityOutput> => {
      activityOrder.push("userValidate");
      userValidateCalls.push(activityInput);
      if (validatorConfigurationFaults.has(activityInput.runId)) {
        throw new RunConfigurationError(
          `The Project configures the validator runner "${activityInput.runnerName}", which is not registered.`,
        );
      }
      const held = heldUserValidations.get(activityInput.runId);
      if (held !== undefined) {
        // The real activity heartbeats while the live validator session runs, and it observes
        // the cancellation signal. This double copies both, the same way the `implement` double
        // does, so a scope cancellation reaches it before the test releases the held pass.
        Context.current().cancellationSignal.addEventListener(
          "abort",
          () => cancelledLiveValidations.push(activityInput.runId),
          { once: true },
        );
        const heartbeat = setInterval(() => Context.current().heartbeat(), 100);
        try {
          await held;
        } finally {
          clearInterval(heartbeat);
        }
      }
      const outcome = userValidationOutcomes.get(activityInput.runId);
      if (outcome !== undefined) return outcome(activityInput.attempt);
      return {
        passed: true,
        results: [{ assertionId: "VAL-UI-001", result: "PASS", reason: "The page renders." }],
        hasFailure: false,
        hasManual: false,
        hasBlocked: false,
        summary: "Every user validation assertion passed.",
        failures: [],
        sessionId: "ses_fake_validator",
        previewUrl: null,
      };
    },
    review: async (activityInput: ReviewActivityInput): Promise<ReviewActivityOutput> => {
      activityOrder.push("review");
      reviewCalls.push(activityInput);
      if (reviewerConfigurationFaults.has(activityInput.runId)) {
        throw new RunConfigurationError(
          `The Project configures the reviewer runner "${activityInput.runnerName}", which is not registered.`,
        );
      }
      const held = heldReviews.get(activityInput.runId);
      if (held !== undefined) {
        // The real activity heartbeats while the live Reviewer session runs, and it observes the
        // cancellation signal. This double copies both, the same way the `userValidate` double
        // does, so a scope cancellation reaches it before the test releases the held pass.
        Context.current().cancellationSignal.addEventListener(
          "abort",
          () => cancelledLiveReviews.push(activityInput.runId),
          { once: true },
        );
        const heartbeat = setInterval(() => Context.current().heartbeat(), 100);
        try {
          await held;
        } finally {
          clearInterval(heartbeat);
        }
      }
      // Controller ruling B. When the test supplied a scripted report, the double parses it
      // with the real `parseReviewReport` and decides it with the real `decideReview`, so the
      // rule under test is the real rule and not a hand-written outcome.
      const reportFn = reviewReports.get(activityInput.runId);
      if (reportFn !== undefined) {
        const { text, changedFiles } = reportFn(activityInput.attempt);
        let report;
        try {
          report = parseReviewReport(text);
        } catch (error) {
          if (!(error instanceof ReviewReportInvalidError)) throw error;
          return {
            passed: false,
            verdict: "fail",
            findingCount: 0,
            blockingCount: 0,
            summary: "",
            failures: [],
            sessionId: "ses_fake_reviewer",
            reportUsable: false,
            reportProblem: error.message,
            changedFiles,
            worktreeSha: "",
          };
        }
        const decision = decideReview({
          report,
          contract: REVIEW_HARNESS_CONTRACT,
          changedFiles,
        });
        const list = reviewDecisions.get(activityInput.runId) ?? [];
        list.push(decision);
        reviewDecisions.set(activityInput.runId, list);
        return {
          passed: decision.passed,
          verdict: report.verdict,
          findingCount: decision.decisions.length,
          blockingCount: decision.blocking.length,
          summary: decision.summary,
          failures: decision.failures,
          sessionId: "ses_fake_reviewer",
          reportUsable: true,
          reportProblem: null,
          changedFiles,
          worktreeSha: REVIEWED_WORKTREE_SHA,
        };
      }

      const passing: ReviewActivityOutput = {
        passed: true,
        verdict: "pass",
        findingCount: 0,
        blockingCount: 0,
        summary: "The independent review found no blocking finding.",
        failures: [],
        sessionId: "ses_fake_reviewer",
        reportUsable: true,
        reportProblem: null,
        changedFiles: ["src/app.ts"],
        worktreeSha: REVIEWED_WORKTREE_SHA,
      };
      const outcome = reviewOutcomes.get(activityInput.runId);
      if (outcome === undefined) return passing;
      return { ...passing, ...outcome(activityInput.attempt) };
    },
    checkBase: async (
      activityInput: CheckBaseActivityInput,
    ): Promise<CheckBaseActivityOutput> => {
      activityOrder.push("checkBase");
      const override = baseChecks.get(activityInput.runId);
      return override === undefined
        ? { fresh: true, currentTargetSha: activityInput.baseSha }
        : override();
    },
    publish: async (activityInput: PublishActivityInput): Promise<PublishActivityOutput> => {
      activityOrder.push("publish");
      publishCalls.push(activityInput);
      const held = heldPublishes.get(activityInput.runId);
      if (held !== undefined) {
        // The real activity takes time on the network, so a stop can arrive while it runs. The
        // double heartbeats and awaits, the same way the `review` double does.
        const heartbeat = setInterval(() => Context.current().heartbeat(), 100);
        try {
          await held;
        } finally {
          clearInterval(heartbeat);
        }
      }
      // The real activity refuses a reviewed tree that does not equal the captured tree. The
      // double keeps that coupling, so the workflow must carry the value the review returned.
      if (activityInput.reviewedWorktreeSha !== REVIEWED_WORKTREE_SHA) {
        throw ApplicationFailure.nonRetryable(
          "the primary worktree changed after the independent review examined it",
          "PUBLICATION_FAILED",
        );
      }
      const override = publishOutcomes.get(activityInput.runId);
      if (override !== undefined) return override();
      return {
        patchSha256: "d".repeat(64),
        commitSha: "e".repeat(40),
        pullRequestUrl: "https://github.com/acme/fixture/pull/1",
        pullRequestNumber: 1,
        branch: `factoree/${activityInput.runId}`,
        created: true,
        patchByteLength: 812,
      };
    },
    publishProofPack: async (
      activityInput: PublishProofPackActivityInput,
    ): Promise<PublishProofPackActivityOutput> => {
      activityOrder.push("publishProofPack");
      proofPackCalls.push(activityInput);
      const held = heldProofPacks.get(activityInput.runId);
      if (held !== undefined) {
        // The real activity reads five stores and posts to Linear, so a stop can arrive while it
        // runs. The double heartbeats and awaits, the same way the `publish` double does.
        const heartbeat = setInterval(() => Context.current().heartbeat(), 100);
        try {
          await held;
        } finally {
          clearInterval(heartbeat);
        }
      }
      const override = proofPackOutcomes.get(activityInput.runId);
      if (override !== undefined) return override();
      return {
        sha256: "9".repeat(64),
        assertionCount: 1,
        limitationCount: 0,
        postedAt: "2026-01-01T03:00:00.000Z",
      };
    },
    verifyTargetIdentity: async (input: {
      tenantId: string;
      runId: string;
      productSlug: string;
      repositoryUrl: string;
      baseSha: string;
    }) => {
      activityOrder.push("verifyTargetIdentity");
      targetIdentityCalls.push(input);
      const outcome = targetIdentityOutcomes.get(input.runId);
      if (outcome !== undefined) return outcome();
      return { configSha: "f".repeat(64), matched: true, declaredProduct: input.productSlug };
    },
    recordRunTarget: async (input: {
      tenantId: string;
      runId: string;
      repositoryId: string;
      selectionReason: string;
      mergeOrder: number;
    }) => {
      recordRunTargetCalls.push(input);
      return `target-${input.runId}-${input.repositoryId}`;
    },
    recordRunTargetFacts: async (input: {
      tenantId: string;
      runId: string;
      repositoryId: string;
      baseSha?: string;
      patchSha256?: string;
      commitSha?: string;
      pullRequestUrl?: string;
    }) => {
      recordRunTargetFactsCalls.push(input);
    },
    postTargetNotice: async (input: {
      tenantId: string;
      runId: string;
      fullName: string;
      reason: string;
    }) => {
      postTargetNoticeCalls.push(input);
    },
  };

  /**
   * The Work Item of a Run. It states a goal and no open question, so Refinement is ready at
   * once. A test that needs a question states its own Work Item.
   */
  const workItemInput = {
    issueId: "issue-1",
    title: "Add the health endpoint",
    description: "## Goal\n\nAdd the health endpoint.\n",
    url: null,
    labels: [],
  };

  /** The Product of a Run. SDD section 15: only the Product defaults travel from here. */
  const productInput = {
    productId: "product-1",
    productSlug: "acme",
    repositories: [
      { id: "repository-1", fullName: "acme/primary", defaultBranch: "main", absentSince: null, githubInstallationId: "install-1" },
    ],
    repositoryBaseUrl: "https://example.invalid",
    stagingRead: DEFAULT_PROJECT_DEFAULTS.stagingRead,
    spriteRetentionHours: DEFAULT_PROJECT_DEFAULTS.spriteRetentionHours,
    defaultAutonomy: "L2",
    organizationSkillsRepository: null,
  };

  const input = (sessionId: string, maxRunMinutes = 90): AgentRunWorkflowInput => ({
    tenantId: "tenant-1",
    workspaceId: "workspace-123",
    productId: "product-1",
    linearIssueId: "issue-1",
    agentSessionId: sessionId,
    autonomyLevel: "L2",
    maxRunMinutes,
    workItem: workItemInput,
    product: productInput,
    repositoryProposal: null,
  });

  /** Starts one Run of the default fixture Project, with the given overrides. */
  const start = async (sessionId: string, overrides: Partial<AgentRunWorkflowInput> = {}) =>
    environment().client.workflow.start(agentRunWorkflow, {
      taskQueue: "test",
      workflowId: buildWorkflowId("workspace-123", sessionId),
      args: [{ ...input(sessionId), ...overrides }],
    });

  const runWorker = async <T>(body: () => Promise<T>): Promise<T> => {
    const worker = await Worker.create({
      connection: environment().nativeConnection,
      taskQueue: "test",
      workflowBundle: { code: await loadAgentRunWorkflowBundle() },
      activities,
    });
    return worker.runUntil(body());
  };

  return {
    activities,
    created,
    acknowledged,
    completions,
    statuses,
    statusCalls,
    statusesOf,
    failingSessions,
    prepared,
    implementCalls,
    verifyCalls,
    cancelledSessions,
    destroyed,
    checkPrepared,
    releasedChecks,
    heldPreparations,
    heldImplementations,
    heldVerifications,
    heldStatuses,
    failingImplementations,
    cancelledLiveSessions,
    postedErrors,
    postedProgress,
    postedFinalResponses,
    configurationFaults,
    validatorConfigurationFaults,
    runtimeOverrides,
    verifyOutcomes,
    elicitations,
    autonomyLevels,
    validationCalls,
    validationOutcomes,
    heldValidations,
    userValidateCalls,
    userValidationOutcomes,
    heldUserValidations,
    cancelledLiveValidations,
    reviewCalls,
    reviewOutcomes,
    reviewReports,
    reviewDecisions,
    heldReviews,
    reviewerConfigurationFaults,
    cancelledLiveReviews,
    baseChecks,
    publishOutcomes,
    publishCalls,
    heldPublishes,
    proofPackCalls,
    proofPackOutcomes,
    heldProofPacks,
    recordRunTargetCalls,
    recordRunTargetFactsCalls,
    postTargetNoticeCalls,
    targetIdentityOutcomes,
    targetIdentityCalls,
    activityOrder,
    workItemLabels,
    failingLabelReads,
    refineCalls,
    contextCalls,
    refineOverrides,
    contextConflicts,
    missingBranches,
    workItemInput,
    productInput,
    PRIMARY_SHA,
    input,
    start,
    runStatusQuery,
    runWorker,
  };
};

/** Polls the run status query until the Run reaches the given status. */
export const waitForStatus = async (
  handle: WorkflowHandle,
  status: string,
  timeoutMs?: number,
): Promise<void> => {
  await waitFor(
    async () => (await handle.query(runStatusQuery)).status === status,
    `status ${status}`,
    timeoutMs,
  );
};

/**
 * Polls until the predicate holds. It lets the workflow reach a step before the test signals.
 *
 * A real Temporal Worker dispatches each activity through an actual poll, execute, and report
 * cycle over a native connection, and that dispatch can starve entirely under CPU contention.
 * Instrumentation confirmed this: under deliberate oversubscription, a stalled wait polled
 * about 2200 times across its whole budget with zero movement in the watched value. Widening
 * this budget does not fix that. A failure here points at contention on the machine, not at a
 * defect in the workflow under test. `testTimeout` in `vitest.workflow.config.ts` is 180
 * seconds, so this default still fails fast well inside one test case.
 */
export const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  what = "the condition",
  timeoutMs = 60_000,
  describe?: () => unknown,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;
  let lastObserved: unknown;
  while (!(await predicate())) {
    pollCount += 1;
    if (describe) {
      lastObserved = await describe();
    }
    if (Date.now() > deadline) {
      const detail = describe
        ? ` (polled ${pollCount} times; last observed value: ${JSON.stringify(lastObserved)})`
        : ` (polled ${pollCount} times)`;
      throw new Error(`the test waited ${timeoutMs} milliseconds for ${what}${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Resolves the promise a held activity waits on. */
export const hold = (map: Map<string, Promise<void>>, runId: string): (() => void) => {
  let release = (): void => undefined;
  map.set(
    runId,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  return release;
};
