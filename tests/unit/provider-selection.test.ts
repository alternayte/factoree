import { describe, expect, it } from "vitest";
import {
  SandboxProviderSelector,
  type ProviderSelectionPorts,
  type ProviderSelectionRequest,
  type ProviderUsage,
} from "~/domain/runs/provider-selection.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import type { SandboxCapabilities } from "~/domain/runs/sandbox.js";
import { SandboxSlotUnavailableError } from "~/domain/runs/sandbox-slot-error.js";
import type { SandboxProviderSettings } from "~/domain/settings/sandbox-providers.js";

// docs/specs/sandbox-provider-spillover.md. The rule that picks the sandbox provider of a run.

const NOW = new Date("2026-11-10T12:00:00Z");

const provider = (id: string, overrides: Partial<SandboxProviderSettings> = {}): SandboxProviderSettings => ({
  id,
  name: id,
  type: id.startsWith("e2b") ? "e2b" : "kiln",
  url: null,
  apiKey: "key",
  maxLive: 6,
  vcpus: null,
  memoryMb: null,
  priority: 1,
  enabled: true,
  downUntil: null,
  downReason: null,
  ...overrides,
});

const capabilities = (supportsDocker: boolean): SandboxCapabilities => ({
  enforcesNetworkPolicy: true,
  supportsCheckpoints: false,
  supportsExposedServices: true,
  supportsCustomImage: true,
  supportsDocker,
});

const request = (overrides: Partial<ProviderSelectionRequest> = {}): ProviderSelectionRequest => ({
  runId: "run-1",
  tenantId: "tenant-1",
  allowedProviderIds: [],
  repositoryUrl: "https://github.com/acme/app.git",
  needsDocker: false,
  ...overrides,
});

/** Ports over a fixed provider list. `hold` grants while the usage leaves room, and records the attempts. */
const ports = (
  providers: SandboxProviderSettings[],
  usage: Record<string, ProviderUsage> = {},
  options: { failed?: string[]; noDocker?: string[]; broken?: string[]; held?: string | null } = {},
) => {
  const holds: string[] = [];
  const value: ProviderSelectionPorts = {
    refresh: () => Promise.resolve(),
    providers: () => providers,
    capabilities: (id) => (options.broken?.includes(id) ? null : capabilities(!(options.noDocker ?? []).includes(id))),
    usage: () => Promise.resolve(usage),
    hold: (id, _runId, count) => {
      holds.push(id);
      const entry = providers.find((candidate) => candidate.id === id);
      const used = usage[id] ?? { live: 0, retained: 0 };
      return Promise.resolve(entry?.maxLive === null || (entry?.maxLive ?? 0) - used.live + used.retained >= count);
    },
    heldProviderOf: () => Promise.resolve(options.held ?? null),
    failedBuildAheads: () => Promise.resolve(options.failed ?? []),
  };
  return { value, holds };
};

describe("SandboxProviderSelector.selectForRun", () => {
  it("takes the best priority with room, and spills to a worse priority only when it is full", async () => {
    const kiln = provider("kiln", { priority: 1 });
    const e2b = provider("e2b", { priority: 2, maxLive: null });
    const { value } = ports([e2b, kiln], { kiln: { live: 3, retained: 0 } });
    expect(await new SandboxProviderSelector(value).selectForRun(request(), NOW)).toBe("kiln");

    const full = ports([e2b, kiln], { kiln: { live: 6, retained: 0 } });
    expect(await new SandboxProviderSelector(full.value).selectForRun(request(), NOW)).toBe("e2b");
    expect(full.holds).toEqual(["kiln", "e2b"]);
  });

  it("counts retained sandboxes as room, because the limit deletes them", async () => {
    const { value } = ports([provider("kiln"), provider("e2b", { priority: 2 })], { kiln: { live: 6, retained: 3 } });
    expect(await new SandboxProviderSelector(value).selectForRun(request(), NOW)).toBe("kiln");
  });

  it("spreads runs over providers of one priority by their free slots", async () => {
    const { value } = ports([provider("kiln"), provider("kiln-2")], { kiln: { live: 3, retained: 0 } });
    expect(await new SandboxProviderSelector(value).selectForRun(request(), NOW)).toBe("kiln-2");
  });

  it("keeps the provider a run already holds slots on", async () => {
    const { value, holds } = ports([provider("kiln")], {}, { held: "e2b" });
    expect(await new SandboxProviderSelector(value).selectForRun(request(), NOW)).toBe("e2b");
    expect(holds).toEqual([]);
  });

  it("uses only the providers the product allows", async () => {
    const { value } = ports([provider("kiln"), provider("e2b", { priority: 2 })], { kiln: { live: 6, retained: 0 } });
    await expect(
      new SandboxProviderSelector(value).selectForRun(request({ allowedProviderIds: ["kiln"] }), NOW),
    ).rejects.toBeInstanceOf(SandboxSlotUnavailableError);
  });

  it("is a configuration fault when no enabled, complete provider is allowed", async () => {
    const { value } = ports([provider("kiln", { enabled: false }), provider("e2b")], {}, { broken: ["e2b"] });
    await expect(new SandboxProviderSelector(value).selectForRun(request(), NOW)).rejects.toBeInstanceOf(RunConfigurationError);
  });

  it("skips a provider that is down, and waits when every one is down", async () => {
    const down = { downUntil: new Date(NOW.getTime() + 60_000), downReason: "connection refused" };
    const { value } = ports([provider("kiln", down), provider("e2b", { priority: 2 })]);
    expect(await new SandboxProviderSelector(value).selectForRun(request(), NOW)).toBe("e2b");

    const all = ports([provider("kiln", down)]);
    await expect(new SandboxProviderSelector(all.value).selectForRun(request(), NOW)).rejects.toBeInstanceOf(
      SandboxSlotUnavailableError,
    );
  });

  it("prefers a provider where the build-ahead did not fail, and keeps a failed one when it is the only one", async () => {
    const { value } = ports([provider("kiln"), provider("e2b", { priority: 2 })], {}, { failed: ["kiln"] });
    expect(await new SandboxProviderSelector(value).selectForRun(request(), NOW)).toBe("e2b");

    const only = ports([provider("kiln")], {}, { failed: ["kiln"] });
    expect(await new SandboxProviderSelector(only.value).selectForRun(request(), NOW)).toBe("kiln");
  });

  it("prefers a provider with Docker when the repository needs it", async () => {
    const { value } = ports([provider("sprites"), provider("e2b", { priority: 2 })], {}, { noDocker: ["sprites"] });
    expect(await new SandboxProviderSelector(value).selectForRun(request({ needsDocker: true }), NOW)).toBe("e2b");
    expect(await new SandboxProviderSelector(value).selectForRun(request({ needsDocker: false }), NOW)).toBe("sprites");
  });
});

describe("SandboxProviderSelector.selectForSetup", () => {
  it("takes the first provider in order with a free slot, and holds nothing", async () => {
    const { value, holds } = ports([provider("kiln", { maxLive: 2 }), provider("e2b", { priority: 2 })], {
      kiln: { live: 2, retained: 0 },
    });
    expect(await new SandboxProviderSelector(value).selectForSetup(request(), NOW)).toBe("e2b");
    expect(holds).toEqual([]);
  });
});
