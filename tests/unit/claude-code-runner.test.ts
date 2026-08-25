import { describe, expect, it } from "vitest";
import { ClaudeCodeRunner } from "~/adapters/runners/claude-code/claude-code-runner.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { Redactor } from "~/telemetry/redaction.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const runInput = (sandbox: FakeSandbox, ref: Awaited<ReturnType<FakeSandbox["create"]>>, prompt: string) => ({
  runId: "run-1",
  tenantId: "tenant-1",
  role: "implementer" as const,
  sandbox,
  ref,
  workingDirectory: "/workspace/primary",
  prompt,
  promptVersion: "implementer/1",
  environment: { TEST_API_KEY: "super-secret-value" },
  actionPolicy: buildActionPolicy(),
  timeoutMs: 5_000,
});

/**
 * Waits until `condition` returns true, or fails the test after `timeoutMs`. The runner tests
 * use this instead of a fixed count of `Promise.resolve()` calls, because the number of
 * microtask turns before the runner registers a command is an implementation detail, not a
 * contract.
 */
const waitUntil = async (condition: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("waitUntil timed out before the condition held.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

describe("ClaudeCodeRunner", () => {
  it("is named claude, the name the stock configuration selects", () => {
    expect(new ClaudeCodeRunner({ redactor: new Redactor() }).name).toBe("claude");
  });

  it("never places the prompt on the command line", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref, "a secret goal sentence"));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    const command = sandbox.commands.at(-1);
    expect(command?.args.join(" ")).not.toContain("a secret goal sentence");
    expect(command?.env?.["FACTOREE_PROMPT"]).toBe("a secret goal sentence");
    sandbox.finishProcess("process-2", {
      exitCode: 0,
      stdout: '{"type":"result","result":"ok","session_id":"s"}',
    });
    await started;
  });

  it("starts the CLI in non-interactive mode with the stream-json format", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref, "goal"));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    const command = sandbox.commands.at(-1);
    const script = command?.args[1] ?? "";
    expect(command?.file).toBe("sh");
    expect(script).toContain("--print");
    expect(script).toContain("--output-format stream-json");
    expect(script).toContain("$FACTOREE_PROMPT");
    sandbox.finishProcess("process-2", { exitCode: 0, stdout: '{"type":"result","result":"ok"}' });
    await started;
  });

  it("resumes the named session and keeps the identifier out of the command line", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref, "goal"));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.finishProcess("process-2", {
      exitCode: 0,
      stdout: '{"type":"result","result":"ok","session_id":"ses-1"}',
    });
    const first = await started;

    const resumed = runner.resume(first.session, { prompt: "repair it", timeoutMs: 1_000 });
    await waitUntil(() => sandbox.commands.length === 2);
    const command = sandbox.commands.at(-1);
    expect(command?.env?.["FACTOREE_CLAUDE_SESSION"]).toBe("ses-1");
    expect(command?.args.join(" ")).not.toContain("ses-1");
    expect(command?.args[1] ?? "").toContain("--resume");
    sandbox.finishProcess("process-3", { exitCode: 0, stdout: '{"type":"result","result":"ok"}' });
    await resumed;
  });

  it("reports a non-zero exit as an incomplete run", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref, "goal"));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.finishProcess("process-2", { exitCode: 2, stdout: '{"type":"result","result":"it broke"}' });
    const result = await started;
    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it("redacts a Project secret the agent printed", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(["s3cr3t-value"]), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref, "goal"));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.finishProcess("process-2", {
      exitCode: 0,
      stdout: '{"type":"result","result":"I printed s3cr3t-value"}',
    });
    const result = await started;
    expect(result.summary).not.toContain("s3cr3t-value");
  });
});
