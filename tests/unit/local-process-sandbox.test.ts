import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { runSandboxContract } from "../support/sandbox-contract.js";

runSandboxContract("LocalProcessSandbox", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "factoree-contract-"));
  const sandbox = new LocalProcessSandbox({ rootDirectory });
  return { sandbox, dispose: async () => rm(rootDirectory, { recursive: true, force: true }) };
});

describe("LocalProcessSandbox", () => {
  it("declares that it cannot enforce a network policy", () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: tmpdir() });
    expect(sandbox.capabilities.enforcesNetworkPolicy).toBe(false);
    expect(sandbox.name).toBe("local");
  });

  it("removes the workspace directory on destroy", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "factoree-destroy-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    await sandbox.exec(ref, { file: "sh", args: ["-c", "printf x > marker"] });
    await sandbox.destroy(ref);
    await expect(sandbox.exec(ref, { file: "sh", args: ["-c", "true"] })).rejects.toThrow(/destroyed/);
    await rm(rootDirectory, { recursive: true, force: true });
  });

  it("removes a workspace that holds a read-only subtree", async () => {
    // Every reference checkout is read-only, because SDD section 29 denies an agent writing one.
    // A read-only directory blocks removal of the entries inside it, so destroy must restore
    // write permission first. Without that step this test fails with EACCES.
    const rootDirectory = await mkdtemp(join(tmpdir(), "factoree-readonly-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    const created = await sandbox.exec(ref, {
      file: "sh",
      args: ["-c", "mkdir -p reference/design/.git && printf x > reference/design/.git/config && chmod -R a-w reference/design"],
    });
    expect(created.exitCode).toBe(0);
    // The checkpoint copy carries the same read-only mode, so destroy must handle it too.
    await sandbox.checkpoint(ref, "baseline");

    await sandbox.destroy(ref);

    expect(existsSync(join(rootDirectory, ref.id))).toBe(false);
    await rm(rootDirectory, { recursive: true, force: true });
  });

  it("copies the workspace into a checkpoint directory", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "factoree-checkpoint-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    await sandbox.exec(ref, { file: "sh", args: ["-c", "printf baseline > marker"] });
    const checkpoint = await sandbox.checkpoint(ref, "baseline");
    await sandbox.exec(ref, { file: "sh", args: ["-c", "printf changed > marker"] });
    const saved = await readFile(join(rootDirectory, ref.id, "checkpoints", checkpoint.id, "marker"), "utf8");
    expect(saved).toBe("baseline");
    await rm(rootDirectory, { recursive: true, force: true });
  });
});

describe("LocalProcessSandbox and the host environment", () => {
  it("hides a host credential from the child process", async () => {
    // SDD section 30. The worker holds an admin credential, a Linear token, and a Fly token in
    // its own environment. An agent that runs `printenv` must not read any of them.
    const rootDirectory = await mkdtemp(join(tmpdir(), "factoree-env-"));
    process.env.ADMIN_API_TOKEN = "admin-token-fixture";
    try {
      const sandbox = new LocalProcessSandbox({ rootDirectory });
      const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
      const result = await sandbox.exec(ref, { file: "sh", args: ["-c", "printenv"] });
      expect(result.stdout).not.toContain("admin-token-fixture");
      expect(result.stdout).toContain("PATH=");
      expect(result.stdout).toContain("HOME=");
      await sandbox.destroy(ref);
    } finally {
      delete process.env.ADMIN_API_TOKEN;
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("still passes the environment of the command", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "factoree-env-"));
    try {
      const sandbox = new LocalProcessSandbox({ rootDirectory });
      const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
      const result = await sandbox.exec(ref, {
        file: "sh",
        args: ["-c", "printf %s \"$FIXTURE\""],
        env: { FIXTURE: "fixture-value" },
      });
      expect(result.stdout).toBe("fixture-value");
      await sandbox.destroy(ref);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});


describe("LocalProcessSandbox, an isolated command", () => {
  it("runs without the environment attached to the sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "factoree-isolated-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory: root });
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    sandbox.attachEnvironment(ref, { OPENCODE_API_KEY: "runner-credential" });

    const withCredential = await sandbox.exec(ref, {
      file: "sh",
      args: ["-c", "printf %s \"${OPENCODE_API_KEY:-absent}\""],
    });
    const isolated = await sandbox.exec(ref, {
      file: "sh",
      args: ["-c", "printf %s \"${OPENCODE_API_KEY:-absent}\""],
      isolated: true,
    });

    expect(withCredential.stdout).toBe("runner-credential");
    expect(isolated.stdout).toBe("absent");
    await rm(root, { recursive: true, force: true });
  });
});

describe("LocalProcessSandbox, a timeout of a command that forked", () => {
  it("ends the whole process tree, not the shell alone", async () => {
    // A shell forks its command on Linux, and a signal to the shell alone leaves that child
    // running. The child keeps the pipes of the shell open, so `close` never arrives and the
    // caller waits for a command it already killed. CI proved it: the same test waited the full
    // thirty seconds of the `sleep` and failed at the five second budget of the test.
    const root = await mkdtemp(join(tmpdir(), "factoree-kill-tree-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory: root });
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });

    const startedAt = Date.now();
    const result = await sandbox.exec(ref, {
      file: "sh",
      // `& wait` forces the fork on every platform, so the test reads the same everywhere.
      args: ["-c", "sleep 30 & wait"],
      timeoutMs: 500,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    // The command ends at its timeout, not at the end of the sleep.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await rm(root, { recursive: true, force: true });
  }, 15_000);
});

describe("LocalProcessSandbox, a cancel of a process that forked", () => {
  it("ends the whole process tree, so a stopped preview holds its port no longer", async () => {
    // A shell forks its command on Linux, and a cancel of the shell alone left the command
    // running. CI proved the cost twice: a stopped preview still answered 200 on its port, and
    // the user validation after it read the old application.
    const root = await mkdtemp(join(tmpdir(), "factoree-cancel-tree-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory: root });
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const pidFile = join(root, "grandchild.pid");

    const process1 = await sandbox.startProcess(ref, {
      file: "sh",
      args: ["-c", `sleep 30 & echo $! > ${pidFile}; wait`],
      cwd: "/",
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(Number.isInteger(pid)).toBe(true);

    await sandbox.cancelProcess(ref, process1);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(false);
    await rm(root, { recursive: true, force: true });
  }, 15_000);
});
