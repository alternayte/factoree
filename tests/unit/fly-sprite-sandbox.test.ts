import { posix } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FlySpriteSandbox } from "~/adapters/sandbox/fly-sprites/fly-sprite-sandbox.js";
import { SandboxError } from "~/domain/runs/sandbox.js";
import type { SpritesGateway, SpritesSpriteHandle } from "~/adapters/sandbox/fly-sprites/sprites-client.js";

const WORKSPACE = "/home/sprite/workspace";

const procDir = (id: string): string => posix.join(WORKSPACE, ".factoree", "proc", id);

const handle = (overrides: Partial<SpritesSpriteHandle> = {}): SpritesSpriteHandle => {
  const sprite: SpritesSpriteHandle = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    execFile: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
    // The file capture is the gateway's own concern, and `wrapSprite` has its tests. Here it
    // behaves as the plain call, so one fake `execFile` serves every path of the adapter.
    execFileCaptured: (file, args, options) => sprite.execFile(file, args, options),
    startDetached: vi.fn().mockResolvedValue(undefined),
    createCheckpoint: vi.fn().mockResolvedValue({ id: "v1" }),
    updateNetworkPolicy: vi.fn().mockResolvedValue(undefined),
    publishPort: vi.fn().mockResolvedValue("https://factoree-run-1-abc.sprites.app/"),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return sprite;
};

const gateway = (sprite: SpritesSpriteHandle): SpritesGateway => ({
  createSprite: vi.fn().mockResolvedValue({ name: "factoree-run-1", handle: sprite }),
  sprite: vi.fn().mockReturnValue(sprite),
});

/**
 * A small in-memory stand-in for the sprite's real filesystem. It understands the four shell
 * script shapes `FlySpriteSandbox` sends through `execFile`: an existence check, a file read, a
 * marker write, and `mkdir -p`. It records every kill script separately, so a test can inspect
 * the process ID a cancel actually signalled.
 */
const virtualSprite = (): { handle: SpritesSpriteHandle; files: Map<string, string>; killScripts: string[] } => {
  const files = new Map<string, string>();
  const killScripts: string[] = [];

  const execFile: SpritesSpriteHandle["execFile"] = (file, args) => {
    if (file === "mkdir") {
      const dir = args.at(-1) ?? "";
      files.set(dir, "");
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    }
    const script = args[1] ?? "";
    const exists = /^if \[ -e '([^']*)' \]; then echo 1; fi$/.exec(script);
    if (exists?.[1] !== undefined) {
      return Promise.resolve({ exitCode: 0, stdout: files.has(exists[1]) ? "1" : "", stderr: "" });
    }
    const read = /^if \[ -f '([^']*)' \]; then cat '[^']*'; fi$/.exec(script);
    if (read?.[1] !== undefined) {
      return Promise.resolve({ exitCode: 0, stdout: files.get(read[1]) ?? "", stderr: "" });
    }
    const write = /^: > '([^']*)'$/.exec(script);
    if (write?.[1] !== undefined) {
      files.set(write[1], "");
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    }
    if (script.includes("kill -TERM")) {
      killScripts.push(script);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    }
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  };

  return { handle: handle({ execFile }), files, killScripts };
};

