import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MockActivityEnvironment, TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { agentRunWorkflow, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import { createReviewActivities } from "~/activities/review.activities.js";
import type { ReviewActivityInput, ReviewActivityOutput } from "~/activities/review.activities.js";
import { createValidationActivities } from "~/activities/validation.activities.js";
import type { UserValidateActivityInput } from "~/activities/validation.activities.js";
import { createVerificationActivities } from "~/activities/verification.activities.js";
import type { VerifyActivityInput } from "~/activities/verification.activities.js";
import { createEvidencePersistence } from "~/activities/evidence.activities.js";
import type { ImplementActivityInput } from "~/activities/agent.activities.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import type {
  AgentCancelOutcome,
  AgentResumeInput,
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  AgentSessionRef,
} from "~/domain/runs/agent-runner.js";
import { DEFAULT_PROJECT_RUNTIME_CONFIG } from "~/domain/runs/project-runtime-config.js";
import { hashValidationContract } from "~/domain/validation/validation-contract.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import type { BrowserDriver } from "~/domain/validation/browser-driver.js";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { FilesystemEvidenceStorage } from "~/adapters/evidence/filesystem-evidence-storage.js";
import { PrismaAgentExecutionRepository } from "~/persistence/prisma/agent-execution.prisma.js";
import { PrismaEvidenceStore } from "~/persistence/prisma/evidence.prisma.js";
import { PrismaReviewFindingStore } from "~/persistence/prisma/review-finding.prisma.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaValidationContractStore } from "~/persistence/prisma/validation-contract.prisma.js";
import { PrismaValidationResultStore } from "~/persistence/prisma/validation-result.prisma.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { Redactor } from "~/telemetry/redaction.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import { startDatabase, seedTenantProjectAndRun } from "../integration/support/database.js";
import { createWorkflowHarness, hold, waitFor } from "../workflow/support/harness.js";
import { commitAll, initRepository } from "./support/fixture-repository.js";
import { pickPort, realHttpFetch, realProbe } from "./support/preview-fixture-helpers.js";
import {
  DEFECT_MARKER,
  DEFECTIVE_FILE,
  EDITOR_HEADER_CHECK,
  REVIEW_FIXTURE_BASE_FILES,
  REVIEW_FIXTURE_RULE,
  applyReviewFixtureAuthorizationFix,
  writeReviewFixtureApp,
} from "./support/review-fixture-app.js";

/** The name the frozen Validation Contract states. Both revisions of the fixture answer it. */
const NEW_NAME = "Reviewed Project";

/**
 * The verification command. It is a real check of the file the change adds, and it fails when
 * that file is absent or empty. SDD section 35 runs every command from a clean shell whose
 * `PATH` holds the system directories only, so the command uses `grep` and not `node`.
 */
const VERIFY_COMMANDS = [{ name: "server", run: 'grep -q "http.createServer" server.cjs' }];

/** The report the first Reviewer session writes. It names the known defect. */
const BLOCKING_REPORT = JSON.stringify({
  version: 1,
  verdict: "fail",
  findings: [
    {
      id: "RV-1",
      severity: "high",
      category: "security",
      requirement: `Repository rule: ${REVIEW_FIXTURE_RULE}`,
      evidence: `${DEFECTIVE_FILE}:37`,
      description:
        "PATCH /projects/1 saves the new name for every caller, so a reader with no editor " +
        "rights can rename the project.",
    },
    {
      // SDD section 43. The evidence names a file the base commit holds and the change never
      // touched, so `decideReview` must not let this finding block the Run.
      id: "RV-3",
      severity: "high",
      category: "correctness",
      requirement: "Repository rule: the contributing guide must state the review baseline.",
      evidence: "CONTRIBUTING.md:3",
      description: "The contributing guide states no review baseline.",
    },
    {
      // SDD section 41. Every other gate passes for this finding: the severity blocks, the
      // requirement names no assertion of the frozen contract, and the evidence names the one
      // changed file. Only the style rule can stop it.
      id: "RV-4",
      severity: "high",
      category: "style",
      requirement: "Repository rule: keep every helper name short.",
      evidence: `${DEFECTIVE_FILE}:31`,
      description: "The name `savePatch` reads better as `patchProject`.",
    },
  ],
});

