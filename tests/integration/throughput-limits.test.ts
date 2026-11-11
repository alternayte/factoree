import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunSlots } from "~/persistence/prisma/run-slots.prisma.js";
import { PrismaSandboxLeaseStore } from "~/persistence/prisma/sandbox-lease.prisma.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { TERMINAL_RUN_STATUSES } from "~/domain/runs/run-status.js";
import { SandboxSlots } from "~/domain/runs/sandbox-slots.js";
import { SandboxSlotUnavailableError } from "~/domain/runs/sandbox-slot-error.js";
import type { SandboxRef } from "~/domain/runs/sandbox.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsSandbox } from "~/adapters/sandbox/settings-sandbox.js";

// docs/specs/release-0-1-0.md part 3, against PostgreSQL. DI-15.13: maxConcurrentRuns and the
// queue. DI-15.14: sandboxMaxLive and the eviction of the oldest retained sandbox.

let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let tenantId = "";
let sequence = 0;

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  tenantId = (await prisma.tenant.create({ data: { linearWorkspaceId: "ws-throughput", name: "T" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
  await stop();
});

const product = async (maxConcurrentRuns: number): Promise<string> => {
  sequence += 1;
  const row = await prisma.product.create({
    data: {
      tenantId,
      slug: `p-${sequence}`,
      name: "P",
      linearTeamKey: `T${sequence}`,
      linearTeamId: `team-${sequence}`,
      maxConcurrentRuns,
    },
  });
  return row.id;
};

/** One Run of the Product, delegated `secondsAgo` before now, so the delegation order is fixed. */
const run = async (productId: string, secondsAgo: number, status = "RESOLVING_CONTEXT"): Promise<string> => {
  sequence += 1;
  const row = await prisma.run.create({
    data: {
      tenantId,
      productId,
      linearAgentSessionId: `session-${sequence}`,
      temporalWorkflowId: `wf-${sequence}`,
      status,
      autonomyLevel: "L2",
      createdAt: new Date(Date.now() - secondsAgo * 1000),
    },
  });
  return row.id;
};

const statusOf = async (runId: string): Promise<string> =>
  (await prisma.run.findUniqueOrThrow({ where: { id: runId } })).status;

describe("maxConcurrentRuns", () => {
  it("queues the Runs over the limit in delegation order and reports how many are ahead", async () => {
    const slots = new PrismaRunSlots(prisma);
    const productId = await product(1);
    const first = await run(productId, 40);
    const second = await run(productId, 30);
    const third = await run(productId, 20);

    expect(await slots.claim(first)).toEqual({ granted: true });
    // The third Run reaches the gate first, and the second, delegated earlier, still goes ahead.
    expect(await slots.claim(third)).toEqual({ granted: false, ahead: 1 });
    expect(await slots.claim(second)).toEqual({ granted: false, ahead: 1 });
    expect(await slots.claim(third)).toEqual({ granted: false, ahead: 2 });
    expect(await statusOf(second)).toBe("QUEUED");
    expect(await statusOf(third)).toBe("QUEUED");

    await prisma.run.update({ where: { id: first }, data: { status: "READY_FOR_HUMAN" } });
    // The slot goes to the oldest queued Run, never to a younger one that asks first.
    expect(await slots.claim(third)).toEqual({ granted: false, ahead: 1 });
    expect(await slots.claim(second)).toEqual({ granted: true });
    // The granted Run still reads QUEUED until the workflow writes PREPARING. It counts once.
    expect(await slots.claim(third)).toEqual({ granted: false, ahead: 1 });
    // A retry of a granted claim keeps the slot.
    expect(await slots.claim(second)).toEqual({ granted: true });
  });

  it("drops a cancelled Run from the queue", async () => {
    const slots = new PrismaRunSlots(prisma);
    const productId = await product(1);
    const active = await run(productId, 30);
    const cancelled = await run(productId, 20);
    const waiting = await run(productId, 10);

    expect(await slots.claim(active)).toEqual({ granted: true });
    expect(await slots.claim(cancelled)).toEqual({ granted: false, ahead: 1 });
    expect(await slots.claim(waiting)).toEqual({ granted: false, ahead: 2 });

    await prisma.run.update({ where: { id: cancelled }, data: { status: "CANCELLED" } });
    expect(await slots.claim(waiting)).toEqual({ granted: false, ahead: 1 });
  });

  it.each([...TERMINAL_RUN_STATUSES])("frees the slot when the Run ends %s", async (terminal) => {
    const slots = new PrismaRunSlots(prisma);
    const productId = await product(1);
    const holder = await run(productId, 20);
    const next = await run(productId, 10);

    expect(await slots.claim(holder)).toEqual({ granted: true });
    expect(await slots.claim(next)).toEqual({ granted: false, ahead: 1 });
    // A failure, a timeout (FAILED with RUN_TIMEOUT) and a stop all end in a terminal status.
    await prisma.run.update({ where: { id: holder }, data: { status: terminal } });
    expect(await slots.claim(next)).toEqual({ granted: true });
  });

  it("never grants more slots than the limit to concurrent claims", async () => {
    const slots = new PrismaRunSlots(prisma);
    const productId = await product(2);
    const runs = await Promise.all([1, 2, 3, 4, 5, 6].map((index) => run(productId, 60 - index)));
    const claims = await Promise.all(runs.map((runId) => slots.claim(runId)));
    expect(claims.filter((claim) => claim.granted)).toHaveLength(2);
  });
});

describe("sandboxMaxLive", () => {
  const adapter = (): string => {
    sequence += 1;
    return `fake-${sequence}`;
  };

  /** A live sandbox of `runId` with its lease, created `secondsAgo` before now. */
  const liveSandbox = async (provider: string, runId: string, sandboxId: string, secondsAgo: number): Promise<void> => {
    await prisma.sandboxLease.create({
      data: { adapter: provider, runId, sandboxId, createdAt: new Date(Date.now() - secondsAgo * 1000) },
    });
    await prisma.run.update({ where: { id: runId }, data: { spriteId: sandboxId, spriteAdapter: provider } });
  };

  const slotsWith = (deleted: SandboxRef[], waitMs = 0) =>
    new SandboxSlots({
      store: new PrismaSandboxLeaseStore(prisma),
      destroy: (ref) => {
        deleted.push(ref);
        return Promise.resolve();
      },
      workspacePath: "/workspace",
      waitMs,
      pollMs: 20,
    });

  it("deletes the oldest retained sandbox at the limit, and the Run forgets it", async () => {
    const provider = adapter();
    const productId = await product(5);
    const older = await run(productId, 50, "READY_FOR_HUMAN");
    const newer = await run(productId, 40, "FAILED");
    const working = await run(productId, 30, "IMPLEMENTING");
    const next = await run(productId, 10, "PREPARING");
    await liveSandbox(provider, working, "sbx-working", 300);
    await liveSandbox(provider, older, "sbx-older", 200);
    await liveSandbox(provider, newer, "sbx-newer", 100);

    const deleted: SandboxRef[] = [];
    const leaseId = await slotsWith(deleted).acquire(provider, next, 3);

    // The working sandbox is older, and it is not retained, so it stays.
    expect(deleted.map((ref) => ref.id)).toEqual(["sbx-older"]);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: older } })).spriteId).toBeNull();
    expect((await prisma.run.findUniqueOrThrow({ where: { id: newer } })).spriteId).toBe("sbx-newer");
    expect(await prisma.sandboxLease.count({ where: { adapter: provider } })).toBe(3);
    expect((await prisma.sandboxLease.findUniqueOrThrow({ where: { id: leaseId } })).runId).toBe(next);
  });

  it("waits for a slot when no sandbox is retained, and takes the one a delete frees", async () => {
    const provider = adapter();
    const productId = await product(5);
    const first = await run(productId, 30, "IMPLEMENTING");
    const second = await run(productId, 20, "VERIFYING");
    const next = await run(productId, 10, "PREPARING");
    await liveSandbox(provider, first, "sbx-first", 60);
    await liveSandbox(provider, second, "sbx-second", 50);

    const deleted: SandboxRef[] = [];
    const slots = slotsWith(deleted, 30_000);
    let granted = false;
    const acquiring = slots.acquire(provider, next, 2).then((leaseId) => {
      granted = true;
      return leaseId;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(granted).toBe(false);

    await slots.release(provider, "sbx-second");
    await acquiring;
    expect(deleted).toEqual([]);
    expect(await prisma.sandboxLease.count({ where: { adapter: provider } })).toBe(2);
  });

  it("gives the wait back to the workflow after its time, with no retained sandbox", async () => {
    const provider = adapter();
    const productId = await product(5);
    const working = await run(productId, 30, "IMPLEMENTING");
    const next = await run(productId, 10, "PREPARING");
    await liveSandbox(provider, working, "sbx-working", 60);

    await expect(slotsWith([], 100).acquire(provider, next, 1)).rejects.toBeInstanceOf(SandboxSlotUnavailableError);
    expect(await prisma.sandboxLease.count({ where: { adapter: provider } })).toBe(1);
  });

  it("never passes the limit with concurrent creates", async () => {
    const provider = adapter();
    const productId = await product(5);
    const runs = await Promise.all([1, 2, 3, 4, 5, 6].map((index) => run(productId, 60 - index, "PREPARING")));
    const results = await Promise.allSettled(runs.map((runId) => slotsWith([], 100).acquire(provider, runId, 3)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(await prisma.sandboxLease.count({ where: { adapter: provider } })).toBe(3);
  });
});

// docs/specs/sandbox-provider-spillover.md. A run holds the slots of its peak on its provider from
// start to end, so it never waits for a check sprite once it has started.
describe("held slots", () => {
  const provider = (): string => {
    sequence += 1;
    return `held-${sequence}`;
  };

  const store = () => new PrismaSandboxLeaseStore(prisma);

  const slots = (deleted: SandboxRef[] = []) =>
    new SandboxSlots({
      store: store(),
      destroy: (ref) => {
        deleted.push(ref);
        return Promise.resolve();
      },
      workspacePath: "/workspace",
      waitMs: 0,
      pollMs: 20,
    });

  it("holds three slots, gives a create one of them, and refuses a second run with no room", async () => {
    const id = provider();
    const productId = await product(5);
    const first = await run(productId, 30, "PREPARING");
    const second = await run(productId, 20, "PREPARING");

    expect(await slots().hold(id, first, 3, 4)).toBe(true);
    // A retry of the hold holds nothing more.
    expect(await slots().hold(id, first, 3, 4)).toBe(true);
    expect(await prisma.sandboxLease.count({ where: { adapter: id } })).toBe(3);
    expect(await slots().hold(id, second, 3, 4)).toBe(false);
    expect(await store().heldProviderOf(first)).toBe(id);

    // The create of the run takes a held slot and counts nothing new, even at the limit.
    const leaseId = await slots().acquire(id, first, 3);
    await slots().bind(leaseId, "sbx-work");
    expect(await prisma.sandboxLease.count({ where: { adapter: id } })).toBe(3);
    // Another run takes the fourth slot, and a fifth create waits.
    const other = await slots().acquire(id, second, 4);
    await slots().bind(other, "sbx-other");
    await expect(slots().acquire(id, second, 4)).rejects.toBeInstanceOf(SandboxSlotUnavailableError);
  });

  it("keeps a slot held after a delete while the run works, and gives back the unused ones when it ends", async () => {
    const id = provider();
    const productId = await product(5);
    const runId = await run(productId, 30, "VERIFYING");
    expect(await slots().hold(id, runId, 3, 3)).toBe(true);
    const work = await slots().acquire(id, runId, 3);
    await slots().bind(work, "sbx-work");
    await prisma.run.update({ where: { id: runId }, data: { spriteId: "sbx-work", spriteAdapter: id } });
    const check = await slots().acquire(id, runId, 3);
    await slots().bind(check, "sbx-check");

    // The check sprite of a superseded attempt goes, and its slot stays with the run.
    await slots().release(id, "sbx-check");
    expect(await prisma.sandboxLease.count({ where: { adapter: id, runId } })).toBe(3);

    // The terminal write gives back the unused held slots. The retained work sprite keeps its own.
    await new PrismaRunRepository(prisma).updateStatus(runId, "READY_FOR_HUMAN");
    const left = await prisma.sandboxLease.findMany({ where: { adapter: id } });
    expect(left.map((lease) => lease.sandboxId)).toEqual(["sbx-work"]);

    // A delete after the end gives the slot back for good.
    await slots().release(id, "sbx-work");
    expect(await prisma.sandboxLease.count({ where: { adapter: id } })).toBe(0);
  });

  it("deletes a retained sandbox to make room for a hold", async () => {
    const id = provider();
    const productId = await product(5);
    const ended = await run(productId, 50, "FAILED");
    const next = await run(productId, 10, "PREPARING");
    await prisma.sandboxLease.create({ data: { adapter: id, runId: ended, sandboxId: "sbx-retained" } });
    await prisma.run.update({ where: { id: ended }, data: { spriteId: "sbx-retained", spriteAdapter: id } });

    const deleted: SandboxRef[] = [];
    expect(await slots(deleted).hold(id, next, 3, 3)).toBe(true);
    expect(deleted.map((ref) => ref.id)).toEqual(["sbx-retained"]);
    expect(await store().usage()).toMatchObject({ [id]: { live: 3, retained: 0 } });
  });
});

// A failed delete at the provider keeps the lease and marks it, and the reaper pass deletes the
// sandbox again. No Run names a check sprite, so without the mark the sandbox would stay forever
// (a paused E2B sandbox lives until a kill).
describe("a failed sandbox delete", () => {
  it("keeps the lease, marks it, and gives the slot back once a retry deletes the sandbox", async () => {
    sequence += 1;
    const id = `failing-${sequence}`;
    const root = await mkdtemp(join(tmpdir(), "failed-delete-"));
    try {
      const sandbox = new SettingsSandbox({
        settings: () =>
          Promise.resolve({
            image: null,
            registryUsername: null,
            registryToken: null,
            providers: [
              {
                id,
                name: id,
                type: "local",
                url: null,
                apiKey: null,
                maxLive: 5,
                vcpus: null,
                memoryMb: null,
                priority: 1,
                enabled: true,
                downUntil: null,
                downReason: null,
              },
            ],
          }),
        allowLocal: true,
        localRoot: root,
        leases: new PrismaSandboxLeaseStore(prisma),
      });
      const ref = await (await sandbox.forProvider(id)).create({ runId: "check-run", tenantId, productId: "p" });
      const adapter = sandbox.adapterOf(id);
      if (adapter === null) throw new Error("no adapter");
      const destroy = adapter.destroy.bind(adapter);
      adapter.destroy = () => Promise.reject(new Error("provider down"));

      await expect(sandbox.destroy(ref)).rejects.toThrow("provider down");
      const marked = await prisma.sandboxLease.findFirstOrThrow({ where: { adapter: id, sandboxId: ref.id } });
      expect(marked.destroyFailedAt).not.toBeNull();
      // A retry that fails again keeps the mark.
      expect(await sandbox.retryFailedDestroys()).toBe(0);
      expect(await prisma.sandboxLease.count({ where: { adapter: id } })).toBe(1);

      adapter.destroy = destroy;
      expect(await sandbox.retryFailedDestroys()).toBe(1);
      expect(await prisma.sandboxLease.count({ where: { adapter: id } })).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
