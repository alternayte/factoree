import { describe, expect, it } from "vitest";
import { OpenCodeRunner } from "~/adapters/runners/opencode/opencode-runner.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { Redactor } from "~/telemetry/redaction.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const runInput = (sandbox: FakeSandbox, ref: Awaited<ReturnType<FakeSandbox["create"]>>) => ({
  runId: "run-1",
  tenantId: "tenant-1",
  role: "implementer" as const,
  sandbox,
  ref,
  workingDirectory: "/workspace/primary",
  prompt: "Add a health endpoint.",
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

describe("OpenCodeRunner", () => {
  it("is named opencode", () => {
    expect(new OpenCodeRunner({ redactor: new Redactor() }).name).toBe("opencode");
  });

  it("starts the opencode executable in the working directory", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    const command = sandbox.commands.at(-1);
    expect(command?.file).toBe("sh");
    expect(command?.env?.FACTOREE_OPENCODE_BIN).toBe("opencode");
    expect(command?.cwd).toBe("/workspace/primary");
    sandbox.finishProcess("process-2", { stdout: '{"type":"session.start","session":{"id":"ses_1"}}' });
    await started;
  });

  it("passes the model and its reasoning effort the worker chose (B-3)", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({
      redactor: new Redactor(),
      pollIntervalMs: 1,
      model: "deepseek/deepseek-flash",
      variant: "max",
    });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    const args = sandbox.commands.at(-1)?.args ?? [];
    expect(args.slice(3, 7)).toEqual(["--model", "deepseek/deepseek-flash", "--variant", "max"]);
    sandbox.finishProcess("process-2", { stdout: '{"type":"session.start","session":{"id":"ses_1"}}' });
    await started;
  });

  it("uses the effort of the session's role over the default (DI-14.40)", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({
      redactor: new Redactor(),
      pollIntervalMs: 1,
      model: "deepseek/deepseek-flash",
      variant: "max",
      roleVariants: { validator: "low" },
    });
    const started = runner.run({ ...runInput(sandbox, ref), role: "validator" });
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    expect((sandbox.commands.at(-1)?.args ?? []).slice(3, 7)).toEqual(["--model", "deepseek/deepseek-flash", "--variant", "low"]);
    sandbox.finishProcess("process-2", { stdout: '{"type":"session.start","session":{"id":"ses_1"}}' });
    await started;
  });

  it("passes the prompt through a file, not through the command line", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    const command = sandbox.commands.at(-1);
    expect(command?.args.join(" ")).not.toContain("Add a health endpoint.");
    // A file, not an environment value: Linux carries at most 131072 bytes in one value, and a
    // real Reviewer prompt measured 202351 bytes.
    const promptFile = command?.env?.FACTOREE_PROMPT_FILE ?? "";
    expect(promptFile).toMatch(/\.factoree\/prompt\/.*\.txt$/);
    expect(sandbox.files.get(promptFile)).toBe("Add a health endpoint.");
    sandbox.finishProcess("process-2", { stdout: "" });
    await started;
  });

  it("returns the session reference and the summary when the process exits zero", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.finishProcess("process-2", {
      exitCode: 0,
      stdout: ['{"type":"session.start","session":{"id":"ses_1"}}', '{"type":"message","text":"done"}'].join("\n"),
    });
    const result = await started;
    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
    expect(result.session.sessionId).toBe("ses_1");
    expect(result.session.processId).toBe("process-2");
    expect(result.session.runner).toBe("opencode");
  });

  it("reports completed false when the process exits non-zero", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.finishProcess("process-2", { exitCode: 1, stdout: '{"type":"message","text":"failed"}' });
    const result = await started;
    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("redacts a Project secret from the summary (SDD section 60)", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const redactor = new Redactor(["super-secret-value"]);
    const runner = new OpenCodeRunner({ redactor, pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.finishProcess("process-2", {
      exitCode: 0,
      stdout: '{"type":"message","text":"I printed super-secret-value"}',
    });
    const result = await started;
    expect(result.summary).not.toContain("super-secret-value");
    expect(result.summary).toContain("[REDACTED]");
  });

  it("cancels the sandbox process for a session and reports the outcome", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => runner.activeSession("run-1") !== undefined);
    const outcome = await runner.cancel({ sessionId: "ses_1", processId: "process-2", runner: "opencode" });
    const result = await started;
    expect(sandbox.calls).toContain("cancelProcess");
    expect(result.cancelled).toBe(true);
    expect(outcome).toBe("cancelled");
  });

  it("reports no-live-session for a process id this runner does not hold", async () => {
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const outcome = await runner.cancel({
      sessionId: "ses_unknown",
      processId: "process-unknown",
      runner: "opencode",
    });
    expect(outcome).toBe("no-live-session");
  });

  it("resumes a session with the opencode session flag", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const first = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.finishProcess("process-2", { exitCode: 0, stdout: '{"type":"session.start","session":{"id":"ses_1"}}' });
    const initial = await first;

    const resumed = runner.resume(initial.session, { prompt: "Fix the lint failure.", timeoutMs: 5_000 });
    await waitUntil(() => sandbox.started.length === 2);
    const command = sandbox.started.at(-1);
    expect(command?.args.join(" ")).toContain("--session");
    expect(command?.env?.FACTOREE_OPENCODE_SESSION).toBe("ses_1");
    sandbox.finishProcess("process-3", { exitCode: 0, stdout: '{"type":"message","text":"fixed"}' });
    expect((await resumed).summary).toBe("fixed");
  });

  it("keeps the previous session entry so a retried resume can still find its sandbox", async () => {
    // Factoree runs resume as a Temporal activity. Temporal retries an activity with its
    // original arguments unchanged, so a retry presents the same AgentSessionRef as the first
    // attempt. The runner must not have deleted the entry that reference points to.
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const first = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.finishProcess("process-2", { exitCode: 0, stdout: '{"type":"session.start","session":{"id":"ses_1"}}' });
    const initial = await first;

    const originalReadProcess = sandbox.readProcess.bind(sandbox);
    let failedOnce = false;
    sandbox.readProcess = (readRef, process) => {
      if (!failedOnce && process.id === "process-3") {
        failedOnce = true;
        return Promise.reject(new Error("transient sandbox fault"));
      }
      return originalReadProcess(readRef, process);
    };

    const failingAttempt = runner.resume(initial.session, { prompt: "Fix the lint failure.", timeoutMs: 5_000 });
    await expect(failingAttempt).rejects.toThrow("transient sandbox fault");

    sandbox.readProcess = originalReadProcess;
    const retriedAttempt = runner.resume(initial.session, { prompt: "Fix the lint failure.", timeoutMs: 5_000 });
    await waitUntil(() => sandbox.started.length === 3);
    sandbox.finishProcess("process-4", { exitCode: 0, stdout: '{"type":"message","text":"fixed on retry"}' });
    const result = await retriedAttempt;
    expect(result.summary).toBe("fixed on retry");
  });

  it("cancels the process and reports a timeout when the process outlives its budget", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const result = await runner.run({ ...runInput(sandbox, ref), timeoutMs: 5 });
    expect(result.completed).toBe(false);
    expect(sandbox.calls).toContain("cancelProcess");
  });
});