/**
 * The report the second Reviewer session writes. It carries one low correctness finding, so the
 * attempt 2 rows are real rows and the proof that none of them blocks is a real proof. The
 * category is not `style`, so the severity rule of SDD section 41 is the only rule that stops
 * this finding from blocking.
 */
const CLEAN_REPORT = JSON.stringify({
  version: 1,
  verdict: "pass",
  findings: [
    {
      id: "RV-2",
      severity: "low",
      category: "correctness",
      requirement: "Repository rule: a helper must answer a malformed body with a 400.",
      evidence: `${DEFECTIVE_FILE}:31`,
      description: "A malformed body keeps the saved name instead of answering with a 400.",
    },
  ],
});

/**
 * Negative case 1. The Reviewer claims a pass verdict and reports a valid high finding in the
 * same document. SDD section 41 and DI-8.2: the agent claim decides nothing.
 */
const LYING_REPORT = JSON.stringify({
  version: 1,
  verdict: "pass",
  findings: [
    {
      id: "RV-9",
      severity: "high",
      category: "correctness",
      requirement: `Repository rule: ${REVIEW_FIXTURE_RULE}`,
      evidence: `${DEFECTIVE_FILE}:37`,
      description: "PATCH /projects/1 accepts a request that carries no editor header.",
    },
  ],
});

/** A BrowserDriver double that fails the test if the http-only contract below ever calls it. */
class UnusedBrowserDriver implements BrowserDriver {
  readonly name = "unused";
  run(): ReturnType<BrowserDriver["run"]> {
    throw new Error("The Phase 8 exit contract holds no browser assertion.");
  }
}

/**
 * A scripted validator runner. It writes the real `plan.json` a live session leaves behind. The
 * assertions the plan drives run against the real preview process, over real HTTP.
 */
class ScriptedValidatorRunner implements AgentRunner {
  readonly name = "claude";
  private calls = 0;

  constructor(private readonly planText: string) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.calls += 1;
    await mkdir(input.workingDirectory, { recursive: true });
    await writeFile(join(input.workingDirectory, "plan.json"), this.planText, "utf8");
    return {
      session: { sessionId: `ses_validator_p8_${this.calls}`, processId: `p${this.calls}`, runner: this.name },
      completed: true,
      exitCode: 0,
      cancelled: false,
      summary: "The user validation session is complete.",
      durationMs: 5,
      failureLog: null,
    };
  }

  resume(session: AgentSessionRef, input: AgentResumeInput): Promise<AgentRunResult> {
    void session;
    void input;
    throw new Error("The Phase 8 exit test never resumes a validator session.");
  }

  cancel(): Promise<AgentCancelOutcome> {
    return Promise.resolve("no-live-session");
  }
}

/**
 * The one double controller ruling C permits. It writes a real report file into the real review
 * directory, exactly as a live Reviewer session must, and it returns a fresh session identifier
 * for every pass. A `null` report writes no file at all, which is the second negative case.
 */
class ScriptedReviewerRunner implements AgentRunner {
  readonly name = "claude";
  readonly runs: AgentRunInput[] = [];
  private calls = 0;

  constructor(private readonly reportFor: (call: number) => string | null) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.runs.push(input);
    this.calls += 1;
    const call = this.calls;
    await mkdir(input.workingDirectory, { recursive: true });
    const text = this.reportFor(call);
    // Defect 3. The activity reads a per-attempt report path, `report-${attempt}.json`, so the
    // double must write there too. This double's `call` count tracks the review attempt.
    if (text !== null) await writeFile(join(input.workingDirectory, `report-${call}.json`), text, "utf8");
    return {
      session: { sessionId: `ses_reviewer_p8_${call}`, processId: `p${call}`, runner: this.name },
      completed: true,
      exitCode: 0,
      cancelled: false,
      summary: "The independent review is complete.",
      durationMs: 5,
      failureLog: null,
    };
  }

  resume(session: AgentSessionRef, input: AgentResumeInput): Promise<AgentRunResult> {
    void session;
    void input;
    throw new Error("The Phase 8 exit test never resumes a Reviewer session.");
  }

  cancel(): Promise<AgentCancelOutcome> {
    return Promise.resolve("no-live-session");
  }
}

