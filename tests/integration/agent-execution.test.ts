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
        idempotencyKey: "run-1:implementer:attempt-1",
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
        idempotencyKey: "run-2:implementer:attempt-1",
      });
      expect(await repository.listForRun(second.tenantId, first.runId)).toHaveLength(0);
    });
  });

  it("records once when a retried activity calls record twice with the same key", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
      const repository = new PrismaAgentExecutionRepository(prisma);
      const attempt = {
        tenantId,
        runId,
        role: "implementer" as const,
        runner: "opencode",
        model: null,
        sessionRef: "ses_1",
        promptVersion: "implementer/1",
        durationMs: 1_234,
        finalResult: { completed: true, exitCode: 0, cancelled: false, summary: "The change is applied." },
        idempotencyKey: "run-3:implementer:attempt-1",
      };
      const first = await repository.record(attempt);
      const second = await repository.record(attempt);
      expect(second.id).toBe(first.id);
      expect(await repository.listForRun(tenantId, runId)).toHaveLength(1);
    });
  });

  it("records two rows for two distinct attempts of the same Run and role", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
      const repository = new PrismaAgentExecutionRepository(prisma);
      const base = {
        tenantId,
        runId,
        role: "implementer" as const,
        runner: "opencode",
        model: null,
        sessionRef: null,
        promptVersion: "implementer/1",
        durationMs: 1,
        finalResult: { completed: true, exitCode: 0, cancelled: false, summary: "" },
      };
      await repository.record({ ...base, idempotencyKey: "run-4:implementer:attempt-1" });
      await repository.record({ ...base, idempotencyKey: "run-4:implementer:attempt-2" });
      expect(await repository.listForRun(tenantId, runId)).toHaveLength(2);
    });
  });
});
