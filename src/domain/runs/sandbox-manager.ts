import type { CheckoutResult, RepositorySpec } from "./checkout.js";
import {
  checkoutOrganizationSkills,
  checkoutPrimary,
  checkoutReferences,
  refreshPrimary,
  removeReferences,
  withoutUrlCredentials,
} from "./checkout.js";
import { renderSkillLines, SKILL_DIRECTORIES, type SkillScope, type SkillSet } from "./skill-discovery.js";
import type { SkillResolution } from "./skill-registry.js";
import type { SkillRoot } from "./skill-source.js";
import { discoverSkills } from "./skill-source.js";
import { RunConfigurationError } from "./run-configuration-error.js";
import type { PreviewConfig, ProjectDefaults, ProjectRuntimeConfig, VerificationCommand } from "./project-runtime-config.js";
import { toProjectRuntimeConfig } from "./project-runtime-config.js";
import { readRepositoryConfig, readRepositoryInstructions } from "./repository-config-source.js";
import type { CheckpointRef, ProcessRef, Sandbox, SandboxRef } from "./sandbox.js";
import { BROWSER_TOOL_HOSTS, BROWSER_TOOLS_INSTALL_SCRIPT, BROWSER_TOOLS_POLL_MS, BROWSER_TOOLS_WAIT_MS } from "./browser-tools.js";
import { NetworkPolicyNotEnforcedError } from "./sandbox.js";
import { SandboxSlotUnavailableError } from "./sandbox-slot-error.js";
import {
  bootstrapKeyOf,
  keyFilePatternsOf,
  selectKeyFiles,
  type WarmSnapshot,
  type WarmSnapshotStore,
} from "./warm-snapshot.js";
import { bootstrapAllowListOf } from "./project-runtime-config.js";
import { ensureDocker, listRepositoryFiles, seedServices, startServices } from "./services.js";
import { recordStage, type RunStageStore } from "./run-stage.js";
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
   * docs/specs/skill-registry.md. The skill resolution of the registry, with archives the worker
   * already checked. Only a work sprite gets it, because only the implementer receives skills.
   */
  registrySkills?: SkillResolution;
  /**
   * A read-only repository credential, for a private repository. It reaches one git command at a
   * time and never stays inside the sandbox. SDD section 30 forbids a write credential here.
   */
  repositoryCredential?: string;
  /**
   * docs/specs/proof-pack-and-visual-evidence.md. True for a work sprite. A repository with an
   * enabled preview then gets agent-browser for the implementer's self-check. A check sprite runs
   * no agent that browses, so it gets nothing.
   */
  browserTools?: boolean;
  /**
   * docs/specs/run-speed.md. True for a build-ahead: the sandbox serves no run. It starts cold,
   * saves the warm snapshot, and is deleted. `runId` then names the build-ahead, not a run.
   */
  buildAhead?: boolean;
  /**
   * docs/specs/claude-code-runner.md. The model hosts the agent sessions of this sandbox call, for
   * example `api.anthropic.com` for a claude session. The agent phase adds them to the allow list.
   */
  agentHosts?: string[];
}

/** docs/specs/run-speed.md. What one build-ahead did. */
export type BuildAheadOutcome =
  | { kind: "built"; snapshotId: string; bootstrapKey: string }
  | { kind: "skipped"; reason: string };

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
  /** True when agent-browser is installed for the implementer's self-check. */
  selfCheckReady: boolean;
  /** docs/specs/skill-registry.md. Every applied skill of the sandbox, listed in the prompt or not. */
  skillRecords: DeliveredSkill[];
  /** docs/specs/skill-registry.md. The registry resolution the sandbox holds, or null. */
  skillResolution: { set: string | null; id: string } | null;
  /**
   * docs/specs/egress-honesty-and-issue-status.md, DI-21.46. The effective allow list of the agent
   * phase: the run's allow list and the agent hosts of this sandbox, sorted.
   */
  allowedHosts: string[];
}

/** docs/specs/skill-registry.md. One skill that reached a sandbox. SDD section 55 records it. */
export interface DeliveredSkill {
  scope: SkillScope;
  name: string;
  /** The absolute path of its `SKILL.md`. An activation names this path. */
  path: string;
  /** The registry version and archive digest, or null for a skill from a checkout. */
  version: number | null;
  sha256: string | null;
  /** True when the implementer prompt lists the skill. */
  listed: boolean;
}

