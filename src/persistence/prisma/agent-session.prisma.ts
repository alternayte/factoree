import type { PrismaClient } from "@prisma/client";
import type {
  AgentSessionOutcome,
  AgentSessionRecord,
  AgentSessionRole,
  AgentSessionStore,
  ProductAgentSessionReader,
  RecordAgentSessionInput,
} from "~/domain/runs/agent-session.js";

/** docs/specs/agent-session-usage-and-hangs.md. The `AgentSession` table. */
export class PrismaAgentSessionStore implements AgentSessionStore, ProductAgentSessionReader {
  constructor(private readonly prisma: PrismaClient) {}

  async record(input: RecordAgentSessionInput): Promise<AgentSessionRecord> {
    // A retried Temporal activity records the same session again with the same key. The unique
    // constraint on (tenant, key) makes the write collide, and the upsert returns the row that
    // already exists rather than creating a second one.
    const usage = input.usage;
    const row = await this.prisma.agentSession.upsert({
      where: { tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey } },
      update: {},
      create: {
        tenantId: input.tenantId,
        runId: input.runId,
        role: input.role,
        attempt: input.attempt,
        runner: input.runner,
        cliSessionId: input.cliSessionId,
        model: input.model,
        effort: input.effort,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        reasoningTokens: usage?.reasoningTokens ?? null,
        cacheReadTokens: usage?.cacheReadTokens ?? null,
        cacheWriteTokens: usage?.cacheWriteTokens ?? null,
        costUsd: usage?.costUsd ?? null,
        turns: usage?.turns ?? null,
        durationMs: Math.round(input.durationMs),
        longestTurnMs: usage?.longestTurnMs ?? null,
        modelMs: usage?.modelMs ?? null,
        toolMs: usage?.toolMs ?? null,
        outcome: input.outcome,
        idempotencyKey: input.idempotencyKey,
      },
    });
    return toRecord(row);
  }

  async listForRun(tenantId: string, runId: string): Promise<AgentSessionRecord[]> {
    // The tenant filter is part of the query. SDD section 52 forbids relying on the caller.
    const rows = await this.prisma.agentSession.findMany({
      where: { tenantId, runId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(toRecord);
  }

  async listRecentForProduct(tenantId: string, productId: string, limit: number): Promise<AgentSessionRecord[]> {
    // The tenant filter sits on the session and on its Run. SDD section 52.
    const rows = await this.prisma.agentSession.findMany({
      where: { tenantId, run: { tenantId, productId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
    return rows.map(toRecord);
  }
}

interface Row {
  id: string;
  tenantId: string;
  runId: string;
  role: string;
  attempt: number;
  runner: string;
  cliSessionId: string | null;
  model: string | null;
  effort: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  turns: number | null;
  durationMs: number;
  longestTurnMs: number | null;
  modelMs: number | null;
  toolMs: number | null;
  outcome: string;
  idempotencyKey: string;
  createdAt: Date;
}

// This store is the only writer of the table, and it writes only the declared roles and
// outcomes. The casts below assume that rather than check it at run time.
const toRecord = (row: Row): AgentSessionRecord => {
  const usageFields = [
    row.inputTokens,
    row.outputTokens,
    row.reasoningTokens,
    row.cacheReadTokens,
    row.cacheWriteTokens,
    row.costUsd,
    row.turns,
    row.longestTurnMs,
    row.modelMs,
    row.toolMs,
  ];
  return {
    id: row.id,
    tenantId: row.tenantId,
    runId: row.runId,
    role: row.role as AgentSessionRole,
    attempt: row.attempt,
    runner: row.runner,
    cliSessionId: row.cliSessionId,
    model: row.model,
    effort: row.effort,
    // A row with every usage field null is a session the CLI left no record for.
    usage: usageFields.every((value) => value === null)
      ? null
      : {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          reasoningTokens: row.reasoningTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          costUsd: row.costUsd,
          turns: row.turns,
          longestTurnMs: row.longestTurnMs,
          modelMs: row.modelMs,
          toolMs: row.toolMs,
        },
    durationMs: row.durationMs,
    outcome: row.outcome as AgentSessionOutcome,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  };
};
