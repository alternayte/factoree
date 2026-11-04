import { describe, expect, it } from "vitest";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { DEFAULT_PROJECT_DEFAULTS } from "~/domain/runs/project-runtime-config.js";
import type { SandboxCreateInput, SandboxRef, WarmSnapshots } from "~/domain/runs/sandbox.js";
import { bootstrapKeyOf, type RetiredWarmSnapshot, type WarmSnapshot, type WarmSnapshotStore } from "~/domain/runs/warm-snapshot.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const IMAGE = `ghcr.io/alternayte/factoree-sandbox@sha256:${"a".repeat(64)}`;
const TEMPLATE = `factoree-${"a".repeat(16)}-2c-4096m`;
const HEAD = "aaaabbbbccccddddeeeeffff0000111122223333";

const CONFIG_YAML =
  "version: 1\nidentity:\n  product: checkout-platform\n  linear:\n    teamKey: PAY\nbootstrap:\n  command: npm ci\n" +
  "verify:\n  commands:\n    - name: test\n      run: npm test\nsandbox:\n  allowedDomains:\n    - registry.npmjs.org\n" +
  "preview:\n  enabled: true\n  command: npm start\n  readyUrl: http://localhost:3000/\n  timeoutSeconds: 120\n";

/** docs/specs/run-speed.md. The bootstrap key of CONFIG_YAML under the Product allow list below. */
const KEY = bootstrapKeyOf({ bootstrapCommand: "npm ci", warmCommand: null, allowedDomains: ["registry.npmjs.org"] });

/** A fake on the sandbox image, with warm snapshots. It records what it saved and restored. */
class WarmFakeSandbox extends FakeSandbox {
  readonly image = IMAGE;
  readonly taken: string[] = [];
  readonly restored: string[] = [];
  readonly removed: string[] = [];
  restoreFails = false;
  /** Kiln refuses the delete of a snapshot that a live sandbox still reads. */
  removeRefused = false;
  readonly warmSnapshots: WarmSnapshots = {
    template: TEMPLATE,
    take: (ref: SandboxRef) => {
      this.calls.push("snapshot");
      const id = `snap-${this.taken.length + 1}`;
      this.taken.push(`${ref.id}:${id}`);
      return Promise.resolve(id);
    },
    restore: (input: SandboxCreateInput, snapshotId: string) => {
      this.calls.push("restore");
      if (this.restoreFails) return Promise.reject(new Error("kiln: HTTP 404: not_found"));
      this.restored.push(snapshotId);
      return Promise.resolve({ id: `warm-${input.runId}`, adapter: this.name, workspacePath: "/workspace" });
    },
    remove: (snapshotId: string) => {
      if (this.removeRefused) return Promise.resolve(false);
      this.removed.push(snapshotId);
      return Promise.resolve(true);
    },
  };

