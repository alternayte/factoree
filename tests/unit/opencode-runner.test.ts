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
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "opencode");
    const command = sandbox.commands.at(-1);
    expect(command?.file).toBe("opencode");
    expect(command?.cwd).toBe("/workspace/primary");
    sandbox.finishProcess("process-2", { stdout: '{"type":"session.start","session":{"id":"ses_1"}}' });
    await started;
  });

  it("passes the prompt through the environment, not through the command line", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "opencode");
    const command = sandbox.commands.at(-1);
    expect(command?.args.join(" ")).not.toContain("Add a health endpoint.");
    expect(command?.env?.FACTOREE_PROMPT).toBe("Add a health endpoint.");
    sandbox.finishProcess("process-2", { stdout: "" });
    await started;
  });

  it("returns the session reference and the summary when the process exits zero", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "opencode");
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
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "opencode");
    sandbox.finishProcess("process-2", { exitCode: 1, stdout: '{"type":"message","text":"failed"}' });
    const result = await started;
    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("redacts a Project secret from the summary (SDD section 60)", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const redactor = new Redactor(["super-secret-value"]);
    const runner = new OpenCodeRunner({ redactor, pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "opencode");
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
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
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
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const first = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "opencode");
    sandbox.finishProcess("process-2", { exitCode: 0, stdout: '{"type":"session.start","session":{"id":"ses_1"}}' });
    const initial = await first;

    const resumed = runner.resume(initial.session, { prompt: "Fix the lint failure.", timeoutMs: 5_000 });
    await waitUntil(() => sandbox.commands.length === 2);
    const command = sandbox.commands.at(-1);
    expect(command?.args).toContain("--session");
    expect(command?.args).toContain("ses_1");
    sandbox.finishProcess("process-3", { exitCode: 0, stdout: '{"type":"message","text":"fixed"}' });
    expect((await resumed).summary).toBe("fixed");
  });

  it("keeps the previous session entry so a retried resume can still find its sandbox", async () => {
    // Factoree runs resume as a Temporal activity. Temporal retries an activity with its
    // original arguments unchanged, so a retry presents the same AgentSessionRef as the first
    // attempt. The runner must not have deleted the entry that reference points to.
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const first = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "opencode");
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
    await waitUntil(() => sandbox.commands.length === 3);
    sandbox.finishProcess("process-4", { exitCode: 0, stdout: '{"type":"message","text":"fixed on retry"}' });
    const result = await retriedAttempt;
    expect(result.summary).toBe("fixed on retry");
  });

  it("cancels the process and reports a timeout when the process outlives its budget", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const result = await runner.run({ ...runInput(sandbox, ref), timeoutMs: 5 });
    expect(result.completed).toBe(false);
    expect(sandbox.calls).toContain("cancelProcess");
  });
});