describe("OpenCodeRunner, the summary of a failed run", () => {
  it("reports the error of the agent, not its shutdown line", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.finishProcess("process-2", {
      exitCode: 1,
      stdout: [
        '{"type":"session.start","session":{"id":"ses_1"}}',
        '{"type":"error","error":{"name":"APIError","data":{"message":"Insufficient balance."}}}',
        'timestamp=2026-08-27T14:13:31.415Z level=INFO message="disposing instance"',
      ].join("\n"),
    });

    const result = await started;

    expect(result.completed).toBe(false);
    expect(result.summary).toBe("Insufficient balance.");
  });

  it("keeps the answer of the agent when the run finished", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.finishProcess("process-2", {
      exitCode: 0,
      stdout: [
        '{"type":"session.start","session":{"id":"ses_1"}}',
        '{"type":"error","error":{"data":{"message":"a retry that recovered"}}}',
        '{"type":"message","text":"The change is applied."}',
      ].join("\n"),
    });

    const result = await started;

    expect(result.completed).toBe(true);
    expect(result.summary).toBe("The change is applied.");
  });
});

describe("CliAgentRunner, the idle deadline of a session", () => {
  it("ends a session that stopped writing, before the budget ends", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({
      redactor: new Redactor(),
      pollIntervalMs: 1,
      silenceLimitMs: 20,
    });

    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    // The process stays alive and writes one event, then nothing. This is the shape of an agent
    // waiting on a connection that a sandbox pause dropped.
    sandbox.updateProcess("process-2", {
      running: true,
      stdout: '{"type":"session.start","session":{"id":"ses_1"}}',
    });

    const result = await started;

    expect(result.completed).toBe(false);
    expect(result.cancelled).toBe(true);
    // The cancel signal decides the code: the fallback 124 applies only when the process left
    // no exit code at all.
    expect(result.exitCode).toBe(143);
    expect(result.summary).toContain("wrote nothing");
    expect(result.session.sessionId).toBe("ses_1");
    // docs/specs/agent-session-usage-and-hangs.md. The silence makes the session hung.
    expect(result.outcome).toBe("hung");
    expect(result.silenceLimitMs).toBe(20);
  });

  it("reports a budget that ends during the silence as a timeout, not as a hang", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1, silenceLimitMs: 60_000 });

    const result = await runner.run({ ...runInput(sandbox, ref), timeoutMs: 20 });

    expect(result.completed).toBe(false);
    expect(result.outcome).toBe("failed");
  });

  it("keeps a session alive while it still writes", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({
      redactor: new Redactor(),
      pollIntervalMs: 1,
      silenceLimitMs: 60,
    });

    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    for (let step = 0; step < 5; step += 1) {
      sandbox.updateProcess("process-2", { running: true, stdout: `{"type":"step_start","n":${step}}` });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    sandbox.finishProcess("process-2", { exitCode: 0, stdout: '{"type":"message","text":"done"}' });

    const result = await started;

    expect(result.completed).toBe(true);
    expect(result.summary).toBe("done");
  });
});

