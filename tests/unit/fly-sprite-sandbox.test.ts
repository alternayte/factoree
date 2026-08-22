import { describe, expect, it, vi } from "vitest";
import { FlySpriteSandbox } from "~/adapters/sandbox/fly-sprites/fly-sprite-sandbox.js";
import type { SpritesGateway, SpritesSpriteHandle } from "~/adapters/sandbox/fly-sprites/sprites-client.js";

const handle = (overrides: Partial<SpritesSpriteHandle> = {}): SpritesSpriteHandle => ({
  execFile: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
  startDetached: vi.fn().mockResolvedValue(undefined),
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

/**
 * Builds an `execFile` fake for `readProcess`, which reads three files back in order: `exit`,
 * `out`, then `err`. Each script argument checks for a file and prints its content, or prints
 * nothing when the file is absent.
 */
const readProcessExecFile = (options: { exit?: string; stdout?: string; stderr?: string }) =>
  vi.fn().mockImplementation((_file: string, args: string[]) => {
    const script = args[1] ?? "";
    if (script.includes("/exit'")) {
      return Promise.resolve({ exitCode: 0, stdout: options.exit ?? "", stderr: "" });
    }
    if (script.includes("/out'")) {
      return Promise.resolve({ exitCode: 0, stdout: options.stdout ?? "", stderr: "" });
    }
    if (script.includes("/err'")) {
      return Promise.resolve({ exitCode: 0, stdout: options.stderr ?? "", stderr: "" });
    }
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  });

describe("FlySpriteSandbox", () => {
  it("names the adapter fly-sprites and declares its real capabilities", () => {
    const sandbox = new FlySpriteSandbox({ gateway: gateway(handle()) });
    expect(sandbox.name).toBe("fly-sprites");
    expect(sandbox.capabilities.enforcesNetworkPolicy).toBe(true);
    expect(sandbox.capabilities.supportsCheckpoints).toBe(true);
    // The Fly Sprites SDK has no documented API that publishes a port to a reachable URL, so
    // this flag stays honest at false rather than advertising a capability the adapter lacks.
    expect(sandbox.capabilities.supportsExposedServices).toBe(false);
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

  it("starts a process with a Factoree-generated identifier", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    const started = await sandbox.startProcess(ref, { file: "opencode", args: ["run"] });
    expect(started.id).toMatch(/^proc-[0-9a-f]{8}$/);
    expect(sprite.startDetached).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sprite.startDetached).mock.calls[0];
    expect(call?.[0]).toBe("sh");
    expect(call?.[1]?.[0]).toBe("-c");
    // The real command's file and arguments are passed as positional parameters after the
    // wrapper script, not folded into the script text.
    expect(call?.[1]?.slice(2)).toEqual(["sh", "opencode", "run"]);
  });

  it("reports a running process when the exit file is absent", async () => {
    const sprite = handle({ execFile: readProcessExecFile({ stdout: "partial output" }) });
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    const snapshot = await sandbox.readProcess(ref, { id: "proc-aaaaaaaa" });
    expect(snapshot.running).toBe(true);
    expect(snapshot.exitCode).toBeNull();
    expect(snapshot.stdout).toBe("partial output");
  });

  it("reports a finished process with a zero exit code", async () => {
    const sprite = handle({
      execFile: readProcessExecFile({ exit: "0\n", stdout: "done", stderr: "" }),
    });
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    const snapshot = await sandbox.readProcess(ref, { id: "proc-aaaaaaaa" });
    expect(snapshot.running).toBe(false);
    expect(snapshot.exitCode).toBe(0);
    expect(snapshot.stdout).toBe("done");
  });

  it("reports a finished process with a non-zero exit code", async () => {
    const sprite = handle({
      execFile: readProcessExecFile({ exit: "17\n", stdout: "", stderr: "boom" }),
    });
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    const snapshot = await sandbox.readProcess(ref, { id: "proc-aaaaaaaa" });
    expect(snapshot.running).toBe(false);
    expect(snapshot.exitCode).toBe(17);
    expect(snapshot.stderr).toBe("boom");
  });

  it("cancels a process by its pid file and terminates the process group", async () => {
    const execFile: SpritesSpriteHandle["execFile"] = vi.fn((_file: string, args: string[]) => {
      const script = args[1] ?? "";
      if (script.includes("/pid'")) return Promise.resolve({ exitCode: 0, stdout: "4242\n", stderr: "" });
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const sprite = handle({ execFile });
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    await sandbox.cancelProcess(ref, { id: "proc-aaaaaaaa" });
    const killCall = vi.mocked(execFile).mock.calls.find((call) => (call[1][1] ?? "").includes("kill -TERM"));
    expect(killCall?.[1][1]).toContain("-4242");
  });

  it("does not throw when it cancels an identifier that was never issued", async () => {
    const sprite = handle({ execFile: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }) });
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
