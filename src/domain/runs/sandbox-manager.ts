import type { CheckedOutRepository, CheckoutResult, RepositorySpec } from "./checkout.js";
import {
  checkoutOrganizationSkills,
  checkoutPrimary,
  checkoutTarget,
  overlayPullRequestHead,
  checkoutReferences,
  movePrimaryToTarget,
  refreshPrimary,
  refreshTarget,
  removeIgnoredFiles,
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
  setBootstrapKeyOf,
  snapshotSubjectOf,
  type SetMemberKey,
  type WarmSnapshot,
  type WarmSnapshotStore,
} from "./warm-snapshot.js";
import { bootstrapAllowListOf } from "./project-runtime-config.js";
import {
  composeProjectOf,
  ensureDocker,
  listRepositoryFiles,
  seedServices,
  startServices,
  stopServices,
  targetEnvironmentOf,
} from "./services.js";
import { recordStage, type RunStageStore } from "./run-stage.js";
import type { Logger } from "~/telemetry/logger.js";
import { credentialKeyOf, NO_HOST_CREDENTIALS, type HostCredentialAccess } from "~/domain/products/host-credentials.js";
import {
  applyEgress,
  assertBindable,
  githubRepositoriesOf,
  probeCredentialHosts,
  type CredentialBindingStore,
  type CredentialEgress,
} from "./credential-egress.js";

export interface PrepareSandboxInput {
  runId: string;
  tenantId: string;
  productId: string;
  primary: RepositorySpec;
  references: RepositorySpec[];
  defaults: ProjectDefaults;
  /**
   * docs/specs/change-sets.md. Every target of a change set, in set order, each with its own
   * read-only credential. Two or more check out at `<workspace>/targets/<owner>/<repo>`, and
   * `primary` then names the first of them. Absent, or one entry, for a run with one target.
   */
  targets?: TargetSpec[];
  /**
   * docs/specs/change-sets.md, DI-21.138. The other repositories of the product that the refiner
   * reads. `read` clones them while the checkout hosts are still allowed, through `clone_sibling`.
   * Only the work sprite of a run that can add a target gets it.
   */
  siblings?: SiblingReader;
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
  /**
   * docs/specs/sandbox-provider-spillover.md. The sandbox provider of the sandbox: the one the run is
   * pinned to, or the one a build-ahead builds for. Absent means the default provider.
   */
  provider?: string;
  /**
   * docs/specs/pr-review-merge-and-deploy.md, D2. The pull request head of a PR follow-up run. The
   * work sprite and the triage sprite apply the diff from the base to this head after the
   * configuration read, so the configuration and the checks come from the base. Absent for every
   * other sandbox.
   */
  pullRequestHead?: string;
  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.119. True when the base is a new base
   * that the head does not hold: the work sprite merges the head into it, and a conflict leaves its
   * markers in the worktree for the implementer.
   */
  pullRequestMerge?: boolean;
}

/** docs/specs/change-sets.md. One target of a change set to check out. */
export interface TargetSpec extends RepositorySpec {
  /** The `owner/repo` name of the target. */
  repository: string;
  /** The read-only clone credential of the installation that grants the target. */
  credential?: string;
}

/** docs/specs/change-sets.md, DI-21.138. One read-only sibling clone, at the commit it read. */
export interface SiblingCheckout {
  repository: string;
  path: string;
  commitSha: string;
}

/** DI-21.138. Clones the sibling repositories. A sibling that does not clone is left out. */
export interface SiblingReader {
  /** The clone URLs, so the checkout policy and the credential binding hold their hosts. */
  urls: string[];
  read(sandbox: Sandbox, ref: SandboxRef): Promise<SiblingCheckout[]>;
}

/** docs/specs/change-sets.md. One checked-out target, with the configuration its own file gives. */
export interface PreparedTarget {
  repository: string;
  checkout: CheckedOutRepository;
  runtime: ProjectRuntimeConfig;
  verifyCommands: VerificationCommand[];
  preview: PreviewConfig | null;
  /** The environment of a command Factoree runs in the target. Empty for a run with one target. */
  environment: Record<string, string>;
}

