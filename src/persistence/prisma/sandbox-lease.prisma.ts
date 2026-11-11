import { Prisma } from "@prisma/client";
import { TERMINAL_RUN_STATUSES } from "~/domain/runs/run-status.js";
import type { RetainedSandbox, SandboxLeaseStore, SandboxReservation } from "~/domain/runs/sandbox-slots.js";
import type { FactoreePrismaClient } from "./client.js";

/** A reservation the create never bound. Its worker stopped between the reservation and the create. */
const UNBOUND_LEASE_MS = 15 * 60_000;

/** An eviction mark whose worker stopped before the delete ended. */
const STALE_EVICTION_MS = 10 * 60_000;

type Transaction = Prisma.TransactionClient;

const TERMINAL = Prisma.join([...TERMINAL_RUN_STATUSES]);

/**
 * DI-15.14. The leases of the live sandboxes. A transaction advisory lock per provider makes the
 * count and the grant one step for every worker. A retained sandbox is the work sandbox a
 * terminal Run still names.
 *
 * docs/specs/sandbox-provider-spillover.md. `adapter` holds the sandbox provider id. A held lease
 * is one of the slots a run takes at start. It counts while unbound, a create of the run binds it,
 * and a delete unbinds it again until the run ends.
 */
export class PrismaSandboxLeaseStore implements SandboxLeaseStore {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  private async lock(tx: Transaction, adapter: string): Promise<void> {
    const lockKey = `factoree:sandbox-lease:${adapter}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS "locked"`;
  }

  /** Drops stale reservations, and the unused held slots of a run that ended without its terminal write. */
  private async sweep(tx: Transaction, adapter: string, now: number): Promise<void> {
    await tx.sandboxLease.deleteMany({
      where: { adapter, held: false, sandboxId: null, createdAt: { lt: new Date(now - UNBOUND_LEASE_MS) } },
    });
    await tx.$executeRaw`
      DELETE FROM "SandboxLease" l
      USING "Run" r
      WHERE l."adapter" = ${adapter} AND l."held" AND l."sandboxId" IS NULL
        AND r."id" = l."runId" AND r."status" IN (${TERMINAL})`;
  }

  /** Marks the oldest retained sandbox of the provider for deletion by this caller, or answers full. */
  private async victim(tx: Transaction, adapter: string, now: number, live: number): Promise<SandboxReservation> {
    const victims = await tx.$queryRaw<Array<{ leaseId: string; sandboxId: string; runId: string; tenantId: string }>>`
      SELECT l."id" AS "leaseId", l."sandboxId", r."id" AS "runId", r."tenantId"
      FROM "SandboxLease" l
      JOIN "Run" r ON r."spriteId" = l."sandboxId" AND r."spriteAdapter" = l."adapter"
      WHERE l."adapter" = ${adapter}
        AND (l."evictingSince" IS NULL OR l."evictingSince" < ${new Date(now - STALE_EVICTION_MS)})
        AND r."status" IN (${TERMINAL})
      ORDER BY l."createdAt" ASC, l."id" ASC
      LIMIT 1`;
    const victim = victims[0];
    if (victim === undefined) return { kind: "full", live };
    await tx.sandboxLease.update({ where: { id: victim.leaseId }, data: { evictingSince: new Date(now) } });
    return { kind: "evict", victim: { ...victim, adapter } };
  }

