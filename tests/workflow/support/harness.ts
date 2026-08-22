/* eslint-disable @typescript-eslint/require-await -- test activity doubles intentionally return immediately */
import { Context } from "@temporalio/activity";
import { Worker } from "@temporalio/worker";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import type { PrepareSandboxActivityInput } from "~/activities/sandbox.activities.js";
import type { ImplementActivityInput } from "~/activities/agent.activities.js";
import type { VerifyActivityInput } from "~/activities/verification.activities.js";
import type { ProjectRuntimeConfig, VerificationCommand } from "~/domain/runs/project-runtime-config.js";
import {
  DEFAULT_PROJECT_DEFAULTS,
  DEFAULT_PROJECT_RUNTIME_CONFIG,
} from "~/domain/runs/project-runtime-config.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";

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
    postElicitation: async () => undefined,
    postFinalResponse: async () => undefined,
    postError: async (activityInput: { message: string }) => {
      postedErrors.push(activityInput.message);
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

  /** The sandbox input of a Run. SDD section 15: only the Project defaults travel from here. */
  const sandboxInput = {
    primary: { url: "https://example.invalid/primary.git", ref: "main" },
    references: [],
    defaults: DEFAULT_PROJECT_DEFAULTS,
    goal: "Add the health endpoint.",
  };

  const input = (sessionId: string, maxRunMinutes = 90) => ({
    tenantId: "tenant-1",
    workspaceId: "workspace-123",
    projectId: "project-1",
    linearIssueId: "issue-1",
    agentSessionId: sessionId,
    autonomyLevel: "L2",
    maxRunMinutes,
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
    sandboxInput,
    input,
    runWorker,
  };
};

/** Polls until the predicate holds. It lets the workflow reach a step before the test signals. */
export const waitFor = async (predicate: () => boolean, what = "the condition"): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`the test waited ten seconds for ${what}`);
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
