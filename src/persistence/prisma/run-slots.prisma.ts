import { TERMINAL_RUN_STATUSES } from "~/domain/runs/run-status.js";
import type { RunSlotClaim, RunSlots } from "~/domain/runs/run-slots.js";
import type { FactoreePrismaClient } from "./client.js";

/**
 * DI-15.13. The slots of a Product live in the Run rows: a Run with `slotGrantedAt` and a status
 * that is not terminal holds one. A claim locks the Product row, so two claims of one Product,
 * from any worker, run one after the other and never grant the same slot twice.
 */
export class PrismaRunSlots implements RunSlots {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async claim(runId: string): Promise<RunSlotClaim> {
    return await this.prisma.$transaction(async (tx) => {
      const run = await tx.run.findUnique({
        where: { id: runId },
        select: { productId: true, createdAt: true, slotGrantedAt: true, status: true },
      });
      if (run === null) throw new Error(`no Run "${runId}" exists to claim a slot`);
      if (run.slotGrantedAt !== null) return { granted: true };

      const products = await tx.$queryRaw<Array<{ maxConcurrentRuns: number }>>`
        SELECT "maxConcurrentRuns" FROM "Product" WHERE "id" = ${run.productId} FOR UPDATE`;
      const limit = products[0]?.maxConcurrentRuns;
      if (limit === undefined) throw new Error(`no Product "${run.productId}" exists for Run "${runId}"`);

      const active = await tx.run.count({
        where: {
          productId: run.productId,
          slotGrantedAt: { not: null },
          status: { notIn: [...TERMINAL_RUN_STATUSES] },
        },
      });
      // Delegation order: the creation time of the Run, and its id for two Runs of one instant.
      const queuedAhead = await tx.run.count({
        where: {
          productId: run.productId,
          status: "QUEUED",
          slotGrantedAt: null,
          id: { not: runId },
          OR: [{ createdAt: { lt: run.createdAt } }, { createdAt: run.createdAt, id: { lt: runId } }],
        },
      });

      if (active + queuedAhead < limit) {
        await tx.run.update({ where: { id: runId }, data: { slotGrantedAt: new Date() } });
        return { granted: true };
      }
      // The status changes in the same transaction, so the next claim already counts this Run.
      if (run.status !== "QUEUED") await tx.run.update({ where: { id: runId }, data: { status: "QUEUED" } });
      return { granted: false, ahead: queuedAhead + active - limit + 1 };
    });
  }
}