/** The `owner/repo` name of a clone URL, or the URL itself when it names none, as a local path in a test. */
const repositoryOfUrl = (url: string): string => {
  const parts = url.replace(/\/+$/, "").replace(/\.git$/, "").split("/").slice(-2);
  return parts.length === 2 ? parts.join("/") : url;
};

/**
 * docs/specs/change-sets.md, DI-21.132. The sandbox configuration of a change set from the file of
 * each target. User validation runs in one target until assertions name their target: the first
 * target with an enabled preview, else the first target. Its runtime is the base. The allow lists
 * are the union of the targets' lists, each already capped by the product ceiling. The repair
 * budget is the smallest of the targets. Each verify command runs in its own target, named after it.
 */
export const combineTargets = (
  targets: PreparedTarget[],
): { validation: PreparedTarget; runtime: ProjectRuntimeConfig; verifyCommands: VerificationCommand[]; preview: PreviewConfig | null } => {
  const first = targets[0];
  if (first === undefined) throw new Error("a sandbox needs at least one target");
  if (targets.length === 1) return { validation: first, runtime: first.runtime, verifyCommands: first.verifyCommands, preview: first.preview };
  const validation = targets.find((target) => target.preview !== null && target.preview.enabled) ?? first;
  const union = (pick: (runtime: ProjectRuntimeConfig) => string[]): string[] => [...new Set(targets.flatMap((target) => pick(target.runtime)))];
  const strictest = targets.reduce((least, target) => (target.runtime.repairMaxAttempts < least.runtime.repairMaxAttempts ? target : least), first);
  return {
    validation,
    runtime: {
      ...validation.runtime,
      allowedDomains: union((runtime) => runtime.allowedDomains),
      bootstrapAllowedDomains: union((runtime) => runtime.bootstrapAllowedDomains ?? []),
      sandboxAllowListDeclared: targets.some((target) => target.runtime.sandboxAllowListDeclared === true),
      docker: targets.some((target) => target.runtime.docker === true),
      agentsBlockIgnored: targets.some((target) => target.runtime.agentsBlockIgnored === true),
      repairMaxAttempts: strictest.runtime.repairMaxAttempts,
      ...(strictest.runtime.repairBudgetSource === undefined ? {} : { repairBudgetSource: strictest.runtime.repairBudgetSource }),
    },
    verifyCommands: targets.flatMap((target) =>
      target.verifyCommands.map((command) => ({
        name: `${target.repository}: ${command.name}`,
        run: command.run,
        workingDirectory: target.checkout.path,
        env: target.environment,
      })),
    ),
    preview: validation.preview,
  };
};

/** docs/specs/run-speed.md. What one build-ahead did. */
export type BuildAheadOutcome =
  | { kind: "built"; snapshotId: string; bootstrapKey: string }
  | { kind: "skipped"; reason: string };

export interface PreparedSandbox {
  ref: SandboxRef;
  /**
   * The primary checkout is the target user validation runs in. For a change set it is one of
   * `targets` (DI-21.132).
   */
  checkout: CheckoutResult;
  /** docs/specs/change-sets.md. Every target, in set order. One entry, the primary, for one target. */
  targets: PreparedTarget[];
  /** DI-21.138. The read-only sibling clones of the refiner. Empty for every other sandbox. */
  siblings: SiblingCheckout[];
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

/**
 * docs/specs/check-isolation.md. The step after the configuration read and before the bootstrap. A
 * check sprite applies the captured patch there, to each target of a change set.
 */
export type BeforeBootstrap = (ref: SandboxRef, primaryPath: string, targets: Array<{ repository: string; path: string }>) => Promise<void>;

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
  /**
   * docs/specs/host-credentials.md. The host credentials of a product, with their bindings. It runs
   * in the activity, so no value crosses a Temporal boundary. Absent means no product has any.
   */
  hostCredentials?: (tenantId: string, productId: string, checkoutRepositories: readonly string[]) => Promise<HostCredentialAccess>;
  /** docs/specs/host-credentials.md. Where a sandbox with a `github` binding is recorded for its refresh. */
  credentialBindings?: CredentialBindingStore;
  /**
   * docs/specs/change-sets.md, DI-21.136. Asks for the build-ahead of a set whose work sprite found
   * no set snapshot. Absent means no set snapshot is ever built.
   */
  requestSetBuildAhead?: (request: { tenantId: string; productId: string; repositoryFullNames: string[] }) => Promise<void>;
}