/** The directory of the registry skills, beside the organization skills checkout. */
export const REGISTRY_SKILLS_DIRECTORY = "registry-skills";

/** docs/specs/skill-registry.md. The record of each applied skill, with its registry version. */
export const deliveredSkillsOf = (set: SkillSet, resolution: SkillResolution | null): DeliveredSkill[] => {
  const pinned = new Map((resolution?.skills ?? []).map((skill) => [skill.name, skill]));
  const listed = new Set(set.skills.map((entry) => entry.name));
  return set.available.map((entry) => {
    const registry = entry.origin.scope === "registry" ? pinned.get(entry.origin.name) : undefined;
    return {
      scope: entry.origin.scope,
      name: entry.name,
      path: entry.origin.path,
      version: registry?.version ?? null,
      sha256: registry?.sha256 ?? null,
      listed: listed.has(entry.name),
    };
  });
};

export interface SandboxManagerOptions {
  sandbox: Sandbox;
  /**
   * docs/specs/proof-pack-and-visual-evidence.md. True when the sandbox runs the Sprite image
   * that `BROWSER_TOOLS_INSTALL_SCRIPT` was proven on. The local adapter runs on the worker host,
   * where the script must not touch the system packages. A function decides by adapter name,
   * because the install settings choose the adapter for each new sandbox.
   */
  installBrowserTools?: boolean | ((sandboxName: string) => boolean);
  /**
   * docs/specs/kiln-sandbox-provider.md. Where the warm snapshot of each repository is recorded.
   * Without it, or on an adapter with no `warmSnapshots`, every sandbox starts cold.
   */
  warmSnapshots?: WarmSnapshotStore;
  /** docs/specs/run-speed.md. The stage rows of each run. The warm snapshot is one stage. */
  stages?: RunStageStore | undefined;
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
 * `pipefail` reports the first failing stage instead. A shell without the option, such as dash
 * 0.5.12 in Debian bookworm, treats a failed `set` as a fatal error of a special builtin and
 * exits with status 2, so `|| true` never runs. The option is therefore tried in a subshell
 * first, and set only where it exists. Such a shell keeps the old behaviour.
 */
const bootstrapScript = (command: string): string =>
  `if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi\n${command}`;

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

  private installsBrowserTools(sandboxName: string): boolean {
    const option = this.options.installBrowserTools;
    return typeof option === "function" ? option(sandboxName) : option === true;
  }

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
    const sandbox = this.options.sandbox;
    // docs/specs/release-0-1-0.md. The install settings choose the provider of each new sandbox.
    await sandbox.refresh?.();
    if (!sandbox.capabilities.enforcesNetworkPolicy && this.options.allowUnenforcedNetwork !== true) {
      throw new NetworkPolicyNotEnforcedError(sandbox.name);
    }

    // docs/specs/kiln-sandbox-provider.md. The run log names the toolchain the sandbox runs.
    if (sandbox.capabilities.supportsCustomImage) {
      this.options.logger?.info("the sandbox runs the Factoree sandbox image", {
        run_id: input.runId,
        adapter: sandbox.name,
        image: sandbox.image ?? "unknown",
      });
    } else {
      this.options.logger?.warn("B-2 is open: the runner CLIs in this sandbox are not root-owned", {
        run_id: input.runId,
        adapter: sandbox.name,
      });
    }

