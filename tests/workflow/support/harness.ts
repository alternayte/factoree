/* eslint-disable @typescript-eslint/require-await -- test activity doubles intentionally return immediately */
import { createHash } from "node:crypto";
import { Context } from "@temporalio/activity";
import { Worker } from "@temporalio/worker";
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
import type { PrepareSandboxActivityInput } from "~/activities/sandbox.activities.js";
import type { ImplementActivityInput } from "~/activities/agent.activities.js";
import type { VerifyActivityInput } from "~/activities/verification.activities.js";
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
}

/** One recorded `completeRun` call. */
export interface CompletionCall {
  runId: string;
  status: string;
  failureReason?: string;
}

/** The single verification command every Run of the harness gets by default. */
export const DEFAULT_VERIFY_COMMANDS: VerificationCommand[] = [{ name: "unit", run: "npm test" }];

/** The failure text the verify double reports when it fails a check. */
export const VERIFY_FAILURE_TEXT = 'Verification check "unit" failed with exit code 1.';

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
  /** A run id in this map holds preparation open until the test resolves the promise. */
  const heldPreparations = new Map<string, Promise<void>>();
  /** A run id in this map holds the Implementer open, the same way a real agent run does. */
  const heldImplementations = new Map<string, Promise<void>>();
  /** A run id in this map holds verification open, the same way a real build does. */
  const heldVerifications = new Map<string, Promise<void>>();
  /** The run ids whose Implementer double reports a failed attempt. */
  const failingImplementations = new Set<string>();
  /** The run ids whose live Implementer session the activity cancelled. */
  const cancelledLiveSessions: string[] = [];
  /** Every message the workflow posted to the human on the error path. */
  const postedErrors: string[] = [];
  /** Every message the workflow posted to the human on the progress path. */
  const postedProgress: string[] = [];
  /** The run ids whose preparation double raises a configuration fault. */
  const configurationFaults = new Set<string>();
  /** The runtime values one run id overrides on the prepared sandbox. */
  const runtimeOverrides = new Map<string, Partial<ProjectRuntimeConfig>>();
  /** Reports whether the verification pass of one run id and one attempt passes. */
  const verifyOutcomes = new Map<string, (attempt: number) => boolean>();
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
    setRunStatus: async (input: { runId: string; status: string; repairCount?: number }) => {
      statuses.push(input.status);
      statusCalls.push(input);
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
        workItemReferences: output.workItem.references.map((entry) => entry.value),
        risks: output.risks,
        unresolvedQuestions: output.unresolvedQuestions,
        autonomyLevel: output.autonomyLevel,
      };
    },
    resolveContext: async (input: ResolveContextActivityInput) => {
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
    postFinalResponse: async () => undefined,
    postError: async (activityInput: { message: string }) => {
      postedErrors.push(activityInput.message);
    },
    fetchWorkItemLabels: async (activityInput: { sessionId: string; issueId: string }) => {
      if (failingLabelReads.has(activityInput.sessionId)) throw new Error("Linear is down");
      return workItemLabels.get(activityInput.sessionId) ?? [];
    },
    prepareSandbox: async (activityInput: PrepareSandboxActivityInput) => {
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
        repositoryInstructions: "Use the existing test idiom.",
      };
    },
    destroySandbox: async (activityInput: { spriteId: string }) => {
      destroyed.push(activityInput.spriteId);
    },
    reapExpiredSandboxes: async () => 0,
    implement: async (activityInput: ImplementActivityInput) => {
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

  /** The Project of a Run. SDD section 15: only the Project defaults travel from here. */
  const projectInput = {
    primaryRepository: "acme/primary",
    referenceRepositories: [],
    defaultBranch: "main",
    repositoryBaseUrl: "https://example.invalid",
    stagingRead: DEFAULT_PROJECT_DEFAULTS.stagingRead,
    spriteRetentionHours: DEFAULT_PROJECT_DEFAULTS.spriteRetentionHours,
    defaultAutonomy: "L2",
  };

  const input = (sessionId: string, maxRunMinutes = 90): AgentRunWorkflowInput => ({
    tenantId: "tenant-1",
    workspaceId: "workspace-123",
    projectId: "project-1",
    linearIssueId: "issue-1",
    agentSessionId: sessionId,
    autonomyLevel: "L2",
    maxRunMinutes,
    workItem: workItemInput,
    project: projectInput,
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
      workflowsPath: new URL("../../../src/workflows/agent-run.workflow.ts", import.meta.url).pathname,
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
    heldPreparations,
    heldImplementations,
    heldVerifications,
    failingImplementations,
    cancelledLiveSessions,
    postedErrors,
    postedProgress,
    configurationFaults,
    runtimeOverrides,
    verifyOutcomes,
    elicitations,
    autonomyLevels,
    workItemLabels,
    failingLabelReads,
    refineCalls,
    contextCalls,
    refineOverrides,
    contextConflicts,
    missingBranches,
    workItemInput,
    projectInput,
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

/** Polls until the predicate holds. It lets the workflow reach a step before the test signals. */
export const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  what = "the condition",
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`the test waited ${timeoutMs} milliseconds for ${what}`);
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