describe("OpenCodeRunner, the permission to read across the workspace", () => {
  // The User Validator and the Reviewer work from a scratch directory beside the checkout, and
  // opencode rejects a read outside the working directory. A real Run ended with both assertions
  // `BLOCKED`, because the validator could read nothing and wrote no Validation Plan.
  const configOf = (command: { env?: Record<string, string> } | undefined) =>
    JSON.parse(command?.env?.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      permission?: { external_directory?: string };
    };

  it("allows a read outside the working directory on a new session", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");

    expect(configOf(sandbox.commands.at(-1)).permission?.external_directory).toBe("allow");

    sandbox.finishProcess("process-2", { stdout: '{"type":"message","text":"done"}' });
    await started;
  });

  it("allows it on a resumed session too", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.finishProcess("process-2", { stdout: '{"type":"session.start","session":{"id":"ses_1"}}' });
    const first = await started;

    const resumed = runner.resume(first.session, { ...runInput(sandbox, ref), prompt: "carry on" });
    await waitUntil(() => sandbox.started.length > 1);

    expect(configOf(sandbox.started.at(-1)).permission?.external_directory).toBe("allow");

    sandbox.finishProcess("process-3", { stdout: '{"type":"message","text":"done"}' });
    await resumed;
  });
});

describe("OpenCodeRunner, the repository the session configures itself from", () => {
  // A validator or a reviewer works from a scratch directory, so opencode found no repository
  // configuration and fell back to a default model. A real Run proved the cost: the validator
  // ran a model the Project never chose, the provider answered 500, and it wrote no plan.
  // The assertion reads the real argument list. An earlier version of this test rebuilt the
  // command as text, and it passed while the running command was broken: the path travelled in
  // an environment variable with its quotes attached, and `opencode` answered
  // "Failed to change directory".
  const argsOf = (command: { args: string[] } | undefined): string[] => command?.args ?? [];

  it("names the repository with --dir when the caller gives one", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run({
      ...runInput(sandbox, ref),
      workingDirectory: "/workspace/validation",
      repositoryPath: "/workspace/primary",
    });
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");

    const args = argsOf(sandbox.commands.at(-1));
    expect(args.slice(-2)).toEqual(["--dir", "/workspace/primary"]);
    // The script reads its parameters with "$@", so `sh` must fill $0 ahead of them.
    expect(args[2]).toBe("sh");
    expect(args[1]).toContain('"$@"');
    expect(sandbox.commands.at(-1)?.cwd).toBe("/workspace/validation");

    sandbox.finishProcess("process-2", { stdout: '{"type":"message","text":"done"}' });
    await started;
  });

  it("adds no --dir when the caller names no repository", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");

    expect(argsOf(sandbox.commands.at(-1))).not.toContain("--dir");

    sandbox.finishProcess("process-2", { stdout: '{"type":"message","text":"done"}' });
    await started;
  });

  it("keeps the repository on a resumed session", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run({ ...runInput(sandbox, ref), repositoryPath: "/workspace/primary" });
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.finishProcess("process-2", { stdout: '{"type":"session.start","session":{"id":"ses_1"}}' });
    const first = await started;

    const resumed = runner.resume(first.session, { ...runInput(sandbox, ref), prompt: "carry on" });
    await waitUntil(() => sandbox.started.length > 1);

    expect(argsOf(sandbox.started.at(-1)).slice(-2)).toEqual(["--dir", "/workspace/primary"]);

    sandbox.finishProcess("process-3", { stdout: '{"type":"message","text":"done"}' });
    await resumed;
  });
});

