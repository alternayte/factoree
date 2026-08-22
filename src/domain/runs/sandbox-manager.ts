import type { CheckoutResult, RepositorySpec } from "./checkout.js";
import { checkoutPrimary, checkoutReferences, withoutUrlCredentials } from "./checkout.js";
import { RunConfigurationError } from "./run-configuration-error.js";
import type { ProjectDefaults, ProjectRuntimeConfig, VerificationCommand } from "./project-runtime-config.js";
import { toProjectRuntimeConfig } from "./project-runtime-config.js";
import { readRepositoryConfig, readRepositoryInstructions } from "./repository-config-source.js";
import type { CheckpointRef, Sandbox, SandboxRef } from "./sandbox.js";
import { NetworkPolicyNotEnforcedError } from "./sandbox.js";

export interface PrepareSandboxInput {
  runId: string;
  tenantId: string;
  projectId: string;
  primary: RepositorySpec;
  references: RepositorySpec[];
  defaults: ProjectDefaults;
  /** Project test secrets only. SDD section 30 forbids every other credential here. */
  environment?: Record<string, string>;
}

export interface PreparedSandbox {
  ref: SandboxRef;
  checkout: CheckoutResult;
  baselineCheckpoint: CheckpointRef | null;
  /** Built from `.factoree/config.yaml` and the Project defaults. SDD sections 15 and 57. */
  runtime: ProjectRuntimeConfig;
  /** SDD section 35. The deterministic verification commands of this Run. */
  verifyCommands: VerificationCommand[];
  /** SDD section 34. The repository instructions found in the primary checkout. */
  repositoryInstructions: string;
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
 * The hosts a checkout needs. SDD section 32 applies the network policy before the first
 * checkout, and the allow list of the Run lives in a file only the checkout can produce, so the
 * first policy allows exactly the repository hosts and nothing else. A local path carries no
 * host and adds nothing.
 */
const checkoutHosts = (specs: RepositorySpec[]): string[] => {
  const hosts = new Set<string>();
  for (const spec of specs) {
    try {
      const host = new URL(spec.url).hostname.toLowerCase();
      if (host !== "") hosts.add(host);
    } catch {
      // A local path, or an scp-style address. Neither needs egress through the policy.
    }
  }
  return [...hosts].sort();
};

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
      const repositoryHosts = checkoutHosts([input.primary, ...input.references]);

      // Policy one. Only the repository hosts. The file that names the real allow list does not
      // exist yet, so nothing wider may be permitted here.
      await sandbox.applyNetworkPolicy(ref, { allowedDomains: repositoryHosts });

      // The workspace directory must exist before the first checkout. The caller creates it here,
      // because one adapter cannot reliably create the directory at sandbox creation time.
      const mkdir = await sandbox.exec(ref, { file: "mkdir", args: ["-p", ref.workspacePath] });
      if (mkdir.exitCode !== 0) {
        throw new Error(
          `the command "mkdir -p ${ref.workspacePath}" failed with exit code ${mkdir.exitCode}: ` +
            withoutUrlCredentials(mkdir.stderr.trim()),
        );
      }

      const primary = await checkoutPrimary(sandbox, ref, input.primary);

      // SDD section 15. The primary repository owns the configuration of the Run.
      const file = await readRepositoryConfig(sandbox, ref, primary.path);
      const { runtime, verifyCommands } = toProjectRuntimeConfig(file, input.defaults);

      // Policy two. The configured allow list joined with the repository hosts, so the reference
      // checkouts and the bootstrap command both work.
      await sandbox.applyNetworkPolicy(ref, {
        allowedDomains: [...new Set([...repositoryHosts, ...runtime.allowedDomains])].sort(),
      });

      const references = await checkoutReferences(sandbox, ref, input.references);
      const checkout: CheckoutResult = { primary, references };

      if (runtime.bootstrapCommand !== null) {
        const result = await sandbox.exec(ref, {
          file: "sh",
          args: ["-c", runtime.bootstrapCommand],
          cwd: primary.path,
        });
        if (result.exitCode !== 0) {
          // The bootstrap command comes from the repository configuration, so a failure of it is
          // a configuration fault. A retry runs the same command and fails again.
          throw new RunConfigurationError(
            `the bootstrap command failed with exit code ${result.exitCode}: ` +
              withoutUrlCredentials(result.stderr.trim()),
          );
        }
      }

      const repositoryInstructions = await readRepositoryInstructions(sandbox, ref, primary.path);

      // Policy three. The configured allow list alone. Every later step, the Implementer and the
      // verification commands included, runs under exactly what the repository declared.
      // SDD section 29.
      await sandbox.applyNetworkPolicy(ref, { allowedDomains: runtime.allowedDomains });

      const baselineCheckpoint = sandbox.capabilities.supportsCheckpoints
        ? await sandbox.checkpoint(ref, "baseline")
        : null;

      return { ref, checkout, baselineCheckpoint, runtime, verifyCommands, repositoryInstructions };
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
