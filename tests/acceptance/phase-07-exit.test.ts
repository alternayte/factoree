import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { PlaywrightBrowserDriver } from "~/adapters/browser/playwright/playwright-browser-driver.js";
import { FilesystemEvidenceStorage } from "~/adapters/evidence/filesystem-evidence-storage.js";
import { runUserValidation } from "~/domain/validation/user-validator.js";
import type { UserValidatorDependencies } from "~/domain/validation/user-validator.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import { createEvidencePersistence } from "~/activities/evidence.activities.js";
import { PrismaEvidenceStore } from "~/persistence/prisma/evidence.prisma.js";
import { PrismaValidationResultStore } from "~/persistence/prisma/validation-result.prisma.js";
import { PrismaValidationContractStore } from "~/persistence/prisma/validation-contract.prisma.js";
import { hashValidationContract } from "~/domain/validation/validation-contract.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import { startDatabase, seedTenantProjectAndRun } from "../integration/support/database.js";
import { applyPreviewFixtureNamePersistenceFix, writePreviewFixtureApp } from "./support/preview-fixture-app.js";
import { pickPort, realHttpFetch, realProbe } from "./support/preview-fixture-helpers.js";

const NEW_NAME = "Renamed Project";

const contractFor = (runId: string): ValidationContract => ({
  version: 1,
  runId,
  workItem: "PHASE-07-EXIT",
  goal: "A signed-in editor can rename the project, and the reload keeps the new name.",
  assertions: [
    {
      id: "VAL-UI-001",
      requirement: "AC-1",
      statement: `The project page shows "${NEW_NAME}" after a save and a reload.`,
      method: "browser",
      evidence: ["screenshot", "network", "assertion-log"],
      preconditions: [],
    },
    {
      id: "VAL-API-001",
      requirement: "AC-2",
      statement: "GET /health returns 200.",
      method: "http",
      evidence: ["request-response"],
      preconditions: [],
    },
  ],
});