/**
 * docs/specs/change-sets.md, DI-21.136. What a warm snapshot restores for a change set: every
 * target from a set snapshot, or the first target alone from the snapshot of its repository.
 */
type WarmScope = "all" | "first";

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

/** docs/specs/change-sets.md. True when the sandbox checks out two or more targets. */
const isChangeSet = (input: PrepareSandboxInput): input is PrepareSandboxInput & { targets: TargetSpec[] } =>
  input.targets !== undefined && input.targets.length > 1;

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

  /** docs/specs/host-credentials.md. A missing stored secret is a fault the operator repairs. */
  private async credentialAccessOf(input: PrepareSandboxInput, checkoutRepositories: readonly string[]): Promise<HostCredentialAccess> {
    if (this.options.hostCredentials === undefined) return NO_HOST_CREDENTIALS;
    try {
      return await this.options.hostCredentials(input.tenantId, input.productId, checkoutRepositories);
    } catch (error) {
      if (error instanceof RunConfigurationError) throw error;
      throw new RunConfigurationError(`The product's host credentials cannot be bound: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** docs/specs/sandbox-provider-spillover.md. The sandbox of one provider, or the default one. */
  private async sandboxOf(provider: string | undefined): Promise<Sandbox> {
    const sandbox = this.options.sandbox;
    if (provider === undefined || sandbox.forProvider === undefined) return sandbox;
    return sandbox.forProvider(provider);
  }

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
    beforeBootstrap?: BeforeBootstrap,
  ): Promise<PreparedSandbox> {
    // docs/specs/release-0-1-0.md. The install settings choose the provider of each new sandbox.
    await this.options.sandbox.refresh?.();
    const sandbox = await this.sandboxOf(input.provider);
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

    if (isChangeSet(input)) return this.prepareSet(input, beforeBootstrap);
    const warm = await this.warmSnapshotFor(input, input.primary.url);
    if (warm !== null) {
      const prepared = await this.prepareIn(input, beforeBootstrap, warm);
      if (prepared !== null) return prepared;
    }
    const prepared = await this.prepareIn(input, beforeBootstrap, null);
    if (prepared === null) throw new Error("a cold sandbox preparation returned no sandbox");
    return prepared;
  }

  /**
   * docs/specs/change-sets.md, DI-21.136. A change set starts from its set snapshot. With none, or
   * one that cannot serve the set, it restores the snapshot of its first target, clones the others
   * cold, and its work sprite asks for a build-ahead of the set. With neither, every target is cold.
   */
  private async prepareSet(
    input: PrepareSandboxInput & { targets: TargetSpec[] },
    beforeBootstrap: BeforeBootstrap | undefined,
  ): Promise<PreparedSandbox> {
    const subject = snapshotSubjectOf(input.targets.map((target) => target.url));
    const setWarm = await this.warmSnapshotFor(input, subject);
    if (setWarm !== null) {
      const prepared = await this.prepareIn(input, beforeBootstrap, setWarm, undefined, "all");
      if (prepared !== null) return prepared;
    }
    // A check sprite follows the work sprite of its run, which asked already. A build-ahead builds the set.
    if (beforeBootstrap === undefined && input.buildAhead !== true && this.options.requestSetBuildAhead !== undefined) {
      try {
        await this.options.requestSetBuildAhead({
          tenantId: input.tenantId,
          productId: input.productId,
          repositoryFullNames: input.targets.map((target) => target.repository),
        });
        this.options.logger?.info("the change set has no set snapshot, so a build-ahead of the set is requested", {
          run_id: input.runId,
          repositories: input.targets.map((target) => target.repository).join(", "),
        });
      } catch (error) {
        // A build-ahead only saves time, so a failed request costs the next run its warm start.
        this.options.logger?.warn("the build-ahead request of the set failed", { run_id: input.runId, error: String(error) });
      }
    }
    const first = input.targets[0];
    const firstWarm = first === undefined || input.buildAhead === true ? null : await this.warmSnapshotFor(input, first.url);
    if (firstWarm !== null) {
      const prepared = await this.prepareIn(input, beforeBootstrap, firstWarm, undefined, "first");
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
  async hasCurrentWarmSnapshot(input: {
    tenantId: string;
    /** The repository URL, or the subject of a set (`snapshotSubjectOf`). */
    repositoryUrl: string;
    bootstrapKey: string;
    provider?: string;
  }): Promise<boolean> {
    await this.options.sandbox.refresh?.();
    const sandbox = await this.sandboxOf(input.provider);
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
    await this.options.sandbox.refresh?.();
    const sandbox = await this.sandboxOf(input.provider);
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

  /** The warm snapshot of a repository or a set this Run can start from, or null when it starts cold. */
  private async warmSnapshotFor(input: PrepareSandboxInput, subject: string): Promise<WarmSnapshot | null> {
    const sandbox = await this.sandboxOf(input.provider);
    const store = this.options.warmSnapshots;
    if (store === undefined || sandbox.warmSnapshots === undefined) return null;
    const warm = await store.find({ tenantId: input.tenantId, adapter: sandbox.name, repositoryUrl: subject });
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
    beforeBootstrap: BeforeBootstrap | undefined,
    warm: WarmSnapshot | null,
    onSaved?: (snapshot: { snapshotId: string; bootstrapKey: string }) => void,
    /** docs/specs/change-sets.md, DI-21.136. What `warm` restores of a change set. */
    scope: WarmScope = "all",
  ): Promise<PreparedSandbox | null> {
    const sandbox = await this.sandboxOf(input.provider);
    // docs/specs/host-credentials.md. The credentials are read before the create, so a provider
    // that cannot bind them fails the preparation before it costs a sandbox.
    const setTargets = isChangeSet(input) ? input.targets : null;
    const checkoutRepositories = githubRepositoriesOf([
      ...(setTargets === null ? [input.primary.url] : setTargets.map((target) => target.url)),
      ...input.references.map((reference) => reference.url),
      ...(input.organizationSkills === undefined ? [] : [input.organizationSkills.url]),
      ...(input.siblings?.urls ?? []),
    ]);
    const access = await this.credentialAccessOf(input, checkoutRepositories);
    assertBindable(sandbox, access);
    const egress: CredentialEgress = {
      tenantId: input.tenantId,
      productId: input.productId,
      access,
      store: this.options.credentialBindings,
      repositories: checkoutRepositories,
    };
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
      const specs = [...(setTargets ?? [input.primary]), ...input.references];
      if (input.organizationSkills !== undefined) specs.push(input.organizationSkills);
      for (const url of input.siblings?.urls ?? []) specs.push({ url, ref: "HEAD" });
      const repositoryHosts = checkoutHosts(specs);

      // Policy one. Only the repository hosts. The file that names the real allow list does not
      // exist yet, so nothing wider may be permitted here.
      await applyEgress(sandbox, ref, repositoryHosts, egress);

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

      await probeCredentialHosts(sandbox, ref, access);

      let primary: CheckedOutRepository;
      let targets: PreparedTarget[];
      let bootstrapKey: string | null = null;
      if (setTargets === null) {
        primary =
          warm === null
            ? await checkoutPrimary(sandbox, ref, input.primary, input.repositoryCredential)
            : await refreshPrimary(sandbox, ref, input.primary, input.repositoryCredential);

        // SDD section 15. The primary repository owns the configuration of the Run.
        const file = await readRepositoryConfig(sandbox, ref, primary.path);
        const resolved = toProjectRuntimeConfig(file, input.defaults);
        targets = [{ repository: repositoryOfUrl(primary.url), checkout: primary, ...resolved, environment: {} }];

        // docs/specs/run-speed.md. A warm snapshot ran one bootstrap command, one warm command and one
        // allow list. A change of any of them means the snapshot no longer fits, and the cold run
        // takes a new one. A change to any other field keeps the snapshot.
        // docs/specs/repository-setup-and-services.md. The compose stack and the key files join the key.
        bootstrapKey = await this.bootstrapKeyIn(sandbox, ref, primary.path, resolved.runtime, access);
        if (warm !== null && bootstrapKey !== warm.bootstrapKey) {
          this.options.logger?.info("the bootstrap key changed since the warm snapshot, so the sandbox starts cold", {
            run_id: input.runId,
            snapshot_id: warm.snapshotId,
          });
          await sandbox.destroy(ref).catch(() => undefined);
          return null;
        }
      } else {
        // docs/specs/change-sets.md. Each target checks out in its own folder and owns its own
        // configuration: its bootstrap, its compose project, its MISE_CONFIG_FILE and its verify commands.
        // DI-21.136. A set snapshot holds every target, and the snapshot of one repository the first.
        targets = [];
        const members: SetMemberKey[] = [];
        for (const [index, target] of setTargets.entries()) {
          const credential = target.credential ?? input.repositoryCredential;
          let checkout: CheckedOutRepository;
          if (warm === null || (scope === "first" && index > 0)) {
            checkout = await checkoutTarget(sandbox, ref, target, credential);
          } else if (scope === "all") {
            checkout = await refreshTarget(sandbox, ref, target, credential);
          } else {
            const moved = await this.moveSnapshotPrimary(sandbox, ref, input, target.repository);
            if (!moved) {
              await sandbox.destroy(ref).catch(() => undefined);
              return null;
            }
            checkout = await refreshTarget(sandbox, ref, target, credential);
            // DI-21.144. The dependency folders of the snapshot name `primary`, so the bootstrap of
            // this target builds them again in its new folder.
            await removeIgnoredFiles(sandbox, ref, checkout.path);
          }
          const resolved = toProjectRuntimeConfig(await readRepositoryConfig(sandbox, ref, checkout.path), input.defaults);
          // The key reads the configuration before the compose project name of the set, so it equals
          // the key of the repository alone and the key the build-ahead computes.
          const memberKey = await this.bootstrapKeyIn(sandbox, ref, checkout.path, resolved.runtime, access);
          members.push({ repositoryUrl: target.url, bootstrapKey: memberKey });
          // The first target decides before any other target is cloned into a sandbox that goes.
          if (warm !== null && scope === "first" && index === 0 && memberKey !== warm.bootstrapKey) {
            this.options.logger?.info("the bootstrap key changed since the warm snapshot, so the sandbox starts without it", {
              run_id: input.runId,
              snapshot_id: warm.snapshotId,
            });
            await sandbox.destroy(ref).catch(() => undefined);
            return null;
          }
          const services = resolved.runtime.services ?? null;
          targets.push({
            repository: target.repository,
            checkout,
            ...resolved,
            runtime: { ...resolved.runtime, services: services === null ? null : { ...services, project: composeProjectOf(target.repository) } },
            environment: targetEnvironmentOf(checkout.path),
          });
        }
        if (warm !== null && scope === "all") {
          if (setBootstrapKeyOf(members) !== warm.bootstrapKey) {
            this.options.logger?.info("the bootstrap key changed since the warm snapshot, so the sandbox starts without it", {
              run_id: input.runId,
              snapshot_id: warm.snapshotId,
            });
            await sandbox.destroy(ref).catch(() => undefined);
            return null;
          }
        }
        // DI-21.136. Only a build-ahead saves a set snapshot, so a run never waits for one.
        if (input.buildAhead === true) bootstrapKey = setBootstrapKeyOf(members);
        primary = combineTargets(targets).validation.checkout;
      }
      const { runtime, verifyCommands, preview } = combineTargets(targets);
      // docs/specs/claude-code-runner.md. The Product selects the runners, and the run log says so.
      if (runtime.agentsBlockIgnored === true) {
        this.options.logger?.warn("Factoree ignores the agents block of .factoree/config.yaml: the Product selects the runner of each role", {
          run_id: input.runId,
          step: "prepare",
        });
      }

      if (input.pullRequestHead !== undefined) {
        await overlayPullRequestHead(sandbox, ref, primary, input.pullRequestHead, input.repositoryCredential, input.pullRequestMerge === true);
      }
      if (beforeBootstrap !== undefined) {
        await beforeBootstrap(
          ref,
          primary.path,
          targets.map((target) => ({ repository: target.repository, path: target.checkout.path })),
        );
      }

      // docs/specs/proof-pack-and-visual-evidence.md. A work sprite with a preview gets the browser
      // tools for the implementer's self-check. The install runs beside the bootstrap, under
      // policy two, so no agent ever runs with its hosts.
      // The sandbox image already holds the tools, so such a sandbox installs nothing.
      const wantsBrowserTools = input.browserTools === true && preview !== null && preview.enabled;
      const browserTools =
        wantsBrowserTools && !sandbox.capabilities.supportsCustomImage && this.installsBrowserTools(sandbox.name);

      // Policy two. The configured allow list joined with the repository hosts, so the reference
      // checkouts and the bootstrap command both work.
      await applyEgress(
        sandbox,
        ref,
        [...new Set([...repositoryHosts, ...targets.flatMap((target) => bootstrapAllowListOf(target.runtime)), ...(browserTools ? BROWSER_TOOL_HOSTS : [])])],
        egress,
      );
      const install = browserTools
        ? await sandbox.startProcess(ref, { file: "sh", args: ["-c", BROWSER_TOOLS_INSTALL_SCRIPT], cwd: "/" })
        : null;

      if (warm !== null) await removeReferences(sandbox, ref);
      const references = await checkoutReferences(sandbox, ref, input.references, input.repositoryCredential);
      const checkout: CheckoutResult = { primary, references };

      // docs/specs/repository-setup-and-services.md. Rootless Docker and the compose stack start
      // under policy two, before the bootstrap, so a bootstrap can migrate the database. A warm
      // sandbox already holds them, and both calls change nothing on a healthy stack.
      if (runtime.docker === true) {
        const servicesStarted = Date.now();
        await ensureDocker(sandbox, ref);
        for (const target of targets) {
          const services = target.runtime.services ?? null;
          if (services !== null) await startServices(sandbox, ref, target.checkout.path, services);
        }
        this.options.logger?.info("the services are ready", {
          run_id: input.runId,
          step: "prepare_services",
          warm: warm !== null,
          duration_ms: Date.now() - servicesStarted,
        });
      }

      // docs/specs/change-sets.md. Each target runs its own bootstrap in its own folder, in set order.
      for (const target of targets) {
        const command = target.runtime.bootstrapCommand;
        if (command === null) continue;
        const result = await sandbox.exec(ref, {
          file: "sh",
          args: ["-c", bootstrapScript(command)],
          cwd: target.checkout.path,
          ...(Object.keys(target.environment).length === 0 ? {} : { env: target.environment }),
        });
        if (result.exitCode !== 0) {
          // The bootstrap command comes from the repository configuration, so a failure of it is
          // a configuration fault. A retry runs the same command and fails again.
          throw new RunConfigurationError(
            `${targets.length > 1 ? `the bootstrap command of ${target.repository}` : "the bootstrap command"} failed with exit code ${result.exitCode}: ` +
              withoutUrlCredentials(bootstrapFailureDetail(result.stdout, result.stderr)),
          );
        }
      }

      // The seed fills the stack once. A warm sandbox holds the seeded data of its snapshot.
      // DI-21.136. A change set that restored only its first target seeds every stack: the first
      // stack starts again under the compose project of the set.
      if (warm === null || (setTargets !== null && scope === "first")) {
        for (const target of targets) {
          const services = target.runtime.services ?? null;
          if (services === null) continue;
          await seedServices(
            sandbox,
            ref,
            target.checkout.path,
            services,
            ...(Object.keys(target.environment).length === 0 ? [] : [target.environment]),
          );
        }
      }

      const selfCheckReady = sandbox.capabilities.supportsCustomImage
        ? wantsBrowserTools
        : install === null
          ? false
          : await this.awaitBrowserTools(ref, install, input.runId);

      // docs/specs/kiln-sandbox-provider.md. A cold work sprite saves itself here, after the clone
      // and the bootstrap and before any agent runs. A check sprite holds the patch, so it never
      // saves itself.
      // docs/specs/change-sets.md, DI-21.135. A set snapshot runs the warm command of each target in
      // its own folder, and its row names the set.
      if (warm === null && beforeBootstrap === undefined && bootstrapKey !== null) {
        const warmCommands = targets.flatMap((target) =>
          target.runtime.warmCommand === undefined || target.runtime.warmCommand === null
            ? []
            : [{ path: target.checkout.path, command: target.runtime.warmCommand, environment: target.environment }],
        );
        const repositoryUrls = setTargets === null ? [input.primary.url] : setTargets.map((target) => target.url);
        const saved = await this.saveWarmSnapshot(input, ref, repositoryUrls, warmCommands, bootstrapKey);
        if (saved !== null) onSaved?.({ snapshotId: saved, bootstrapKey });
      }

      // docs/specs/run-speed.md. A build-ahead serves no run, so its sandbox goes once the
      // snapshot exists.
      if (input.buildAhead === true) {
        await sandbox.destroy(ref);
        return null;
      }

      // docs/specs/change-sets.md. The instructions of each target, under its name and its folder.
      let repositoryInstructions: string;
      if (setTargets === null) {
        repositoryInstructions = await readRepositoryInstructions(sandbox, ref, primary.path);
      } else {
        const sections: string[] = [];
        for (const target of targets) {
          sections.push(`### ${target.repository} at ${target.checkout.path}\n\n${await readRepositoryInstructions(sandbox, ref, target.checkout.path)}`);
        }
        repositoryInstructions = sections.join("\n\n");
      }

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

      // docs/specs/change-sets.md, DI-21.138. The siblings clone while the checkout hosts are allowed,
      // after the warm snapshot, so no snapshot holds them.
      const siblings = input.siblings === undefined ? [] : await input.siblings.read(sandbox, ref);

      // Policy three. The configured allow list alone. Every later step, the Implementer and the
      // verification commands included, runs under exactly what the repository declared.
      // SDD section 29.
      // docs/specs/host-credentials.md. The credential hosts stay reachable, so the implementer can
      // add a private dependency, and the prompt states them as allowed.
      const allowedHosts = await applyEgress(sandbox, ref, [...new Set([...runtime.allowedDomains, ...(input.agentHosts ?? [])])], egress);

      // SDD section 16. Discovery runs on the checkouts, in precedence order. A repository skill
      // always precedes an organization skill of the same name. Discovery needs no egress, so it
      // runs after the policy is narrowed.
      // docs/specs/skill-registry.md. The registry skills rank after the repository skills and
      // before the organization skills. They live outside the checkout, so no registry skill
      // reaches `git status` or the verified patch.
      const registryRoot =
        input.registrySkills === undefined ? null : await this.deliverRegistrySkills(sandbox, ref, input.registrySkills);
      const roots: SkillRoot[] = targets.map((target) => ({ scope: "repository", path: target.checkout.path }));
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
        targets,
        siblings,
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
  private async runWarmCommand(
    input: PrepareSandboxInput,
    ref: SandboxRef,
    primaryPath: string,
    command: string,
    environment: Record<string, string>,
  ): Promise<number | null> {
    const result = await this.options.sandbox.exec(ref, {
      file: "sh",
      args: ["-c", bootstrapScript(command)],
      cwd: primaryPath,
      ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
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
    repositoryUrls: string[],
    warmCommands: Array<{ path: string; command: string; environment: Record<string, string> }>,
    bootstrapKey: string,
  ): Promise<string | null> {
    // The ref names the provider that created the sandbox, and its snapshot belongs to that provider.
    const sandbox = await this.sandboxOf(input.provider ?? (this.options.sandbox.forProvider === undefined ? undefined : ref.adapter));
    const store = this.options.warmSnapshots;
    if (store === undefined || sandbox.warmSnapshots === undefined) return null;
    const startedAt = new Date();
    try {
      // The exit code of the first warm command that failed, or null.
      let warmCommandExitCode: number | null = null;
      for (const warm of warmCommands) {
        const exitCode = await this.runWarmCommand(input, ref, warm.path, warm.command, warm.environment);
        warmCommandExitCode ??= exitCode;
      }
      const snapshotId = await sandbox.warmSnapshots.take(ref);
      const replaced = await store.save({
        tenantId: input.tenantId,
        adapter: sandbox.name,
        repositoryUrl: snapshotSubjectOf(repositoryUrls),
        ...(repositoryUrls.length > 1 ? { repositoryUrls: [...new Set(repositoryUrls)].sort() } : {}),
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

  /**
   * docs/specs/run-speed.md. The bootstrap key of one checkout: its bootstrap and warm commands, its
   * bootstrap allow list, its compose stack, its key files and the host credentials of the product.
   */
  private async bootstrapKeyIn(
    sandbox: Sandbox,
    ref: SandboxRef,
    path: string,
    runtime: ProjectRuntimeConfig,
    access: HostCredentialAccess,
  ): Promise<string> {
    return bootstrapKeyOf({
      bootstrapCommand: runtime.bootstrapCommand,
      warmCommand: runtime.warmCommand ?? null,
      allowedDomains: bootstrapAllowListOf(runtime),
      services: runtime.services ?? null,
      docker: runtime.docker === true,
      files: selectKeyFiles(await listRepositoryFiles(sandbox, ref, path), keyFilePatternsOf(runtime)),
      credentials: credentialKeyOf(access.credentials),
    });
  }

  /**
   * docs/specs/change-sets.md, DI-21.136. Moves the checkout of a snapshot of one repository from
   * `primary` to the folder of its target. Its compose stack runs under the project name of the
   * folder `primary`, so it stops first: the set starts it again under the project of the target.
   * False when the stack does not stop, and the snapshot then cannot serve the set.
   */
  private async moveSnapshotPrimary(sandbox: Sandbox, ref: SandboxRef, input: PrepareSandboxInput, repository: string): Promise<boolean> {
    const primaryPath = `${ref.workspacePath}/primary`;
    try {
      const { runtime } = toProjectRuntimeConfig(await readRepositoryConfig(sandbox, ref, primaryPath), input.defaults);
      const services = runtime.services ?? null;
      if (runtime.docker === true && services !== null) {
        await ensureDocker(sandbox, ref);
        await stopServices(sandbox, ref, primaryPath, services);
      }
      await movePrimaryToTarget(sandbox, ref, repository);
      return true;
    } catch (error) {
      this.options.logger?.warn("the snapshot of the first target cannot serve the change set, so the set starts cold", {
        run_id: input.runId,
        repository,
        detail: withoutUrlCredentials(String(error)).slice(0, 500),
      });
      return false;
    }
  }

  async release(prepared: PreparedSandbox): Promise<void> {
    await this.options.sandbox.destroy(prepared.ref);
  }
}