describe("FlySpriteSandbox", () => {
  it("names the adapter fly-sprites and declares its real capabilities", () => {
    const sandbox = new FlySpriteSandbox({ gateway: gateway(handle()) });
    expect(sandbox.name).toBe("fly-sprites");
    expect(sandbox.capabilities.enforcesNetworkPolicy).toBe(true);
    expect(sandbox.capabilities.supportsCheckpoints).toBe(true);
    // H-2. A live probe proved that a service declaring `httpPort` routes the sprite URL.
    expect(sandbox.capabilities.supportsExposedServices).toBe(true);
  });

  it("creates one uniquely named sprite per Run", async () => {
    const sprite = handle();
    const api = gateway(sprite);
    const sandbox = new FlySpriteSandbox({ gateway: api });
    const first = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    const second = await sandbox.create({ runId: "run-b", tenantId: "t", productId: "p" });
    expect(first.id).not.toBe(second.id);
    expect(first.id).toContain("run-a");
    expect(api.createSprite).toHaveBeenCalledTimes(2);
  });

  it("sends a deny-by-default network policy", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
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
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    const result = await sandbox.exec(ref, { file: "sh", args: ["-c", "exit 2"] });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it("runs a command in the workspace path by default", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    await sandbox.exec(ref, { file: "git", args: ["status"] });
    expect(sprite.execFile).toHaveBeenCalledWith(
      "git",
      ["status"],
      expect.objectContaining({ cwd: ref.workspacePath }),
    );
  });

  it("passes a command's timeout to exec as the gateway's timeout option", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    await sandbox.exec(ref, { file: "git", args: ["status"], timeoutMs: 5000 });
    expect(sprite.execFile).toHaveBeenCalledWith("git", ["status"], expect.objectContaining({ timeout: 5000 }));
  });

  it("starts a process with a Factoree-generated identifier and creates its directory first", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    const started = await sandbox.startProcess(ref, { file: "opencode", args: ["run"] });
    expect(started.id).toMatch(/^proc-[0-9a-f]{8}$/);
    expect(sprite.execFile).toHaveBeenCalledWith("mkdir", ["-p", procDir(started.id)], expect.anything());
    expect(sprite.startDetached).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sprite.startDetached).mock.calls[0];
    expect(call?.[0]).toBe("sh");
    expect(call?.[1]?.[0]).toBe("-c");
    // The real command's file and arguments are passed as positional parameters after the
    // wrapper script, not folded into the script text.
    expect(call?.[1]?.slice(2)).toEqual(["sh", "opencode", "run"]);
  });

  it("does not pass a command's timeout to startProcess, since startProcess ignores it", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    await sandbox.startProcess(ref, { file: "opencode", args: ["run"], timeoutMs: 5000 });
    const call = vi.mocked(sprite.startDetached).mock.calls[0];
    expect(call?.[2]).not.toHaveProperty("timeout");
  });

  it("reports a running process when the exit file is absent", async () => {
    const { handle: sprite, files } = virtualSprite();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    const dir = procDir("proc-aaaaaaaa");
    files.set(dir, "");
    files.set(posix.join(dir, "out"), "partial output");
    const snapshot = await sandbox.readProcess(ref, { id: "proc-aaaaaaaa" });
    expect(snapshot.running).toBe(true);
    expect(snapshot.exitCode).toBeNull();
    expect(snapshot.stdout).toBe("partial output");
  });

  it("reports a finished process with a zero exit code", async () => {
    const { handle: sprite, files } = virtualSprite();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    const dir = procDir("proc-aaaaaaaa");
    files.set(dir, "");
    files.set(posix.join(dir, "exit"), "0\n");
    files.set(posix.join(dir, "out"), "done");
    const snapshot = await sandbox.readProcess(ref, { id: "proc-aaaaaaaa" });
    expect(snapshot.running).toBe(false);
    expect(snapshot.exitCode).toBe(0);
    expect(snapshot.stdout).toBe("done");
  });

  it("reports a finished process with a non-zero exit code", async () => {
    const { handle: sprite, files } = virtualSprite();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    const dir = procDir("proc-aaaaaaaa");
    files.set(dir, "");
    files.set(posix.join(dir, "exit"), "17\n");
    files.set(posix.join(dir, "err"), "boom");
    const snapshot = await sandbox.readProcess(ref, { id: "proc-aaaaaaaa" });
    expect(snapshot.running).toBe(false);
    expect(snapshot.exitCode).toBe(17);
    expect(snapshot.stderr).toBe("boom");
  });

  it("throws for a process identifier that was never issued, instead of polling forever", async () => {
    const { handle: sprite } = virtualSprite();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    await expect(sandbox.readProcess(ref, { id: "proc-unknown" })).rejects.toThrow(SandboxError);
    await expect(sandbox.readProcess(ref, { id: "proc-unknown" })).rejects.toThrow(/proc-unknown/);
  });

  it("cancels a running process by its pid file and terminates the process group", async () => {
    const { handle: sprite, files, killScripts } = virtualSprite();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    const dir = procDir("proc-aaaaaaaa");
    files.set(dir, "");
    files.set(posix.join(dir, "pid"), "4242");
    await sandbox.cancelProcess(ref, { id: "proc-aaaaaaaa" });
    expect(killScripts).toHaveLength(1);
    expect(killScripts[0]).toContain("-4242");
    // The cancel marker is written even though the process was already running: it is
    // harmless there, since the wrapper only reads it before it launches the command.
    expect(files.has(posix.join(dir, "cancel"))).toBe(true);
  });

  it("still terminates a process that starts during the cancel window, rather than reporting success silently", async () => {
    const { handle: sprite, files, killScripts } = virtualSprite();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    const dir = procDir("proc-aaaaaaaa");
    const pidFile = posix.join(dir, "pid");
    files.set(dir, "");
    // The pid file does not exist yet: cancelProcess is called in the window before the
    // wrapper has backgrounded the real command. It appears only once the bounded reread has
    // started, simulating the wrapper catching up mid-retry.
    setTimeout(() => files.set(pidFile, "9999"), 20);
    await sandbox.cancelProcess(ref, { id: "proc-aaaaaaaa" });
    expect(killScripts).toHaveLength(1);
    expect(killScripts[0]).toContain("-9999");
  });

  it("does not throw when it cancels an identifier that was never issued, and signals nothing", async () => {
    const { handle: sprite, killScripts } = virtualSprite();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    await expect(sandbox.cancelProcess(ref, { id: "gone" })).resolves.toBeUndefined();
    expect(killScripts).toHaveLength(0);
  });

  it("does not throw when it destroys a sprite that has already gone", async () => {
    const sprite = handle({ delete: vi.fn().mockRejectedValue(new Error("404 not found")) });
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    await expect(sandbox.destroy(ref)).resolves.toBeUndefined();
  });

  it("creates a named checkpoint", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    const checkpoint = await sandbox.checkpoint(ref, "baseline");
    expect(sprite.createCheckpoint).toHaveBeenCalledWith("baseline");
    expect(checkpoint).toEqual({ id: "v1", name: "baseline" });
  });

  it("publishes the port through the sprite URL (H-2)", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    expect(await sandbox.exposeService(ref, 8080)).toEqual({ port: 8080, url: "https://factoree-run-1-abc.sprites.app" });
    expect(sprite.publishPort).toHaveBeenCalledWith(8080);
  });

  it("reports a failed publication as a SandboxError that names the port", async () => {
    const sprite = handle({ publishPort: vi.fn().mockRejectedValue(new Error("no capacity")) });
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    await expect(sandbox.exposeService(ref, 8080)).rejects.toThrow(SandboxError);
    await expect(sandbox.exposeService(ref, 8080)).rejects.toThrow(/8080/);
  });
});