    const warm = await this.warmSnapshotFor(input);
    if (warm !== null) {
      const prepared = await this.prepareIn(input, beforeBootstrap, warm);
      if (prepared !== null) return prepared;
    }
    const prepared = await this.prepareIn(input, beforeBootstrap, null);
    if (prepared === null) throw new Error("a cold sandbox preparation returned no sandbox");
    return prepared;
  }

  /**
   * docs/specs/run-speed.md. True when the stored warm snapshot of the repository belongs to the
   * current template and to `bootstrapKey`, so a build-ahead has nothing to do.
   */
  async hasCurrentWarmSnapshot(input: { tenantId: string; repositoryUrl: string; bootstrapKey: string }): Promise<boolean> {
    const sandbox = this.options.sandbox;
    await sandbox.refresh?.();
    const store = this.options.warmSnapshots;
    if (store === undefined || sandbox.warmSnapshots === undefined) return false;
    const warm = await store.find({ tenantId: input.tenantId, adapter: sandbox.name, repositoryUrl: input.repositoryUrl });
    return warm !== null && warm.template === sandbox.warmSnapshots.template && warm.bootstrapKey === input.bootstrapKey;
  }

  /**
   * docs/specs/run-speed.md. Builds the warm snapshot of one repository before a run needs it: a
   * cold sandbox, the clone, the bootstrap and the warm command, the snapshot, then the delete.
   */
  async buildAhead(input: PrepareSandboxInput): Promise<BuildAheadOutcome> {
    const sandbox = this.options.sandbox;
    await sandbox.refresh?.();
    if (this.options.warmSnapshots === undefined || sandbox.warmSnapshots === undefined) {
      return { kind: "skipped", reason: `the ${sandbox.name} adapter takes no warm snapshot` };
    }
    if (!sandbox.capabilities.enforcesNetworkPolicy && this.options.allowUnenforcedNetwork !== true) {
      throw new NetworkPolicyNotEnforcedError(sandbox.name);
    }
    let built: { snapshotId: string; bootstrapKey: string } | null = null;
    await this.prepareIn({ ...input, buildAhead: true, browserTools: false }, undefined, null, (snapshot) => {
      built = snapshot;
    });
    const result = built as { snapshotId: string; bootstrapKey: string } | null;
    if (result === null) return { kind: "skipped", reason: "the warm snapshot was not saved" };
    return { kind: "built", ...result };
  }

  /** The warm snapshot this Run can start from, or null when it starts cold. */
  private async warmSnapshotFor(input: PrepareSandboxInput): Promise<WarmSnapshot | null> {
    const sandbox = this.options.sandbox;
    const store = this.options.warmSnapshots;
    if (store === undefined || sandbox.warmSnapshots === undefined) return null;
    const warm = await store.find({ tenantId: input.tenantId, adapter: sandbox.name, repositoryUrl: input.primary.url });
    // A snapshot of another template holds an old toolchain or size. The cold run replaces it.
    return warm !== null && warm.template === sandbox.warmSnapshots.template ? warm : null;
  }

  /**
   * One preparation. With `warm`, the sandbox starts from the warm snapshot, and the result is null
   * when the snapshot cannot serve this Run: the restore failed, or `.factoree/config.yaml`
   * changed since the snapshot. The caller then prepares a cold sandbox, which takes a new one.
   */
  private async prepareIn(
    input: PrepareSandboxInput,
    beforeBootstrap: ((ref: SandboxRef, primaryPath: string) => Promise<void>) | undefined,
    warm: WarmSnapshot | null,
    onSaved?: (snapshot: { snapshotId: string; bootstrapKey: string }) => void,
  ): Promise<PreparedSandbox | null> {
    const sandbox = this.options.sandbox;
    const createInput = {
      runId: input.runId,
      tenantId: input.tenantId,
      productId: input.productId,
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    };
    let ref: SandboxRef;
    if (warm === null || sandbox.warmSnapshots === undefined) {
      ref = await sandbox.create(createInput);
    } else {
      try {
        ref = await sandbox.warmSnapshots.restore(createInput, warm.snapshotId);
      } catch (error) {
        // DI-15.14. A full provider says nothing about the snapshot, and a cold start needs a slot too.
        if (error instanceof SandboxSlotUnavailableError) throw error;
        this.options.logger?.warn("the warm snapshot did not restore, so the sandbox starts cold", {
          run_id: input.runId,
          snapshot_id: warm.snapshotId,
          detail: String(error).slice(0, 500),
        });
        await this.options.warmSnapshots?.forget(warm);
        // No row names the snapshot now, and it still holds disk on the provider.
        await this.options.warmSnapshots?.retire({ tenantId: warm.tenantId, adapter: warm.adapter, snapshotId: warm.snapshotId });
        return null;
      }
      this.options.logger?.info("the sandbox starts from the warm snapshot", {
        run_id: input.runId,
        snapshot_id: warm.snapshotId,
      });
    }

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

      const primary =
        warm === null
          ? await checkoutPrimary(sandbox, ref, input.primary, input.repositoryCredential)
          : await refreshPrimary(sandbox, ref, input.primary, input.repositoryCredential);

      // SDD section 15. The primary repository owns the configuration of the Run.
      const file = await readRepositoryConfig(sandbox, ref, primary.path);
      const { runtime, verifyCommands, preview } = toProjectRuntimeConfig(file, input.defaults);
      // docs/specs/claude-code-runner.md. The Product selects the runners, and the run log says so.
      if (runtime.agentsBlockIgnored === true) {
        this.options.logger?.warn("Factoree ignores the agents block of .factoree/config.yaml: the Product selects the runner of each role", {
          run_id: input.runId,
          step: "prepare",
        });
      }

      // docs/specs/run-speed.md. A warm snapshot ran one bootstrap command, one warm command and one
      // allow list. A change of any of them means the snapshot no longer fits, and the cold run
      // takes a new one. A change to any other field keeps the snapshot.
      // docs/specs/repository-setup-and-services.md. The compose stack and the key files join the key.
      const bootstrapKey = bootstrapKeyOf({
        bootstrapCommand: runtime.bootstrapCommand,
        warmCommand: runtime.warmCommand ?? null,
        allowedDomains: bootstrapAllowListOf(runtime),
        services: runtime.services ?? null,
        docker: runtime.docker === true,
        files: selectKeyFiles(await listRepositoryFiles(sandbox, ref, primary.path), keyFilePatternsOf(runtime)),
      });
      if (warm !== null && bootstrapKey !== warm.bootstrapKey) {
        this.options.logger?.info("the bootstrap key changed since the warm snapshot, so the sandbox starts cold", {
          run_id: input.runId,
          snapshot_id: warm.snapshotId,
        });
        await sandbox.destroy(ref).catch(() => undefined);
        return null;
      }

      if (beforeBootstrap !== undefined) await beforeBootstrap(ref, primary.path);

      // docs/specs/proof-pack-and-visual-evidence.md. A work sprite with a preview gets the browser
      // tools for the implementer's self-check. The install runs beside the bootstrap, under
      // policy two, so no agent ever runs with its hosts.
      // The sandbox image already holds the tools, so such a sandbox installs nothing.
      const wantsBrowserTools = input.browserTools === true && preview !== null && preview.enabled;
      const browserTools =
        wantsBrowserTools && !sandbox.capabilities.supportsCustomImage && this.installsBrowserTools(sandbox.name);

      // Policy two. The configured allow list joined with the repository hosts, so the reference
      // checkouts and the bootstrap command both work.
      await sandbox.applyNetworkPolicy(ref, {
        allowedDomains: [
          ...new Set([...repositoryHosts, ...bootstrapAllowListOf(runtime), ...(browserTools ? BROWSER_TOOL_HOSTS : [])]),
        ].sort(),
      });
      const install = browserTools
        ? await sandbox.startProcess(ref, { file: "sh", args: ["-c", BROWSER_TOOLS_INSTALL_SCRIPT], cwd: "/" })
        : null;

      if (warm !== null) await removeReferences(sandbox, ref);
      const references = await checkoutReferences(sandbox, ref, input.references, input.repositoryCredential);
      const checkout: CheckoutResult = { primary, references };

      // docs/specs/repository-setup-and-services.md. Rootless Docker and the compose stack start
      // under policy two, before the bootstrap, so a bootstrap can migrate the database. A warm
      // sandbox already holds them, and both calls change nothing on a healthy stack.
      const services = runtime.services ?? null;
      if (runtime.docker === true) {
        const servicesStarted = Date.now();
        await ensureDocker(sandbox, ref);
        if (services !== null) await startServices(sandbox, ref, primary.path, services);
        this.options.logger?.info("the services are ready", {
          run_id: input.runId,
          step: "prepare_services",
          warm: warm !== null,
          duration_ms: Date.now() - servicesStarted,
        });
      }

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

      // The seed fills the stack once. A warm sandbox holds the seeded data of its snapshot.
      if (services !== null && warm === null) await seedServices(sandbox, ref, primary.path, services);

      const selfCheckReady = sandbox.capabilities.supportsCustomImage
        ? wantsBrowserTools
        : install === null
          ? false
          : await this.awaitBrowserTools(ref, install, input.runId);

      // docs/specs/kiln-sandbox-provider.md. A cold work sprite saves itself here, after the clone
      // and the bootstrap and before any agent runs. A check sprite holds the patch, so it never
      // saves itself.
      if (warm === null && beforeBootstrap === undefined) {
        const saved = await this.saveWarmSnapshot(input, ref, primary.path, runtime.warmCommand ?? null, bootstrapKey);
        if (saved !== null) onSaved?.({ snapshotId: saved, bootstrapKey });
      }

      // docs/specs/run-speed.md. A build-ahead serves no run, so its sandbox goes once the
      // snapshot exists.
      if (input.buildAhead === true) {
        await sandbox.destroy(ref);
        return null;
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
      const allowedHosts = [...new Set([...runtime.allowedDomains, ...(input.agentHosts ?? [])])].sort();
      await sandbox.applyNetworkPolicy(ref, { allowedDomains: allowedHosts });

      // SDD section 16. Discovery runs on the checkouts, in precedence order. A repository skill
      // always precedes an organization skill of the same name. Discovery needs no egress, so it
      // runs after the policy is narrowed.
      // docs/specs/skill-registry.md. The registry skills rank after the repository skills and
      // before the organization skills. They live outside the checkout, so no registry skill
      // reaches `git status` or the verified patch.
      const registryRoot =
        input.registrySkills === undefined ? null : await this.deliverRegistrySkills(sandbox, ref, input.registrySkills);
      const roots: SkillRoot[] = [{ scope: "repository", path: primary.path }];
      if (registryRoot !== null) roots.push({ scope: "registry", path: registryRoot });
      if (organizationSkills !== null) roots.push({ scope: "organization", path: organizationSkills.path });
      const skillSet = await discoverSkills(sandbox, ref, roots, this.options.logger);
      const skills = renderSkillLines(skillSet);

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
        selfCheckReady,
        skillRecords: deliveredSkillsOf(skillSet, input.registrySkills ?? null),
        skillResolution:
          input.registrySkills === undefined ? null : { set: input.registrySkills.set, id: input.registrySkills.id },
        allowedHosts,
      };
    } catch (error) {
      // A half-prepared sandbox must not leak. Destruction is idempotent, and a destroy failure
      // must not mask the original error.
      await sandbox.destroy(ref).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Waits for the browser tool install. A failed or slow install costs the implementer its
   * self-check and nothing else, because the self-check is never evidence. The log names why.
   */
  /**
   * docs/specs/skill-registry.md. Unpacks each checked archive into its own directory below
   * `registry-skills/.agents/skills`, then makes the tree read-only. `Sandbox.writeFile` carries
   * text, so each archive travels as base64 and `base64 -d` restores the bytes. The registry
   * adapter already refused an archive with a link or an entry outside its root.
   */
  private async deliverRegistrySkills(sandbox: Sandbox, ref: SandboxRef, resolution: SkillResolution): Promise<string> {
    const root = `${ref.workspacePath}/${REGISTRY_SKILLS_DIRECTORY}`;
    const skillsDirectory = `${root}/${SKILL_DIRECTORIES[0]}`;
    const staging = `${root}/.archives`;
    const exec = async (args: string[], what: string): Promise<void> => {
      const result = await sandbox.exec(ref, { file: "sh", args: ["-c", ...args], cwd: "/" });
      if (result.exitCode !== 0) {
        throw new Error(`${what} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`);
      }
    };
    await exec(['mkdir -p -- "$0" "$1"', skillsDirectory, staging], "creating the registry skills directory");
    for (const skill of resolution.skills) {
      const encoded = `${staging}/${skill.name}.b64`;
      await sandbox.writeFile(ref, encoded, Buffer.from(skill.archive).toString("base64"));
      await exec(
        ['mkdir -p -- "$1" && base64 -d < "$0" | tar -xzf - --no-same-owner --no-same-permissions -C "$1"', encoded, `${skillsDirectory}/${skill.name}`],
        `unpacking the registry skill "${skill.name}"`,
      );
    }
    // SDD section 29 denies writing what the agent must only read. This is a file mode.
    await exec(['rm -rf -- "$1" && chmod -R a-w "$0"', root, staging], "closing the registry skills directory");
    return root;
  }

  private async awaitBrowserTools(ref: SandboxRef, install: ProcessRef, runId: string): Promise<boolean> {
    const sandbox = this.options.sandbox;
    const deadline = Date.now() + BROWSER_TOOLS_WAIT_MS;
    for (;;) {
      const snapshot = await sandbox.readProcess(ref, install);
      if (!snapshot.running) {
        if (snapshot.exitCode === 0) return true;
        this.options.logger?.warn("the browser tool install failed, so the implementer has no self-check", {
          run_id: runId,
          exit_code: snapshot.exitCode ?? -1,
          detail: withoutUrlCredentials(bootstrapFailureDetail(snapshot.stdout, snapshot.stderr)).slice(-500),
        });
        return false;
      }
      if (Date.now() >= deadline) {
        await sandbox.cancelProcess(ref, install).catch(() => undefined);
        this.options.logger?.warn("the browser tool install did not finish, so the implementer has no self-check", {
          run_id: runId,
        });
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, BROWSER_TOOLS_POLL_MS));
    }
  }

  /**
   * docs/specs/run-speed.md. Runs the warm command of the repository, which fills its build
   * caches. A failure is logged and recorded on the snapshot, and the snapshot is still taken: a
   * base commit that does not build must not stop every run, and a partial build cache is still
   * valid input to an incremental build. Answers the exit code of a failed command, or null.
   */
  private async runWarmCommand(input: PrepareSandboxInput, ref: SandboxRef, primaryPath: string, command: string): Promise<number | null> {
    const result = await this.options.sandbox.exec(ref, {
      file: "sh",
      args: ["-c", bootstrapScript(command)],
      cwd: primaryPath,
    });
    this.options.logger?.info("the warm command ran before the warm snapshot", {
      run_id: input.runId,
      exit_code: result.exitCode,
    });
    if (result.exitCode === 0) return null;
    this.options.logger?.warn("the warm command failed, so the warm snapshot holds a partial build cache", {
      run_id: input.runId,
      exit_code: result.exitCode,
      detail: withoutUrlCredentials(bootstrapFailureDetail(result.stdout, result.stderr)).slice(-500),
    });
    return result.exitCode;
  }

  /**
   * Runs the warm command, then takes the warm snapshot of the repository and records it. The old
   * snapshot goes once the new one is recorded. A failure here costs the next run its warm start
   * and nothing else. Answers the snapshot id, or null when none was saved.
   */
  private async saveWarmSnapshot(
    input: PrepareSandboxInput,
    ref: SandboxRef,
    primaryPath: string,
    warmCommand: string | null,
    bootstrapKey: string,
  ): Promise<string | null> {
    const sandbox = this.options.sandbox;
    const store = this.options.warmSnapshots;
    if (store === undefined || sandbox.warmSnapshots === undefined) return null;
    const startedAt = new Date();
    try {
      const warmCommandExitCode = warmCommand === null ? null : await this.runWarmCommand(input, ref, primaryPath, warmCommand);
      const snapshotId = await sandbox.warmSnapshots.take(ref);
      const replaced = await store.save({
        tenantId: input.tenantId,
        adapter: sandbox.name,
        repositoryUrl: input.primary.url,
        template: sandbox.warmSnapshots.template,
        bootstrapKey,
        warmCommandExitCode,
        snapshotId,
      });
      if (replaced !== null) {
        // The record comes first, so a remove that throws or that the provider refuses because a
        // live sandbox still reads the snapshot leaves it to the reaper, and never orphans it.
        const retired = { tenantId: replaced.tenantId, adapter: replaced.adapter, snapshotId: replaced.snapshotId };
        await store.retire(retired);
        if (await sandbox.warmSnapshots.remove(replaced.snapshotId)) await store.dropRetired(retired);
      }
      this.options.logger?.info("the warm snapshot of the repository is saved", {
        run_id: input.runId,
        snapshot_id: snapshotId,
      });
      return snapshotId;
    } catch (error) {
      this.options.logger?.warn("the warm snapshot was not saved", {
        run_id: input.runId,
        detail: String(error).slice(0, 500),
      });
      return null;
    } finally {
      // A build-ahead serves no run, so it has no run stage row.
      if (input.buildAhead !== true && this.options.logger !== undefined) {
        await recordStage(this.options.stages, this.options.logger, {
          tenantId: input.tenantId,
          runId: input.runId,
          stage: "warm_snapshot",
          attempt: 1,
          sandboxId: ref.id,
          startedAt,
          endedAt: new Date(),
        });
      }
    }
  }

  async release(prepared: PreparedSandbox): Promise<void> {
    await this.options.sandbox.destroy(prepared.ref);
  }
}
