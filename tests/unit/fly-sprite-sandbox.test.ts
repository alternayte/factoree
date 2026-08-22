import { describe, expect, it, vi } from "vitest";
import { FlySpriteSandbox } from "~/adapters/sandbox/fly-sprites/fly-sprite-sandbox.js";
import type { SpritesGateway, SpritesSpriteHandle } from "~/adapters/sandbox/fly-sprites/sprites-client.js";

const handle = (overrides: Partial<SpritesSpriteHandle> = {}): SpritesSpriteHandle => ({
  execFile: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
  createSession: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
  readSession: vi.fn().mockResolvedValue({ running: false, exitCode: 0, stdout: "", stderr: "" }),
  killSession: vi.fn().mockResolvedValue(undefined),
  createCheckpoint: vi.fn().mockResolvedValue({ id: "v1" }),
  updateNetworkPolicy: vi.fn().mockResolvedValue(undefined),
  createService: vi.fn().mockResolvedValue({ url: "https://sprite.example/8080" }),
  delete: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

const gateway = (sprite: SpritesSpriteHandle): SpritesGateway => ({
  createSprite: vi.fn().mockResolvedValue({ name: "factoree-run-1", handle: sprite }),
  sprite: vi.fn().mockReturnValue(sprite),
});

describe("FlySpriteSandbox", () => {
  it("names the adapter fly-sprites and declares that it enforces the network policy", () => {
    const sandbox = new FlySpriteSandbox({ gateway: gateway(handle()) });
    expect(sandbox.name).toBe("fly-sprites");
    expect(sandbox.capabilities.enforcesNetworkPolicy).toBe(true);
    expect(sandbox.capabilities.supportsCheckpoints).toBe(true);
  });

  it("creates one uniquely named sprite per Run", async () => {
    const sprite = handle();
    const api = gateway(sprite);
    const sandbox = new FlySpriteSandbox({ gateway: api });
    const first = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    const second = await sandbox.create({ runId: "run-b", tenantId: "t", projectId: "p" });
    expect(first.id).not.toBe(second.id);
    expect(first.id).toContain("run-a");
    expect(api.createSprite).toHaveBeenCalledTimes(2);
  });

  it("sends a deny-by-default network policy", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    await sandbox.applyNetworkPolicy(ref, { allowedDomains: ["registry.npmjs.org"] });
    expect(sprite.updateNetworkPolicy).toHaveBeenCalledWith({
      rules: [
        { domain: "registry.npmjs.org", action: "allow" },
        { domain: "*", action: "deny" },
      ],
    });
  });

  it("returns a command result instead of throwing on a non-zero exit code", async () => {
    const sprite = handle({
      execFile: vi.fn().mockRejectedValue(
        Object.assign(new Error("command failed"), { exitCode: 2, stdout: "out", stderr: "err" }),
      ),
    });
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    const result = await sandbox.exec(ref, { file: "sh", args: ["-c", "exit 2"] });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it("runs a command in the workspace path by default", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    await sandbox.exec(ref, { file: "git", args: ["status"] });
    expect(sprite.execFile).toHaveBeenCalledWith(
      "git",
      ["status"],
      expect.objectContaining({ cwd: ref.workspacePath }),
    );
  });

  it("starts a detachable session for a process and cancels it by session identifier", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    const started = await sandbox.startProcess(ref, { file: "opencode", args: ["run"] });
    expect(started.id).toBe("session-1");
    await sandbox.cancelProcess(ref, started);
    expect(sprite.killSession).toHaveBeenCalledWith("session-1");
  });

  it("does not throw when it cancels a session that has already gone", async () => {
    const sprite = handle({ killSession: vi.fn().mockRejectedValue(new Error("not found")) });
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    await expect(sandbox.cancelProcess(ref, { id: "gone" })).resolves.toBeUndefined();
  });

  it("does not throw when it destroys a sprite that has already gone", async () => {
    const sprite = handle({ delete: vi.fn().mockRejectedValue(new Error("404 not found")) });
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    await expect(sandbox.destroy(ref)).resolves.toBeUndefined();
  });

  it("creates a named checkpoint", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    const checkpoint = await sandbox.checkpoint(ref, "baseline");
    expect(sprite.createCheckpoint).toHaveBeenCalledWith("baseline");
    expect(checkpoint).toEqual({ id: "v1", name: "baseline" });
  });
});