const planText = JSON.stringify({
  version: 1,
  entries: [
    {
      assertionId: "VAL-UI-001",
      kind: "browser",
      steps: [
        { action: "goto", path: "/" },
        { action: "fill", selector: "#name", value: NEW_NAME },
        { action: "click", selector: "#save" },
        { action: "reload" },
        { action: "expectText", selector: "#current", text: NEW_NAME },
      ],
    },
    {
      assertionId: "VAL-API-001",
      kind: "http",
      request: {
        method: "GET",
        path: "/health",
        headers: {},
        body: null,
        expectStatus: 200,
        expectBodyContains: null,
      },
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

interface Rig {
  sandbox: LocalProcessSandbox;
  ref: Awaited<ReturnType<LocalProcessSandbox["create"]>>;
  port: number;
  root: string;
}

const buildRig = async (name: string, tenantId: string, productId: string, runId: string): Promise<Rig> => {
  const port = await pickPort();
  sandboxRoot = await mkdtemp(join(tmpdir(), `factoree-phase07-${name}-`));
  const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
  const ref = await sandbox.create({ runId, tenantId, productId });
  return { sandbox, ref, port, root: ref.workspacePath };
};

/**
 * Phase 7 exit, SDD section 69: a UI fixture change produces independent acceptance evidence.
 * Real preview process, real exposed URL, real Chromium, real HTTP request, real evidence rows
 * in the real database. The negative half is mandatory: the same validator against the same
 * contract, before the UI change, must report FAIL and must still produce the screenshot.
 */
describe("Phase 7 exit — a UI fixture change produces independent acceptance evidence", () => {
  it("passes, and writes real evidence rows, after the UI fixture change is applied", async () => {
    const { tenantId, productId, runId } = await seedTenantProjectAndRun(prisma);
    const rig = await buildRig("after", tenantId, productId, runId);

    // Step 1 and 2. The fixture repository starts with the bug: a save does not survive a
    // reload. The Implementer-style fix is applied before the validator runs.
    await writePreviewFixtureApp({ root: rig.root, persistName: false });
    await applyPreviewFixtureNamePersistenceFix(rig.root);

    const contracts = new PrismaValidationContractStore(prisma);
    const evidence = new PrismaEvidenceStore(prisma);
    const results = new PrismaValidationResultStore(prisma);
    const redactor = new Redactor();
    const logger = createLogger({ level: "error", redactor, sink: () => undefined });
    const storage = new FilesystemEvidenceStorage({ rootDirectory: join(sandboxRoot, "evidence") });
    const persistence = createEvidencePersistence({ evidence, results, storage, logger });

    // Evidence and result rows carry a real foreign key onto a ValidationAssertion row, so the
    // frozen contract must exist in the database first, the way it always does for a real Run.
    const contract = contractFor(runId);
    const storedContract = await contracts.save({
      tenantId,
      runId,
      contract,
      sha256: hashValidationContract(contract),
      document: "# Validation Contract\n\nVAL-UI-001, VAL-API-001",
    });
    const rowIds = new Map(storedContract.assertions.map((assertion) => [assertion.id, assertion.rowId]));

    const dependencies: UserValidatorDependencies = {
      sandbox: rig.sandbox,
      browser: new PlaywrightBrowserDriver(),
      fetchImpl: realHttpFetch,
      probe: realProbe,
      redactor,
      logger,
    };

    try {
      // Step 3. The real User Validator: real preview process, real exposed URL, real
      // Chromium, real HTTP request.
      const outcome = await runUserValidation(dependencies, {
        runId,
        tenantId,
        ref: rig.ref,
        primaryPath: rig.root,
        contract,
        preview: {
          enabled: true,
          command: "node server.cjs",
          readyUrl: `http://127.0.0.1:${rig.port}/health`,
          timeoutSeconds: 30,
        },
        planText,
        environment: { PORT: String(rig.port) },
        timeoutMs: 30_000,
      });

      expect(outcome.passed).toBe(true);

      for (const assertionOutcome of outcome.outcomes) {
        await persistence.persistAssertionOutcome({
          tenantId,
          runId,
          validationAssertionId: rowIds.get(assertionOutcome.assertionId)!,
          outcome: assertionOutcome,
          attempt: 1,
        });
      }

      const rows = await evidence.listForRun(tenantId, runId);
      const validationRows = rows.filter((row) => row.validationAssertionId !== null);
      expect(validationRows.length).toBeGreaterThanOrEqual(4);
      // SDD section 39. Every artifact records the assertion it answers and the hash of its
      // bytes.
      for (const row of validationRows) {
        expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(row.storageRef).not.toBeNull();
        expect(row.validationAssertionId).not.toBeNull();
      }
      // The evidence is independent: a browser and an HTTP client produced it, not the agent
      // that wrote the change. SDD core principle P-01.
      expect(validationRows.some((row) => row.kind === "screenshot")).toBe(true);
      expect(validationRows.some((row) => row.kind === "request-response")).toBe(true);

      const resultRows = await results.listForRun(tenantId, runId);
      // `Array.every` is true on an empty array. The length check makes a persistence regression
      // that writes no row fail this proof.
      expect(resultRows).toHaveLength(2);
      expect(resultRows.every((row) => row.result === "PASS")).toBe(true);
    } finally {
      await rig.sandbox.destroy(rig.ref);
    }
  }, 90_000);

  it("fails the same contract before the UI fixture change, and still produces the screenshot", async () => {
    const { tenantId, productId, runId } = await seedTenantProjectAndRun(prisma);
    const rig = await buildRig("before", tenantId, productId, runId);

    // The negative half. The fixture repository still carries the bug: a save does not survive
    // a reload.
    await writePreviewFixtureApp({ root: rig.root, persistName: false });

    const dependencies: UserValidatorDependencies = {
      sandbox: rig.sandbox,
      browser: new PlaywrightBrowserDriver(),
      fetchImpl: realHttpFetch,
      probe: realProbe,
      redactor: new Redactor(),
      logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
    };

    try {
      const outcome = await runUserValidation(dependencies, {
        runId,
        tenantId,
        ref: rig.ref,
        primaryPath: rig.root,
        contract: contractFor(runId),
        preview: {
          enabled: true,
          command: "node server.cjs",
          readyUrl: `http://127.0.0.1:${rig.port}/health`,
          timeoutSeconds: 30,
        },
        planText,
        environment: { PORT: String(rig.port) },
        timeoutMs: 30_000,
      });

      expect(outcome.passed).toBe(false);
      const uiOutcome = outcome.outcomes.find((assertionOutcome) => assertionOutcome.assertionId === "VAL-UI-001")!;
      expect(uiOutcome.result).toBe("FAIL");
      // The FAIL must come from the missing UI behavior, not from a preview failure or a
      // transport error. The reason names the expected name the page never showed.
      expect(uiOutcome.reason).toContain(NEW_NAME);
      // The assertion log names the `expectText` step that failed, and no earlier step.
      const assertionLog = uiOutcome.artifacts.find((artifact) => artifact.kind === "assertion-log");
      expect(assertionLog).toBeDefined();
      const loggedSteps = (assertionLog!.metadata as { steps: Array<{ action: string; passed: boolean }> })
        .steps;
      const failedSteps = loggedSteps.filter((step) => !step.passed);
      expect(failedSteps).toHaveLength(1);
      expect(failedSteps[0]!.action).toBe("expectText");
      // A reader can still see what the page showed.
      expect(uiOutcome.artifacts.some((artifact) => artifact.kind === "screenshot")).toBe(true);
    } finally {
      await rig.sandbox.destroy(rig.ref);
    }
  }, 90_000);
});
