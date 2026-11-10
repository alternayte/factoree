import { createHash } from "node:crypto";
import type {
  CheckpointRef,
  Command,
  CommandResult,
  EgressRecord,
  NetworkPolicy,
  ProcessRef,
  ProcessSnapshot,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateInput,
  SandboxRef,
  ServiceRef,
  WarmSnapshots,
} from "~/domain/runs/sandbox.js";
import { SandboxCreateError } from "~/domain/runs/sandbox.js";
import { kilnSandboxSize, requireSetting, type SandboxSettings } from "~/domain/settings/install-settings.js";
import { isProviderDown, type SandboxProviderSettings } from "~/domain/settings/sandbox-providers.js";
import { SandboxSlots, type RetainedSandbox, type SandboxLeaseStore } from "~/domain/runs/sandbox-slots.js";
import { SandboxSlotUnavailableError } from "~/domain/runs/sandbox-slot-error.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import { DEFAULT_WORKSPACE_PATH } from "~/domain/runs/sprite-reaper.js";
import type { Logger } from "~/telemetry/logger.js";
import { KilnClient } from "./kiln/kiln-client.js";
import { KilnSandbox } from "./kiln/kiln-sandbox.js";
import { createE2BGateway } from "./e2b/e2b-client.js";
import { E2BSandbox } from "./e2b/e2b-sandbox.js";
import { buildInfo } from "~/config/build-info.js";
import { FlySpriteSandbox } from "./fly-sprites/fly-sprite-sandbox.js";
import { createSpritesGateway } from "./fly-sprites/sprites-client.js";
import { LocalProcessSandbox } from "./local/local-process-sandbox.js";

/** docs/specs/sandbox-provider-spillover.md. The install-wide image settings and the provider list. */
export interface SandboxConfiguration extends SandboxSettings {
  providers: SandboxProviderSettings[];
}

export interface SettingsSandboxOptions {
  /** Reads the sandbox section of the install settings and the sandbox providers. */
  settings: () => Promise<SandboxConfiguration>;
  /** FACTOREE_UNSAFE_LOCAL_SANDBOX. Without it the local provider is refused. */
  allowLocal: boolean;
  /** FACTOREE_SANDBOX_LOCAL_ROOT. */
  localRoot: string;
  /**
   * docs/specs/release-0-1-0.md, DI-15.14. The leases of the live sandboxes. With it, every create
   * takes a slot of the `maxLive` of its provider first, and every delete frees one.
   */
  leases?: SandboxLeaseStore;
  logger?: Logger;
  /** Runs after the limit deleted a retained sandbox. The worker counts it. */
  onEvicted?: (victim: RetainedSandbox) => void;
}

/** The settings of one provider that change its adapter. The limit, priority and state do not. */
const fingerprint = (provider: SandboxProviderSettings, settings: SandboxSettings): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        provider.type,
        provider.url,
        provider.apiKey,
        provider.vcpus,
        provider.memoryMb,
        settings.image,
        settings.registryUsername,
        settings.registryToken,
      ]),
    )
    .digest("hex");

interface ProviderEntry {
  fingerprint: string;
  sandbox: Sandbox;
}

/** The order selection tries providers in: priority first, then name and id for a stable order. */
const byPriority = (left: SandboxProviderSettings, right: SandboxProviderSettings): number =>
  left.priority - right.priority || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);

/**
 * docs/specs/release-0-1-0.md, DI-14.50 and docs/specs/sandbox-provider-spillover.md. The worker's
 * one `Sandbox`. The install settings list the sandbox providers, and this adapter builds one
 * provider adapter for each, again when its settings change. A sandbox ref names its provider id,
 * so each call on an existing sandbox goes to the provider that created it. `forProvider` gives
 * the view of one provider that a pinned run creates its sandboxes through. A create with no
 * named provider goes to the default: the enabled provider with the best priority that is not down.
 */
export class SettingsSandbox implements Sandbox {
  private readonly entries = new Map<string, ProviderEntry>();
  private providers: SandboxProviderSettings[] = [];
  /** Why a listed provider has no adapter, by provider id. */
  private readonly problems = new Map<string, string>();
  /** An environment attached before this worker built the adapter of its sandbox. */
  private readonly pendingEnvironment = new Map<string, Record<string, string>>();
  private readonly views = new Map<string, ProviderSandbox>();
  private readonly slots: SandboxSlots | null;