  constructor(private readonly configYaml = CONFIG_YAML) {
    super({ enforcesNetworkPolicy: true, supportsCheckpoints: false, supportsExposedServices: true, supportsCustomImage: true });
    this.onExec = (command) => {
      const last = command.args[command.args.length - 1] ?? "";
      if (command.file === "cat" && last.endsWith(".factoree/config.yaml")) return { exitCode: 0, stdout: this.configYaml, stderr: "" };
      if (command.file === "cat") return { exitCode: 1, stdout: "", stderr: "no such file" };
      if (command.file === "git" && command.args.includes("rev-parse")) return { exitCode: 0, stdout: `${HEAD}\n`, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
  }
}

class MemoryWarmSnapshotStore implements WarmSnapshotStore {
  readonly rows = new Map<string, WarmSnapshot>();
  private key(value: { tenantId: string; adapter: string; repositoryUrl: string }): string {
    return `${value.tenantId}|${value.adapter}|${value.repositoryUrl}`;
  }
  find(key: { tenantId: string; adapter: string; repositoryUrl: string }): Promise<WarmSnapshot | null> {
    return Promise.resolve(this.rows.get(this.key(key)) ?? null);
  }
  save(snapshot: WarmSnapshot): Promise<WarmSnapshot | null> {
    const previous = this.rows.get(this.key(snapshot)) ?? null;
    this.rows.set(this.key(snapshot), snapshot);
    return Promise.resolve(previous);
  }
  forget(snapshot: WarmSnapshot): Promise<void> {
    if (this.rows.get(this.key(snapshot))?.snapshotId === snapshot.snapshotId) this.rows.delete(this.key(snapshot));
    return Promise.resolve();
  }
  readonly retired = new Map<string, RetiredWarmSnapshot>();
  retire(snapshot: RetiredWarmSnapshot): Promise<void> {
    this.retired.set(`${snapshot.adapter}|${snapshot.snapshotId}`, { ...snapshot });
    return Promise.resolve();
  }
  listRetired(limit: number): Promise<RetiredWarmSnapshot[]> {
    return Promise.resolve([...this.retired.values()].slice(0, limit));
  }
  dropRetired(snapshot: RetiredWarmSnapshot): Promise<void> {
    this.retired.delete(`${snapshot.adapter}|${snapshot.snapshotId}`);
    return Promise.resolve();
  }
}

const input = {
  runId: "run-1",
  tenantId: "tenant-1",
  productId: "project-1",
  primary: { url: "https://github.com/acme/app.git", ref: HEAD },
  references: [],
  defaults: { ...DEFAULT_PROJECT_DEFAULTS, allowedDomains: ["registry.npmjs.org"] },
  browserTools: true,
};

const stored = (bootstrapKey: string, template = TEMPLATE): WarmSnapshot => ({
  tenantId: "tenant-1",
  adapter: "fake",
  repositoryUrl: "https://github.com/acme/app.git",
  template,
  bootstrapKey,
  warmCommandExitCode: null,
  snapshotId: "snap-old",
});

const gitLines = (sandbox: FakeSandbox): string[] =>
  sandbox.commands.filter((command) => command.file === "git").map((command) => command.args.join(" "));

describe("SandboxManager warm snapshots (docs/specs/kiln-sandbox-provider.md)", () => {
  it("saves a warm snapshot of a cold work sprite after the bootstrap and before the agent policy", async () => {
    const sandbox = new WarmFakeSandbox();
    const store = new MemoryWarmSnapshotStore();
    await new SandboxManager({ sandbox, warmSnapshots: store }).prepare(input);

    const order = sandbox.calls.filter((call) => call === "snapshot" || call === "applyNetworkPolicy" || call === "exec:sh");
    // Policy one, policy two, the bootstrap, the snapshot, then the agent policy.
    expect(order).toEqual(["applyNetworkPolicy", "applyNetworkPolicy", "exec:sh", "snapshot", "applyNetworkPolicy"]);
    expect([...store.rows.values()]).toEqual([{ ...stored(KEY), snapshotId: "snap-1" }]);
  });

  it("removes the snapshot a new one replaces", async () => {
    const sandbox = new WarmFakeSandbox();
    const store = new MemoryWarmSnapshotStore();
    // A snapshot of another size (docs/specs/kiln-sandbox-size.md).
    await store.save(stored(KEY, `factoree-${"a".repeat(16)}-4c-4096m`));
    await new SandboxManager({ sandbox, warmSnapshots: store }).prepare(input);

    // Another template: the run starts cold, and its snapshot replaces the old one.
    expect(sandbox.calls).not.toContain("restore");
    expect(sandbox.removed).toEqual(["snap-old"]);
    expect([...store.retired.values()]).toEqual([]);
  });

  it("keeps a replaced snapshot that a live sandbox still reads, so the reaper removes it later", async () => {
    const sandbox = new WarmFakeSandbox();
    sandbox.removeRefused = true;
    const store = new MemoryWarmSnapshotStore();
    await store.save(stored(KEY, `factoree-${"a".repeat(16)}-4c-4096m`));
    await new SandboxManager({ sandbox, warmSnapshots: store }).prepare(input);

    // No row names snap-old any more, so without the record it would stay on the provider for ever.
    expect([...store.retired.values()]).toEqual([{ tenantId: "tenant-1", adapter: "fake", snapshotId: "snap-old" }]);
  });

  it("records a snapshot that did not restore, so the reaper removes it", async () => {
    const sandbox = new WarmFakeSandbox();
    sandbox.restoreFails = true;
    const store = new MemoryWarmSnapshotStore();
    await store.save(stored(KEY));
    await new SandboxManager({ sandbox, warmSnapshots: store }).prepare(input);

    expect(store.retired.has("fake|snap-old")).toBe(true);
  });

  it("starts from the warm snapshot, moves the checkout to the run ref and runs the bootstrap again", async () => {
    const sandbox = new WarmFakeSandbox();
    const store = new MemoryWarmSnapshotStore();
    await store.save(stored(KEY));
    const prepared = await new SandboxManager({ sandbox, warmSnapshots: store }).prepare(input);

    expect(sandbox.restored).toEqual(["snap-old"]);
    expect(sandbox.calls).not.toContain("create");
    expect(sandbox.calls).not.toContain("snapshot");
    expect(prepared.ref.id).toBe("warm-run-1");
    const git = gitLines(sandbox);
    expect(git.some((line) => line.startsWith("clone"))).toBe(false);
    expect(git).toContain(`-C /workspace/primary fetch --no-tags origin ${HEAD}`);
    expect(git).toContain("-C /workspace/primary checkout --force --detach FETCH_HEAD");
    expect(sandbox.commands.some((command) => command.file === "sh" && command.args[1]?.includes("npm ci"))).toBe(true);
    // The image holds the browser tools, so nothing installs them, and the self-check is ready.
    expect(sandbox.calls.some((call) => call.startsWith("startProcess"))).toBe(false);
    expect(prepared.selfCheckReady).toBe(true);
  });

  it("starts cold and takes a new snapshot when the bootstrap key changed", async () => {
    const sandbox = new WarmFakeSandbox();
    const store = new MemoryWarmSnapshotStore();
    await store.save(stored("2222222222222222222222222222222222222222"));
    const prepared = await new SandboxManager({ sandbox, warmSnapshots: store }).prepare(input);

    expect(sandbox.destroyed).toEqual(["warm-run-1"]);
    expect(sandbox.calls.filter((call) => call === "create")).toHaveLength(1);
    expect(prepared.ref.id).not.toBe("warm-run-1");
    expect(store.rows.get("tenant-1|fake|https://github.com/acme/app.git")?.bootstrapKey).toBe(KEY);
    expect(sandbox.removed).toEqual(["snap-old"]);
  });

  it("starts cold and forgets the snapshot when the restore fails", async () => {
    const sandbox = new WarmFakeSandbox();
    sandbox.restoreFails = true;
    const store = new MemoryWarmSnapshotStore();
    await store.save(stored(KEY));
    await new SandboxManager({ sandbox, warmSnapshots: store }).prepare(input);

    expect(sandbox.calls.filter((call) => call === "create")).toHaveLength(1);
    expect(store.rows.get("tenant-1|fake|https://github.com/acme/app.git")?.snapshotId).toBe("snap-1");
  });

  it("keeps the snapshot when only a field outside the bootstrap key changed (docs/specs/run-speed.md)", async () => {
    const sandbox = new WarmFakeSandbox(CONFIG_YAML.replace("run: npm test", "run: npm run test:ci"));
    const store = new MemoryWarmSnapshotStore();
    await store.save(stored(KEY));
    await new SandboxManager({ sandbox, warmSnapshots: store }).prepare(input);

    expect(sandbox.restored).toEqual(["snap-old"]);
    expect(sandbox.calls).not.toContain("create");
    expect(sandbox.destroyed).toEqual([]);
  });

  it("runs the warm command before the snapshot of a cold work sprite, and not in a fork", async () => {
    const yaml = CONFIG_YAML.replace("verify:", "warm:\n  command: go build ./...\nverify:");
    const key = bootstrapKeyOf({ bootstrapCommand: "npm ci", warmCommand: "go build ./...", allowedDomains: ["registry.npmjs.org"] });
    const cold = new WarmFakeSandbox(yaml);
    const store = new MemoryWarmSnapshotStore();
    await new SandboxManager({ sandbox: cold, warmSnapshots: store }).prepare(input);

    const warmCommand = cold.commands.findIndex((command) => command.file === "sh" && command.args[1]?.includes("go build ./..."));
    expect(warmCommand).toBeGreaterThan(-1);
    expect(cold.calls.filter((call) => call === "exec:sh" || call === "snapshot").slice(-2)).toEqual(["exec:sh", "snapshot"]);
    expect([...store.rows.values()][0]).toMatchObject({ bootstrapKey: key, warmCommandExitCode: null });

    const fork = new WarmFakeSandbox(yaml);
    await new SandboxManager({ sandbox: fork, warmSnapshots: store }).prepare({ ...input, runId: "run-2" });
    expect(fork.restored).toEqual(["snap-1"]);
    expect(fork.commands.some((command) => command.file === "sh" && command.args[1]?.includes("go build ./..."))).toBe(false);
  });

  it("records a failed warm command on the snapshot and still takes it", async () => {
    const yaml = CONFIG_YAML.replace("verify:", "warm:\n  command: dotnet build\nverify:");
    const sandbox = new WarmFakeSandbox(yaml);
    const base = sandbox.onExec!;
    sandbox.onExec = (command) =>
      command.file === "sh" && command.args[1]?.includes("dotnet build") ? { exitCode: 1, stdout: "", stderr: "error CS1002" } : base(command);
    const store = new MemoryWarmSnapshotStore();
    const prepared = await new SandboxManager({ sandbox, warmSnapshots: store }).prepare(input);

    expect(prepared.ref.id).toBeDefined();
    expect([...store.rows.values()][0]).toMatchObject({ snapshotId: "snap-1", warmCommandExitCode: 1 });
  });

  it("builds ahead: a cold sandbox, the snapshot, then the delete", async () => {
    const sandbox = new WarmFakeSandbox();
    const store = new MemoryWarmSnapshotStore();
    await store.save(stored("2222222222222222222222222222222222222222"));
    const manager = new SandboxManager({ sandbox, warmSnapshots: store });

    expect(await manager.hasCurrentWarmSnapshot({ tenantId: "tenant-1", repositoryUrl: input.primary.url, bootstrapKey: KEY })).toBe(false);
    const outcome = await manager.buildAhead({ ...input, runId: "build-ahead:repo-1" });

    expect(outcome).toEqual({ kind: "built", snapshotId: "snap-1", bootstrapKey: KEY });
    expect(sandbox.calls).not.toContain("restore");
    expect(sandbox.destroyed).toHaveLength(1);
    expect(sandbox.removed).toEqual(["snap-old"]);
    expect(await manager.hasCurrentWarmSnapshot({ tenantId: "tenant-1", repositoryUrl: input.primary.url, bootstrapKey: KEY })).toBe(true);
  });

  it("never saves a check sprite, which holds the patch", async () => {
    const sandbox = new WarmFakeSandbox();
    const store = new MemoryWarmSnapshotStore();
    await new SandboxManager({ sandbox, warmSnapshots: store }).prepare(input, () => Promise.resolve());

    expect(sandbox.calls).not.toContain("snapshot");
    expect(store.rows.size).toBe(0);
  });
});
