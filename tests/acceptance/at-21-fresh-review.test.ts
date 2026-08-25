import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import { createReviewActivities } from "~/activities/review.activities.js";
import type { ReviewActivityInput, ReviewActivityOutput } from "~/activities/review.activities.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import type {
  AgentResumeInput,
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  AgentSessionRef,
} from "~/domain/runs/agent-runner.js";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { hashValidationContract } from "~/domain/validation/validation-contract.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import { PrismaAgentExecutionRepository } from "~/persistence/prisma/agent-execution.prisma.js";
import { PrismaReviewFindingStore } from "~/persistence/prisma/review-finding.prisma.js";
import { PrismaValidationContractStore } from "~/persistence/prisma/validation-contract.prisma.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { Redactor } from "~/telemetry/redaction.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import { startDatabase, seedTenantProjectAndRun } from "../integration/support/database.js";
import { createFixtureRepository, commitAll, git } from "./support/fixture-repository.js";

/** The exact sentence the real Implementer session leaves behind, and never gives the Reviewer. */
const IMPLEMENTER_SUMMARY = "The change is applied. Every test passes.";

/** A scripted Reviewer runner. It writes a real `report.json`, exactly as a live agent session
 * would leave one, then returns a fixed session identity. `LocalProcessSandbox` uses real host
 * paths, so writing the file with `fs` is exactly what a live process leaves on disk. */
class ScriptedReviewerRunner implements AgentRunner {
  readonly runs: AgentRunInput[] = [];
  constructor(
    readonly name: string,
    private readonly sessionId: string,
    private readonly reportText: string,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.runs.push(input);
    await mkdir(input.workingDirectory, { recursive: true });
    await writeFile(join(input.workingDirectory, "report.json"), this.reportText, "utf8");
    return {
      session: { sessionId: this.sessionId, processId: `process-${this.sessionId}`, runner: this.name },
      completed: true,
      exitCode: 0,
      cancelled: false,
      summary: "The independent review is complete.",
      durationMs: 5,
    };
  }

