import type { CheckoutResult, RepositorySpec } from "./checkout.js";
import { checkoutOrganizationSkills, checkoutPrimary, checkoutReferences, withoutUrlCredentials } from "./checkout.js";
import { renderSkillLines } from "./skill-discovery.js";
import type { SkillRoot } from "./skill-source.js";
import { discoverSkills } from "./skill-source.js";
import { RunConfigurationError } from "./run-configuration-error.js";
import type { PreviewConfig, ProjectDefaults, ProjectRuntimeConfig, VerificationCommand } from "./project-runtime-config.js";
import { toProjectRuntimeConfig } from "./project-runtime-config.js";
import { readRepositoryConfig, readRepositoryInstructions } from "./repository-config-source.js";
import type { CheckpointRef, Sandbox, SandboxRef } from "./sandbox.js";
import { NetworkPolicyNotEnforcedError } from "./sandbox.js";
import type { Logger } from "~/telemetry/logger.js";

export interface PrepareSandboxInput {
  runId: string;
  tenantId: string;
  productId: string;
  primary: RepositorySpec;
  references: RepositorySpec[];
  defaults: ProjectDefaults;
  /** Project test secrets only. SDD section 30 forbids every other credential here. */
  environment?: Record<string, string>;
  /** SDD section 16. The organization-wide skills repository of the Project, when it has one. */
  organizationSkills?: RepositorySpec;
  /**
   * A read-only repository credential, for a private repository. It reaches one git command at a
   * time and never stays inside the sandbox. SDD section 30 forbids a write credential here.
   */
  repositoryCredential?: string;
}

export interface PreparedSandbox {
  ref: SandboxRef;
  checkout: CheckoutResult;
  baselineCheckpoint: CheckpointRef | null;
  /** Built from `.factoree/config.yaml` and the Project defaults. SDD sections 15 and 57. */
  runtime: ProjectRuntimeConfig;
  /** SDD section 35. The deterministic verification commands of this Run. */
  verifyCommands: VerificationCommand[];
  /** SDD sections 15 and 37. The preview the User Validator starts. */
  preview: PreviewConfig | null;
  /** SDD section 34. The repository instructions found in the primary checkout. */
  repositoryInstructions: string;
  /**
   * SDD section 16 and section 34. The applicable skills of this Run, already rendered as prompt
   * lines. Each line names the skill, its description, its scope, and its path. A name conflict
   * carries its own line, so no skill is ever overwritten silently.
   */
  skills: string[];
  /**
   * SDD section 55. The commit the organization skills checkout resolved to. It is absent when
   * the Project configures no organization skills repository.
   */
  organizationSkillsSha?: string;
}

export interface SandboxManagerOptions {
  sandbox: Sandbox;
  /**
   * Permits an adapter that cannot enforce an egress policy. Only the test suite and local
   * development set this value to true. Production must leave it false. SDD section 29 denies
   * arbitrary outbound network access, and a prompt is not a boundary.
   */
  allowUnenforcedNetwork?: boolean;
  /**
   * Reports an unexpected skill read failure at debug level. SDD section 16. Optional so every
   * existing `new SandboxManager({ sandbox })` call still compiles.
   */
  logger?: Logger;
}

/**
 * The hosts a checkout needs. SDD section 32 applies the network policy before the first
 * checkout, and the allow list of the Run lives in a file only the checkout can produce, so the
 * first policy allows exactly the repository hosts and nothing else. A local path carries no
 * host and adds nothing.
 */
/**
 * Wraps the bootstrap command so a failing stage of a pipeline fails the command.
 *
 * A shell reports the status of the last stage of a pipeline only. The common installer form
 * `curl ... | bash` therefore exits 0 when the download fails, because the shell that reads the
 * empty script exits 0. The Run then continues with nothing installed, and it fails much later,
 * with an error that names a missing tool rather than the download that never happened.
 *
 * `pipefail` reports the first failing stage instead. A shell that does not support the option
 * prints to stderr and returns non-zero, and `|| true` keeps such a shell on the old behaviour
 * rather than failing every bootstrap.
 */
const bootstrapScript = (command: string): string =>
  `set -o pipefail 2>/dev/null || true\n${command}`;

