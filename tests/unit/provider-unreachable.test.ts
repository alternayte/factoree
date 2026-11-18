import { describe, expect, it } from "vitest";
import { ClaudeCodeRunner } from "~/adapters/runners/claude-code/claude-code-runner.js";
import { parseClaudeOutput } from "~/adapters/runners/claude-code/output-parser.js";
import { endsInProviderUnreachable, isProviderUnreachableText } from "~/adapters/runners/provider-unreachable.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { agentSessionKey, summarizeAgentSessions } from "~/domain/runs/agent-session.js";
import { failureCategoryOf } from "~/domain/runs/failure-category.js";
import { providerUnreachableOf } from "~/activities/agent-session-recording.js";
import { Redactor } from "~/telemetry/redaction.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const API_ERROR = "API Error: Unable to connect to API (EAI_AGAIN)";

const runInput = (sandbox: FakeSandbox, ref: Awaited<ReturnType<FakeSandbox["create"]>>, timeoutMs = 5_000) => ({
  runId: "run-1",
  tenantId: "tenant-1",
  role: "implementer" as const,
  sandbox,
  ref,
  workingDirectory: "/workspace/primary",
  prompt: "goal",
  promptVersion: "implementer/1",
  environment: {},
  actionPolicy: buildActionPolicy(),
  timeoutMs,
});

const waitUntil = async (condition: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("waitUntil timed out before the condition held.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

describe("the provider-unreachable classifier", () => {
  it.each(["EAI_AGAIN", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "Can't reach the API server"])("matches %s", (pattern) => {
    expect(isProviderUnreachableText(`API Error: getaddrinfo ${pattern} api.anthropic.com`)).toBe(true);
  });

  it("does not match ordinary output", () => {
    expect(isProviderUnreachableText("The change is applied. Every test passes.")).toBe(false);
  });

  it.each(["ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN"])(
    "does not match a tool or test line that merely echoes %s",
    (code) => {
      expect(isProviderUnreachableText(`npm error network request to https://registry failed: ${code}`)).toBe(false);
      expect(isProviderUnreachableText(`{"type":"tool_result","content":"fetch failed: ${code}"}`)).toBe(false);
    },
  );

  it("reads only the tail of the output for the fast-fail", () => {
    const old = `${API_ERROR}\n`;
    expect(endsInProviderUnreachable(`${old}${"working\n".repeat(500)}`)).toBe(false);
    expect(endsInProviderUnreachable(`${"working\n".repeat(500)}${old}`)).toBe(true);
  });

  it("does not fast-fail when a tool result echoing ETIMEDOUT is the last line", () => {
    expect(endsInProviderUnreachable(`${API_ERROR}\n{"type":"tool_result","content":"curl: (28) ETIMEDOUT"}\n`)).toBe(
      false,
    );
  });
});

describe("the Claude output parser and a connectivity error", () => {
  it("reads the plain connectivity line as the error message", () => {
    const parsed = parseClaudeOutput("Can't reach the API server (EAI_AGAIN)\n");
    expect(parsed.errorMessage).toBe("Can't reach the API server (EAI_AGAIN)");
  });

  it("reads the text of an error result", () => {
    const parsed = parseClaudeOutput(`{"type":"result","is_error":true,"result":"${API_ERROR}"}`);
    expect(parsed.errorMessage).toBe(API_ERROR);
  });

  it("reports no error message for a clean run", () => {
    expect(parseClaudeOutput('{"type":"result","result":"ok"}').errorMessage).toBeUndefined();
  });
});

describe("CliAgentRunner and an unreachable provider", () => {
  it("sets failureKind and the unreachable outcome when the CLI exits 1 on EAI_AGAIN", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.finishProcess("process-2", { exitCode: 1, stderr: `${API_ERROR}\n` });

    const result = await started;

    expect(result.completed).toBe(false);
    expect(result.failureKind).toBe("PROVIDER_UNREACHABLE");
    expect(result.outcome).toBe("unreachable");
    expect(result.summary).toContain("EAI_AGAIN");
    expect(providerUnreachableOf([result])?.summary).toContain("EAI_AGAIN");
  });

  it("leaves a finished session and an ordinary failure alone", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.finishProcess("process-2", { exitCode: 1, stderr: "tests failed\n" });

    const result = await started;

    expect(result.failureKind).toBeUndefined();
    expect(result.outcome).toBe("failed");
  });

  it("leaves a failed session whose tool output merely echoes ETIMEDOUT as an ordinary failure", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new ClaudeCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.finishProcess("process-2", {
      exitCode: 1,
      stdout: '{"type":"tool_result","content":"curl: (28) ETIMEDOUT reaching test host"}\n',
      stderr: "the change did not apply\n",
    });

    const result = await started;

    expect(result.failureKind).toBeUndefined();
    expect(result.outcome).toBe("failed");
  });

  it("cancels the session on the grace timer, long before the silence limit", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new ClaudeCodeRunner({
      redactor: new Redactor(),
      pollIntervalMs: 1,
      silenceLimitMs: 60_000,
      providerUnreachableGraceMs: 20,
    });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    // The CLI stays alive and backs off, so it never exits on its own within the test.
    sandbox.updateProcess("process-2", { running: true, stderr: `${API_ERROR} Retrying in 4 seconds\n` });

    const result = await started;

    expect(result.cancelled).toBe(true);
    expect(result.failureKind).toBe("PROVIDER_UNREACHABLE");
    expect(result.outcome).toBe("unreachable");
  });

  it("does not fast-fail while the session writes other output after the error", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new ClaudeCodeRunner({
      redactor: new Redactor(),
      pollIntervalMs: 1,
      providerUnreachableGraceMs: 30,
    });
    const started = runner.run(runInput(sandbox, ref));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    sandbox.updateProcess("process-2", { running: true, stderr: `${API_ERROR}\n` });
    await new Promise((resolve) => setTimeout(resolve, 5));
    sandbox.updateProcess("process-2", {
      running: true,
      stderr: `${API_ERROR}\n${"the model is working again\n".repeat(200)}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    sandbox.finishProcess("process-2", { exitCode: 0, stdout: '{"type":"result","result":"ok"}' });

    const result = await started;

    expect(result.completed).toBe(true);
    expect(result.failureKind).toBeUndefined();
  });
});

describe("the domain of an unreachable provider", () => {
  it("files PROVIDER_UNREACHABLE under INFRASTRUCTURE", () => {
    expect(failureCategoryOf("PROVIDER_UNREACHABLE")).toBe("INFRASTRUCTURE");
  });

  it("gives each retry session its own row key", () => {
    const keys = [0, 1, 2].map((retry) => agentSessionKey("r", "refiner", null, retry > 0, retry));
    expect(new Set(keys).size).toBe(3);
  });

  it("counts unreachable sessions apart from hung ones", () => {
    const row = (outcome: "unreachable" | "finished") => ({
      tenantId: "t",
      runId: "r",
      role: "implementer" as const,
      attempt: 1,
      runner: "claude",
      cliSessionId: null,
      model: null,
      effort: null,
      usage: null,
      durationMs: 1,
      outcome,
      idempotencyKey: outcome,
    });
    const totals = summarizeAgentSessions([row("unreachable"), row("finished")]);
    expect(totals.roles[0]).toMatchObject({ sessions: 2, hung: 0, unreachable: 1 });
  });
});