describe("FlySpriteSandbox.applyNetworkPolicy, the propagation of the policy", () => {
  it("waits until the sandbox resolves every allowed name", async () => {
    // A measured Sprite refused a newly allowed domain until 442 ms after the API call returned.
    let probes = 0;
    const sprite = handle({
      execFile: vi.fn().mockImplementation(() => {
        probes += 1;
        return Promise.resolve({ exitCode: probes < 3 ? 2 : 0, stdout: "", stderr: "" });
      }),
    });
    const sandbox = new FlySpriteSandbox({
      gateway: gateway(sprite),
      networkPolicyAttempts: 5,
      networkPolicyDelayMs: 0,
    });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });

    await sandbox.applyNetworkPolicy(ref, { allowedDomains: ["opencode.ai", "github.com"] });

    expect(probes).toBe(3);
    const script = String(vi.mocked(sprite.execFile).mock.calls[0]?.[1]?.[1]);
    expect(script).toContain("getent hosts 'opencode.ai'");
    expect(script).toContain("getent hosts 'github.com'");
  });

  it("returns after the last attempt, so the next command reports the real problem", async () => {
    const sprite = handle({
      execFile: vi.fn().mockResolvedValue({ exitCode: 2, stdout: "", stderr: "" }),
    });
    const sandbox = new FlySpriteSandbox({
      gateway: gateway(sprite),
      networkPolicyAttempts: 3,
      networkPolicyDelayMs: 0,
    });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });

    await expect(sandbox.applyNetworkPolicy(ref, { allowedDomains: ["opencode.ai"] })).resolves.toBeUndefined();
    expect(vi.mocked(sprite.execFile)).toHaveBeenCalledTimes(3);
  });

  it("probes nothing when the policy denies everything", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });

    await sandbox.applyNetworkPolicy(ref, { allowedDomains: [] });

    expect(vi.mocked(sprite.execFile)).not.toHaveBeenCalled();
  });

  it("probes no wildcard entry, because it names no host to resolve", async () => {
    const sprite = handle({ execFile: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }) });
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite), networkPolicyDelayMs: 0 });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });

    await sandbox.applyNetworkPolicy(ref, { allowedDomains: ["*.example.com", "opencode.ai"] });

    const script = String(vi.mocked(sprite.execFile).mock.calls[0]?.[1]?.[1]);
    expect(script).toContain("opencode.ai");
    expect(script).not.toContain("example.com");
  });
});