/** The output of a failed bootstrap. An installer reports its reason on either stream. */
const bootstrapFailureDetail = (stdout: string, stderr: string): string => {
  const parts = [stderr.trim(), stdout.trim()].filter((part) => part.length > 0);
  return parts.length === 0 ? "the command wrote no output" : parts.join(" | ");
};

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

  /**
   * `beforeBootstrap` runs after the primary checkout and the read of `.factoree/config.yaml`,
   * and before the reference checkouts and the bootstrap. A check sprite applies the captured
   * patch there: the configuration comes from the base SHA, and the bootstrap installs the
   * patched dependencies. See docs/specs/check-isolation.md.
   */
  async prepare(
    input: PrepareSandboxInput,
    beforeBootstrap?: (ref: SandboxRef, primaryPath: string) => Promise<void>,
  ): Promise<PreparedSandbox> {
    if (!this.options.sandbox.capabilities.enforcesNetworkPolicy && this.options.allowUnenforcedNetwork !== true) {
      throw new NetworkPolicyNotEnforcedError(this.options.sandbox.name);
    }

    const sandbox = this.options.sandbox;
    const ref = await sandbox.create({
      runId: input.runId,
      tenantId: input.tenantId,
      productId: input.productId,
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    });

    // Both adapters deliver the environment through this call. `SandboxCreateInput.environment`
    // alone reaches neither a Sprite exec nor a local child process.
    sandbox.attachEnvironment(ref, input.environment ?? {});

    try {
      // The organization skills repository is checked out under the first policy, so its host
      // must be allowed there.
      const specs = [input.primary, ...input.references];
      if (input.organizationSkills !== undefined) specs.push(input.organizationSkills);
      const repositoryHosts = checkoutHosts(specs);

      // Policy one. Only the repository hosts. The file that names the real allow list does not
      // exist yet, so nothing wider may be permitted here.
      await sandbox.applyNetworkPolicy(ref, { allowedDomains: repositoryHosts });

      // The workspace directory must exist before the first checkout. The caller creates it here,
      // because one adapter cannot reliably create the directory at sandbox creation time.
      // The command runs at the root, not at the default working directory. An adapter defaults
      // the working directory to the workspace path, and that directory is what this command
      // creates. A missing working directory fails the command before it starts.
      const mkdir = await sandbox.exec(ref, { file: "mkdir", args: ["-p", ref.workspacePath], cwd: "/" });
      if (mkdir.exitCode !== 0) {
        throw new Error(
          `the command "mkdir -p ${ref.workspacePath}" failed with exit code ${mkdir.exitCode}: ` +
            withoutUrlCredentials(mkdir.stderr.trim()),
        );
      }

      const primary = await checkoutPrimary(sandbox, ref, input.primary, input.repositoryCredential);

      // SDD section 15. The primary repository owns the configuration of the Run.
      const file = await readRepositoryConfig(sandbox, ref, primary.path);
      const { runtime, verifyCommands, preview } = toProjectRuntimeConfig(file, input.defaults);

      if (beforeBootstrap !== undefined) await beforeBootstrap(ref, primary.path);

      // Policy two. The configured allow list joined with the repository hosts, so the reference
      // checkouts and the bootstrap command both work.
      await sandbox.applyNetworkPolicy(ref, {
        allowedDomains: [...new Set([...repositoryHosts, ...runtime.allowedDomains])].sort(),
      });

      const references = await checkoutReferences(sandbox, ref, input.references, input.repositoryCredential);
      const checkout: CheckoutResult = { primary, references };

      if (runtime.bootstrapCommand !== null) {
        const result = await sandbox.exec(ref, {
          file: "sh",
          args: ["-c", bootstrapScript(runtime.bootstrapCommand)],
          cwd: primary.path,
        });
        if (result.exitCode !== 0) {
          // The bootstrap command comes from the repository configuration, so a failure of it is
          // a configuration fault. A retry runs the same command and fails again.
          throw new RunConfigurationError(
            `the bootstrap command failed with exit code ${result.exitCode}: ` +
              withoutUrlCredentials(bootstrapFailureDetail(result.stdout, result.stderr)),
          );
        }
      }

      const repositoryInstructions = await readRepositoryInstructions(sandbox, ref, primary.path);

      // SDD section 16. The organization skills repository is read-only, and it lives outside
      // the `reference/` tree. It is checked out while the checkout hosts are still allowed.
      const organizationSkills =
        input.organizationSkills === undefined
          ? null
          : await checkoutOrganizationSkills(
              sandbox,
              ref,
              input.organizationSkills,
              input.repositoryCredential,
            );

      // Policy three. The configured allow list alone. Every later step, the Implementer and the
      // verification commands included, runs under exactly what the repository declared.
      // SDD section 29.
      await sandbox.applyNetworkPolicy(ref, { allowedDomains: runtime.allowedDomains });

      // SDD section 16. Discovery runs on the checkouts, in precedence order. A repository skill
      // always precedes an organization skill of the same name. Discovery needs no egress, so it
      // runs after the policy is narrowed.
      const roots: SkillRoot[] = [{ scope: "repository", path: primary.path }];
      if (organizationSkills !== null) roots.push({ scope: "organization", path: organizationSkills.path });
      const skills = renderSkillLines(await discoverSkills(sandbox, ref, roots, this.options.logger));

      const baselineCheckpoint = sandbox.capabilities.supportsCheckpoints
        ? await sandbox.checkpoint(ref, "baseline")
        : null;

      return {
        ref,
        checkout,
        baselineCheckpoint,
        runtime,
        verifyCommands,
        preview,
        repositoryInstructions,
        skills,
        ...(organizationSkills === null ? {} : { organizationSkillsSha: organizationSkills.baseSha }),
      };
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
