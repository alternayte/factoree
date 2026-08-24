import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaValidationContractStore } from "~/persistence/prisma/validation-contract.prisma.js";
import { VALIDATION_CONTRACT_VERSION } from "~/domain/validation/validation-contract.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { startDatabase, seedTenantProjectAndRun } from "./support/database.js";

const FIRST_SHA256 = "d".repeat(64);

let database: { url: string; stop: () => Promise<void> };
let prisma: FactoreePrismaClient;
let store: PrismaValidationContractStore;
let tenantId = "";
let runId = "";
let otherTenantId = "";

const contractOf = (runId: string): ValidationContract => ({
  version: VALIDATION_CONTRACT_VERSION,
  runId,
  workItem: "ENG-143",
  goal: "A signed-in editor can rename a project.",
  assertions: [
    {
      id: "VAL-API-001",
      requirement: "AC-2",
      statement: "PATCH /projects/{id} returns 403 for a user without edit permission.",
      method: "http",
      evidence: ["request-response"],
      preconditions: ["a project the user cannot edit"],
    },
  ],
});

beforeAll(async () => {
  database = await startDatabase();
  prisma = createPrismaClient(database.url);
  store = new PrismaValidationContractStore(prisma);
  const seeded = await seedTenantProjectAndRun(prisma);
  tenantId = seeded.tenantId;
  runId = seeded.runId;
  const other = await seedTenantProjectAndRun(prisma);
  otherTenantId = other.tenantId;
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
  await database.stop();
});

describe("PrismaValidationContractStore", () => {
  it("stores a contract with every assertion field and reads it back", async () => {
    const value = contractOf(runId);
    const stored = await store.save({
      tenantId,
      runId,
      contract: value,
      sha256: FIRST_SHA256,
      document: "# Validation Contract\n",
    });
    expect(stored.version).toBe(1);
    expect(stored.sha256).toBe(FIRST_SHA256);
    expect(stored.workItem).toBe("ENG-143");
    expect(stored.goal).toBe(value.goal);
    expect(stored.assertions).toHaveLength(1);

    const found = await store.findByRun(tenantId, runId);
    expect(found?.assertions[0]).toEqual(value.assertions[0]);
    expect(found?.document).toBe("# Validation Contract\n");
    expect(found?.tenantId).toBe(tenantId);
    expect(found?.runId).toBe(runId);
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  it("is idempotent, so a retry returns the contract already frozen", async () => {
    const again = await store.save({
      tenantId,
      runId,
      contract: { ...contractOf(runId), goal: "A different goal." },
      sha256: "e".repeat(64),
      document: "# Different\n",
    });
    expect(again.sha256).toBe(FIRST_SHA256);
    expect(again.document).toBe("# Validation Contract\n");
    expect(await prisma.validationContract.count({ where: { runId } })).toBe(1);
  });

  it("answers null for another tenant, because SDD section 52 scopes every read", async () => {
    await expect(store.findByRun(otherTenantId, runId)).resolves.toBeNull();
  });

  it("rejects a row whose method column holds a value the SDD does not allow", async () => {
    await prisma.validationAssertion.updateMany({
      where: { assertionKey: "VAL-API-001" },
      data: { method: "telepathy" },
    });
    await expect(store.findByRun(tenantId, runId)).rejects.toThrow(/unknown method/);
    await prisma.validationAssertion.updateMany({
      where: { assertionKey: "VAL-API-001" },
      data: { method: "http" },
    });
  });
});
