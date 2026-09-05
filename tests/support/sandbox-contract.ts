import { describe, expect, it } from "vitest";
import type { Sandbox } from "~/domain/runs/sandbox.js";

export interface SandboxUnderTest {
  sandbox: Sandbox;
  dispose: () => Promise<void>;
}

export interface SandboxContractOptions {
  /**
   * True when the subject really runs a command. An in-memory double records a command and
   * answers it from a script, so it cannot honour stdout, an exit code, a working directory, an
   * environment variable, a timeout, or the isolation of two workspaces. Such a subject claims
   * the lifecycle part of the contract only. The execution part stays as strong as it was.
   */
  executesCommands?: boolean;
}

/**
 * Every Sandbox adapter must pass this suite. SDD section 12 requires that the Fly Sprites
 * adapter be replaceable, so the behaviour the rest of Factoree depends on lives here and
 * not in one adapter's own test file.
 *
 * The suite has two parts. Every conformer passes the lifecycle part. A conformer that executes
 * commands passes the execution part as well.
 */
export const runSandboxContract = (
  name: string,
  create: () => Promise<SandboxUnderTest>,
  options: SandboxContractOptions = {},
): void => {
  const executesCommands = options.executesCommands ?? true;
  const whenExecuting = executesCommands ? it : it.skip;
  describe(`Sandbox contract: ${name}`, () => {
    const withSandbox = async (body: (subject: SandboxUnderTest) => Promise<void>): Promise<void> => {
      const subject = await create();
      try {
        await body(subject);
      } finally {
        await subject.dispose();
      }
    };

    it("creates a sandbox with a unique identifier and a workspace path", async () => {
      await withSandbox(async ({ sandbox }) => {
        const first = await sandbox.create({ runId: "run-a", tenantId: "t", productId: "p" });
        const second = await sandbox.create({ runId: "run-b", tenantId: "t", productId: "p" });
        expect(first.id).not.toBe(second.id);
        expect(first.adapter).toBe(sandbox.name);
        expect(first.workspacePath.startsWith("/")).toBe(true);
        await sandbox.destroy(first);
        await sandbox.destroy(second);
      });
    });

    whenExecuting("runs a command and reports stdout and a zero exit code", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
        const result = await sandbox.exec(ref, { file: "sh", args: ["-c", "printf hello"] });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hello");
        expect(result.timedOut).toBe(false);
        await sandbox.destroy(ref);
      });
    });

    whenExecuting("reports a non-zero exit code and stderr without throwing", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-2", tenantId: "t", productId: "p" });
        const result = await sandbox.exec(ref, { file: "sh", args: ["-c", "printf oops >&2; exit 3"] });
        expect(result.exitCode).toBe(3);
        expect(result.stderr).toBe("oops");
        await sandbox.destroy(ref);
      });
    });

    whenExecuting("runs a command in the workspace by default and honours cwd and env", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-3", tenantId: "t", productId: "p" });
        await sandbox.exec(ref, { file: "sh", args: ["-c", "mkdir -p sub && printf x > sub/f"] });
        const inSub = await sandbox.exec(ref, { file: "sh", args: ["-c", "cat f"], cwd: "sub" });
        expect(inSub.stdout).toBe("x");
        const withEnv = await sandbox.exec(ref, {
          file: "sh",
          args: ["-c", "printf %s \"$FACTOREE_TEST\""],
          env: { FACTOREE_TEST: "value" },
        });
        expect(withEnv.stdout).toBe("value");
        await sandbox.destroy(ref);
      });
    });

    whenExecuting("stops a command at its timeout and reports timedOut", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-4", tenantId: "t", productId: "p" });
        const result = await sandbox.exec(ref, { file: "sh", args: ["-c", "sleep 30"], timeoutMs: 500 });
        expect(result.timedOut).toBe(true);
        expect(result.exitCode).not.toBe(0);
        await sandbox.destroy(ref);
      });
    });

    whenExecuting("starts a process, reads its output, and reports it as finished", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-5", tenantId: "t", productId: "p" });
        const process = await sandbox.startProcess(ref, { file: "sh", args: ["-c", "printf started; exit 0"] });
        const snapshot = await pollUntil(async () => sandbox.readProcess(ref, process), (s) => !s.running);
        expect(snapshot.exitCode).toBe(0);
        expect(snapshot.stdout).toBe("started");
        await sandbox.destroy(ref);
      });
    });

    it("cancels a running process", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-6", tenantId: "t", productId: "p" });
        const process = await sandbox.startProcess(ref, { file: "sh", args: ["-c", "sleep 60"] });
        await sandbox.cancelProcess(ref, process);
        const snapshot = await pollUntil(async () => sandbox.readProcess(ref, process), (s) => !s.running);
        expect(snapshot.running).toBe(false);
        expect(snapshot.exitCode).not.toBe(0);
        await sandbox.destroy(ref);
      });
    });

    whenExecuting("cancelling an already finished process does not throw", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-7", tenantId: "t", productId: "p" });
        const process = await sandbox.startProcess(ref, { file: "sh", args: ["-c", "exit 0"] });
        await pollUntil(async () => sandbox.readProcess(ref, process), (s) => !s.running);
        await expect(sandbox.cancelProcess(ref, process)).resolves.toBeUndefined();
        await sandbox.destroy(ref);
      });
    });

    it("creates a named checkpoint when the adapter supports checkpoints", async () => {
      await withSandbox(async ({ sandbox }) => {
        if (!sandbox.capabilities.supportsCheckpoints) return;
        const ref = await sandbox.create({ runId: "run-8", tenantId: "t", productId: "p" });
        const checkpoint = await sandbox.checkpoint(ref, "baseline");
        expect(checkpoint.name).toBe("baseline");
        expect(checkpoint.id.length).toBeGreaterThan(0);
        await sandbox.destroy(ref);
      });
    });

    it("applies a network policy without throwing", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-9", tenantId: "t", productId: "p" });
        await expect(
          sandbox.applyNetworkPolicy(ref, { allowedDomains: ["registry.npmjs.org"] }),
        ).resolves.toBeUndefined();
        await sandbox.destroy(ref);
      });
    });

    it("destroying a sandbox twice does not throw", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-10", tenantId: "t", productId: "p" });
        await sandbox.destroy(ref);
        await expect(sandbox.destroy(ref)).resolves.toBeUndefined();
      });
    });

    whenExecuting("isolates two sandboxes from one another", async () => {
      await withSandbox(async ({ sandbox }) => {
        const first = await sandbox.create({ runId: "run-11", tenantId: "t", productId: "p" });
        const second = await sandbox.create({ runId: "run-12", tenantId: "t", productId: "p" });
        await sandbox.exec(first, { file: "sh", args: ["-c", "printf one > marker"] });
        const read = await sandbox.exec(second, { file: "sh", args: ["-c", "cat marker 2>/dev/null; printf END"] });
        expect(read.stdout).toBe("END");
        await sandbox.destroy(first);
        await sandbox.destroy(second);
      });
    });
  });
};

const pollUntil = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error("the sandbox contract poll timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
