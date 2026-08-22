import type { Logger } from "~/telemetry/logger.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import type { SpriteReaper } from "~/domain/runs/sprite-reaper.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import type { ProjectRuntimeConfig } from "~/domain/runs/project-runtime-config.js";
import type { RepositorySpec } from "~/domain/runs/checkout.js";
import { metrics } from "~/telemetry/metrics.js";

export interface SandboxActivityDependencies {
  sandboxManager: SandboxManager;
  sandbox: Sandbox;
  runs: RunRepository;
  reaper: SpriteReaper;
  logger: Logger;
}

export interface PrepareSandboxActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  primary: RepositorySpec;
  references: RepositorySpec[];
  config: ProjectRuntimeConfig;
  environment: Record<string, string>;
}

export interface PrepareSandboxActivityOutput {
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  baseSha: string;
  referencePaths: string[];
  baselineCheckpointId: string | null;
}

const MILLISECONDS_PER_HOUR = 3_600_000;

/**
 * Deletes one sandbox and reports a failure at error level. A silent failure hides a leak, and
 * an operator must be able to see the sandbox that stayed behind.
 */
const release = async (
  dependencies: SandboxActivityDependencies,
  spriteId: string,
  adapter: string,
  destroy: () => Promise<void>,
): Promise<void> => {
  try {
    await destroy();
  } catch (error) {
    dependencies.logger.error("the sandbox was not deleted and is now unreferenced", {
      sprite_id: spriteId,
      adapter,
      error: String(error),
      step: "prepare",
    });
  }
};

export const createSandboxActivities = (dependencies: SandboxActivityDependencies) => ({
  async prepareSandbox(input: PrepareSandboxActivityInput): Promise<PrepareSandboxActivityOutput> {
    const prepared = await dependencies.sandboxManager.prepare({
      runId: input.runId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      primary: input.primary,
      references: input.references,
      config: input.config,
      environment: input.environment,
    });

    // SDD section 51. The Run keeps the sandbox reference and the retention deadline, so
    // `SpriteReaper` can delete the sandbox after the window ends. The workflow never deletes
    // it, because SDD section 32 orders RETAIN before DELETE.
    // A retry of this activity prepares a second sandbox, because `prepare` creates a new one
    // for each call. The sandbox the Run already holds must go, otherwise the overwrite below
    // makes it unreferenced and the reaper can never find it. Factoree reads the reference
    // before the overwrite, and deletes that sandbox after the overwrite has committed. An
    // idempotent `prepare` was the alternative. It was rejected, because a partly prepared
    // sandbox from a crashed attempt has an unknown checkout state, and reuse of it would carry
    // that state into the new attempt.
    const previous = await dependencies.runs.findById(input.tenantId, input.runId);

    const retainUntil = new Date(Date.now() + input.config.spriteRetentionHours * MILLISECONDS_PER_HOUR);
    try {
      await dependencies.runs.setSandbox(input.tenantId, input.runId, {
        spriteId: prepared.ref.id,
        adapter: prepared.ref.adapter,
        retainUntil,
        baseSha: prepared.checkout.primary.baseSha,
        implementerRunner: input.config.implementerRunner,
      });
    } catch (error) {
      // The Run holds no reference to this sandbox, and a Temporal retry creates a new one. The
      // unreferenced sandbox must go now.
      await release(dependencies, prepared.ref.id, prepared.ref.adapter, () =>
        dependencies.sandboxManager.release(prepared),
      );
      throw error;
    }

    if (previous?.spriteId != null && previous.spriteId !== prepared.ref.id) {
      const staleId = previous.spriteId;
      const staleAdapter = previous.spriteAdapter ?? dependencies.sandbox.name;
      await release(dependencies, staleId, staleAdapter, () =>
        dependencies.sandbox.destroy({
          id: staleId,
          adapter: staleAdapter,
          workspacePath: prepared.ref.workspacePath,
        }),
      );
      metrics.sandboxesDestroyed.inc({ adapter: staleAdapter, reason: "SUPERSEDED" });
    }

    metrics.sandboxesCreated.inc({
      tenant_id: input.tenantId,
      project_id: input.projectId,
      adapter: prepared.ref.adapter,
    });
    dependencies.logger.info("sandbox prepared", {
      tenant_id: input.tenantId,
      project_id: input.projectId,
      run_id: input.runId,
      sprite_id: prepared.ref.id,
      base_sha: prepared.checkout.primary.baseSha,
      step: "prepare",
    });

    return {
      spriteId: prepared.ref.id,
      adapter: prepared.ref.adapter,
      workspacePath: prepared.ref.workspacePath,
      primaryPath: prepared.checkout.primary.path,
      baseSha: prepared.checkout.primary.baseSha,
      referencePaths: prepared.checkout.references.map((entry) => entry.path),
      baselineCheckpointId: prepared.baselineCheckpoint?.id ?? null,
    };
  },

  /**
   * An explicit early teardown. This activity is reserved for a later phase that needs one, for
   * example an operator command. The normal terminal path never calls it. SDD section 51 keeps
   * the sandbox for the retention window, and `SpriteReaper` deletes it later.
   */
  async destroySandbox(input: {
    tenantId: string;
    runId: string;
    spriteId: string;
    adapter: string;
    workspacePath: string;
    reason: string;
  }): Promise<void> {
    await dependencies.sandbox.destroy({
      id: input.spriteId,
      adapter: input.adapter,
      workspacePath: input.workspacePath,
    });
    await dependencies.runs.clearSandbox(input.tenantId, input.runId);
    metrics.sandboxesDestroyed.inc({ adapter: input.adapter, reason: input.reason });
  },

  async reapExpiredSandboxes(): Promise<number> {
    return await dependencies.reaper.reap(new Date());
  },
});
