import { describe, expect, it } from "vitest";
import { OpenCodeRunner } from "~/adapters/runners/opencode/opencode-runner.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { Redactor } from "~/telemetry/redaction.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

/**
 * Waits until `condition` returns true, or fails the test after `timeoutMs`. Copied from
 * `tests/unit/opencode-runner.test.ts`, because the runner registers a command after a number
 * of microtask turns that is an implementation detail, not a contract.
 */
const waitUntil = async (condition: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("waitUntil timed out before the condition held.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

/**
 * Starts one Run to completion. A caller reuses an earlier `runner` and `sandbox` to start a
 * second Run against the same fake sandbox and its one reference, so the fake process ids stay
 * unique across Runs, as a real sandbox provider guarantees. Returns the runner, the sandbox,
 * the sandbox reference, and the session of the resolved `AgentRunResult`.
 */
const startOneRun = async (
  runId: string,
  shared: { runner?: OpenCodeRunner; sandbox?: FakeSandbox; ref?: Awaited<ReturnType<FakeSandbox["create"]>> } = {},
) => {
  const runner = shared.runner ?? new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
  const sandbox = shared.sandbox ?? new FakeSandbox();
  const ref = shared.ref ?? (await sandbox.create({ runId, tenantId: "tenant-1", productId: "project-1" }));
  const commandsBefore = sandbox.started.length;
  const started = runner.run({
    runId,
    tenantId: "tenant-1",
    role: "implementer",
    sandbox,
    ref,
    workingDirectory: "/workspace/primary",
    prompt: "Add a health endpoint.",
    promptVersion: "implementer/1",
    environment: {},
    actionPolicy: buildActionPolicy(),
    timeoutMs: 5_000,
  });
  await waitUntil(() => sandbox.started.length > commandsBefore && sandbox.started.at(-1)?.file === "sh");
  // A fresh sandbox spends one counter tick on `create`, so its first `startProcess` yields
  // "process-2". Reusing a sandbox's ref across Runs spends no further `create` tick, so each
  // further `startProcess` id is one past the number of commands already recorded.
  const processId = `process-${commandsBefore + 2}`;
  sandbox.finishProcess(processId, {
    exitCode: 0,
    stdout: `{"type":"session.start","session":{"id":"ses-${runId}"}}`,
  });
  const result = await started;
  return { runner, sandbox, ref, session: result.session };
};

describe("CliAgentRunner.releaseRun", () => {
  it("disposes every session of one Run", async () => {
    const { runner, sandbox, ref } = await startOneRun("run-a");
    const session = runner.activeSession("run-a");
    // The Run finished. Before release, a resume still reaches the recorded session.
    runner.releaseRun("run-a");
    await expect(
      runner.resume(
        { sessionId: "ses-run-a", processId: "process-2", runner: "opencode" },
        { prompt: "again", timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(/no live sandbox/);
    expect(session).toBeUndefined();
    expect(sandbox).toBeDefined();
    expect(ref).toBeDefined();
  });

  it("keeps the sessions of every other Run", async () => {
    const first = await startOneRun("run-a");
    const second = await startOneRun("run-b", { runner: first.runner, sandbox: first.sandbox, ref: first.ref });
    second.runner.releaseRun("run-a");
    // The second Run is untouched, so its session still resumes.
    const commandsBeforeResume = second.sandbox.started.length;
    const resumed = second.runner.resume(second.session, { prompt: "again", timeoutMs: 5_000 });
    await waitUntil(() => second.sandbox.started.length > commandsBeforeResume);
    second.sandbox.finishProcess(`process-${commandsBeforeResume + 2}`, {
      exitCode: 0,
      stdout: '{"type":"message","text":"done again"}',
    });
    const result = await resumed;
    expect(result.exitCode).toBe(0);
  });

  it("reports the number of retained sessions, so a test can prove the map is bounded", async () => {
    const first = await startOneRun("run-a");
    await startOneRun("run-b", { runner: first.runner, sandbox: first.sandbox, ref: first.ref });
    expect(first.runner.retainedSessionCount()).toBe(2);
    first.runner.releaseRun("run-a");
    expect(first.runner.retainedSessionCount()).toBe(1);
    first.runner.releaseRun("run-b");
    expect(first.runner.retainedSessionCount()).toBe(0);
  });
});
