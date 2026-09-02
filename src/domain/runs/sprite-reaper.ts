import type { ExpiredSandboxRun } from "./run-repository.js";
import type { Sandbox } from "./sandbox.js";

export type ExpiredSandbox = ExpiredSandboxRun;

export interface SpriteReaperRuns {
  listExpiredSandboxes(now: Date, limit: number): Promise<ExpiredSandbox[]>;
  clearSandbox(tenantId: string, runId: string): Promise<void>;
}

export interface SpriteReaperOptions {
  sandboxes: Record<string, Sandbox>;
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
}

const DEFAULT_WORKSPACE_PATH = "/home/sprite/workspace";
const DEFAULT_BATCH_SIZE = 50;

/**
 * SDD section 51. Deletes a sandbox after its retention window has passed. The Proof Pack and
 * the evidence metadata stay in PostgreSQL. Deletion of the sandbox does not remove them. See
 * acceptance test AT-34.
 */
export class SpriteReaper {
  constructor(private readonly options: SpriteReaperOptions) {}

  async reap(now: Date): Promise<number> {
    const expired = await this.options.runs.listExpiredSandboxes(
      now,
      this.options.batchSize ?? DEFAULT_BATCH_SIZE,
    );
    const workspacePath = this.options.workspacePath ?? DEFAULT_WORKSPACE_PATH;
    let destroyed = 0;
    for (const entry of expired) {
      const sandbox = this.options.sandboxes[entry.adapter];
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
    return destroyed;
  }
}
