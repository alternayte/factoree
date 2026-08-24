import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { buildImplementerInput } from "~/domain/runs/implementer-input.js";
import { VALIDATION_CONTRACT_VERSION } from "~/domain/validation/validation-contract.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaValidationContractStore } from "~/persistence/prisma/validation-contract.prisma.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { startDatabase, seedTenantProjectAndRun } from "../integration/support/database.js";

const STRONG_SHA = "a".repeat(64);
const WEAK_SHA = "b".repeat(64);

const strongContract = (runId: string): ValidationContract => ({
  version: VALIDATION_CONTRACT_VERSION,
  runId,
  workItem: "ENG-201",
  goal: "A signed-in editor can publish a report.",
  assertions: [
    {
      id: "VAL-UI-001",
      requirement: "AC-1",
      statement: "The report page shows a Published banner after publishing.",
      method: "browser",
      evidence: ["screenshot", "network", "assertion-log"],
      preconditions: [],
    },
  ],
});

const weakenedContract = (runId: string): ValidationContract => ({
  version: VALIDATION_CONTRACT_VERSION,
  runId,
  workItem: "ENG-201",
  goal: "A signed-in editor can publish a report.",
  assertions: [
    {
      id: "VAL-MAN-001",
      requirement: "AC-1",
      statement: "A human confirms the report published.",
      method: "manual",
      evidence: ["human-confirmation"],
      preconditions: [],
    },
  ],
});

let database: { url: string; stop: () => Promise<void> };
let prisma: FactoreePrismaClient;
let store: PrismaValidationContractStore;
let runs: PrismaRunRepository;
let tenantId = "";
let runId = "";

beforeAll(async () => {
  database = await startDatabase();
  prisma = createPrismaClient(database.url);
  store = new PrismaValidationContractStore(prisma);
  runs = new PrismaRunRepository(prisma);
  const seeded = await seedTenantProjectAndRun(prisma);
  tenantId = seeded.tenantId;
  runId = seeded.runId;

  await store.save({
    tenantId,
    runId,
    contract: strongContract(runId),
    sha256: STRONG_SHA,
    document: "# Validation Contract\n\nVAL-UI-001 requires a screenshot.\n",
  });
  await runs.setValidationContractVersion(tenantId, runId, STRONG_SHA);
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
  await database.stop();
});

/**
 * AT-11, SDD section 66 and SDD section 25. An Implementer must not alter the active Validation
 * Contract. This test attempts a second `save` that carries a weakened assertion, and expects the
 * store to keep the first, strong contract exactly as it froze.
 */
describe("AT-11 — validation immutability", () => {
  it("keeps the frozen contract when a second save arrives with weaker assertions", async () => {
    const first = await store.findByRun(tenantId, runId);
    expect(first).not.toBeNull();

    const second = await store.save({
      tenantId,
      runId,
      contract: weakenedContract(runId),
      sha256: WEAK_SHA,
      document: "# Validation Contract\n\nVAL-MAN-001 requires only human confirmation.\n",
    });

    expect(second.id).toBe(first?.id);
    expect(second.sha256).toBe(STRONG_SHA);
    expect(second.sha256).not.toBe(WEAK_SHA);
    expect(second.assertions).toEqual(first?.assertions);
    expect(second.assertions).toHaveLength(1);
    expect(second.assertions[0]?.id).toBe("VAL-UI-001");
    expect(second.assertions[0]?.evidence).toEqual(["screenshot", "network", "assertion-log"]);

    const rerouted = await store.findByRun(tenantId, runId);
    expect(rerouted?.id).toBe(first?.id);
    expect(rerouted?.sha256).toBe(STRONG_SHA);
    expect(rerouted?.assertions).toEqual(first?.assertions);
  });

  it("keeps Run.validationContractVersion at the frozen hash", async () => {
    const run = await runs.findById(tenantId, runId);
    expect(run?.validationContractVersion).toBe(STRONG_SHA);
    expect(run?.validationContractVersion).not.toBe(WEAK_SHA);
  });

  it("gives the Implementer no port that can change the contract", () => {
    const base = {
      goal: "Publish the report.",
      humanDecisions: [],
      validationContract: null,
      contextContract: null,
      requiredContext: [],
      primaryRepositoryPath: "/workspace/primary",
      referenceRepositoryPaths: [],
      repositoryInstructions: "",
      skills: [],
      actionPolicy: buildActionPolicy(),
      repairFindings: [],
      projectTestSecrets: {},
    };
    const built = buildImplementerInput({ ...base, validationContract: "VAL-API-001" });

    // The Implementer input is a plain string and a plain environment map. It exposes no
    // function, so it holds no store handle and no client the Implementer could call to alter
    // the contract.
    expect(Object.values(built).every((value) => typeof value !== "function")).toBe(true);
    expect(JSON.stringify(built)).not.toContain("save");
  });
});
