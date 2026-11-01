import { describe, expect, it, vi } from "vitest";
import { SpriteReaper } from "~/domain/runs/sprite-reaper.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const runs = (entries: Array<{ tenantId: string; runId: string; spriteId: string; adapter: string }>) => ({
  listExpiredSandboxes: vi.fn().mockResolvedValue(entries),
  clearSandbox: vi.fn().mockResolvedValue(undefined),
});

describe("SpriteReaper", () => {
  it("destroys every sandbox past its retention window", async () => {
    const sandbox = new FakeSandbox();
    const repository = runs([
      { tenantId: "t", runId: "r1", spriteId: "sprite-1", adapter: "fake" },
      { tenantId: "t", runId: "r2", spriteId: "sprite-2", adapter: "fake" },
    ]);
    const reaper = new SpriteReaper({ sandboxes: { fake: sandbox }, runs: repository });
    expect(await reaper.reap(new Date("2026-01-01T00:00:00Z"))).toBe(2);
    expect(sandbox.destroyed).toEqual(["sprite-1", "sprite-2"]);
  });

  it("clears the sandbox reference on the Run, so the Proof Pack stays readable (AT-34)", async () => {
    const sandbox = new FakeSandbox();
    const repository = runs([{ tenantId: "t", runId: "r1", spriteId: "sprite-1", adapter: "fake" }]);
    const reaper = new SpriteReaper({ sandboxes: { fake: sandbox }, runs: repository });
    await reaper.reap(new Date());
    expect(repository.clearSandbox).toHaveBeenCalledWith("t", "r1");
  });

  it("skips a Run whose adapter is not registered and does not clear it", async () => {
    const sandbox = new FakeSandbox();
    const repository = runs([{ tenantId: "t", runId: "r1", spriteId: "sprite-1", adapter: "unknown" }]);
    const reaper = new SpriteReaper({ sandboxes: { fake: sandbox }, runs: repository });
    expect(await reaper.reap(new Date())).toBe(0);
    expect(repository.clearSandbox).not.toHaveBeenCalled();
  });

  it("continues after one destroy fails", async () => {
    const sandbox = new FakeSandbox();
    vi.spyOn(sandbox, "destroy").mockRejectedValueOnce(new Error("api down"));
    const repository = runs([
      { tenantId: "t", runId: "r1", spriteId: "sprite-1", adapter: "fake" },
      { tenantId: "t", runId: "r2", spriteId: "sprite-2", adapter: "fake" },
    ]);
    const reaper = new SpriteReaper({ sandboxes: { fake: sandbox }, runs: repository });
    expect(await reaper.reap(new Date())).toBe(1);
  });

  it("uses the workspace path of the adapter when it destroys a sandbox", async () => {
    const sandbox = new FakeSandbox();
    const destroy = vi.spyOn(sandbox, "destroy");
    const repository = runs([{ tenantId: "t", runId: "r1", spriteId: "sprite-1", adapter: "fake" }]);
    const reaper = new SpriteReaper({
      sandboxes: { fake: sandbox },
      runs: repository,
      workspacePath: "/srv/workspace",
    });
    await reaper.reap(new Date());
    expect(destroy).toHaveBeenCalledWith({
      id: "sprite-1",
      adapter: "fake",
      workspacePath: "/srv/workspace",
    });
  });

  it("removes a retired warm snapshot once no sandbox reads it, and keeps it while one does", async () => {
    const refused = new Set(["snap-read"]);
    const sandbox = Object.assign(new FakeSandbox(), {
      warmSnapshots: {
        template: "t",
        take: vi.fn(),
        restore: vi.fn(),
        remove: vi.fn((snapshotId: string) => Promise.resolve(!refused.has(snapshotId))),
      },
    });
    const retired = [
      { tenantId: "t", adapter: "fake", snapshotId: "snap-free" },
      { tenantId: "t", adapter: "fake", snapshotId: "snap-read" },
    ];
    const retiredSnapshots = {
      listRetired: vi.fn().mockResolvedValue(retired),
      dropRetired: vi.fn().mockResolvedValue(undefined),
    };
    const reaper = new SpriteReaper({ sandboxes: { fake: sandbox }, runs: runs([]), retiredSnapshots });
    await reaper.reap(new Date());
    expect(retiredSnapshots.dropRetired).toHaveBeenCalledTimes(1);
    expect(retiredSnapshots.dropRetired).toHaveBeenCalledWith({ tenantId: "t", adapter: "fake", snapshotId: "snap-free" });
  });
});