const contractFor = (runId: string): ValidationContract => ({
  version: 1,
  runId,
  workItem: "PHASE-08-EXIT",
  goal: `An editor can rename the project to "${NEW_NAME}".`,
  assertions: [
    {
      id: "VAL-API-001",
      requirement: "AC-1",
      statement: "PATCH /projects/1 with an editor header saves the new name.",
      method: "http",
      evidence: ["request-response"],
      preconditions: [],
    },
    {
      id: "VAL-API-002",
      requirement: "AC-2",
      statement: `GET / shows "${NEW_NAME}" after the save.`,
      method: "http",
      evidence: ["request-response"],
      preconditions: [],
    },
  ],
});

/**
 * The validation plan. It exercises the editor path only, so it passes against the defective
 * revision as well as against the repaired revision. The known defect is therefore invisible to
 * user validation, and the independent review is the only step that can find it.
 */
const planText = JSON.stringify({
  version: 1,
  entries: [
    {
      assertionId: "VAL-API-001",
      kind: "http",
      request: {
        method: "PATCH",
        path: "/projects/1",
        headers: { "content-type": "application/json", "x-editor": "user" },
        body: JSON.stringify({ name: NEW_NAME }),
        expectStatus: 200,
        expectBodyContains: null,
      },
    },
    {
      assertionId: "VAL-API-002",
      kind: "http",
      request: {
        method: "GET",
        path: "/",
        headers: {},
        body: null,
        expectStatus: 200,
        expectBodyContains: NEW_NAME,
      },
    },
  ],
});

let database: { url: string; stop: () => Promise<void> };
let prisma: FactoreePrismaClient;
let temporal: TestWorkflowEnvironment;

beforeAll(async () => {
  database = await startDatabase();
  prisma = createPrismaClient(database.url);
  temporal = await TestWorkflowEnvironment.createTimeSkipping();
}, 300_000);

afterAll(async () => {
  await temporal.teardown();
  await prisma.$disconnect();
  await database.stop();
});

const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const path = temporaryRoots.pop();
    if (path !== undefined) await rm(path, { recursive: true, force: true });
  }
});

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

/** The base revision of the fixture repository, and the real base SHA of the change. */
const createFixtureBase = async (workspacePath: string): Promise<{ appPath: string; baseSha: string }> => {
  const appPath = join(workspacePath, "app");
  await initRepository(appPath);
  for (const file of REVIEW_FIXTURE_BASE_FILES) {
    await writeFile(join(appPath, file.path), file.text, "utf8");
  }
  const baseSha = await commitAll(appPath, "base revision");
  return { appPath, baseSha };
};

interface Rig {
  tenantId: string;
  productId: string;
  runId: string;
  sandbox: LocalProcessSandbox;
  ref: Awaited<ReturnType<LocalProcessSandbox["create"]>>;
  appPath: string;
  reviewerRunner: ScriptedReviewerRunner;
  reviewInputs: ReviewActivityInput[];
  reviewOutputs: ReviewActivityOutput[];
  implementCalls: ImplementActivityInput[];
  verifyInputs: VerifyActivityInput[];
  validateInputs: UserValidateActivityInput[];
  findings: PrismaReviewFindingStore;
  results: PrismaValidationResultStore;
  evidence: PrismaEvidenceStore;
  executions: PrismaAgentExecutionRepository;
  harness: ReturnType<typeof createWorkflowHarness>;
  activities: Record<string, unknown>;
  sessionId: string;
}

/**
 * Builds one Run of the real `agentRunWorkflow`, with the real verification activity, the real
 * user validation activity, and the real review activity. The scripted agent runner is the only
 * double of the reviewed path. The Implementer is a double, because controller ruling C states
 * that the Implementer is not the subject of this exit condition: the double writes the
 * defective revision on the first attempt, and the repaired revision on every later attempt.
 */
