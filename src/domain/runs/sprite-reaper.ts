import type { ExpiredSandboxRun } from "./run-repository.js";
import type { Sandbox } from "./sandbox.js";
import type { WarmSnapshotStore } from "./warm-snapshot.js";

export type ExpiredSandbox = ExpiredSandboxRun;

export interface SpriteReaperRuns {
  listExpiredSandboxes(now: Date, limit: number): Promise<ExpiredSandbox[]>;
  clearSandbox(tenantId: string, runId: string): Promise<void>;
}

export interface SpriteReaperOptions {
  /**
   * The sandbox of each provider, by the id a ref names, or a function that finds it.
   * docs/specs/sandbox-provider-spillover.md: the provider ids are not fixed names.
   */
  sandboxes: Record<string, Sandbox> | ((adapter: string) => Promise<Sandbox | undefined>);
  runs: SpriteReaperRuns;
  batchSize?: number;
  /**
   * The workspace path of the sandbox. Every adapter uses one fixed workspace path, and
   * `destroy` needs a complete `SandboxRef`. Destruction removes the whole sandbox, so this
   * value never selects which part is removed.
   */
  workspacePath?: string;
  /**
   * Runs after each successful deletion. The worker uses it to count the deletion. The domain
   * holds no metric registry of its own.
   */
  onDestroyed?: (entry: ExpiredSandbox) => void;
  /** The warm snapshots that no row names any more. The reaper removes each one it can. */
  retiredSnapshots?: Pick<WarmSnapshotStore, "listRetired" | "dropRetired">;
  /**
   * Deletes again each sandbox whose earlier delete failed, and answers how many are gone. A
   * check sprite, a setup sandbox and a build-ahead sandbox have no Run reference, so only this
   * pass finds them.
   */
  retryFailedDestroys?: () => Promise<number>;
}

/** The one workspace path every adapter uses. A delete needs a complete `SandboxRef`. */
export const DEFAULT_WORKSPACE_PATH = "/home/sprite/workspace";
const DEFAULT_BATCH_SIZE = 50;

/**
 * SDD section 51. Deletes a sandbox after its retention window has passed. The Proof Pack and
 * the evidence metadata stay in PostgreSQL. Deletion of the sandbox does not remove them. See
 * acceptance test AT-34.
 */
export class SpriteReaper {
  constructor(private readonly options: SpriteReaperOptions) {}

  private async sandboxOf(adapter: string): Promise<Sandbox | undefined> {
    const sandboxes = this.options.sandboxes;
    if (typeof sandboxes === "function") return sandboxes(adapter).catch(() => undefined);
    return sandboxes[adapter];
  }

  async reap(now: Date): Promise<number> {
    const expired = await this.options.runs.listExpiredSandboxes(
      now,
      this.options.batchSize ?? DEFAULT_BATCH_SIZE,
    );
    const workspacePath = this.options.workspacePath ?? DEFAULT_WORKSPACE_PATH;
    let destroyed = 0;
    for (const entry of expired) {
      const sandbox = await this.sandboxOf(entry.adapter);
      // An unknown adapter stays as it is. A cleared reference loses the only record of the
      // sandbox, so an operator could never delete it.
      if (sandbox === undefined) continue;
      try {
        await sandbox.destroy({ id: entry.spriteId, adapter: entry.adapter, workspacePath });
      } catch {
        // One provider fault must not stop the batch. The next pass retries this entry.
        continue;
      }
      await this.options.runs.clearSandbox(entry.tenantId, entry.runId);
      this.options.onDestroyed?.(entry);
      destroyed += 1;
    }
    destroyed += (await this.options.retryFailedDestroys?.()) ?? 0;
    // After the sandboxes: a deleted sandbox no longer reads the snapshot it started from.
    await this.removeRetiredSnapshots();
    return destroyed;
  }

  private async removeRetiredSnapshots(): Promise<void> {
    const store = this.options.retiredSnapshots;
    if (store === undefined) return;
    for (const retired of await store.listRetired(this.options.batchSize ?? DEFAULT_BATCH_SIZE)) {
      const snapshots = (await this.sandboxOf(retired.adapter))?.warmSnapshots;
      if (snapshots === undefined) continue;
      try {
        // False: a live sandbox still reads it. The next pass tries again.
        if (await snapshots.remove(retired.snapshotId)) await store.dropRetired(retired);
      } catch {
        // One provider fault must not stop the batch. The next pass retries this snapshot.
      }
    }
  }
}
