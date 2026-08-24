/* eslint-disable @typescript-eslint/require-await -- stub Activities match the workflow's async activity signatures */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { agentRunWorkflow, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { DEFAULT_PROJECT_RUNTIME_CONFIG } from "~/domain/runs/project-runtime-config.js";

let environment: TestWorkflowEnvironment;
const createCalls: string[] = [];
const completions: string[] = [];

const activities = {
  createRun: async (input: { linearAgentSessionId: string }) => {
    // The repository is idempotent, so a repeated call returns the same Run.
    createCalls.push(input.linearAgentSessionId);
    return { runId: `run-${input.linearAgentSessionId}`, created: createCalls.length === 1 };
  },
  setRunStatus: async () => undefined,
  setRunAutonomyLevel: async () => undefined,
  completeRun: async (input: { runId: string }) => {
    completions.push(input.runId);
  },
  acknowledgeSession: async () => undefined,
  postProgress: async () => undefined,
  postElicitation: async () => undefined,
  postFinalResponse: async () => undefined,
  postError: async () => undefined,
  fetchWorkItemLabels: async () => [],
  // Phase 4 puts refinement and context resolution before preparation, so this Run reaches
  // every activity below. Each double returns at once, and none of them holds state.
  refine: async (input: { project: { primaryRepository: string; referenceRepositories: string[] } }) => ({
    status: "ready",
    goal: "Add the health endpoint.",
    primaryRepository: input.project.primaryRepository,
    referenceRepositories: input.project.referenceRepositories,
    acceptanceCriteria: [],
    criteria: [],
    workItemReferences: [],
    risks: [],
    unresolvedQuestions: [],
    autonomyLevel: "L2",
  }),
  resolveContext: async (input: { primaryRepository: { slug: string } }) => ({
    sha256: "c".repeat(64),
    document: "# Context Contract\n",
    requiredContext: [],
    primary: { slug: input.primaryRepository.slug, sha: "b".repeat(40) },
    references: [],
    unresolvedConflict: null,
    conflictCount: 0,
    summary: "Factoree resolved the context of this Run.",
  }),
  buildValidationContract: async () => ({
    status: "ready",
    sha256: "c".repeat(64),
    document: "# Validation Contract\n\nThe health endpoint answers 200.\n",
    assertionCount: 1,
    frozenAt: "2026-01-01T00:00:00.000Z",
    question: null,
    summary: "Factoree froze the Validation Contract with 1 assertion.",
  }),
  prepareSandbox: async (input: { runId: string }) => ({
    spriteId: `sprite-${input.runId}`,
    adapter: "fake",
    workspacePath: "/workspace",
    primaryPath: "/workspace/primary",
    baseSha: "b".repeat(40),
    referencePaths: [],
    referenceBaseShas: [],
    baselineCheckpointId: null,
    runtime: DEFAULT_PROJECT_RUNTIME_CONFIG,
    verifyCommands: [],
    repositoryInstructions: "",
  }),
  implement: async (input: { runnerName: string }) => ({
    sessionId: "ses_fake",
    processId: "process-fake",
    runner: input.runnerName,
    completed: true,
    exitCode: 0,
    cancelled: false,
    summary: "The change is applied.",
    durationMs: 10,
    cancelledSession: false,
  }),
  verify: async () => ({ passed: true, checks: [], summary: "Every check passed.", failures: [] }),
  cancelImplementer: async () => undefined,
  // Phase 7 adds the userValidate activity to the bounded loop. This file builds its own
  // activity map instead of using the shared harness, so `npm run typecheck` cannot catch a
  // missing entry here. See the Phase 6 carried finding: the same omission failed a Run
  // intermittently after a restart.
  userValidate: async () => ({
    passed: true,
    results: [],
    hasFailure: false,
    hasManual: false,
    hasBlocked: false,
    summary: "Every user validation assertion passed.",
    failures: [],
    sessionId: "ses_fake_validator",
  }),
};

const newWorker = async (): Promise<Worker> =>
  Worker.create({
    connection: environment.nativeConnection,
    taskQueue: "at-35",
    workflowsPath: new URL("../../src/workflows/agent-run.workflow.ts", import.meta.url).pathname,
    activities,
  });

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
});

afterAll(async () => {
  await environment.teardown();
});

describe("AT-35 worker restart", () => {
  it("does not duplicate a Run when the worker restarts during it", async () => {
    const workflowId = buildWorkflowId("workspace-123", "session-at35");

    const first = await newWorker();
    const firstRun = first.run();
    const handle = await environment.client.workflow.start(agentRunWorkflow, {
      taskQueue: "at-35",
      workflowId,
      args: [
        {
          tenantId: "tenant-1",
          workspaceId: "workspace-123",
          projectId: "project-1",
          linearIssueId: "issue-1",
          agentSessionId: "session-at35",
          autonomyLevel: "L2",
          maxRunMinutes: 90,
          workItem: {
            issueId: "issue-1",
            title: "Add the health endpoint",
            description: "## Goal\n\nAdd the health endpoint.\n",
            url: null,
            labels: [],
          },
          project: {
            primaryRepository: "acme/primary",
            referenceRepositories: [],
            defaultBranch: "main",
            repositoryBaseUrl: "https://example.invalid",
            stagingRead: false,
            spriteRetentionHours: 24,
            defaultAutonomy: "L2",
          },
        },
      ],
    });

    // Wait until the Run exists, then stop the worker while the workflow is still open.
    for (let attempt = 0; attempt < 40 && createCalls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(createCalls).toHaveLength(1);
    first.shutdown();
    await firstRun;

    const second = await newWorker();
    const secondRun = second.run();
    await handle.signal(stopSignal);
    const result = await handle.result();
    second.shutdown();
    await secondRun;

    expect(result.runId).toBe("run-session-at35");
    expect(createCalls).toHaveLength(1);
    expect(completions).toEqual(["run-session-at35"]);
    const description = await handle.describe();
    expect(description.status.name).toBe("COMPLETED");
  });
});
