import type { FactoreePrismaClient } from "./client.js";
import type { RunStopLog, StopRequest } from "~/domain/runs/run-stop.js";

/** Issue #45, DI-21.65. The first stop of a Run wins, as the workflow keeps the first payload. */
export class PrismaRunStopLog implements RunStopLog {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async record(tenantId: string, runId: string, request: StopRequest, at: Date): Promise<void> {
    await this.prisma.run.updateMany({
      where: { tenantId, id: runId, stopRequestedAt: null },
      data: { stopRequestedAt: at, stopSource: request.source, stopRequestedBy: request.by ?? null },
    });
  }
}