  resume(session: AgentSessionRef, input: AgentResumeInput): Promise<AgentRunResult> {
    void session;
    void input;
    throw new Error("AT-21 never resumes the Reviewer session.");
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

let database: { url: string; stop: () => Promise<void> };
let prisma: FactoreePrismaClient;

beforeAll(async () => {
  database = await startDatabase();
  prisma = createPrismaClient(database.url);
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
  await database.stop();
});

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

let root: string;
let sandboxRoot: string;

afterEach(async () => {
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
  if (root) await rm(root, { recursive: true, force: true });
});

/**
 * AT-21, SDD section 36 and SDD section 40. The Reviewer uses a fresh context. This file proves
 * it three ways, modelled on AT-17: the session identifiers differ, the persisted
 * `AgentExecution` rows carry both roles with two distinct session references, and the real
 * reviewer prompt holds neither the Implementer's summary text nor its success sentence. It
 * also proves the SDD section 40 input list really reaches the Reviewer: `RefineActivityOutput`
 * constraints, the deterministic verification summary, and the user-validation evidence all
 * appear in the captured prompt the double received.
 */
describe("AT-21 — the Reviewer session is fresh", () => {
  it("differs from the Implementer session, in the persisted rows, in the prompt text, and carries the SDD section 40 input list", async () => {
    const { tenantId, projectId, runId } = await seedTenantProjectAndRun(prisma);

    root = await mkdtemp(join(tmpdir(), "factoree-at21-repo-"));
    const primary = await createFixtureRepository(root, "app");
    const baseSha = (await git(primary, ["rev-parse", "HEAD"])).trim();

    // A real change against the base SHA, the way a real Implementer session leaves one.
    await writeFile(join(primary, "src-auth.ts"), "export const authorize = () => true;\n", "utf8");
    await commitAll(primary, "add authorize");

    const contracts = new PrismaValidationContractStore(prisma);
    const executions = new PrismaAgentExecutionRepository(prisma);
    const findings = new PrismaReviewFindingStore(prisma);
    const redactor = new Redactor();

    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-at21-sandbox-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const ref = await sandbox.create({ runId, tenantId, projectId });

    const contract: ValidationContract = {
      version: 1,
      runId,
      workItem: "AT-21",
      goal: "An expired token is rejected.",
      assertions: [
        {
          id: "VAL-API-001",
          requirement: "AC-1",
          statement: "An expired token gets a 401.",
          method: "http",
          evidence: ["request-response"],
          preconditions: [],
        },
      ],
    };
    const sha256 = hashValidationContract(contract);
    const document = "# Validation Contract\n\nVAL-API-001";
    await contracts.save({ tenantId, runId, contract, sha256, document });

    // The Implementer's own session and its success claim. As in AT-17, this test writes the
    // row directly: the point under test is that the path below never reaches it.
    await executions.record({
      tenantId,
      runId,
      role: "implementer",
      runner: "opencode",
      model: null,
      sessionRef: "ses_implementer_at21",
      promptVersion: "implementer/1",
      durationMs: 5,
      finalResult: { completed: true, exitCode: 0, cancelled: false, summary: IMPLEMENTER_SUMMARY },
      idempotencyKey: `${runId}:implementer:attempt-1`,
    });

    const passReport = JSON.stringify({ version: 1, verdict: "pass", findings: [] });
    const reviewerRunner = new ScriptedReviewerRunner("opencode", "ses_reviewer_at21", passReport);

    const activities = createReviewActivities({
      sandbox,
      runners: new AgentRunnerRegistry([reviewerRunner]),
      executions,
      secrets: new MemorySecretStore(),
      redactor,
      contracts,
      reviewFindings: findings,
      logger,
    });

    // The controller-required input list: the SDD section 40 input the Reviewer must receive.
    const constraints = ["Do not remove the retry of the delivery worker."];
    const verificationSummary = "Every verification check passed. unit: exit 0.";
    const validationEvidence = ["VAL-API-001: PASS. GET /health answered 200."];

    const input: ReviewActivityInput = {
      runId,
      tenantId,
      projectId,
      runnerName: "opencode",
      spriteId: ref.id,
      adapter: ref.adapter,
      workspacePath: ref.workspacePath,
      primaryPath: primary,
      baseSha,
      goal: contract.goal,
      contextContract: null,
      constraints,
      verificationSummary,
      validationEvidence,
      repositoryInstructions: "Use the existing test idiom.",
      timeoutMs: 30_000,
      attempt: 1,
    };

    // The stronger statement: the activity input type carries no field that could hold an
    // Implementer transcript or an Implementer summary.
    expect(Object.keys(input)).not.toContain("implementerSummary");
    expect(Object.keys(input)).not.toContain("implementerTranscript");

    const environment = new MockActivityEnvironment();
    const output: ReviewActivityOutput = await environment.run(
      (activityInput: ReviewActivityInput) => activities.review(activityInput),
      input,
    );

    try {
      expect(output.reportUsable).toBe(true);
      expect(output.sessionId).toBe("ses_reviewer_at21");
      expect(output.sessionId).not.toBe("ses_implementer_at21");

      const rows = await executions.listForRun(tenantId, runId);
      expect(rows.map((row) => row.role).sort()).toEqual(["implementer", "reviewer"]);
      expect(new Set(rows.map((row) => row.sessionRef)).size).toBe(2);

      const reviewerRow = rows.find((row) => row.role === "reviewer");
      expect(reviewerRow?.sessionRef).toBe("ses_reviewer_at21");
      const implementerRow = rows.find((row) => row.role === "implementer");
      expect(implementerRow?.sessionRef).toBe("ses_implementer_at21");

      expect(reviewerRunner.runs).toHaveLength(1);
      const prompt = reviewerRunner.runs[0]?.prompt ?? "";
      expect(prompt).not.toContain(IMPLEMENTER_SUMMARY);
      expect(prompt).not.toContain("ses_implementer_at21");

      // The controller's extra assertion: the constraints, the verification summary, and the
      // user-validation evidence of SDD section 40 really reach the Reviewer's own prompt, not
      // merely the activity input.
      expect(prompt).toContain(constraints[0]);
      expect(prompt).toContain(verificationSummary);
      expect(prompt).toContain(validationEvidence[0]);
    } finally {
      await sandbox.destroy(ref);
    }
  }, 60_000);
});
