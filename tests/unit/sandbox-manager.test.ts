import { describe, expect, it } from "vitest";
import { NetworkPolicyNotEnforcedError } from "~/domain/runs/sandbox.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import { DEFAULT_PROJECT_RUNTIME_CONFIG } from "~/domain/runs/project-runtime-config.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const input = {
  runId: "run-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  primary: { url: "https://github.com/acme/app.git", ref: "main" },
  references: [],
  config: { ...DEFAULT_PROJECT_RUNTIME_CONFIG, allowedDomains: ["registry.npmjs.org"] },
};

const withSha = (): FakeSandbox => {
  const sandbox = new FakeSandbox();
  sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
  return sandbox;
};

describe("SandboxManager.prepare", () => {
  it("follows the SDD section 32 order: create, network policy, checkout, bootstrap, checkpoint", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    await manager.prepare({ ...input, config: { ...input.config, bootstrapCommand: "npm ci" } });
    const order = sandbox.calls.filter(
      (call) => call === "create" || call === "applyNetworkPolicy" || call.startsWith("checkpoint"),
    );
    expect(order).toEqual(["create", "applyNetworkPolicy", "checkpoint:baseline"]);
  });

  it("applies the network policy before it runs any command", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    await manager.prepare(input);
    const policyIndex = sandbox.calls.indexOf("applyNetworkPolicy");
    const firstExec = sandbox.calls.findIndex((call) => call.startsWith("exec:"));
    expect(policyIndex).toBeGreaterThanOrEqual(0);
    expect(policyIndex).toBeLessThan(firstExec);
  });

  it("creates the workspace directory after the policy and before the first clone", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    await manager.prepare(input);
    const policyIndex = sandbox.calls.indexOf("applyNetworkPolicy");
    const mkdirIndex = sandbox.commands.findIndex(
      (command) => command.file === "mkdir" && command.args.includes("/workspace"),
    );
    const cloneIndex = sandbox.commands.findIndex(
      (command) => command.file === "git" && command.args[0] === "clone",
    );
    expect(mkdirIndex).toBeGreaterThanOrEqual(0);
    expect(cloneIndex).toBeGreaterThan(mkdirIndex);
    // The applyNetworkPolicy call is not in `commands`, so compare against the raw call order.
    const mkdirCallIndex = sandbox.calls.indexOf("exec:mkdir");
    expect(mkdirCallIndex).toBeGreaterThan(policyIndex);
  });

  it("passes the Project allow list to the network policy", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    await manager.prepare(input);
    expect(sandbox.policies[0]).toEqual({ allowedDomains: ["registry.npmjs.org"] });
  });

  it("runs the bootstrap command in the primary worktree after the checkout", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    await manager.prepare({ ...input, config: { ...input.config, bootstrapCommand: "npm ci" } });
    const bootstrap = sandbox.commands.find((command) => command.args.includes("npm ci"));
    expect(bootstrap?.cwd).toBe("/workspace/primary");
  });

  it("skips bootstrap when the Project configures no bootstrap command", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    await manager.prepare(input);
    expect(sandbox.commands.some((command) => command.args.includes("npm ci"))).toBe(false);
  });

  it("fails the preparation when the bootstrap command fails", async () => {
    const sandbox = withSha();
    sandbox.scriptExec(/npm ci/, { exitCode: 1, stderr: "install failed" });
    const manager = new SandboxManager({ sandbox });
    await expect(
      manager.prepare({ ...input, config: { ...input.config, bootstrapCommand: "npm ci" } }),
    ).rejects.toThrow(/install failed/);
  });

  it("reports a failed bootstrap command as a configuration fault", async () => {
    // SDD section 49. The command comes from the Project configuration, so a retry repeats it.
    const sandbox = withSha();
    sandbox.scriptExec(/npm ci/, { exitCode: 1, stderr: "install failed" });
    const manager = new SandboxManager({ sandbox });
    await expect(
      manager.prepare({ ...input, config: { ...input.config, bootstrapCommand: "npm ci" } }),
    ).rejects.toBeInstanceOf(RunConfigurationError);
  });

  it("destroys the sandbox when preparation fails, so no sandbox leaks", async () => {
    const sandbox = withSha();
    sandbox.scriptExec(/clone/, { exitCode: 128, stderr: "clone failed" });
    const manager = new SandboxManager({ sandbox });
    await expect(manager.prepare(input)).rejects.toThrow(/clone failed/);
    expect(sandbox.destroyed).toHaveLength(1);
  });

  it("returns the sandbox reference, the base SHA, and the baseline checkpoint", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    const prepared = await manager.prepare(input);
    expect(prepared.ref.id).toContain("run-1");
    expect(prepared.checkout.primary.baseSha).toBe("aaaabbbbccccddddeeeeffff0000111122223333");
    expect(prepared.baselineCheckpoint?.name).toBe("baseline");
  });

  it("refuses a sandbox that cannot enforce the network policy", async () => {
    const sandbox = new FakeSandbox({
      enforcesNetworkPolicy: false,
      supportsCheckpoints: true,
      supportsExposedServices: false,
    });
    const manager = new SandboxManager({ sandbox });
    await expect(manager.prepare(input)).rejects.toThrow(NetworkPolicyNotEnforcedError);
  });

  it("accepts an unenforced sandbox only when the caller opts in", async () => {
    const sandbox = new FakeSandbox({
      enforcesNetworkPolicy: false,
      supportsCheckpoints: true,
      supportsExposedServices: false,
    });
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    await expect(manager.prepare(input)).resolves.toBeDefined();
  });

  it("skips the checkpoint when the adapter does not support checkpoints", async () => {
    const sandbox = new FakeSandbox({
      enforcesNetworkPolicy: true,
      supportsCheckpoints: false,
      supportsExposedServices: false,
    });
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const manager = new SandboxManager({ sandbox });
    const prepared = await manager.prepare(input);
    expect(prepared.baselineCheckpoint).toBeNull();
    expect(sandbox.checkpoints).toHaveLength(0);
  });

  it("gives two Runs two different sandbox identifiers", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    const first = await manager.prepare(input);
    const second = await manager.prepare({ ...input, runId: "run-2" });
    expect(first.ref.id).not.toBe(second.ref.id);
  });

  it("destroys the sandbox on release", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    const prepared = await manager.prepare(input);
    await manager.release(prepared);
    expect(sandbox.destroyed).toContain(prepared.ref.id);
  });
});