const buildRig = async (name: string, reportFor: (call: number) => string | null): Promise<Rig> => {
  const { tenantId, productId, runId } = await seedTenantProjectAndRun(prisma);
  const port = await pickPort();

  const sandboxRoot = await mkdtemp(join(tmpdir(), `factoree-phase08-${name}-`));
  temporaryRoots.push(sandboxRoot);
  const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
  const ref = await sandbox.create({ runId, tenantId, productId: productId });
  const { appPath, baseSha } = await createFixtureBase(ref.workspacePath);

  const contracts = new PrismaValidationContractStore(prisma);
  const runs = new PrismaRunRepository(prisma);
  const executions = new PrismaAgentExecutionRepository(prisma);
  const evidence = new PrismaEvidenceStore(prisma);
  const results = new PrismaValidationResultStore(prisma);
  const findings = new PrismaReviewFindingStore(prisma);
  const redactor = new Redactor();
  const storage = new FilesystemEvidenceStorage({ rootDirectory: join(sandboxRoot, "evidence") });

  // The contract freezes before any attempt runs, exactly as it does for a real Run. The real
  // review activity and the real user validation activity both read this row.
  const contract = contractFor(runId);
  const document = "# Validation Contract\n\nVAL-API-001, VAL-API-002";
  const stored = await contracts.save({
    tenantId,
    runId,
    contract,
    sha256: hashValidationContract(contract),
    document,
  });
  await runs.setValidationContractVersion(tenantId, runId, stored.sha256);

  // The fixture app reads its listen port from `PORT`. A Project states it as a test secret
  // marked for injection, SDD section 30, which is the only way a value reaches a command.
  const secrets = new MemorySecretStore({
    PORT: { value: String(port), injectIntoImplementer: true },
  });

  const verification = createVerificationActivities({ sandbox, evidence, secrets, redactor, logger });
  const reviewerRunner = new ScriptedReviewerRunner(reportFor);
  const review = createReviewActivities({
    sandbox,
    runners: new AgentRunnerRegistry([reviewerRunner]),
    executions,
    secrets,
    redactor,
    contracts,
    reviewFindings: findings,
    logger,
  });
  const validation = createValidationActivities({
    contracts,
    runs,
    logger,
    userValidation: {
      sandbox,
      runners: new AgentRunnerRegistry([new ScriptedValidatorRunner(planText)]),
      executions,
      secrets,
      redactor,
      browser: new UnusedBrowserDriver(),
      fetchImpl: realHttpFetch,
      probe: realProbe,
      evidencePersistence: createEvidencePersistence({ evidence, results, storage, logger }),
    },
  });

  const harness = createWorkflowHarness(() => temporal);
  // The real activities read the frozen contract from the database. The double reports the real
  // hash and the real document of that row, so the workflow carries the same contract.
  harness.validationOutcomes.set(runId, () => ({
    status: "ready",
    sha256: stored.sha256,
    document,
    assertionCount: contract.assertions.length,
    frozenAt: "2026-01-01T00:00:00.000Z",
    question: null,
    summary: "Factoree froze the Validation Contract with 2 assertions.",
    manualAssertionIds: [],
  }));

  const reviewInputs: ReviewActivityInput[] = [];
  const reviewOutputs: ReviewActivityOutput[] = [];
  const implementCalls: ImplementActivityInput[] = [];
  const verifyInputs: VerifyActivityInput[] = [];
  const validateInputs: UserValidateActivityInput[] = [];

  const activities: Record<string, unknown> = {
    ...harness.activities,
    createRun: () => Promise.resolve({ runId, created: true }),
    prepareSandbox: () =>
      Promise.resolve({
        spriteId: ref.id,
        adapter: ref.adapter,
        workspacePath: ref.workspacePath,
        primaryPath: appPath,
        baseSha,
        referencePaths: [],
        referenceBaseShas: [],
        baselineCheckpointId: null,
        runtime: { ...DEFAULT_PROJECT_RUNTIME_CONFIG, repairMaxAttempts: 2 },
        verifyCommands: VERIFY_COMMANDS,
        preview: {
          enabled: true,
          command: "node server.cjs",
          readyUrl: `http://127.0.0.1:${port}/health`,
          timeoutSeconds: 30,
        },
        repositoryInstructions: REVIEW_FIXTURE_RULE,
      }),
    implement: async (input: ImplementActivityInput) => {
      implementCalls.push(input);
      // Attempt 1 writes the known defect. Every repair attempt writes the second revision.
      if (input.attempt === 1) await writeReviewFixtureApp({ root: appPath, requireEditor: false });
      else await applyReviewFixtureAuthorizationFix(appPath);
      return {
        sessionId: `ses_implementer_p8_${input.attempt}`,
        processId: `i${input.attempt}`,
        runner: input.runnerName,
        completed: true,
        exitCode: 0,
        cancelled: false,
        summary: "The change is applied.",
        durationMs: 5,
        failureLog: null,
        cancelledSession: false,
      };
    },
    verify: async (input: VerifyActivityInput) => {
      verifyInputs.push(input);
      return await verification.verify(input);
    },
    userValidate: async (input: UserValidateActivityInput) => {
      validateInputs.push(input);
      return await validation.userValidate(input);
    },
    review: async (input: ReviewActivityInput) => {
      reviewInputs.push(input);
      const output = await review.review(input);
      reviewOutputs.push(output);
      return output;
    },
  };

  return {
    tenantId,
    productId,
    runId,
    sandbox,
    ref,
    appPath,
    reviewerRunner,
    reviewInputs,
    reviewOutputs,
    implementCalls,
    verifyInputs,
    validateInputs,
    findings,
    results,
    evidence,
    executions,
    harness,
    activities,
    sessionId: `ses-p8-${name}`,
  };
};

