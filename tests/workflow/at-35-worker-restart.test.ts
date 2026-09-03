/* eslint-disable @typescript-eslint/require-await -- stub Activities match the workflow's async activity signatures */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { agentRunWorkflow } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { DEFAULT_PROJECT_RUNTIME_CONFIG } from "~/domain/runs/project-runtime-config.js";

let environment: TestWorkflowEnvironment;
const createCalls: string[] = [];
const completions: string[] = [];
/** Every `publish` call of the test, by Run. AT-35 allows one pull request per Run only. */
const publishCalls: string[] = [];
/** Every terminal state the Run reached. AT-35 must end in a proved Run, not in a failure. */
const terminalStatuses: Array<{ status: string; failureReason: string | undefined }> = [];
/** Every `publishProofPack` call of the test, by Run. */
const proofPackCalls: string[] = [];
/** Every publication result the double returned, in call order. */
const publishResults: Array<{ runId: string; created: boolean; pullRequestUrl: string }> = [];

const activities = {
  createRun: async (input: { linearAgentSessionId: string }) => {
    // The repository is idempotent, so a repeated call returns the same Run.
    createCalls.push(input.linearAgentSessionId);
    return { runId: `run-${input.linearAgentSessionId}`, created: createCalls.length === 1 };
  },
  setRunStatus: async () => undefined,
  setRunAutonomyLevel: async () => undefined,
  // Specification section 10. This Run holds one repository, so `selectTarget` never gates it,
  // and the double only needs to return a target id.
  recordRunTarget: async () => "target-fake",
  postTargetNotice: async () => undefined,
  completeRun: async (input: { runId: string; status: string; failureReason?: string }) => {
    completions.push(input.runId);
    terminalStatuses.push({ status: input.status, failureReason: input.failureReason });
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
    constraints: [],
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
  // Specification section 8. The fixture repository makes no identity claim to check.
  verifyTargetIdentity: async () => ({ configSha: null, matched: true, declaredProduct: null }),
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
    // `UserValidateActivityInput.preview` is `PreviewConfig | null`. This map is a plain object
    // literal, so `npm run typecheck` cannot catch a missing field here.
    preview: null,
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
  // Phase 8 adds the review activity to the bounded loop. This map is a plain object literal and
  // is not typed as `Activities`, so `npm run typecheck` cannot catch a missing entry here
  // either. A missing entry fails a Run intermittently after a worker restart.
  review: async () => ({
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
    worktreeSha: "b".repeat(40),
  }),
  // Phase 9 adds the publication path. This map is a plain object literal and is not typed as
  // `Activities`, so `npm run typecheck` cannot catch a missing entry here either.
  checkBase: async (input: { baseSha: string }) => ({
    fresh: true,
    currentTargetSha: input.baseSha,
  }),
  // Controller decision 8. The branch name and the pull request lookup are deterministic, so a
  // second call after a worker restart finds the pull request the first call opened. The double
  // returns the same pull request record every time. Only the first call reports a creation.
  publish: async (input: { runId: string }) => {
    publishCalls.push(input.runId);
    const created = publishCalls.filter((entry) => entry === input.runId).length === 1;
    const result = {
      patchSha256: "d".repeat(64),
      commitSha: "e".repeat(40),
      pullRequestUrl: "https://github.com/acme/primary/pull/1",
      pullRequestNumber: 1,
      branch: `factoree/run-${input.runId}`,
      created,
      patchByteLength: 812,
    };
    publishResults.push({
      runId: input.runId,
      created,
      pullRequestUrl: result.pullRequestUrl,
    });
    return result;
  },
  // This file builds its own activity map by hand, so a new activity of the publication path
  // must be added here as well. Without it the Run fails the completion invariant, and this
  // test then passes for the wrong reason.
  publishProofPack: async (input: { runId: string }) => {
    proofPackCalls.push(input.runId);
    return {
      sha256: "9".repeat(64),
      assertionCount: 1,
      limitationCount: 0,
      postedAt: "2026-01-01T03:00:00.000Z",
    };
  },
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
          productId: "product-1",
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
          product: {
            productId: "product-1",
            productSlug: "acme",
            repositories: [{ id: "repository-1", fullName: "acme/primary", defaultBranch: "main", absentSince: null }],
            repositoryBaseUrl: "https://example.invalid",
            stagingRead: false,
            spriteRetentionHours: 24,
            defaultAutonomy: "L2",
            organizationSkillsRepository: null,
          },
          repositoryProposal: null,
        },
      ],
    });

    // Wait until the Run exists, then stop the worker while the workflow is still open.
    // The budget must cover the workflow task timeout on a loaded machine.
    for (let attempt = 0; attempt < 200 && createCalls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(createCalls).toHaveLength(1);
    first.shutdown();
    await firstRun;

    const second = await newWorker();
    const secondRun = second.run();

    // Wait until the Run published, then restart the worker a second time. A publication whose
    // result did not reach the history repeats on the third worker, so this restart exercises
    // the idempotency of SDD section 46 and of controller decision 8.
    // The first shutdown left a workflow task open. The budget must cover the workflow
    // task timeout on a loaded machine.
    for (let attempt = 0; attempt < 1200 && publishCalls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(publishCalls).toHaveLength(1);
    second.shutdown();
    await secondRun;

    const third = await newWorker();
    const thirdRun = third.run();
    // Phase 9 needed a stop here, because a published Run then sat in the residual wait. The
    // Proof Pack of SDD section 47 now completes the Run on its own, so a stop would race with
    // the completion and reach an already-finished workflow.
    const result = await handle.result();
    third.shutdown();
    await thirdRun;

    expect(result.runId).toBe("run-session-at35");
    expect(createCalls).toHaveLength(1);
    expect(completions).toEqual(["run-session-at35"]);

    // AT-35. A worker restart creates no second pull request. Two facts prove that, and the
    // test states each of them on its own.
    const results = publishResults.filter((entry) => entry.runId === "run-session-at35");

    // Fact 1. The number of publication attempts the double really received. Temporal replays a
    // recorded activity result, so the restart above repeats the attempt only when the result of
    // the first attempt did not reach the history.
    expect(results).toHaveLength(publishCalls.length);
    expect(results.length).toBeGreaterThanOrEqual(1);

    // Fact 2. The first attempt opened the pull request. Every later attempt found that same
    // pull request and reported no creation. This statement holds for one attempt and for two,
    // and it fails as soon as a second attempt reports a fresh creation.
    const createdFlags = results.map((entry) => entry.created);
    expect(createdFlags[0]).toBe(true);
    expect(createdFlags.filter((flag) => flag)).toHaveLength(1);

    // Every attempt named the same pull request, so no Run holds two of them.
    expect(new Set(results.map((entry) => entry.pullRequestUrl))).toEqual(
      new Set(["https://github.com/acme/primary/pull/1"]),
    );

    // Fact 3. The restart path ended in a proved Run, not in a failure that merely looked
    // complete to Temporal. SDD section 68 reaches READY_FOR_HUMAN only with a Proof Pack.
    expect(proofPackCalls).toContain("run-session-at35");
    expect(terminalStatuses.at(-1)?.status).toBe("READY_FOR_HUMAN");
    expect(terminalStatuses.at(-1)?.failureReason).toBeUndefined();

    const description = await handle.describe();
    expect(description.status.name).toBe("COMPLETED");
  });
});
