import { Prisma } from "@prisma/client";
import { TERMINAL_RUN_STATUSES } from "~/domain/runs/run-status.js";
import type { RetainedSandbox, SandboxLeaseStore, SandboxReservation } from "~/domain/runs/sandbox-slots.js";
import type { FactoreePrismaClient } from "./client.js";

/** A reservation the create never bound. Its worker stopped between the reservation and the create. */
const UNBOUND_LEASE_MS = 15 * 60_000;

/** An eviction mark whose worker stopped before the delete ended. */
const STALE_EVICTION_MS = 10 * 60_000;

/**
 * DI-15.14. The leases of the live sandboxes. A transaction advisory lock per provider makes the
 * count and the grant one step for every worker. A retained sandbox is the work sandbox a
 * terminal Run still names.
 */
export class PrismaSandboxLeaseStore implements SandboxLeaseStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async reserve(input: { adapter: string; runId: string; maxLive: number | null }): Promise<SandboxReservation> {
    return await this.prisma.$transaction(async (tx) => {
      const lockKey = `factoree:sandbox-lease:${input.adapter}`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS "locked"`;
      const now = Date.now();
      await tx.sandboxLease.deleteMany({
        where: { adapter: input.adapter, sandboxId: null, createdAt: { lt: new Date(now - UNBOUND_LEASE_MS) } },
      });
      const live = await tx.sandboxLease.count({ where: { adapter: input.adapter } });
      if (input.maxLive === null || live < input.maxLive) {
        const lease = await tx.sandboxLease.create({ data: { adapter: input.adapter, runId: input.runId } });
        return { kind: "granted", leaseId: lease.id };
      }

      const victims = await tx.$queryRaw<Array<{ leaseId: string; sandboxId: string; runId: string; tenantId: string }>>`
        SELECT l."id" AS "leaseId", l."sandboxId", r."id" AS "runId", r."tenantId"
        FROM "SandboxLease" l
        JOIN "Run" r ON r."spriteId" = l."sandboxId" AND r."spriteAdapter" = l."adapter"
        WHERE l."adapter" = ${input.adapter}
          AND (l."evictingSince" IS NULL OR l."evictingSince" < ${new Date(now - STALE_EVICTION_MS)})
          AND r."status" IN (${Prisma.join([...TERMINAL_RUN_STATUSES])})
        ORDER BY l."createdAt" ASC, l."id" ASC
        LIMIT 1`;
      const victim = victims[0];
      if (victim === undefined) return { kind: "full", live };
      await tx.sandboxLease.update({ where: { id: victim.leaseId }, data: { evictingSince: new Date(now) } });
      return { kind: "evict", victim: { ...victim, adapter: input.adapter } };
    });
  }

  async bind(leaseId: string, sandboxId: string): Promise<void> {
    await this.prisma.sandboxLease.update({ where: { id: leaseId }, data: { sandboxId } });
  }

  async abandon(leaseId: string): Promise<void> {
    await this.prisma.sandboxLease.deleteMany({ where: { id: leaseId } });
  }

  async release(adapter: string, sandboxId: string): Promise<void> {
    await this.prisma.sandboxLease.deleteMany({ where: { adapter, sandboxId } });
  }

  async evicted(victim: RetainedSandbox): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.sandboxLease.deleteMany({ where: { id: victim.leaseId } }),
      // The Run forgets the sandbox the way the reaper makes it forget, so the reaper skips it.
      this.prisma.run.updateMany({
        where: { id: victim.runId, spriteId: victim.sandboxId },
        data: { spriteId: null, spriteAdapter: null, spriteRetainUntil: null },
      }),
    ]);
  }

  async evictionFailed(victim: RetainedSandbox): Promise<void> {
    await this.prisma.sandboxLease.updateMany({ where: { id: victim.leaseId }, data: { evictingSince: null } });
  }
}
