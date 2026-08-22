import type { PrismaClient } from "@prisma/client";
import type {
  AgentExecutionRecord,
  AgentExecutionRepository,
  RecordAgentExecutionInput,
} from "~/domain/runs/agent-execution.js";
import type { AgentRole } from "~/domain/runs/agent-runner.js";

export class PrismaAgentExecutionRepository implements AgentExecutionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async record(input: RecordAgentExecutionInput): Promise<AgentExecutionRecord> {
    // A retried Temporal activity calls this method again with the same idempotency key. The
    // unique constraint on (tenantId, idempotencyKey) makes the write collide, and the upsert
    // returns the row that already exists rather than creating a second one.
    const row = await this.prisma.agentExecution.upsert({
      where: {
        tenantId_idempotencyKey: {
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      update: {},
      create: {
        tenantId: input.tenantId,
        runId: input.runId,
        role: input.role,
        runner: input.runner,
        model: input.model,
        sessionRef: input.sessionRef,
        promptVersion: input.promptVersion,
        durationMs: input.durationMs,
        finalResult: input.finalResult,
        idempotencyKey: input.idempotencyKey,
      },
    });
    return toRecord(row);
  }

  async listForRun(tenantId: string, runId: string): Promise<AgentExecutionRecord[]> {
    // The tenant filter is part of the query. SDD section 52 forbids relying on the caller.
    const rows = await this.prisma.agentExecution.findMany({
      where: { tenantId, runId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toRecord);
  }
}

interface Row {
  id: string;
  tenantId: string;
  runId: string;
  role: string;
  runner: string;
  model: string | null;
  sessionRef: string | null;
  promptVersion: string | null;
  durationMs: number | null;
  finalResult: unknown;
  idempotencyKey: string;
  createdAt: Date;
}

// This repository is the only writer of `finalResult` today, and it always writes the shape
// declared on `RecordAgentExecutionInput`. The cast below assumes that shape rather than
// checking it at run time. A second writer must add a runtime check here.
const toRecord = (row: Row): AgentExecutionRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  runId: row.runId,
  role: row.role as AgentRole,
  runner: row.runner,
  model: row.model,
  sessionRef: row.sessionRef,
  promptVersion: row.promptVersion ?? "",
  durationMs: row.durationMs ?? 0,
  finalResult: row.finalResult as RecordAgentExecutionInput["finalResult"],
  idempotencyKey: row.idempotencyKey,
  createdAt: row.createdAt,
});