/** Runs one worker of the rig, and starts the Run the workflow drives. */
const runRig = async <T>(rig: Rig, body: (handle: Awaited<ReturnType<typeof startRun>>) => Promise<T>): Promise<T> => {
  const worker = await Worker.create({
    connection: temporal.nativeConnection,
    taskQueue: "test",
    workflowsPath: new URL("../../src/workflows/agent-run.workflow.ts", import.meta.url).pathname,
    activities: rig.activities,
  });
  return await worker.runUntil(
    (async () => {
      const handle = await startRun(rig);
      return await body(handle);
    })(),
  );
};

const startRun = async (rig: Rig) =>
  temporal.client.workflow.start(agentRunWorkflow, {
    taskQueue: "test",
    workflowId: buildWorkflowId("workspace-123", rig.sessionId),
    args: [
      {
        ...rig.harness.input(rig.sessionId),
        tenantId: rig.tenantId,
        productId: rig.productId,
      },
    ],
  });

/** Reads the "Changed files" section of a rendered Reviewer prompt. */
const changedFilesSectionOf = (prompt: string): string => {
  const start = prompt.indexOf("## Changed files");
  const rest = prompt.slice(start);
  const end = rest.indexOf("## Source diff");
  return rest.slice(0, end);
};

/**
 * The Phase 8 exit condition, SDD section 69: a known defect is found, repaired, revalidated,
 * and re-reviewed. The whole loop runs inside the real `agentRunWorkflow`, over a real git
 * fixture repository, a real preview process, real HTTP assertions, the real review activity,
 * and the real database. Controller ruling C: the only double of the reviewed path is the agent
 * runner, and it writes a real report file exactly as a live Reviewer session must.
 */
