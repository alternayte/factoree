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
 * AT-10, SDD section 66. This file holds the PERSISTENCE half of AT-10: a frozen Validation
 * Contract carries a creation time and a SHA-256 hash, and the Run row carries that same hash.
 * It does not, and cannot, prove the ORDER in which a real Run freezes the contract relative to
 * starting the Implementer, because a test that writes both rows itself decides that order by
 * construction. `tests/workflow/validation-contract.workflow.test.ts`, the test named
 * "AT-10 — the Validation Contract is frozen and its hash reaches the Run before the
 * Implementer starts", holds the ordering half: it drives the real workflow and reads the order
 * from activity recordings the test itself never sequences.
 */
describe("AT-10 — validation created first", () => {
  it("freezes a contract with a creation time and a hash, and the Run row carries that hash", async () => {
    const { tenantId, productId, runId } = await seedTenantProjectAndRun(prisma);
    const contracts = new PrismaValidationContractStore(prisma);
    const runs = new PrismaRunRepository(prisma);
    const executions = new PrismaAgentExecutionRepository(prisma);
    const activities = createValidationActivities({ contracts, runs, logger });

    const built = await activities.buildValidationContract({
      runId,
      tenantId,
      productId: productId,
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
    expect(stored?.createdAt).toBeInstanceOf(Date);
    expect(stored?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const run = await runs.findById(tenantId, runId);
    expect(run?.validationContractVersion).toBe(stored?.sha256);

    // This records an AgentExecution for the same Run and re-reads the same state. It shows the
    // hash still holds at that later point, which is real, but it is not an ordering proof: this
    // test wrote the freeze and then wrote the execution itself, in the order it chose, so
    // nothing here decides that order the way the real workflow does.
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

    const runAfterExecution = await runs.findById(tenantId, runId);
    expect(runAfterExecution?.validationContractVersion).toBe(stored?.sha256);
  });

  it("carries no Validation Contract hash for a Run whose contract was never frozen", async () => {
    // The companion case: a Run that skipped the freeze step shows no hash and no stored
    // contract, the state the positive case above rules out.
    const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
    const contracts = new PrismaValidationContractStore(prisma);
    const runs = new PrismaRunRepository(prisma);

    const run = await runs.findById(tenantId, runId);
    expect(run?.validationContractVersion).toBeNull();
    const stored = await contracts.findByRun(tenantId, runId);
    expect(stored).toBeNull();
  });
});
