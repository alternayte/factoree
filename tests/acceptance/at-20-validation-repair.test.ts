import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import { createValidationActivities } from "~/activities/validation.activities.js";
import type { UserValidateActivityInput, UserValidateActivityOutput } from "~/activities/validation.activities.js";
import { createVerificationActivities } from "~/activities/verification.activities.js";
import type { VerifyActivityInput, VerifyActivityOutput } from "~/activities/verification.activities.js";
import { createEvidencePersistence } from "~/activities/evidence.activities.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import type {
  AgentResumeInput,
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  AgentSessionRef,
} from "~/domain/runs/agent-runner.js";
import { hashValidationContract } from "~/domain/validation/validation-contract.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import type { BrowserDriver } from "~/domain/validation/browser-driver.js";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { PrismaAgentExecutionRepository } from "~/persistence/prisma/agent-execution.prisma.js";
import { PrismaEvidenceStore } from "~/persistence/prisma/evidence.prisma.js";
import { PrismaValidationResultStore } from "~/persistence/prisma/validation-result.prisma.js";
import { PrismaValidationContractStore } from "~/persistence/prisma/validation-contract.prisma.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { FilesystemEvidenceStorage } from "~/adapters/evidence/filesystem-evidence-storage.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { Redactor } from "~/telemetry/redaction.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import { startDatabase, seedTenantProjectAndRun } from "../integration/support/database.js";
import { applyPreviewFixtureNamePersistenceFix, writePreviewFixtureApp } from "./support/preview-fixture-app.js";
import { pickPort, realHttpFetch, realProbe } from "./support/preview-fixture-helpers.js";

const NEW_NAME = "Repaired Project";

/** A BrowserDriver double that fails the test if the http-only contract below ever calls it. */
class UnusedBrowserDriver implements BrowserDriver {
  readonly name = "unused";
  run(): ReturnType<BrowserDriver["run"]> {
    throw new Error("AT-20 holds no browser assertion; the driver must never run.");
  }
}

/** The plan text every attempt gets. It never changes; only the fixture's behaviour changes. */
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

/** A scripted validator runner. It writes the real `plan.json` a live session would leave, then
 * returns a fixed session identity per attempt. */
