import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { summarizeUserValidation } from "~/domain/validation/validation-result.js";
import type { AssertionOutcome } from "~/domain/validation/validation-result.js";
import { hashValidationContract } from "~/domain/validation/validation-contract.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import { createEvidencePersistence } from "~/activities/evidence.activities.js";
import { PrismaEvidenceStore } from "~/persistence/prisma/evidence.prisma.js";
import { PrismaValidationResultStore } from "~/persistence/prisma/validation-result.prisma.js";
import { PrismaValidationContractStore } from "~/persistence/prisma/validation-contract.prisma.js";
import { FilesystemEvidenceStorage } from "~/adapters/evidence/filesystem-evidence-storage.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { startDatabase, seedTenantProjectAndRun } from "../integration/support/database.js";

const outcome = (
  assertionId: string,
  result: AssertionOutcome["result"],
  overrides: Partial<AssertionOutcome> = {},
): AssertionOutcome => ({
  assertionId,
  method: "http",
  result,
  reason: `${assertionId} reported ${result}.`,
  artifacts: [],
  ...overrides,
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

/**
 * AT-25, SDD section 36. Every assertion must be PASS before the Run can proceed. The first
 * four cases prove the gate itself, `summarizeUserValidation`, the one function every path to
 * `passed` runs through. The last case runs against the real database, so the gate and the
 * persisted result rows cannot disagree.
 */
describe("AT-25 — every assertion is PASS before the Run can proceed", () => {
  it("a Run with one FAIL does not pass user validation", () => {
    const summary = summarizeUserValidation([outcome("VAL-UI-001", "PASS"), outcome("VAL-API-001", "FAIL")]);
    expect(summary.passed).toBe(false);
  });

  it("a Run with one MANUAL_REQUIRED does not pass user validation", () => {
    const summary = summarizeUserValidation([
      outcome("VAL-UI-001", "PASS"),
      outcome("VAL-API-001", "MANUAL_REQUIRED"),
    ]);
    expect(summary.passed).toBe(false);
  });

  it("a Run with one BLOCKED does not pass user validation", () => {
    const summary = summarizeUserValidation([outcome("VAL-UI-001", "PASS"), outcome("VAL-API-001", "BLOCKED")]);
    expect(summary.passed).toBe(false);
  });

  it("a Run passes only when every assertion is PASS", () => {
    const summary = summarizeUserValidation([outcome("VAL-UI-001", "PASS"), outcome("VAL-API-001", "PASS")]);
    expect(summary.passed).toBe(true);
  });

  it("an empty outcome list is not a pass; it proves nothing", () => {
    const summary = summarizeUserValidation([]);
    expect(summary.passed).toBe(false);
  });

  it("the persisted result rows match the reported results, against the real database", async () => {
    const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
    const contracts = new PrismaValidationContractStore(prisma);
    const evidence = new PrismaEvidenceStore(prisma);
    const results = new PrismaValidationResultStore(prisma);
    const redactor = new Redactor();
    const storage = new FilesystemEvidenceStorage({ rootDirectory: `/tmp/factoree-at25-${runId}` });
    const logger = createLogger({ level: "error", redactor, sink: () => undefined });
    const persistence = createEvidencePersistence({ evidence, results, storage, logger });

    // AT-25's last case runs against real Evidence and ValidationAssertionResult rows, and
    // each carries a real foreign key onto its ValidationAssertion row. A contract must exist
    // first, the way the frozen contract of a real Run always does.
    const contract: ValidationContract = {
      version: 1,
      runId,
      workItem: "AT-25",
      goal: "Every assertion passes.",
      assertions: [
        {
          id: "VAL-UI-001",
          requirement: "AC-1",
          statement: "The page shows the expected state.",
          method: "browser",
          evidence: ["screenshot"],
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
    };
    const sha256 = hashValidationContract(contract);
    const stored = await contracts.save({
      tenantId,
      runId,
      contract,
      sha256,
      document: "# Validation Contract\n\nVAL-UI-001, VAL-API-001",
    });

    const outcomes: AssertionOutcome[] = [
      outcome("VAL-UI-001", "PASS", {
        method: "browser",
        artifacts: [
          {
            kind: "screenshot",
            source: "browser:VAL-UI-001:screenshot",
            contentType: "image/png",
            bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            metadata: {},
          },
        ],
      }),
      outcome("VAL-API-001", "PASS", { method: "http" }),
    ];

    const rowIds = new Map(stored.assertions.map((assertion) => [assertion.id, assertion.rowId]));

    for (const assertionOutcome of outcomes) {
      await persistence.persistAssertionOutcome({
        tenantId,
        runId,
        validationAssertionId: rowIds.get(assertionOutcome.assertionId)!,
        outcome: assertionOutcome,
        attempt: 1,
      });
    }

    const summary = summarizeUserValidation(outcomes);
    expect(summary.passed).toBe(true);

    const rows = await results.listForRun(tenantId, runId);
    const reported = outcomes
      .map((assertionOutcome) => `${assertionOutcome.assertionId}:${assertionOutcome.result}`)
      .sort();
    const persisted = rows.map((row) => `${row.assertionKey}:${row.result}`).sort();
    expect(persisted).toEqual(reported);

    // The gate and the record must not be able to disagree: every persisted row is PASS exactly
    // when the summary the same outcomes produce is `passed`.
    expect(rows.every((row) => row.result === "PASS")).toBe(summary.passed);
  });
});
