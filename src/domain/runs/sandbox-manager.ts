import type { CheckoutResult, RepositorySpec } from "./checkout.js";
import { checkoutRepositories, withoutUrlCredentials } from "./checkout.js";
import { RunConfigurationError } from "./run-configuration-error.js";
import type { ProjectRuntimeConfig } from "./project-runtime-config.js";
import type { CheckpointRef, Sandbox, SandboxRef } from "./sandbox.js";
import { NetworkPolicyNotEnforcedError } from "./sandbox.js";

export interface PrepareSandboxInput {
  runId: string;
  tenantId: string;
  projectId: string;
  primary: RepositorySpec;
  references: RepositorySpec[];
  config: ProjectRuntimeConfig;
  /** Project test secrets only. SDD section 30 forbids every other credential here. */
  environment?: Record<string, string>;
}

export interface PreparedSandbox {
  ref: SandboxRef;
  checkout: CheckoutResult;
  baselineCheckpoint: CheckpointRef | null;
}

export interface SandboxManagerOptions {
  sandbox: Sandbox;
  /**
   * Permits an adapter that cannot enforce an egress policy. Only the test suite and local
   * development set this value to true. Production must leave it false. SDD section 29 denies
   * arbitrary outbound network access, and a prompt is not a boundary.
   */
  allowUnenforcedNetwork?: boolean;
}

/**
 * SDD section 32. Drives the sandbox lifecycle in the required order: create, apply network
 * policy, create the workspace directory, checkout the primary repository, checkout the
 * reference repositories, bootstrap, checkpoint the baseline.
 *
 * The Fly Sprites adapter cannot reliably create the workspace directory at sandbox creation
 * time. `SandboxManager` creates the directory itself, so both adapters get a workspace that
 * exists before the first checkout.
 */
export class SandboxManager {
  constructor(private readonly options: SandboxManagerOptions) {}

  async prepare(input: PrepareSandboxInput): Promise<PreparedSandbox> {
    if (!this.options.sandbox.capabilities.enforcesNetworkPolicy && this.options.allowUnenforcedNetwork !== true) {
      throw new NetworkPolicyNotEnforcedError(this.options.sandbox.name);
    }

    const sandbox = this.options.sandbox;
    const ref = await sandbox.create({
      runId: input.runId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    });

    try {
      // The policy comes before every command. No checkout and no bootstrap can therefore reach
      // a domain outside the allow list.
      await sandbox.applyNetworkPolicy(ref, { allowedDomains: input.config.allowedDomains });

      // The workspace directory must exist before the first checkout. The caller creates it here,
      // because one adapter cannot reliably create the directory at sandbox creation time.
      const mkdir = await sandbox.exec(ref, { file: "mkdir", args: ["-p", ref.workspacePath] });
      if (mkdir.exitCode !== 0) {
        throw new Error(
          `the command "mkdir -p ${ref.workspacePath}" failed with exit code ${mkdir.exitCode}: ` +
            withoutUrlCredentials(mkdir.stderr.trim()),
        );
      }

      const checkout = await checkoutRepositories(sandbox, ref, {
        primary: input.primary,
        references: input.references,
      });

      if (input.config.bootstrapCommand !== null) {
        const result = await sandbox.exec(ref, {
          file: "sh",
          args: ["-c", input.config.bootstrapCommand],
          cwd: checkout.primary.path,
        });
        if (result.exitCode !== 0) {
          // The bootstrap command comes from the Project configuration, so a failure of it is a
          // configuration fault. A retry runs the same command and fails again.
          throw new RunConfigurationError(
            `the bootstrap command failed with exit code ${result.exitCode}: ` +
              withoutUrlCredentials(result.stderr.trim()),
          );
        }
      }

      const baselineCheckpoint = sandbox.capabilities.supportsCheckpoints
        ? await sandbox.checkpoint(ref, "baseline")
        : null;

      return { ref, checkout, baselineCheckpoint };
    } catch (error) {
      // A half-prepared sandbox must not leak. Destruction is idempotent, and a destroy failure
      // must not mask the original error.
      await sandbox.destroy(ref).catch(() => undefined);
      throw error;
    }
  }

  async release(prepared: PreparedSandbox): Promise<void> {
    await this.options.sandbox.destroy(prepared.ref);
  }
}
