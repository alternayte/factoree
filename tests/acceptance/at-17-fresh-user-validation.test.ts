import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import { createValidationActivities } from "~/activities/validation.activities.js";
import type { UserValidateActivityInput, UserValidateActivityOutput } from "~/activities/validation.activities.js";
import { createEvidencePersistence } from "~/activities/evidence.activities.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
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
import { FakeRunner } from "../support/fake-runner.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import { startDatabase, seedTenantProjectAndRun } from "../integration/support/database.js";
import { MemoryAgentSessionStore } from "../support/memory-agent-session-store.js";

/** The exact sentence the real Implementer session leaves behind, and never gives the validator. */
const IMPLEMENTER_SUMMARY = "The change is applied.";

/** A BrowserDriver double that fails the test if this command-only contract ever calls it. */
class UnusedBrowserDriver implements BrowserDriver {
  signIn = (): Promise<never> => Promise.reject(new Error("this fake signs in no account"));
  readonly name = "unused";
  run(): ReturnType<BrowserDriver["run"]> {
    throw new Error("AT-17 holds no browser assertion; the driver must never run.");
  }
}

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

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

/**
 * AT-17, SDD section 36. The User Validator uses a fresh context. This file proves it three
 * ways: the session identifiers differ, the persisted AgentExecution rows carry both roles with
 * two distinct session references, and the prompt text holds neither the Implementer's summary
 * nor its success sentence.
 */
describe("AT-17 — the User Validator session is fresh", () => {
  it("differs from the Implementer session, in the persisted rows and in the prompt text", async () => {
    const { tenantId, productId, runId } = await seedTenantProjectAndRun(prisma);

    const contracts = new PrismaValidationContractStore(prisma);
    const runs = new PrismaRunRepository(prisma);
    const executions = new PrismaAgentExecutionRepository(prisma);
    const evidence = new PrismaEvidenceStore(prisma);
    const results = new PrismaValidationResultStore(prisma);
    const redactor = new Redactor();
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-at17-sandbox-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const storage = new FilesystemEvidenceStorage({ rootDirectory: join(sandboxRoot, "evidence") });

    const contract: ValidationContract = {
      version: 1,
      runId,
      workItem: "AT-17",
      goal: "A signed-in user can rename a project.",
      assertions: [
        {
          id: "VAL-CMD-001",
          requirement: "AC-1",
          statement: "The verification command exits 0.",
          method: "command",
          evidence: ["command-output"],
          preconditions: [],
        },
      ],
    };
    const sha256 = hashValidationContract(contract);
    const document = "# Validation Contract\n\nVAL-CMD-001";
    const stored = await contracts.save({ tenantId, runId, contract, sha256, document });
    await runs.setValidationContractVersion(tenantId, runId, stored.sha256);

    // The Implementer's own session and its success claim. The real path to this row is
    // `implement.activities.ts`; this test writes it directly, the way `at-10` does, because a
    // second real agent session is not this test's concern. What matters is that the validator
    // path built below never sees this row's summary and receives its own distinct session.
    await executions.record({
      tenantId,
      runId,
      role: "implementer",
      runner: "opencode",
      model: null,
      sessionRef: "ses_implementer_at17",
      promptVersion: "implementer/1",
      durationMs: 5,
      finalResult: { completed: true, exitCode: 0, cancelled: false, summary: IMPLEMENTER_SUMMARY },
      idempotencyKey: `${runId}:implementer:attempt-1`,
    });

    const validatorRunner = new FakeRunner("opencode", {
      session: { sessionId: "ses_validator_at17", processId: "process-validator-at17", runner: "opencode" },
    });

    const activities = createValidationActivities({
      contracts,
      runs,
      logger,
      userValidation: {
        sandbox,
        runners: new AgentRunnerRegistry([validatorRunner]),
        sessions: new MemoryAgentSessionStore(),
        executions,
        secrets: new MemorySecretStore(),
        redactor,
        browser: new UnusedBrowserDriver(),
        fetchImpl: () => {
          throw new Error("AT-17 holds no http assertion; fetchImpl must never run.");
        },
        probe: () => {
          throw new Error("AT-17 holds no preview; probe must never run.");
        },
        evidencePersistence: createEvidencePersistence({ evidence, results, storage, logger }),
      },
    });

    const ref = await sandbox.create({ runId, tenantId, productId: productId });
    const input: UserValidateActivityInput = {
      runId,
      tenantId,
      productId: productId,
      runnerName: "opencode",
      spriteId: ref.id,
      adapter: ref.adapter,
      workspacePath: ref.workspacePath,
      primaryPath: ref.workspacePath,
      goal: contract.goal,
      preview: null,
      timeoutMs: 30_000,
      attempt: 1,
    };

    // The stronger statement: the activity input type carries no field that could hold an
    // Implementer transcript or an Implementer summary.
    expect(Object.keys(input)).not.toContain("implementerSummary");
    expect(Object.keys(input)).not.toContain("implementerTranscript");

    const environment = new MockActivityEnvironment();
    const output: UserValidateActivityOutput = await environment.run(
      (activityInput: UserValidateActivityInput) => activities.userValidate(activityInput),
      input,
    );

    try {
      expect(output.sessionId).toBe("ses_validator_at17");
      expect(output.sessionId).not.toBe("ses_implementer_at17");

      const rows = await executions.listForRun(tenantId, runId);
      expect(rows.map((row) => row.role).sort()).toEqual(["implementer", "validator"]);
      expect(new Set(rows.map((row) => row.sessionRef)).size).toBe(2);

      const validatorRow = rows.find((row) => row.role === "validator");
      expect(validatorRow?.sessionRef).toBe("ses_validator_at17");
      const implementerRow = rows.find((row) => row.role === "implementer");
      expect(implementerRow?.sessionRef).toBe("ses_implementer_at17");

      const validatorCall = validatorRunner.runs.find((call) => call.role === "validator");
      expect(validatorCall).toBeDefined();
      expect(validatorCall!.prompt).not.toContain(IMPLEMENTER_SUMMARY);
      expect(validatorCall!.prompt).not.toContain("ses_implementer_at17");
    } finally {
      await sandbox.destroy(ref);
    }
  }, 60_000);
});
