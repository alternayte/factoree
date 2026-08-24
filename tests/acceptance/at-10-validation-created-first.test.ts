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
 * Implementer starts. This test freezes a contract through the real activity, then starts an
 * AgentExecution for the same Run, and orders the two real timestamps a database recorded.
 */
describe("AT-10 — validation created first", () => {
  it("freezes the contract, with a hash and a creation time, before the Implementer starts", async () => {
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

    // The Implementer starts strictly after the freeze finished. Waiting one real millisecond,
    // instead of asserting inside the same tick, makes the ordering genuine.
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

    expect(stored?.createdAt.getTime()).toBeLessThanOrEqual(execution.createdAt.getTime());

    const run = await runs.findById(tenantId, runId);
    expect(run?.validationContractVersion).toBe(stored?.sha256);
  });
});
