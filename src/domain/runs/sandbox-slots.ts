import type { Logger } from "~/telemetry/logger.js";
import type { SandboxRef } from "./sandbox.js";
import { SandboxSlotUnavailableError } from "./sandbox-slot-error.js";

/** A retained sandbox: the work sandbox of a Run that ended, kept for inspection until retention ends. */
export interface RetainedSandbox {
  leaseId: string;
  adapter: string;
  sandboxId: string;
  tenantId: string;
  runId: string;
}

export type SandboxReservation =
  | { kind: "granted"; leaseId: string }
  /** The provider is at its limit. This retained sandbox is marked for deletion by this caller. */
  | { kind: "evict"; victim: RetainedSandbox }
  /** The provider is at its limit, and no retained sandbox can go. */
  | { kind: "full"; live: number };

/**
 * docs/specs/release-0-1-0.md, DI-15.14. One lease per live sandbox of a provider, from the
 * reservation before the create to the delete. `reserve` counts and grants under one lock per
 * provider, so concurrent creates on any worker never pass `maxLive`.
 */
export interface SandboxLeaseStore {
  /** `maxLive` null records the lease and enforces no limit. */
  reserve(input: { adapter: string; runId: string; maxLive: number | null }): Promise<SandboxReservation>;
  /** The create returned this sandbox. */
  bind(leaseId: string, sandboxId: string): Promise<void>;
  /** The create failed, so the reservation goes. */
  abandon(leaseId: string): Promise<void>;
  /** The sandbox is deleted, so its lease goes. A sandbox with no lease is ignored. */
  release(adapter: string, sandboxId: string): Promise<void>;
  /** The evicted sandbox is deleted: its lease goes, and its Run no longer names it. */
  evicted(victim: RetainedSandbox): Promise<void>;
  /** The delete failed: the sandbox stays live and can be chosen again. */
  evictionFailed(victim: RetainedSandbox): Promise<void>;
}

export interface SandboxSlotsOptions {
  store: SandboxLeaseStore;
  /** Deletes a sandbox at the provider, with no lease bookkeeping. */
  destroy: (ref: SandboxRef) => Promise<void>;
  /** Every adapter uses one fixed workspace path, and `destroy` needs a complete ref. */
  workspacePath: string;
  logger?: Logger;
  onEvicted?: (victim: RetainedSandbox) => void;
  /** How long one acquire waits for a slot before it gives the wait back to the workflow. */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_POLL_MS = 5_000;

/**
 * DI-15.14. Gives each sandbox create a slot of the provider's `sandboxMaxLive`. At the limit it
 * deletes the oldest retained sandbox. With none retained it waits a short time, then throws
 * `SandboxSlotUnavailableError`, and the workflow waits on, bounded by the Run budget. A long
 * wait in the workflow survives a worker restart, and a wait inside an activity does not.
 */
export class SandboxSlots {
  constructor(private readonly options: SandboxSlotsOptions) {}

  /** Answers the lease id of the reserved slot. */
  async acquire(adapter: string, runId: string, maxLive: number | null): Promise<string> {
    const waitMs = this.options.waitMs ?? DEFAULT_WAIT_MS;
    const pollMs = this.options.pollMs ?? DEFAULT_POLL_MS;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + waitMs;
    for (;;) {
      const reservation = await this.options.store.reserve({ adapter, runId, maxLive });
      if (reservation.kind === "granted") return reservation.leaseId;
      if (reservation.kind === "evict") {
        if (await this.evict(reservation.victim, runId)) continue;
      } else if (Date.now() >= deadline) {
        throw new SandboxSlotUnavailableError(
          `the ${adapter} provider runs ${reservation.live} sandboxes of Factoree, its limit is ${maxLive ?? "none"}, and none is retained`,
        );
      }
      await sleep(pollMs);
    }
  }

  private async evict(victim: RetainedSandbox, runId: string): Promise<boolean> {
    try {
      await this.options.destroy({ id: victim.sandboxId, adapter: victim.adapter, workspacePath: this.options.workspacePath });
    } catch (error) {
      this.options.logger?.error("the retained sandbox was not deleted, so it still takes a slot", {
        sprite_id: victim.sandboxId,
        adapter: victim.adapter,
        run_id: victim.runId,
        error: String(error),
        step: "sandbox_limit",
      });
      await this.options.store.evictionFailed(victim);
      return false;
    }
    await this.options.store.evicted(victim);
    this.options.onEvicted?.(victim);
    this.options.logger?.info("the oldest retained sandbox is deleted to free a slot of the provider limit", {
      sprite_id: victim.sandboxId,
      adapter: victim.adapter,
      retained_run_id: victim.runId,
      run_id: runId,
      step: "sandbox_limit",
    });
    return true;
  }

  bind(leaseId: string, sandboxId: string): Promise<void> {
    return this.options.store.bind(leaseId, sandboxId);
  }

  abandon(leaseId: string): Promise<void> {
    return this.options.store.abandon(leaseId);
  }

  release(adapter: string, sandboxId: string): Promise<void> {
    return this.options.store.release(adapter, sandboxId);
  }
}
