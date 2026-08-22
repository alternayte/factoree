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
      // The Run now holds no reference to this sandbox, and a Temporal retry creates a new one.
      // The unreferenced sandbox must go now, because the reaper can never find it.
      await dependencies.sandboxManager.release(prepared).catch(() => undefined);
      throw error;
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
   * An explicit early teardown. The normal terminal path does not call this activity. SDD
   * section 51 keeps the sandbox for the retention window, and `SpriteReaper` deletes it later.
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