describe("FlySpriteSandbox, an isolated command", () => {
  it("runs without the environment attached to the sandbox, and keeps the base environment", async () => {
    const sprite = handle({ execFile: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }) });
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    sandbox.attachEnvironment(ref, { OPENCODE_API_KEY: "runner-credential" });

    await sandbox.exec(ref, { file: "sh", args: ["-c", "npm test"], isolated: true, env: { LANG: "C.UTF-8" } });

    const env = vi.mocked(sprite.execFile).mock.calls.at(-1)?.[2]?.env ?? {};
    // SDD section 30. A verification command must not hold the credential of an agent session.
    expect(env["OPENCODE_API_KEY"]).toBeUndefined();
    expect(env["LANG"]).toBe("C.UTF-8");
    // The toolchain of a Sprite lives in /.sprite/bin, so the base PATH must survive.
    expect(env["PATH"]).toContain("/.sprite/bin");
    expect(env["HOME"]).toBe("/home/sprite");
  });

  it("gives an ordinary command the attached environment", async () => {
    const sprite = handle({ execFile: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }) });
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    sandbox.attachEnvironment(ref, { OPENCODE_API_KEY: "runner-credential" });

    await sandbox.exec(ref, { file: "sh", args: ["-c", "opencode run"] });

    const env = vi.mocked(sprite.execFile).mock.calls.at(-1)?.[2]?.env ?? {};
    expect(env["OPENCODE_API_KEY"]).toBe("runner-credential");
  });
});

describe("FlySpriteSandbox.startProcess, a large environment", () => {
  // The exec API puts every environment value in the query string of the WebSocket URL, and the
  // server refuses a URL beyond roughly fifty kilobytes. A Reviewer prompt carries the diff and
  // the Validation Contract, so it crossed that limit and the connection failed with a bare
  // TypeError. Two Runs died there, after implementation, verification, and user validation had
  // all passed.
  it("sends a large environment as a file the wrapper reads", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
    const prompt = "x".repeat(40 * 1024);

    await sandbox.startProcess(ref, { file: "sh", args: ["-c", "true"], env: { FACTOREE_PROMPT: prompt } });

    const [path, content] = vi.mocked(sprite.writeFile).mock.calls[0] ?? [];
    expect(String(path)).toMatch(/\/env$/);
    expect(String(content)).toContain("export FACTOREE_PROMPT=");
    // The URL carries the base environment only, so it stays far below the limit of the server.
    const sent = vi.mocked(sprite.startDetached).mock.calls[0]?.[2]?.env ?? {};
    expect(sent["FACTOREE_PROMPT"]).toBeUndefined();
    expect(sent["PATH"]).toContain("/.sprite/bin");
    // The wrapper reads the file before it starts the command.
    const wrapper = String(vi.mocked(sprite.startDetached).mock.calls[0]?.[1]?.[1]);
    expect(wrapper).toContain("/env'");
  });

  it("keeps a small environment in the call, which needs no extra write", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });

    await sandbox.startProcess(ref, { file: "sh", args: ["-c", "true"], env: { FACTOREE_PROMPT: "small" } });

    expect(vi.mocked(sprite.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(sprite.startDetached).mock.calls[0]?.[2]?.env?.["FACTOREE_PROMPT"]).toBe("small");
  });

  it("names a value the kernel cannot carry, rather than letting the shell fail", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });

    await expect(
      sandbox.startProcess(ref, {
        file: "sh",
        args: ["-c", "true"],
        env: { FACTOREE_PROMPT: "x".repeat(200 * 1024) },
      }),
    ).rejects.toThrow(/FACTOREE_PROMPT.*Argument list too long/s);
  });
});