class ScriptedValidatorRunner implements AgentRunner {
  readonly name = "opencode";
  readonly runs: AgentRunInput[] = [];
  private calls = 0;

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.runs.push(input);
    this.calls += 1;
    await mkdir(input.workingDirectory, { recursive: true });
    await writeFile(join(input.workingDirectory, "plan.json"), planText, "utf8");
    return {
      session: { sessionId: `ses_validator_at20_${this.calls}`, processId: `p${this.calls}`, runner: "opencode" },
      completed: true,
      exitCode: 0,
      cancelled: false,
      summary: "The user validation session is complete.",
      durationMs: 5,
    };
  }

  resume(session: AgentSessionRef, input: AgentResumeInput): Promise<AgentRunResult> {
    void session;
    void input;
    throw new Error("AT-20 never resumes the User Validator session.");
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

const contractFor = (runId: string): ValidationContract => ({
  version: 1,
  runId,
  workItem: "AT-20",
  goal: `An editor can rename the project to "${NEW_NAME}", and the name survives a reload.`,
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

let sandboxRoot: string;

afterEach(async () => {
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

const verifyInputFor = (
  base: Pick<VerifyActivityInput, "runId" | "tenantId" | "projectId" | "spriteId" | "adapter" | "workspacePath" | "primaryPath">,
  attempt: number,
): VerifyActivityInput => ({
  ...base,
  commands: [{ name: "smoke", run: "true" }],
  timeoutMs: 30_000,
  attempt,
});

/**
 * AT-20, SDD section 64: "A build-successful but behaviorally incorrect implementation fails
 * user validation, enters repair, and is fully reverified." A real preview process, a real
 * scripted validator session, and the real database prove the five points of the brief. The
 * fixture builds every time; only the reload behaviour is wrong on the first attempt.
 */
describe("AT-20 — a behaviorally wrong implementation fails validation, repairs, and is fully reverified", () => {
  it("passes verification twice, fails validation once, repairs, and reverifies fully", async () => {
    const { tenantId, projectId, runId } = await seedTenantProjectAndRun(prisma);

    const port = await pickPort();
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-at20-sandbox-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const ref = await sandbox.create({ runId, tenantId, projectId });
    const root = ref.workspacePath;

    // The implementation builds every time; the bug is behavioral only. Attempt 1 runs against
    // the buggy fixture: a save does not survive a reload.
    await writePreviewFixtureApp({ root, persistName: false });

    const contracts = new PrismaValidationContractStore(prisma);
    const runs = new PrismaRunRepository(prisma);
    const executions = new PrismaAgentExecutionRepository(prisma);
    const evidence = new PrismaEvidenceStore(prisma);
    const results = new PrismaValidationResultStore(prisma);
    const redactor = new Redactor();
    const storage = new FilesystemEvidenceStorage({ rootDirectory: join(sandboxRoot, "evidence") });

    const contract = contractFor(runId);
    const sha256 = hashValidationContract(contract);
    const stored = await contracts.save({
      tenantId,
      runId,
      contract,
      sha256,
      document: "# Validation Contract\n\nVAL-API-001, VAL-API-002",
    });
    await runs.setValidationContractVersion(tenantId, runId, stored.sha256);

    const verification = createVerificationActivities({
      sandbox,
      evidence,
      secrets: new MemorySecretStore(),
      redactor,
      logger,
    });

    const validatorRunner = new ScriptedValidatorRunner();
    // The activity forwards only a Project test secret marked for injection into the preview
    // process environment, SDD section 30. The fixture app reads its listen port from `PORT`,
    // so this test states it the same way a Project would state a real test secret.
    const validatorSecrets = new MemorySecretStore({
      PORT: { value: String(port), injectIntoImplementer: true },
    });
    const validation = createValidationActivities({
      contracts,
      runs,
      logger,
      userValidation: {
        sandbox,
        runners: new AgentRunnerRegistry([validatorRunner]),
        executions,
        secrets: validatorSecrets,
        redactor,
        browser: new UnusedBrowserDriver(),
        fetchImpl: realHttpFetch,
        probe: realProbe,
        evidencePersistence: createEvidencePersistence({ evidence, results, storage, logger }),
      },
    });

    const preview = {
      enabled: true,
      command: "node server.cjs",
      readyUrl: `http://127.0.0.1:${port}/health`,
      timeoutSeconds: 30,
    };

    const validateInputFor = (attempt: number): UserValidateActivityInput => ({
      runId,
      tenantId,
      projectId,
      runnerName: "opencode",
      spriteId: ref.id,
      adapter: ref.adapter,
      workspacePath: ref.workspacePath,
      primaryPath: root,
      goal: contract.goal,
      preview,
      timeoutMs: 30_000,
      attempt,
    });

    const activityEnvironment = () => new MockActivityEnvironment();

    try {
      // Point 1. Deterministic verification passes on the first attempt.
      const verify1: VerifyActivityOutput = await activityEnvironment().run(
        (input: VerifyActivityInput) => verification.verify(input),
        verifyInputFor({ runId, tenantId, projectId, spriteId: ref.id, adapter: ref.adapter, workspacePath: ref.workspacePath, primaryPath: root }, 1),
      );
      expect(verify1.passed).toBe(true);

      // Point 2. User validation reports at least one FAIL: the reload never shows the saved
      // name, because the fixture repository still carries the persistence bug.
      const validate1: UserValidateActivityOutput = await activityEnvironment().run(
        (input: UserValidateActivityInput) => validation.userValidate(input),
        validateInputFor(1),
      );
      expect(validate1.hasFailure).toBe(true);
      expect(validate1.results.some((result) => result.result === "FAIL")).toBe(true);

      // Point 3. The Run enters REPAIRING and the repair count reaches 1. Read back from the
      // real database, the same row a real Run's status transition would leave.
      await runs.updateStatus(runId, "REPAIRING", { repairCount: 1 });
      const repaired = await runs.findById(tenantId, runId);
      expect(repaired?.status).toBe("REPAIRING");
      expect(repaired?.repairCount).toBe(1);

      // The repair itself: fixes the one line that made the reload behavior wrong.
      await applyPreviewFixtureNamePersistenceFix(root);

      // Point 4. The second attempt reruns deterministic verification, then user validation,
      // in that order, before any review.
      const verify2: VerifyActivityOutput = await activityEnvironment().run(
        (input: VerifyActivityInput) => verification.verify(input),
        verifyInputFor({ runId, tenantId, projectId, spriteId: ref.id, adapter: ref.adapter, workspacePath: ref.workspacePath, primaryPath: root }, 2),
      );
      expect(verify2.passed).toBe(true);

      const validate2: UserValidateActivityOutput = await activityEnvironment().run(
        (input: UserValidateActivityInput) => validation.userValidate(input),
        validateInputFor(2),
      );

      // Point 5. The second user validation reports every assertion PASS, and the persisted
      // rows hold two attempts. Read the rows from the database, not from the return value.
      expect(validate2.hasFailure).toBe(false);
      expect(validate2.results.every((result) => result.result === "PASS")).toBe(true);

      const resultRows = await results.listForRun(tenantId, runId);
      expect(resultRows).toHaveLength(4);
      const attempt1Rows = resultRows.filter((row) => row.attempt === 1);
      const attempt2Rows = resultRows.filter((row) => row.attempt === 2);
      expect(attempt1Rows).toHaveLength(2);
      expect(attempt2Rows).toHaveLength(2);
      expect(attempt1Rows.some((row) => row.result === "FAIL")).toBe(true);
      expect(attempt2Rows.every((row) => row.result === "PASS")).toBe(true);
    } finally {
      await sandbox.destroy(ref);
    }
  }, 120_000);
});
