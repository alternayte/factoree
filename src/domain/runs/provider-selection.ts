import { isProviderDown, type SandboxProviderSettings } from "~/domain/settings/sandbox-providers.js";
import { RunConfigurationError } from "./run-configuration-error.js";
import type { SandboxCapabilities } from "./sandbox.js";
import { SandboxSlotUnavailableError } from "./sandbox-slot-error.js";

/**
 * docs/specs/sandbox-provider-spillover.md, DI-16.03. A run holds up to three live sandboxes: the
 * work sprite and two check sprites. It holds that many slots of its provider from start to end.
 */
export const RUN_HELD_SLOTS = 3;

export interface ProviderUsage {
  live: number;
  /** Retained sandboxes count as free: the limit deletes them (DI-15.14). */
  retained: number;
}

export interface ProviderSelectionPorts {
  /** Reads the provider list again. */
  refresh(): Promise<void>;
  /** The providers of the last refresh. */
  providers(): SandboxProviderSettings[];
  /** The capabilities of a provider, or null when its settings do not let its adapter build. */
  capabilities(providerId: string): SandboxCapabilities | null;
  usage(): Promise<Record<string, ProviderUsage>>;
  /** Holds slots of the provider for the run. False when it has no room. */
  hold(providerId: string, runId: string, count: number): Promise<boolean>;
  /** The provider where the run already holds slots, or null. */
  heldProviderOf(runId: string): Promise<string | null>;
  /** The providers where the last build-ahead of the repository failed. */
  failedBuildAheads(tenantId: string, repositoryUrl: string): Promise<string[]>;
}

export interface ProviderSelectionRequest {
  /** The run id, or the setup sandbox id. */
  runId: string;
  tenantId: string;
  /** The provider ids the product allows. Empty allows every provider. */
  allowedProviderIds: readonly string[];
  /** The primary repository, or null when none is known. */
  repositoryUrl: string | null;
  /** True when the repository config starts Docker or compose services. */
  needsDocker: boolean;
}

/** The free slots of a provider. A provider with no limit has no end of room. */
export const roomOf = (provider: Pick<SandboxProviderSettings, "maxLive">, usage: ProviderUsage | undefined): number =>
  provider.maxLive === null ? Number.POSITIVE_INFINITY : provider.maxLive - (usage?.live ?? 0) + (usage?.retained ?? 0);

/**
 * The order to try providers in: the best priority first, and among equal priorities the one with
 * the most free slots, so fixed hosts of one priority share the load and a worse priority takes
 * only the spillover.
 */
export const selectionOrder = (
  providers: readonly SandboxProviderSettings[],
  usage: Readonly<Record<string, ProviderUsage>>,
): SandboxProviderSettings[] =>
  [...providers].sort(
    (left, right) =>
      left.priority - right.priority ||
      roomOf(right, usage[right.id]) - roomOf(left, usage[left.id]) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );

/** Keeps the candidates a soft rule allows, unless the rule would leave none. */
const preferring = (
  candidates: SandboxProviderSettings[],
  keep: (provider: SandboxProviderSettings) => boolean,
): SandboxProviderSettings[] => {
  const kept = candidates.filter(keep);
  return kept.length === 0 ? candidates : kept;
};

/**
 * docs/specs/sandbox-provider-spillover.md. Picks the sandbox provider of a run, or of a setup.
 *
 * The hard rules: the provider is enabled, the product allows it, and its adapter builds. With
 * none left the product cannot run, which is a configuration fault. The soft rules prefer a
 * provider that supports Docker when the repository needs it, and one where the last build-ahead
 * of the repository did not fail; with none left they keep every candidate, and the preparation
 * fails or starts cold as it did with one provider. A provider marked down is skipped until its
 * mark ends.
 */
export class SandboxProviderSelector {
  constructor(private readonly ports: ProviderSelectionPorts) {}

  private async candidates(request: ProviderSelectionRequest, now: Date): Promise<SandboxProviderSettings[]> {
    await this.ports.refresh();
    const allowed = (provider: SandboxProviderSettings): boolean =>
      request.allowedProviderIds.length === 0 || request.allowedProviderIds.includes(provider.id);
    let candidates = this.ports
      .providers()
      .filter((provider) => provider.enabled && allowed(provider) && this.ports.capabilities(provider.id) !== null);
    if (candidates.length === 0) {
      throw new RunConfigurationError(
        request.allowedProviderIds.length === 0
          ? "The install settings hold no enabled sandbox provider that Factoree can use. Check the sandbox providers in Settings > Install."
          : `The product allows the sandbox providers ${request.allowedProviderIds.join(", ")}, and none of them is enabled and complete. Change the product's sandbox providers, or the providers in Settings > Install.`,
      );
    }
    if (request.needsDocker) {
      candidates = preferring(candidates, (provider) => this.ports.capabilities(provider.id)?.supportsDocker === true);
    }
    if (request.repositoryUrl !== null) {
      const failed = await this.ports.failedBuildAheads(request.tenantId, request.repositoryUrl);
      candidates = preferring(candidates, (provider) => !failed.includes(provider.id));
    }
    return candidates.filter((provider) => !isProviderDown(provider, now));
  }

  /**
   * Picks the provider of a run and holds `RUN_HELD_SLOTS` slots there. A run that already holds
   * slots keeps its provider, so a retried activity selects nothing new. Throws
   * `SandboxSlotUnavailableError` when no candidate has room: the workflow asks again later.
   */
  async selectForRun(request: ProviderSelectionRequest, now: Date = new Date()): Promise<string> {
    const held = await this.ports.heldProviderOf(request.runId);
    if (held !== null) return held;
    const candidates = await this.candidates(request, now);
    const usage = await this.ports.usage();
    for (const provider of selectionOrder(candidates, usage)) {
      if (await this.ports.hold(provider.id, request.runId, RUN_HELD_SLOTS)) return provider.id;
    }
    throw new SandboxSlotUnavailableError(
      candidates.length === 0
        ? "every sandbox provider the run may use is down after a failed create"
        : `no sandbox provider the run may use has ${RUN_HELD_SLOTS} free slots`,
    );
  }

  /**
   * Picks the provider of a setup, which holds no slots: the first in order with a free slot, or
   * the first in order, whose create then waits as before.
   */
  async selectForSetup(request: ProviderSelectionRequest, now: Date = new Date()): Promise<string> {
    const candidates = await this.candidates(request, now);
    const usage = await this.ports.usage();
    const ordered = selectionOrder(candidates, usage);
    const chosen = ordered.find((provider) => roomOf(provider, usage[provider.id]) >= 1) ?? ordered[0];
    if (chosen === undefined) throw new SandboxSlotUnavailableError("every sandbox provider the setup may use is down after a failed create");
    return chosen.id;
  }
}