describe("CliAgentRunner, a prompt larger than an environment value can hold", () => {
  // A real Reviewer prompt measured 202351 bytes: the contract, the diff, and the instructions.
  // Linux carries at most 131072 bytes in one environment value, so the environment can never
  // carry such a prompt, whatever the transport underneath. Two Runs failed at review with it.
  it("carries a two hundred kilobyte prompt", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const prompt = `START${"x".repeat(200_000)}END`;

    const started = runner.run({ ...runInput(sandbox, ref), prompt });
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");

    const command = sandbox.commands.at(-1);
    const promptFile = command?.env?.FACTOREE_PROMPT_FILE ?? "";
    expect(sandbox.files.get(promptFile)).toBe(prompt);
    // No environment value carries any part of it.
    for (const value of Object.values(command?.env ?? {})) {
      expect(value.length).toBeLessThan(1_000);
    }

    sandbox.finishProcess("process-2", { stdout: '{"type":"message","text":"done"}' });
    await started;
  });
});

describe("OpenCodeRunner, the usage of a session", () => {
  const exportText = (ids: string[]) =>
    JSON.stringify({
      info: { id: "ses_1" },
      messages: ids.map((id) => ({
        info: {
          id,
          role: "assistant",
          providerID: "deepseek",
          modelID: "deepseek-flash",
          cost: 0.5,
          tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 100, write: 1 } },
          time: { created: 0, completed: 2_000 },
        },
      })),
    });

  it("reads the usage with opencode export, in the session's directory and environment", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({
      redactor: new Redactor(),
      pollIntervalMs: 1,
      executable: "/opt/factoree/bin/opencode",
      variant: "max",
    });
    sandbox.scriptExec(/ \/opt\/factoree\/bin\/opencode ses_1$/, { stdout: exportText(["a1", "a2"]) });

    const started = runner.run({ ...runInput(sandbox, ref), repositoryPath: "/workspace/primary" });
    await waitUntil(() => sandbox.started.length === 1);
    sandbox.finishProcess("process-2", { stdout: '{"type":"session.start","session":{"id":"ses_1"}}' });
    const result = await started;

    // anomalyco/opencode#57266. The export goes to a file first, because opencode cuts off a
    // large export written to a pipe.
    const exported = sandbox.commands.find((command) => command.args.includes("ses_1"));
    expect(exported?.file).toBe("sh");
    expect(exported?.args[1]).toContain('export "$2" > "$f"');
    expect(exported?.args.slice(3)).toEqual(["/opt/factoree/bin/opencode", "ses_1"]);
    expect(exported?.cwd).toBe("/workspace/primary");
    expect(exported?.env?.TEST_API_KEY).toBe("super-secret-value");
    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 40,
      reasoningTokens: 10,
      cacheReadTokens: 200,
      cacheWriteTokens: 2,
      costUsd: 1,
      turns: 2,
      longestTurnMs: 2_000,
      modelMs: 4_000,
      toolMs: 0,
    });
    expect(result.model).toBe("deepseek/deepseek-flash");
    expect(result.effort).toBe("max");
    expect(result.outcome).toBe("finished");
  });

  it("reports only the calls of the resume, because the export repeats the earlier ones", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    let calls = ["a1"];
    sandbox.onExec = () => ({ exitCode: 0, stdout: exportText(calls), stderr: "" });

    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.started.length === 1);
    sandbox.finishProcess("process-2", { stdout: '{"type":"session.start","session":{"id":"ses_1"}}' });
    const first = await started;
    expect(first.usage?.turns).toBe(1);

    calls = ["a1", "a2", "a3"];
    const resumed = runner.resume(first.session, { prompt: "continue", timeoutMs: 5_000 });
    await waitUntil(() => sandbox.started.length === 2);
    sandbox.finishProcess("process-3", { stdout: '{"type":"message","text":"done"}' });
    const second = await resumed;
    expect(second.usage?.turns).toBe(2);
    expect(second.usage?.costUsd).toBe(1);
  });

  it("reports no usage when the export fails, and still returns the result", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    sandbox.scriptExec(/ ses_1$/, { exitCode: 1, stderr: "Session not found" });

    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.started.length === 1);
    sandbox.finishProcess("process-2", { stdout: '{"type":"session.start","session":{"id":"ses_1"}}\n{"type":"message","text":"ok"}' });
    const result = await started;

    expect(result.usage).toBeNull();
    expect(result.completed).toBe(true);
  });
});
