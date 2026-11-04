import type { PrismaClient } from "@prisma/client";
import type { RunStageName, RunStageSpan, RunStageStore } from "~/domain/runs/run-stage.js";

/** docs/specs/run-speed.md. The `run_stage` table. */
export class PrismaRunStageStore implements RunStageStore {
  constructor(private readonly prisma: PrismaClient) {}

  async record(span: RunStageSpan): Promise<void> {
    await this.prisma.runStage.create({ data: { ...span } });
  }

  async listForRun(tenantId: string, runId: string): Promise<RunStageSpan[]> {
    // The tenant filter is part of the query. SDD section 52 forbids relying on the caller.
    const rows = await this.prisma.runStage.findMany({
      where: { tenantId, runId },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    });
    // This store is the only writer of the table, and it writes only the declared stage names.
    return rows.map((row) => ({
      tenantId: row.tenantId,
      runId: row.runId,
      stage: row.stage as RunStageName,
      attempt: row.attempt,
      sandboxId: row.sandboxId,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    }));
  }
}
