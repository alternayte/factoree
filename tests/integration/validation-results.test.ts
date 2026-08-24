import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaValidationResultStore } from "~/persistence/prisma/validation-result.prisma.js";
import { PrismaValidationContractStore } from "~/persistence/prisma/validation-contract.prisma.js";
import { VALIDATION_CONTRACT_VERSION } from "~/domain/validation/validation-contract.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { startDatabase, seedTenantProjectAndRun } from "./support/database.js";

let database: { url: string; stop: () => Promise<void> };
let prisma: FactoreePrismaClient;
let results: PrismaValidationResultStore;
let tenantId = "";
let runId = "";
let validationAssertionId = "";

beforeAll(async () => {
  database = await startDatabase();
  prisma = createPrismaClient(database.url);
  results = new PrismaValidationResultStore(prisma);
  const seeded = await seedTenantProjectAndRun(prisma);
  tenantId = seeded.tenantId;
  runId = seeded.runId;

  const contract: ValidationContract = {
    version: VALIDATION_CONTRACT_VERSION,
    runId,
    workItem: "ENG-143",
    goal: "A signed-in editor can rename a project.",
    assertions: [
      {
        id: "VAL-UI-001",
        requirement: "AC-1",
        statement: "The page shows the new name after a reload.",
        method: "browser",
        evidence: ["screenshot"],
        preconditions: [],
      },
    ],
  };
  const contractStore = new PrismaValidationContractStore(prisma);
  const stored = await contractStore.save({
    tenantId,
    runId,
    contract,
    sha256: "d".repeat(64),
    document: "# Validation Contract\n",
  });
  const first = stored.assertions[0];
  if (!first) throw new Error("test setup wrote no assertion");
  validationAssertionId = first.rowId;
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
  await database.stop();
});

describe("PrismaValidationResultStore", () => {
  const baseInput = () => ({
    tenantId,
    runId,
    validationAssertionId,
    assertionKey: "VAL-UI-001",
  });

  it("records one result per assertion and per attempt", async () => {
    const input = baseInput();
    const first = await results.record({
      ...input,
      result: "FAIL",
      reason: "the text did not match",
      attempt: 1,
    });
    const repeat = await results.record({
      ...input,
      result: "PASS",
      reason: "a later claim",
      attempt: 1,
    });

    // SDD section 39. The row is immutable. The second call returns the first row unchanged.
    expect(repeat.id).toBe(first.id);
    expect(repeat.result).toBe("FAIL");

    const second = await results.record({
      ...input,
      result: "PASS",
      reason: "the repair worked",
      attempt: 2,
    });
    expect(second.id).not.toBe(first.id);

    const all = await results.listForRun(tenantId, runId);
    expect(all.map((row) => row.attempt)).toEqual([1, 2]);
  });

  it("reports no result to another tenant", async () => {
    expect(await results.listForRun("other-tenant", runId)).toEqual([]);
  });
});
