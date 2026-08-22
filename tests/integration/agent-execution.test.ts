import { describe, expect, it } from "vitest";
import { PrismaAgentExecutionRepository } from "~/persistence/prisma/agent-execution.prisma.js";
import { withDatabase, seedTenantProjectAndRun } from "./support/database.js";

describe("PrismaAgentExecutionRepository", () => {
  it("records an execution and reads it back for the Run", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
      const repository = new PrismaAgentExecutionRepository(prisma);
      await repository.record({
        tenantId,
        runId,
        role: "implementer",
        runner: "opencode",
        model: null,
        sessionRef: "ses_1",
        promptVersion: "implementer/1",
        durationMs: 1_234,
        finalResult: { completed: true, exitCode: 0, cancelled: false, summary: "The change is applied." },
      });
      const rows = await repository.listForRun(tenantId, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.runner).toBe("opencode");
      expect(rows[0]?.finalResult.completed).toBe(true);
    });
  });

  it("does not return an execution that belongs to another tenant (SDD section 52)", async () => {
    await withDatabase(async (prisma) => {
      const first = await seedTenantProjectAndRun(prisma);
      const second = await seedTenantProjectAndRun(prisma);
      const repository = new PrismaAgentExecutionRepository(prisma);
      await repository.record({
        tenantId: first.tenantId,
        runId: first.runId,
        role: "implementer",
        runner: "opencode",
        model: null,
        sessionRef: null,
        promptVersion: "implementer/1",
        durationMs: 1,
        finalResult: { completed: true, exitCode: 0, cancelled: false, summary: "" },
      });
      expect(await repository.listForRun(second.tenantId, first.runId)).toHaveLength(0);
    });
  });
});