  async reserve(input: { adapter: string; runId: string; maxLive: number | null }): Promise<SandboxReservation> {
    return await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, input.adapter);
      const now = Date.now();
      await this.sweep(tx, input.adapter, now);
      // A held slot of the run is already counted, so the run takes it with no count.
      const held = await tx.sandboxLease.findFirst({
        where: { adapter: input.adapter, runId: input.runId, held: true, sandboxId: null },
        orderBy: { createdAt: "asc" },
      });
      if (held !== null) return { kind: "granted", leaseId: held.id };
      const live = await tx.sandboxLease.count({ where: { adapter: input.adapter } });
      if (input.maxLive === null || live < input.maxLive) {
        const lease = await tx.sandboxLease.create({ data: { adapter: input.adapter, runId: input.runId } });
        return { kind: "granted", leaseId: lease.id };
      }
      return await this.victim(tx, input.adapter, now, live);
    });
  }

  async hold(input: { adapter: string; runId: string; count: number; maxLive: number | null }): Promise<SandboxReservation> {
    return await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, input.adapter);
      const now = Date.now();
      await this.sweep(tx, input.adapter, now);
      const owned = await tx.sandboxLease.count({ where: { adapter: input.adapter, runId: input.runId } });
      const missing = input.count - owned;
      if (missing <= 0) return { kind: "granted", leaseId: "" };
      const live = await tx.sandboxLease.count({ where: { adapter: input.adapter } });
      if (input.maxLive === null || live + missing <= input.maxLive) {
        await tx.sandboxLease.createMany({
          data: Array.from({ length: missing }, () => ({ adapter: input.adapter, runId: input.runId, held: true })),
        });
        return { kind: "granted", leaseId: "" };
      }
      return await this.victim(tx, input.adapter, now, live);
    });
  }

  async heldProviderOf(runId: string): Promise<string | null> {
    const lease = await this.prisma.sandboxLease.findFirst({ where: { runId, held: true }, orderBy: { createdAt: "asc" } });
    return lease?.adapter ?? null;
  }

  async releaseHolds(runId: string): Promise<void> {
    await this.prisma.sandboxLease.deleteMany({ where: { runId, held: true, sandboxId: null } });
  }

  async usage(): Promise<Record<string, { live: number; retained: number }>> {
    const rows = await this.prisma.$queryRaw<Array<{ adapter: string; live: bigint; retained: bigint }>>`
      SELECT l."adapter",
             count(*) AS "live",
             count(r."id") FILTER (WHERE r."status" IN (${TERMINAL})) AS "retained"
      FROM "SandboxLease" l
      LEFT JOIN "Run" r ON r."spriteId" = l."sandboxId" AND r."spriteAdapter" = l."adapter"
      GROUP BY l."adapter"`;
    return Object.fromEntries(rows.map((row) => [row.adapter, { live: Number(row.live), retained: Number(row.retained) }]));
  }

  async bind(leaseId: string, sandboxId: string): Promise<void> {
    await this.prisma.sandboxLease.update({ where: { id: leaseId }, data: { sandboxId } });
  }

  async abandon(leaseId: string): Promise<void> {
    // A held slot stays held when its create fails. The run gives it back when it ends.
    await this.prisma.sandboxLease.deleteMany({ where: { id: leaseId, held: false } });
  }

  async release(adapter: string, sandboxId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const lease = await tx.sandboxLease.findUnique({ where: { adapter_sandboxId: { adapter, sandboxId } } });
      if (lease === null) return;
      if (lease.held) {
        const run = await tx.run.findUnique({ where: { id: lease.runId }, select: { status: true } });
        if (run !== null && !(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) {
          await tx.sandboxLease.update({ where: { id: lease.id }, data: { sandboxId: null, evictingSince: null } });
          return;
        }
      }
      await tx.sandboxLease.delete({ where: { id: lease.id } });
    });
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

  async destroyFailed(adapter: string, sandboxId: string): Promise<void> {
    await this.prisma.sandboxLease.updateMany({ where: { adapter, sandboxId }, data: { destroyFailedAt: new Date() } });
  }

  async failedDestroys(limit: number): Promise<Array<{ adapter: string; sandboxId: string }>> {
    const rows = await this.prisma.sandboxLease.findMany({
      where: { destroyFailedAt: { not: null }, sandboxId: { not: null } },
      orderBy: { destroyFailedAt: "asc" },
      take: limit,
      select: { adapter: true, sandboxId: true },
    });
    return rows.flatMap((row) => (row.sandboxId === null ? [] : [{ adapter: row.adapter, sandboxId: row.sandboxId }]));
  }
}
