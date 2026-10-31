import { describe, expect, it } from "vitest";
import { PrismaAgentSessionStore } from "~/persistence/prisma/agent-session.prisma.js";
import type { RecordAgentSessionInput } from "~/domain/runs/agent-session.js";
import { withDatabase, seedTenantProjectAndRun } from "./support/database.js";

const session = (tenantId: string, runId: string, overrides: Partial<RecordAgentSessionInput> = {}): RecordAgentSessionInput => ({
  tenantId,
  runId,
  role: "implementer",
  attempt: 1,
  runner: "opencode",
  cliSessionId: "ses_1",
  model: "deepseek/deepseek-flash",
  effort: "max",
  usage: {
    inputTokens: 1_200,
    outputTokens: 3_400,
    reasoningTokens: 900,
    cacheReadTokens: 50_000,
    cacheWriteTokens: 0,
    costUsd: 0.4213,
    turns: 12,
    longestTurnMs: 95_000,
  },
  durationMs: 600_000,
  outcome: "finished",
  idempotencyKey: `run:${runId}:implementer:1`,
  ...overrides,
});

/** docs/specs/agent-session-usage-and-hangs.md. The `AgentSession` table. */
describe("PrismaAgentSessionStore", () => {
  it("records a session and reads it back for the Run", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
      const store = new PrismaAgentSessionStore(prisma);
      await store.record(session(tenantId, runId));
      const rows = await store.listForRun(tenantId, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ role: "implementer", outcome: "finished", cliSessionId: "ses_1", effort: "max" });
      expect(rows[0]?.usage).toEqual(session(tenantId, runId).usage);
    });
  });

  it("answers the operator query of the spec in plain SQL", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
      await new PrismaAgentSessionStore(prisma).record(session(tenantId, runId));
      const rows = await prisma.$queryRaw<Array<{ role: string; outcome: string; cost_usd: number; turns: number; longest_turn_ms: number }>>`
        select role, outcome, cost_usd, turns, longest_turn_ms from "AgentSession" where run_id = ${runId}
      `;
      expect(rows).toEqual([{ role: "implementer", outcome: "finished", cost_usd: 0.4213, turns: 12, longest_turn_ms: 95_000 }]);
    });
  });

  it("stores a session with no usage record as null usage", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
      const store = new PrismaAgentSessionStore(prisma);
      await store.record(session(tenantId, runId, { usage: null, outcome: "hung", cliSessionId: null }));
      const [row] = await store.listForRun(tenantId, runId);
      expect(row?.usage).toBeNull();
      expect(row?.outcome).toBe("hung");
    });
  });

  it("writes one row for a retried activity with the same key", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
      const store = new PrismaAgentSessionStore(prisma);
      await store.record(session(tenantId, runId));
      await store.record(session(tenantId, runId));
      await store.record(session(tenantId, runId, { attempt: 2, idempotencyKey: `run:${runId}:implementer:2` }));
      expect(await store.listForRun(tenantId, runId)).toHaveLength(2);
    });
  });

  it("does not return a session that belongs to another tenant (SDD section 52)", async () => {
    await withDatabase(async (prisma) => {
      const first = await seedTenantProjectAndRun(prisma);
      const second = await seedTenantProjectAndRun(prisma);
      const store = new PrismaAgentSessionStore(prisma);
      await store.record(session(first.tenantId, first.runId));
      expect(await store.listForRun(second.tenantId, first.runId)).toEqual([]);
    });
  });
});
