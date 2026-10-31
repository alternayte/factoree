import { createHash } from "node:crypto";
import type {
  CheckpointRef,
  Command,
  CommandResult,
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
import { requireSetting, type SandboxSettings } from "~/domain/settings/install-settings.js";
import { SandboxSlots, type RetainedSandbox, type SandboxLeaseStore } from "~/domain/runs/sandbox-slots.js";
import { DEFAULT_WORKSPACE_PATH } from "~/domain/runs/sprite-reaper.js";
import type { Logger } from "~/telemetry/logger.js";
import { KilnClient } from "./kiln/kiln-client.js";
import { KilnSandbox } from "./kiln/kiln-sandbox.js";
import { buildInfo } from "~/config/build-info.js";
import { FlySpriteSandbox } from "./fly-sprites/fly-sprite-sandbox.js";
import { createSpritesGateway } from "./fly-sprites/sprites-client.js";
import { LocalProcessSandbox } from "./local/local-process-sandbox.js";

export interface SettingsSandboxOptions {
  /** Reads the sandbox section of the install settings. */
  settings: () => Promise<SandboxSettings>;
  /** FACTOREE_UNSAFE_LOCAL_SANDBOX. Without it the local provider is refused. */
  allowLocal: boolean;
  /** FACTOREE_SANDBOX_LOCAL_ROOT. */
  localRoot: string;
  /**
   * docs/specs/release-0-1-0.md, DI-15.14. The leases of the live sandboxes. With it, every create
   * takes a slot of `sandboxMaxLive` first, and every delete frees one.
   */
  leases?: SandboxLeaseStore;
  logger?: Logger;
  /** Runs after the limit deleted a retained sandbox. The worker counts it. */
  onEvicted?: (victim: RetainedSandbox) => void;
}

/** The provider settings that change the adapter. `maxLive` is a limit, not an adapter setting. */
const fingerprint = (settings: SandboxSettings): string => {
  const adapterSettings: Omit<SandboxSettings, "maxLive"> & { maxLive?: number | null } = { ...settings };
  delete adapterSettings.maxLive;
  return createHash("sha256").update(JSON.stringify(adapterSettings)).digest("hex");
};

/**
 * docs/specs/release-0-1-0.md and DI-14.50. The worker's one `Sandbox`. The install settings
 * name the provider and its key, so this adapter builds the provider adapter from them, and
 * builds it again when they change. A new sandbox uses the provider the settings name at
 * `refresh`. A call on an existing sandbox goes to the adapter its ref names, so a Run that
 * started before a change keeps its provider.
 */
export class SettingsSandbox implements Sandbox {
  private current: { fingerprint: string; sandbox: Sandbox } | null = null;
  private readonly byAdapter = new Map<string, Sandbox>();
  /** An environment attached before this worker built the adapter of its sandbox. */
  private readonly pendingEnvironment = new Map<string, Record<string, string>>();
  /** `sandboxMaxLive` at the last `refresh`. A limit needs no new adapter. */
  private maxLive: number | null = null;
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
    this.maxLive = settings.maxLive;
    const next = fingerprint(settings);
    if (this.current?.fingerprint === next) return;
    const sandbox = this.build(settings);
    this.current = { fingerprint: next, sandbox };
    this.byAdapter.set(sandbox.name, sandbox);
  }

  private build(settings: SandboxSettings): Sandbox {
    const provider = requireSetting(settings.provider, "sandbox provider");
    switch (provider) {
      case "kiln":
        return new KilnSandbox({
          client: new KilnClient({
            baseUrl: requireSetting(settings.url, "Kiln URL"),
            apiKey: requireSetting(settings.apiKey, "Kiln API key"),
          }),
          image: requireSetting(settings.image ?? buildInfo.sandboxImageDefault, "sandbox image"),
          ...(settings.registryUsername === null || settings.registryToken === null
            ? {}
            : { registryCredential: { username: settings.registryUsername, token: settings.registryToken } }),
        });
      case "fly-sprites":
        return new FlySpriteSandbox({
          gateway: createSpritesGateway({
            token: requireSetting(settings.apiKey, "Sprites token"),
            ...(settings.url === null ? {} : { baseUrl: settings.url }),
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

  private active(): Sandbox {
    if (this.current === null) throw new Error("the sandbox settings were not read yet; call refresh first");
    return this.current.sandbox;
  }

  get name(): string {
    return this.active().name;
  }

  get capabilities(): SandboxCapabilities {
    return this.active().capabilities;
  }

  get image(): string | undefined {
    return this.active().image;
  }

  get warmSnapshots(): WarmSnapshots | undefined {
    const snapshots = this.active().warmSnapshots;
    if (snapshots === undefined) return undefined;
    return {
      take: async (ref) => {
        const owner = (await this.forRef(ref)).warmSnapshots;
        if (owner === undefined) throw new Error(`the ${ref.adapter} adapter takes no warm snapshot`);
        return owner.take(ref);
      },
      restore: (input, snapshotId) => this.withSlot(input.runId, () => snapshots.restore(input, snapshotId)),
      remove: (snapshotId) => snapshots.remove(snapshotId),
    };
  }

  /** The adapter of a sandbox, by the provider its ref names. */
  async forRef(ref: SandboxRef): Promise<Sandbox> {
    let sandbox = this.byAdapter.get(ref.adapter);
    if (sandbox === undefined) {
      await this.refresh();
      sandbox = this.byAdapter.get(ref.adapter);
    }
    if (sandbox === undefined) {
      throw new Error(
        `sandbox ${ref.id} runs on ${ref.adapter}, and the install settings no longer name that provider`,
      );
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
    const sandbox = this.active();
    return this.withSlot(input.runId, () => sandbox.create(input));
  }

  /**
   * DI-15.14. A create takes a slot of the provider's `sandboxMaxLive` first, and binds it to the
   * sandbox it returns. A failed create gives the slot back.
   */
  private async withSlot(runId: string, create: () => Promise<SandboxRef>): Promise<SandboxRef> {
    const slots = this.slots;
    if (slots === null) return create();
    const leaseId = await slots.acquire(this.active().name, runId, this.maxLive);
    let ref: SandboxRef;
    try {
      ref = await create();
    } catch (error) {
      await slots.abandon(leaseId).catch(() => undefined);
      throw error;
    }
    try {
      await slots.bind(leaseId, ref.id);
    } catch (error) {
      // An unbound lease expires, and nothing would count this sandbox. It must not stay.
      await (await this.forRef(ref)).destroy(ref).catch(() => undefined);
      await slots.abandon(leaseId).catch(() => undefined);
      throw error;
    }
    return ref;
  }

  attachEnvironment(ref: SandboxRef, environment: Record<string, string>): void {
    const sandbox = this.byAdapter.get(ref.adapter);
    if (sandbox === undefined) this.pendingEnvironment.set(`${ref.adapter}:${ref.id}`, environment);
    else sandbox.attachEnvironment(ref, environment);
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
