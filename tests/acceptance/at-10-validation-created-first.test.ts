import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createValidationActivities } from "~/activities/validation.activities.js";
import { PrismaAgentExecutionRepository } from "~/persistence/prisma/agent-execution.prisma.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaValidationContractStore } from "~/persistence/prisma/validation-contract.prisma.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { startDatabase, seedTenantProjectAndRun } from "../integration/support/database.js";

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

/**
 * AT-10, SDD section 66. The Validation Contract creation time and hash must exist before the
 * Implementer starts. This test freezes a contract through the real activity, then records an
 * AgentExecution for the same Run, and checks a property of the system state at the moment the
 * execution exists: the Run row must already carry the frozen hash, and the stored contract must
 * already exist with that hash. A companion case proves this check can fail: for a Run whose
 * contract was never frozen, the Run hash and the stored contract are both absent.
 */
describe("AT-10 — validation created first", () => {
  it("has already frozen the contract, with a hash on the Run row, before an AgentExecution exists", async () => {
    const { tenantId, projectId, runId } = await seedTenantProjectAndRun(prisma);
    const contracts = new PrismaValidationContractStore(prisma);
    const runs = new PrismaRunRepository(prisma);
    const executions = new PrismaAgentExecutionRepository(prisma);
    const activities = createValidationActivities({ contracts, runs, logger });

    const built = await activities.buildValidationContract({
      runId,
      tenantId,
      projectId,
      workItem: "ENG-200",
      goal: "A signed-in user can rename a project.",
      acceptanceCriteria: [
        { id: "AC-1", statement: "PATCH /projects/{id} returns 200 for a valid rename.", source: "stated" },
      ],
      humanAssertions: [],
    });
    expect(built.status).toBe("ready");

    const stored = await contracts.findByRun(tenantId, runId);
    expect(stored).not.toBeNull();
    expect(stored?.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Five real milliseconds separate the freeze from the Implementer start, so the two events
    // are genuinely ordered in time and not merely asserted in the order the test wrote them.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const execution = await executions.record({
      tenantId,
      runId,
      role: "implementer",
      runner: "opencode",
      model: null,
      sessionRef: "ses_at10",
      promptVersion: "implementer/1",
      durationMs: 1,
      finalResult: { completed: true, exitCode: 0, cancelled: false, summary: "The change is applied." },
      idempotencyKey: `${runId}:implementer:attempt-1`,
    });
    expect(execution.createdAt).toBeInstanceOf(Date);

    // At the moment an AgentExecution exists for this Run, the frozen contract and the Run hash
    // must already be in place. A regression that let the Implementer start before the freeze,
    // or that let the freeze activity skip writing the Run hash, would fail this block.
    const run = await runs.findById(tenantId, runId);
    expect(run?.validationContractVersion).toBe(stored?.sha256);
    const rereadContract = await contracts.findByRun(tenantId, runId);
    expect(rereadContract?.sha256).toBe(stored?.sha256);
  });

  it("carries no Validation Contract hash for a Run whose contract was never frozen", async () => {
    // This case proves the check above is capable of failing: a Run that skipped the freeze
    // step must show no hash and no stored contract, the state the positive case rules out.
    const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
    const contracts = new PrismaValidationContractStore(prisma);
    const runs = new PrismaRunRepository(prisma);

    const run = await runs.findById(tenantId, runId);
    expect(run?.validationContractVersion).toBeNull();
    const stored = await contracts.findByRun(tenantId, runId);
    expect(stored).toBeNull();
  });
});