  constructor(private readonly options: SettingsSandboxOptions) {
    this.slots =
      options.leases === undefined
        ? null
        : new SandboxSlots({
            store: options.leases,
            // An eviction deletes at the provider. The store drops the lease itself.
            destroy: async (ref) => (await this.forRef(ref)).destroy(ref),
            workspacePath: DEFAULT_WORKSPACE_PATH,
            ...(options.logger === undefined ? {} : { logger: options.logger }),
            ...(options.onEvicted === undefined ? {} : { onEvicted: options.onEvicted }),
          });
  }

  async refresh(): Promise<void> {
    const settings = await this.options.settings();
    this.providers = [...settings.providers].sort(byPriority);
    this.problems.clear();
    for (const provider of this.providers) {
      const next = fingerprint(provider, settings);
      if (this.entries.get(provider.id)?.fingerprint === next) continue;
      try {
        this.entries.set(provider.id, { fingerprint: next, sandbox: this.build(provider, settings) });
      } catch (error) {
        // One provider with a missing setting must not stop the others.
        this.problems.set(provider.id, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private build(provider: SandboxProviderSettings, settings: SandboxSettings): Sandbox {
    const registryCredential =
      settings.registryUsername === null || settings.registryToken === null
        ? {}
        : { registryCredential: { username: settings.registryUsername, token: settings.registryToken } };
    switch (provider.type) {
      case "kiln":
        return new KilnSandbox({
          client: new KilnClient({
            baseUrl: requireSetting(provider.url, `Kiln URL of the sandbox provider ${provider.name}`),
            apiKey: requireSetting(provider.apiKey, `Kiln API key of the sandbox provider ${provider.name}`),
          }),
          image: requireSetting(settings.image ?? buildInfo.sandboxImageDefault, "sandbox image"),
          size: kilnSandboxSize(provider),
          ...registryCredential,
        });
      case "e2b":
        // docs/specs/e2b-sandbox-provider.md. A self-hosted E2B names its domain by its URL.
        return new E2BSandbox({
          gateway: createE2BGateway({
            apiKey: requireSetting(provider.apiKey, `E2B API key of the sandbox provider ${provider.name}`),
            ...(provider.url === null ? {} : { domain: new URL(provider.url).hostname }),
          }),
          image: requireSetting(settings.image ?? buildInfo.sandboxImageDefault, "sandbox image"),
          size: kilnSandboxSize(provider),
          ...registryCredential,
        });
      case "fly-sprites":
        return new FlySpriteSandbox({
          gateway: createSpritesGateway({
            token: requireSetting(provider.apiKey, `Sprites token of the sandbox provider ${provider.name}`),
            ...(provider.url === null ? {} : { baseUrl: provider.url }),
          }),
        });
      case "local":
        if (!this.options.allowLocal) {
          throw new Error(
            "The install settings name the local sandbox, which isolates nothing. Set FACTOREE_UNSAFE_LOCAL_SANDBOX=1 on a development machine to accept that.",
          );
        }
        return new LocalProcessSandbox({ rootDirectory: this.options.localRoot });
    }
  }

  /** The providers of the last refresh, by priority. */
  providerSettings(): SandboxProviderSettings[] {
    return this.providers;
  }

  /** The adapter of one provider, or null when the settings do not let it build. */
  adapterOf(providerId: string): Sandbox | null {
    return this.entries.get(providerId)?.sandbox ?? null;
  }

  /** Why a listed provider has no adapter, or null. */
  problemOf(providerId: string): string | null {
    return this.problems.get(providerId) ?? null;
  }

  /** The view of one provider. Every create through it takes a slot of that provider. */
  async forProvider(providerId: string): Promise<Sandbox> {
    if (!this.entries.has(providerId)) await this.refresh();
    if (!this.entries.has(providerId)) {
      const problem = this.problems.get(providerId);
      if (problem !== undefined) throw new Error(problem);
      throw new Error(`the install settings hold no sandbox provider ${providerId}`);
    }
    let view = this.views.get(providerId);
    if (view === undefined) {
      view = new ProviderSandbox(this, providerId);
      this.views.set(providerId, view);
    }
    return view;
  }

  /**
   * docs/specs/sandbox-provider-spillover.md. Holds `count` slots of one provider for a run. False
   * when the provider has no room, even after it deleted its retained sandboxes.
   */
  async hold(providerId: string, runId: string, count: number): Promise<boolean> {
    if (this.slots === null) return true;
    const provider = this.providers.find((entry) => entry.id === providerId);
    return this.slots.hold(providerId, runId, count, provider?.maxLive ?? null);
  }

  /** The provider a create with no named provider uses. */
  private defaultProviderId(): string {
    const now = new Date();
    const usable = this.providers.filter((provider) => provider.enabled && this.entries.has(provider.id));
    const chosen = usable.find((provider) => !isProviderDown(provider, now)) ?? usable[0];
    if (chosen !== undefined) return chosen.id;
    const problem = this.providers.map((provider) => this.problems.get(provider.id)).find((entry) => entry !== undefined);
    if (problem !== undefined) throw new Error(problem);
    // The settings were not read yet, or they list no provider.
    return requireSetting<string>(null, "sandbox provider");
  }

  private defaultView(): ProviderSandbox {
    const id = this.defaultProviderId();
    let view = this.views.get(id);
    if (view === undefined) {
      view = new ProviderSandbox(this, id);
      this.views.set(id, view);
    }
    return view;
  }

  get name(): string {
    return this.defaultView().name;
  }

  get capabilities(): SandboxCapabilities {
    return this.defaultView().capabilities;
  }

  get image(): string | undefined {
    return this.defaultView().image;
  }

  get warmSnapshots(): WarmSnapshots | undefined {
    return this.defaultView().warmSnapshots;
  }

  /** The adapter of a sandbox, by the provider its ref names. */
  async forRef(ref: SandboxRef): Promise<Sandbox> {
    let sandbox = this.entries.get(ref.adapter)?.sandbox;
    if (sandbox === undefined) {
      await this.refresh();
      sandbox = this.entries.get(ref.adapter)?.sandbox;
    }
    if (sandbox === undefined) {
      throw new Error(`sandbox ${ref.id} runs on ${ref.adapter}, and the install settings no longer name that provider`);
    }
    const key = `${ref.adapter}:${ref.id}`;
    const environment = this.pendingEnvironment.get(key);
    if (environment !== undefined) {
      sandbox.attachEnvironment(ref, environment);
      this.pendingEnvironment.delete(key);
    }
    return sandbox;
  }

  async create(input: SandboxCreateInput): Promise<SandboxRef> {
    await this.refresh();
    return this.defaultView().create(input);
  }

  /**
   * DI-15.14. A create takes a slot of the `maxLive` of its provider first, and binds it to the
   * sandbox it returns. A failed create gives the slot back. A run that holds a slot of the provider
   * takes that one. docs/specs/sandbox-provider-spillover.md: a failure of the provider call
   * becomes `SandboxCreateError`, and the ref names the provider id.
   */
  async createOn(providerId: string, runId: string, create: (adapter: Sandbox) => Promise<SandboxRef>): Promise<SandboxRef> {
    const adapter = this.entries.get(providerId)?.sandbox;
    if (adapter === undefined) throw new Error(`the install settings hold no sandbox provider ${providerId}`);
    const call = async (): Promise<SandboxRef> => {
      try {
        return { ...(await create(adapter)), adapter: providerId };
      } catch (error) {
        if (error instanceof SandboxSlotUnavailableError || error instanceof RunConfigurationError) throw error;
        throw new SandboxCreateError(providerId, error);
      }
    };
    const slots = this.slots;
    if (slots === null) return call();
    const maxLive = this.providers.find((provider) => provider.id === providerId)?.maxLive ?? null;
    // docs/specs/repository-setup-and-services.md. A setup waits behind runs: it never takes the
    // last free slot of a provider that has more than one, so a Linear run always finds one.
    const limit = runId.startsWith("setup:") && maxLive !== null && maxLive > 1 ? maxLive - 1 : maxLive;
    const leaseId = await slots.acquire(providerId, runId, limit);
    let ref: SandboxRef;
    try {
      ref = await call();
    } catch (error) {
      await slots.abandon(leaseId).catch(() => undefined);
      throw error;
    }
    try {
      await slots.bind(leaseId, ref.id);
    } catch (error) {
      // An unbound lease expires, and nothing would count this sandbox. It must not stay.
      await adapter.destroy(ref).catch(() => undefined);
      await slots.abandon(leaseId).catch(() => undefined);
      throw error;
    }
    return ref;
  }

  attachEnvironment(ref: SandboxRef, environment: Record<string, string>): void {
    const sandbox = this.entries.get(ref.adapter)?.sandbox;
    if (sandbox === undefined) this.pendingEnvironment.set(`${ref.adapter}:${ref.id}`, environment);
    else sandbox.attachEnvironment(ref, environment);
  }

  async egressLog(ref: SandboxRef): Promise<EgressRecord[] | null> {
    const sandbox = await this.forRef(ref);
    return sandbox.egressLog === undefined ? null : sandbox.egressLog(ref);
  }

  async applyNetworkPolicy(ref: SandboxRef, policy: NetworkPolicy): Promise<void> {
    return (await this.forRef(ref)).applyNetworkPolicy(ref, policy);
  }

  async exec(ref: SandboxRef, command: Command): Promise<CommandResult> {
    return (await this.forRef(ref)).exec(ref, command);
  }

  async writeFile(ref: SandboxRef, path: string, content: string): Promise<void> {
    return (await this.forRef(ref)).writeFile(ref, path, content);
  }

  async startProcess(ref: SandboxRef, command: Command): Promise<ProcessRef> {
    return (await this.forRef(ref)).startProcess(ref, command);
  }

  async readProcess(ref: SandboxRef, process: ProcessRef): Promise<ProcessSnapshot> {
    return (await this.forRef(ref)).readProcess(ref, process);
  }

  async cancelProcess(ref: SandboxRef, process: ProcessRef): Promise<void> {
    return (await this.forRef(ref)).cancelProcess(ref, process);
  }

  async checkpoint(ref: SandboxRef, name: string): Promise<CheckpointRef> {
    return (await this.forRef(ref)).checkpoint(ref, name);
  }

  async exposeService(ref: SandboxRef, port: number): Promise<ServiceRef> {
    return (await this.forRef(ref)).exposeService(ref, port);
  }

  async destroy(ref: SandboxRef): Promise<void> {
    await (await this.forRef(ref)).destroy(ref);
    await this.slots?.release(ref.adapter, ref.id);
  }
}

/**
 * docs/specs/sandbox-provider-spillover.md. One provider of `SettingsSandbox`. Its name is the
 * provider id, so a warm snapshot, a lease and a ref of it name the provider. A create goes to
 * this provider only. Every call on a ref goes through the parent, which routes by the ref.
 */
class ProviderSandbox implements Sandbox {
  constructor(
    private readonly parent: SettingsSandbox,
    readonly name: string,
  ) {}

  private adapter(): Sandbox {
    const adapter = this.parent.adapterOf(this.name);
    if (adapter === null) {
      throw new Error(this.parent.problemOf(this.name) ?? `the install settings hold no sandbox provider ${this.name}`);
    }
    return adapter;
  }

  get capabilities(): SandboxCapabilities {
    return this.adapter().capabilities;
  }

  get image(): string | undefined {
    return this.adapter().image;
  }

  get warmSnapshots(): WarmSnapshots | undefined {
    const snapshots = this.adapter().warmSnapshots;
    if (snapshots === undefined) return undefined;
    return {
      template: snapshots.template,
      take: async (ref) => {
        const owner = (await this.parent.forRef(ref)).warmSnapshots;
        if (owner === undefined) throw new Error(`the ${ref.adapter} sandbox provider takes no warm snapshot`);
        return owner.take(ref);
      },
      restore: (input, snapshotId) =>
        this.parent.createOn(this.name, input.runId, (adapter) => {
          const own = adapter.warmSnapshots;
          if (own === undefined) throw new Error(`the ${this.name} sandbox provider takes no warm snapshot`);
          return own.restore(input, snapshotId);
        }),
      remove: (snapshotId) => snapshots.remove(snapshotId),
    };
  }

  async refresh(): Promise<void> {
    await this.parent.refresh();
  }

  create(input: SandboxCreateInput): Promise<SandboxRef> {
    return this.parent.createOn(this.name, input.runId, (adapter) => adapter.create(input));
  }

  egressLog(ref: SandboxRef): Promise<EgressRecord[] | null> {
    return this.parent.egressLog(ref);
  }

  attachEnvironment(ref: SandboxRef, environment: Record<string, string>): void {
    this.parent.attachEnvironment(ref, environment);
  }

  applyNetworkPolicy(ref: SandboxRef, policy: NetworkPolicy): Promise<void> {
    return this.parent.applyNetworkPolicy(ref, policy);
  }

  exec(ref: SandboxRef, command: Command): Promise<CommandResult> {
    return this.parent.exec(ref, command);
  }

  writeFile(ref: SandboxRef, path: string, content: string): Promise<void> {
    return this.parent.writeFile(ref, path, content);
  }

  startProcess(ref: SandboxRef, command: Command): Promise<ProcessRef> {
    return this.parent.startProcess(ref, command);
  }

  readProcess(ref: SandboxRef, process: ProcessRef): Promise<ProcessSnapshot> {
    return this.parent.readProcess(ref, process);
  }

  cancelProcess(ref: SandboxRef, process: ProcessRef): Promise<void> {
    return this.parent.cancelProcess(ref, process);
  }

  checkpoint(ref: SandboxRef, name: string): Promise<CheckpointRef> {
    return this.parent.checkpoint(ref, name);
  }

  exposeService(ref: SandboxRef, port: number): Promise<ServiceRef> {
    return this.parent.exposeService(ref, port);
  }

  destroy(ref: SandboxRef): Promise<void> {
    return this.parent.destroy(ref);
  }
}