describe("Phase 8 exit — a known defect is found, repaired, revalidated, and re-reviewed", () => {
  it("blocks the defective revision, repairs it, revalidates it, and passes the second review", async () => {
    const rig = await buildRig("exit", (call) => (call === 1 ? BLOCKING_REPORT : CLEAN_REPORT));

    // The publication is held, so the stop lands while the Run sits inside the `publish`
    // activity. This rig runs the real `review` activity, so the reviewed worktree SHA it
    // reports is a real content hash, never the fixed value the double `publish` activity of the
    // harness compares it with. Left to run to completion, `publish` therefore always raises
    // PUBLICATION_FAILED, and the workflow only reads that as a human stop, not a failure, when
    // `stopRequested` is already set at the moment `publish` returns control. Without the hold,
    // the stop signal races the workflow to a terminal state, and whichever one lands first
    // decides whether the Run ends CANCELLED or FAILED. The hold removes the race: the workflow
    // is proven to be inside `publish` before the stop is signalled, so the stop always lands in
    // time and the Run always ends CANCELLED.
    const release = hold(rig.harness.heldPublishes, rig.runId);

    try {
      await runRig(rig, async (handle) => {
        await waitFor(() => rig.reviewOutputs.length === 2, "the second review of the exit Run", 120_000);
        await waitFor(
          () => rig.harness.publishCalls.filter((entry) => entry.runId === rig.runId).length === 1,
          "the publication of the exit Run",
          120_000,
        );
        await handle.signal(stopSignal);
        release();
        await handle.result();
      });

      // Point 1. The first Reviewer prompt carries the real diff of the known defect, and the
      // changed-file list names the defective file. The prompt text is the one the real review
      // activity rendered from the real `captureSourceDiff` output.
      const firstPrompt = rig.reviewerRunner.runs[0]?.prompt ?? "";
      expect(firstPrompt).toContain(DEFECT_MARKER);
      expect(firstPrompt).toContain(`+++ b/${DEFECTIVE_FILE}`);
      expect(changedFilesSectionOf(firstPrompt)).toContain(`- ${DEFECTIVE_FILE}`);
      // The defect is really unfixed at this point: the repaired line is absent.
      expect(firstPrompt).not.toContain(EDITOR_HEADER_CHECK);

      // Point 2. The parsed report names the defect, and `decideReview` marked the finding
      // blocking against the real changed-file list. Both values come out of the real activity.
      const firstReview = rig.reviewOutputs[0]!;
      expect(firstReview.reportUsable).toBe(true);
      // Three high findings reached `decideReview`. Only the one inside the change, and outside
      // the style category, blocks the Run.
      expect(firstReview.findingCount).toBe(3);
      expect(firstReview.blockingCount).toBe(1);
      expect(firstReview.passed).toBe(false);
      expect(firstReview.failures).toEqual([expect.stringContaining("RV-1")]);
      expect(firstReview.failures[0]).toContain(`${DEFECTIVE_FILE}:37`);

      // Point 3. A repair happened, and the repair count reached 1. The workflow took that
      // decision itself, and it named the review as the stage that asked for the repair.
      const repairs = rig.harness.statusCalls.filter(
        (entry) => entry.runId === rig.runId && entry.status === "REPAIRING",
      );
      expect(repairs).toHaveLength(1);
      expect(repairs[0]?.repairCount).toBe(1);
      expect(repairs[0]?.repairReason).toBe("REVIEW");
      // The blocking finding really reached the next attempt.
      expect(rig.implementCalls).toHaveLength(2);
      expect(rig.implementCalls[1]?.repairFindings).toEqual([expect.stringContaining("RV-1")]);

      // Point 4. The repair applied the second revision, and deterministic verification ran
      // again. The file on disk is the real artefact, and the Evidence rows are real rows.
      const repairedSource = await readFile(join(rig.appPath, DEFECTIVE_FILE), "utf8");
      expect(repairedSource).toContain(EDITOR_HEADER_CHECK);
      expect(repairedSource).not.toContain(DEFECT_MARKER);
      expect(rig.verifyInputs.map((input) => input.attempt)).toEqual([1, 2]);
      const checkRows = (await rig.evidence.listForRun(rig.tenantId, rig.runId)).filter(
        (row) => row.kind === "deterministic_check",
      );
      expect(checkRows).toHaveLength(2);
      expect(
        checkRows.map((row) => (row.metadata as { attempt: number }).attempt).sort(),
      ).toEqual([1, 2]);
      expect(checkRows.every((row) => (row.metadata as { passed: boolean }).passed)).toBe(true);

      // Point 5. User validation ran again, and every assertion reported PASS. The rows come
      // from the database, and they hold two attempts.
      expect(rig.validateInputs.map((input) => input.attempt)).toEqual([1, 2]);
      const resultRows = await rig.results.listForRun(rig.tenantId, rig.runId);
      expect(resultRows).toHaveLength(4);
      const attempt1Results = resultRows.filter((row) => row.attempt === 1);
      const attempt2Results = resultRows.filter((row) => row.attempt === 2);
      expect(attempt1Results).toHaveLength(2);
      expect(attempt2Results).toHaveLength(2);
      expect(attempt2Results.every((row) => row.result === "PASS")).toBe(true);
      // The attempt 1 rows also report PASS. The known defect is invisible to the frozen
      // contract, so the independent review is the only step that can find it.
      expect(attempt1Results.every((row) => row.result === "PASS")).toBe(true);

      // Point 6. The second review ran in a session whose identifier differs from the first
      // review session, and it reported no blocking finding.
      // The workflow ran one review pass per attempt, and it numbered them itself.
      expect(rig.reviewInputs.map((input) => input.attempt)).toEqual([1, 2]);
      const secondReview = rig.reviewOutputs[1]!;
      expect(secondReview.sessionId).not.toBe(firstReview.sessionId);
      expect(secondReview.blockingCount).toBe(0);
      expect(secondReview.passed).toBe(true);
      // The persisted AgentExecution rows carry the same two distinct reviewer sessions.
      const reviewerRows = (await rig.executions.listForRun(rig.tenantId, rig.runId)).filter(
        (row) => row.role === "reviewer",
      );
      expect(reviewerRows).toHaveLength(2);
      expect(new Set(reviewerRows.map((row) => row.sessionRef)).size).toBe(2);
      // The second prompt really carries the repaired revision.
      expect(rig.reviewerRunner.runs).toHaveLength(2);
      expect(rig.reviewerRunner.runs[1]?.prompt ?? "").toContain(EDITOR_HEADER_CHECK);

      // Point 7. The persisted ReviewFinding rows hold the attempt 1 blocking finding, and hold
      // no blocking finding for attempt 2.
      const findingRows = await rig.findings.listForRun(rig.tenantId, rig.runId);
      const attempt1Findings = findingRows.filter((row) => row.attempt === 1);
      const attempt2Findings = findingRows.filter((row) => row.attempt === 2);
      expect(attempt1Findings).toHaveLength(3);
      const blockingRow = attempt1Findings.find((row) => row.findingKey === "RV-1");
      expect(blockingRow?.blocking).toBe(true);
      expect(blockingRow?.severity).toBe("high");
      // SDD section 43. The second finding carries the same severity and the same category, and
      // its evidence names a file the change never touched. Factoree refused to let it block,
      // and the persisted reason names that rule. This proves the changed-file gate is real.
      const outsideRow = attempt1Findings.find((row) => row.findingKey === "RV-3");
      expect(outsideRow?.severity).toBe("high");
      expect(outsideRow?.blocking).toBe(false);
      expect(outsideRow?.decisionReason).toContain("names no file this Run changed");
      // SDD section 41. The third finding carries the same severity and the same evidence as the
      // blocking finding, and it names a repository rule. Only its category separates it, so
      // this proves the style rule is real. The reason text is the real text of `decideReview`.
      const styleRow = attempt1Findings.find((row) => row.findingKey === "RV-4");
      expect(styleRow?.severity).toBe("high");
      expect(styleRow?.blocking).toBe(false);
      expect(styleRow?.decisionReason).toContain("a style preference does not block");
      expect(attempt2Findings).toHaveLength(1);
      expect(attempt2Findings[0]?.findingKey).toBe("RV-2");
      expect(attempt2Findings.some((row) => row.blocking)).toBe(false);

      // The Run left the attempt loop through the passing-review branch, and then stopped at the
      // request of the test. It did not fail, and it did not leave through any other path.
      const completion = rig.harness.completions.find((entry) => entry.runId === rig.runId);
      expect(completion?.status).toBe("CANCELLED");
      expect(completion?.failureReason).toBe("STOPPED_BY_HUMAN");
      expect(completion?.status).not.toBe("FAILED");
    } finally {
      await rig.sandbox.destroy(rig.ref);
    }
  }, 300_000);

  it("blocks a valid high finding even when the Reviewer claims a pass verdict", async () => {
    const { tenantId, productId, runId } = await seedTenantProjectAndRun(prisma);
    const sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-phase08-liar-"));
    temporaryRoots.push(sandboxRoot);
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const ref = await sandbox.create({ runId, tenantId, productId: productId });
    const { appPath, baseSha } = await createFixtureBase(ref.workspacePath);
    await writeReviewFixtureApp({ root: appPath, requireEditor: false });

    const contracts = new PrismaValidationContractStore(prisma);
    const findings = new PrismaReviewFindingStore(prisma);
    const contract = contractFor(runId);
    await contracts.save({
      tenantId,
      runId,
      contract,
      sha256: hashValidationContract(contract),
      document: "# Validation Contract\n\nVAL-API-001, VAL-API-002",
    });

    const activities = createReviewActivities({
      sandbox,
      runners: new AgentRunnerRegistry([new ScriptedReviewerRunner(() => LYING_REPORT)]),
      executions: new PrismaAgentExecutionRepository(prisma),
      secrets: new MemorySecretStore(),
      redactor: new Redactor(),
      contracts,
      reviewFindings: findings,
      logger,
    });

    try {
      const output: ReviewActivityOutput = await new MockActivityEnvironment().run(
        (input: ReviewActivityInput) => activities.review(input),
        {
          runId,
          tenantId,
          productId: productId,
          runnerName: "claude",
          spriteId: ref.id,
          adapter: ref.adapter,
          workspacePath: ref.workspacePath,
          primaryPath: appPath,
          baseSha,
          goal: contract.goal,
          contextContract: null,
          constraints: [],
          verificationSummary: "Every verification check passed.",
          validationEvidence: ["VAL-API-001: PASS."],
          repositoryInstructions: REVIEW_FIXTURE_RULE,
          timeoutMs: 30_000,
          attempt: 1,
        } satisfies ReviewActivityInput,
      );

      // The agent claim is recorded, and it decides nothing. Factoree's own decision blocks.
      expect(output.verdict).toBe("pass");
      expect(output.passed).toBe(false);
      expect(output.blockingCount).toBe(1);
      expect(output.failures).toEqual([expect.stringContaining("RV-9")]);

      // The persisted row carries both the agent claim and Factoree's own decision.
      const rows = await findings.listForRun(tenantId, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.verdict).toBe("pass");
      expect(rows[0]?.blocking).toBe(true);
      expect(rows[0]?.findingKey).toBe("RV-9");
    } finally {
      await sandbox.destroy(ref);
    }
  }, 120_000);

  it("ends the Run with REVIEW_UNAVAILABLE when the Reviewer writes no report, and starts no repair", async () => {
    const rig = await buildRig("noreport", () => null);

    try {
      await runRig(rig, async (handle) => {
        await handle.result();
      });

      // The real activity read no report from the real review directory.
      expect(rig.reviewOutputs).toHaveLength(1);
      expect(rig.reviewOutputs[0]?.reportUsable).toBe(false);
      expect(rig.reviewOutputs[0]?.reportProblem).toBe("The Reviewer wrote no report.");

      // The Run ended, and the reason is the one SDD section 68 and DI-8.7
      // require. The workflow took that decision itself.
      const completion = rig.harness.completions.find((entry) => entry.runId === rig.runId);
      expect(completion?.status).toBe("FAILED");
      expect(completion?.failureReason).toBe("REVIEW_UNAVAILABLE");

      // No repair started. No REPAIRING status, one Implementer attempt only.
      const statuses = rig.harness.statusCalls.filter((entry) => entry.runId === rig.runId);
      expect(statuses.some((entry) => entry.status === "REPAIRING")).toBe(false);
      expect(rig.implementCalls).toHaveLength(1);

      // An unusable report persists nothing, so no finding row can carry a false result.
      const findingRows = await rig.findings.listForRun(rig.tenantId, rig.runId);
      expect(findingRows).toHaveLength(0);
    } finally {
      await rig.sandbox.destroy(rig.ref);
    }
  }, 300_000);
});
