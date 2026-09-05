import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { OpenCodeRunner } from "~/adapters/runners/opencode/opencode-runner.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { Redactor } from "~/telemetry/redaction.js";

const stub = resolve("tests/fixtures/bin/opencode-stub.sh");

/**
 * Waits until `condition` returns true, or fails the test after `timeoutMs`.
 */
const waitUntil = async (condition: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("waitUntil timed out before the condition held.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("OpenCodeRunner against a real sandbox process", () => {
  let root: string;
  let sandbox: LocalProcessSandbox;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-runner-"));
    sandbox = new LocalProcessSandbox({ rootDirectory: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const input = async (extraEnv: Record<string, string>) => {
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    return {
      ref,
      run: {
        runId: "run-1",
        tenantId: "t",
        role: "implementer" as const,
        sandbox,
        ref,
        workingDirectory: ref.workspacePath,
        prompt: "Write this line into the target file.",
        promptVersion: "implementer/1",
        environment: extraEnv,
        actionPolicy: buildActionPolicy(),
        timeoutMs: 20_000,
      },
    };
  };

  it("runs the agent, which changes a file in the worktree", async () => {
    const { ref, run } = await input({ FACTOREE_STUB_TARGET: "out.txt" });
    const runner = new OpenCodeRunner({ executable: stub, redactor: new Redactor(), pollIntervalMs: 20 });
    const result = await runner.run(run);
    expect(result.completed).toBe(true);
    expect(result.session.sessionId).toBe("ses_stub_1");
    expect(result.summary).toBe("The change is applied.");
    const written = await readFile(join(ref.workspacePath, "out.txt"), "utf8");
    expect(written.trim()).toBe("Write this line into the target file.");
  });

  it("redacts a Project secret the agent printed", async () => {
    const { run } = await input({ FACTOREE_STUB_PRINT_SECRET: "value-from-the-secret-store" });
    const runner = new OpenCodeRunner({
      executable: stub,
      redactor: new Redactor(["value-from-the-secret-store"]),
      pollIntervalMs: 20,
    });
    const result = await runner.run(run);
    expect(result.summary).not.toContain("value-from-the-secret-store");
  });

  it("cancels a running agent process", async () => {
    const { run } = await input({ FACTOREE_STUB_SLEEP: "30" });
    const runner = new OpenCodeRunner({ executable: stub, redactor: new Redactor(), pollIntervalMs: 20 });
    const started = runner.run(run);
    await waitUntil(() => runner.activeSession("run-1") !== undefined);
    const session = runner.activeSession("run-1");
    if (session === undefined) throw new Error("the runner started no session");
    await runner.cancel(session);
    const result = await started;
    expect(result.cancelled).toBe(true);
    expect(result.completed).toBe(false);
  });

  it("stops the agent when it outlives its budget", async () => {
    const { run } = await input({ FACTOREE_STUB_SLEEP: "30" });
    const runner = new OpenCodeRunner({ executable: stub, redactor: new Redactor(), pollIntervalMs: 20 });
    const result = await runner.run({ ...run, timeoutMs: 500 });
    expect(result.completed).toBe(false);
    expect(result.cancelled).toBe(true);
  });
});
