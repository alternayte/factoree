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
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref, "a secret goal sentence"));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    const command = sandbox.commands.at(-1);
    expect(command?.args.join(" ")).not.toContain("a secret goal sentence");
    // The prompt travels in a file, not in the environment: Linux carries at most 131072 bytes
    // in one environment value, and a real Reviewer prompt measured 202351 bytes.
    const promptFile = command?.env?.["FACTOREE_PROMPT_FILE"] ?? "";
    expect(promptFile).toMatch(/\.factoree\/prompt\/.*\.txt$/);
    expect(sandbox.files.get(promptFile)).toBe("a secret goal sentence");
    sandbox.finishProcess("process-2", {
      exitCode: 0,
      stdout: '{"type":"result","result":"ok","session_id":"s"}',
    });
    await started;
  });

  it("starts the CLI in non-interactive mode with the stream-json format", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
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
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
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
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
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
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
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

// GitHub issue 84. A test suite in one Bash call wrote nothing for ten minutes, and Factoree
// stopped a session that waited on a correct command.
describe("ClaudeCodeRunner, a silent tool call", () => {
  const toolUse =
    '{"type":"assistant","session_id":"s","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"dotnet test"}}]}}';

  it("does not count an open tool call as a hang before the tool call limit", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    let now = 0;
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1, silenceLimitMs: 60_000, clock: () => now });
    const started = runner.run({ ...runInput(sandbox, ref, "goal"), timeoutMs: 24 * 60 * 60_000 });
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.updateProcess("process-2", { running: true, stdout: toolUse });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Twenty minutes of silence on an open call.
    now = 20 * 60_000;
    await new Promise((resolve) => setTimeout(resolve, 5));
    sandbox.finishProcess("process-2", { exitCode: 0, stdout: `${toolUse}\n{"type":"result","result":"ok","session_id":"s"}` });
    const result = await started;
    expect(result.outcome).toBe("finished");
  });

  it("stops a session whose open tool call outlasts the tool call limit, and names the call", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    let now = 0;
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1, silenceLimitMs: 60_000, clock: () => now });
    const started = runner.run({ ...runInput(sandbox, ref, "goal"), timeoutMs: 24 * 60 * 60_000 });
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.updateProcess("process-2", { running: true, stdout: toolUse });
    await new Promise((resolve) => setTimeout(resolve, 5));
    now = 40 * 60_000;
    const result = await started;
    expect(result.outcome).toBe("hung");
    expect(result.openToolCall).toEqual({ name: "Bash", input: "dotnet test", runningMs: 40 * 60_000 });
    expect(result.summary).toContain("`dotnet test`");
  });

  it("stops a silent session with no open tool call at the silence limit", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    let now = 0;
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1, silenceLimitMs: 60_000, clock: () => now });
    const started = runner.run({ ...runInput(sandbox, ref, "goal"), timeoutMs: 24 * 60 * 60_000 });
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.updateProcess("process-2", {
      running: true,
      stdout: `${toolUse}\n{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    now = 2 * 60_000;
    const result = await started;
    expect(result.outcome).toBe("hung");
    expect(result.openToolCall).toBeUndefined();
  });
});
