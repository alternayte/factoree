import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsSandbox, type SandboxConfiguration } from "~/adapters/sandbox/settings-sandbox.js";
import type { SandboxProviderSettings } from "~/domain/settings/sandbox-providers.js";

// docs/specs/sandbox-provider-spillover.md. Each sandbox names the provider that created it, so
// every later call on its ref reaches that provider, even with two providers of one type.

const local = (id: string, priority: number): SandboxProviderSettings => ({
  id,
  name: id,
  type: "local",
  url: null,
  apiKey: null,
  maxLive: null,
  vcpus: null,
  memoryMb: null,
  priority,
  enabled: true,
  downUntil: null,
  downReason: null,
});

let root = "";

afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

const sandboxWith = async (providers: SandboxProviderSettings[]) => {
  root = await mkdtemp(join(tmpdir(), "settings-sandbox-"));
  const configuration: SandboxConfiguration = { image: null, registryUsername: null, registryToken: null, providers };
  return new SettingsSandbox({ settings: () => Promise.resolve(configuration), allowLocal: true, localRoot: root });
};

describe("SettingsSandbox with several providers", () => {
  it("names the provider id in the ref of a sandbox that a provider view creates", async () => {
    const sandbox = await sandboxWith([local("local", 1), local("local-2a", 2)]);
    const ref = await (await sandbox.forProvider("local-2a")).create({ runId: "run-1", tenantId: "t", productId: "p" });
    expect(ref.adapter).toBe("local-2a");
    const result = await sandbox.exec(ref, { file: "true", args: [], cwd: "/" });
    expect(result.exitCode).toBe(0);
    await sandbox.destroy(ref);
  });

  it("creates on the best priority when no provider is named", async () => {
    const sandbox = await sandboxWith([local("local-b", 2), local("local-a", 1)]);
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    expect(ref.adapter).toBe("local-a");
    await sandbox.destroy(ref);
  });
});
