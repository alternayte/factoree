import { describe, expect, it } from "vitest";
import { ClaudeCodeRunner } from "~/adapters/runners/claude-code/claude-code-runner.js";
import { parseClaudeOutput } from "~/adapters/runners/claude-code/output-parser.js";
import {
  endsInProviderUnreachable,
  isProviderUnreachableText,
  ProviderOutageWatch,
  readProviderSignals,
} from "~/adapters/runners/provider-unreachable.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { agentSessionKey, summarizeAgentSessions } from "~/domain/runs/agent-session.js";
import { failureCategoryOf } from "~/domain/runs/failure-category.js";
import { providerUnreachableOf } from "~/activities/agent-session-recording.js";
import { Redactor } from "~/telemetry/redaction.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const API_ERROR = "API Error: Unable to connect to API (EAI_AGAIN)";

// The shape the Claude CLI documents for its `system/api_retry` event (SDKAPIRetryMessage). No
// captured outage stream exists in this repository, so the line is built from that shape.
const retryLine = (status: number | null, delayMs?: number): string =>
  `${JSON.stringify({
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 10,
    ...(delayMs === undefined ? {} : { retry_delay_ms: delayMs }),
    error_status: status,
    error: status === null ? "unknown" : "rate_limit",
    session_id: "s-1",
  })}\n`;

const assistantLine = (content: unknown): string =>
  `${JSON.stringify({ type: "assistant", message: { content } })}\n`;

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
    expect(endsInProviderUnreachable(`working on it\n{"type":"tool_result","content":"curl: (28) ETIMEDOUT"}\n`)).toBe(
      false,
    );
  });

  it("skips a tool_result or user event that echoes the API Error marker", () => {
    const toolResult = `{"type":"tool_result","content":"API Error: fetch failed (ETIMEDOUT)"}`;
    const userTurn = `{"type":"user","message":{"content":[{"type":"tool_result","content":"API Error: ENOTFOUND"}]}}`;
    expect(isProviderUnreachableText(toolResult)).toBe(false);
    expect(isProviderUnreachableText(userTurn)).toBe(false);
    expect(endsInProviderUnreachable(`working on it\n${toolResult}\n`)).toBe(false);
  });

  it("matches the Claude api_retry event the CLI writes during its backoff", () => {
    const retry = retryLine(null);
    expect(endsInProviderUnreachable(`{"type":"system","subtype":"init"}\n${retry}${retry}`)).toBe(true);
    expect(isProviderUnreachableText(`${retry}${retry}`)).toBe(true);
  });

  it("does not treat an api_retry that recovered as an outage", () => {
    const output = `${retryLine(null)}${assistantLine([{ type: "text", text: "back to work" }])}`;
    // The last signal line is model activity, not a retry, so a session that recovered is not an outage.
    expect(isProviderUnreachableText(output)).toBe(false);
    expect(endsInProviderUnreachable(output)).toBe(false);
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

  it("names the provider from api_retry events when nothing better was written", () => {
    const retry = retryLine(null);
    const parsed = parseClaudeOutput(`{"type":"system","subtype":"init"}\n${retry}${retry}`);
    expect(parsed.errorMessage).toContain("provider could not be reached");
  });

  it.each([429, 529])("never words a status %i retry as an unreachable provider", (status) => {
    const parsed = parseClaudeOutput(`${retryLine(status)}${retryLine(status)}`);
    expect(parsed.errorMessage ?? "").not.toContain("could not be reached");
    expect(parsed.errorMessage ?? "").toContain(String(status));
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

  it("fast-fails on Claude api_retry events that carry no error text", async () => {
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
    // The CLI stays alive and only writes api_retry events during its backoff.
    sandbox.updateProcess("process-2", {
      running: true,
      stdout: retryLine(null) + retryLine(null) + retryLine(null),
    });

    const result = await started;

    expect(result.cancelled).toBe(true);
    expect(result.failureKind).toBe("PROVIDER_UNREACHABLE");
    expect(result.outcome).toBe("unreachable");
    expect(result.summary).toContain("provider could not be reached");
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

const textBlock = (text: string) => ({ type: "text", text });

describe("event-aware provider signals", () => {
  const kinds = (output: string) => readProviderSignals(output).map((signal) => signal.kind);

  it("reads a null-status api_retry as a connectivity retry", () => {
    expect(readProviderSignals(retryLine(null, 1_500))).toEqual([{ kind: "connectivity-retry" }]);
  });

  it.each([429, 529, 500])("reads a status %i api_retry as another retry, never as an outage", (status) => {
    expect(kinds(retryLine(status, 2_000))).toEqual(["other-retry"]);
    expect(isProviderUnreachableText(retryLine(status).repeat(5))).toBe(false);
    expect(endsInProviderUnreachable(retryLine(status).repeat(5))).toBe(false);
  });

  it("matches a failed result event that carries the provider diagnostic", () => {
    const line = `${JSON.stringify({ type: "result", is_error: true, result: API_ERROR })}\n`;
    expect(kinds(line)).toEqual(["provider-error"]);
    expect(isProviderUnreachableText(line)).toBe(true);
  });

  it("does not match a successful result or an error result without a provider diagnostic", () => {
    const ok = `${JSON.stringify({ type: "result", is_error: false, result: API_ERROR })}\n`;
    const other = `${JSON.stringify({ type: "result", is_error: true, result: "tests failed" })}\n`;
    expect(kinds(ok)).toEqual(["normal"]);
    expect(kinds(other)).toEqual(["normal"]);
  });

  it("does not read tool input, tool result, user or nested assistant data", () => {
    const echo = "API Error: fetch failed (ECONNRESET)";
    const lines = [
      { type: "tool_result", content: echo },
      { type: "user", message: { content: [{ type: "tool_result", content: echo }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: echo } }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }], note: echo } },
      { type: "stream_event", event: { delta: { text: echo } } },
      { type: "unknown-future-event", payload: echo },
      { type: "system", subtype: "init", cwd: echo },
    ].map((event) => `${JSON.stringify(event)}\n`);
    for (const line of lines) {
      expect(isProviderUnreachableText(line)).toBe(false);
      expect(kinds(line)).toEqual(["normal"]);
    }
  });

  it("matches assistant text that starts with the CLI-owned API Error marker", () => {
    const text = "API Error: Unable to connect to API (EAI_AGAIN)";
    expect(kinds(assistantLine([textBlock(text)]))).toEqual(["provider-error"]);
    expect(kinds(assistantLine([textBlock(`  \n${text}`)]))).toEqual(["provider-error"]);
    expect(kinds(assistantLine(text))).toEqual(["provider-error"]);
  });

  it("does not match quoted or embedded API Error text in an assistant message", () => {
    expect(kinds(assistantLine([textBlock("I saw API Error: ECONNRESET in the logs")]))).toEqual(["normal"]);
    expect(
      kinds(assistantLine([{ type: "tool_use", name: "Bash", input: { command: "echo API Error: x (ECONNRESET)" } }])),
    ).toEqual(["normal"]);
    expect(kinds(assistantLine([textBlock("API Error: the build failed")]))).toEqual(["normal"]);
  });

  it("follows the first text block, ignoring thinking and tool_use blocks before it", () => {
    const marker = textBlock(API_ERROR);
    const plain = textBlock("working");
    const thinking = { type: "thinking", thinking: "hmm" };
    const toolUse = { type: "tool_use", name: "Bash", input: {} };
    expect(kinds(assistantLine([thinking, toolUse, marker]))).toEqual(["provider-error"]);
    expect(kinds(assistantLine([toolUse, plain, marker]))).toEqual(["normal"]);
  });

  it("classifies a plain line with the string rule and ignores a non-object JSON line", () => {
    expect(kinds(`${API_ERROR}\nnpm error network ETIMEDOUT\n`)).toEqual(["provider-error", "normal"]);
    expect(kinds("null\n42\n[1]\n")).toEqual(["normal", "normal", "normal"]);
  });

  it("reads the opencode phrase from a JSON error event and from a plain line", () => {
    const event = `${JSON.stringify({ type: "error", error: { data: { message: "Can't reach the API server" } } })}\n`;
    expect(kinds(event)).toEqual(["provider-error"]);
    expect(kinds("Can't reach the API server\n")).toEqual(["provider-error"]);
  });

  it("drops blank lines and an unfinished trailing fragment", () => {
    expect(kinds(`\n  \n${retryLine(null)}\n`)).toEqual(["connectivity-retry"]);
    expect(kinds(`${retryLine(null)}${API_ERROR}`)).toEqual(["connectivity-retry"]);
    expect(readProviderSignals(`${retryLine(null)}${API_ERROR}`, { final: true }).map((s) => s.kind)).toEqual([
      "connectivity-retry",
      "provider-error",
    ]);
  });

  it("lets recovery activity after a retry prevent the terminal classification", () => {
    const output = `${retryLine(null)}${retryLine(null)}${assistantLine([textBlock("done")])}`;
    expect(isProviderUnreachableText(output)).toBe(false);
    expect(endsInProviderUnreachable(output)).toBe(false);
  });

  it("does not match a long tool result line that the tail limit cut in the middle", () => {
    const line = `${JSON.stringify({ type: "tool_result", content: `${"x".repeat(1_500)} API Error: ECONNRESET ${"y".repeat(1_500)}` })}\n`;
    expect(endsInProviderUnreachable(line)).toBe(false);
    expect(endsInProviderUnreachable(`${line}${retryLine(null)}`)).toBe(true);
  });
});

describe("ProviderOutageWatch", () => {
  const GRACE = 100;
  const feed = (watch: ProviderOutageWatch, text: string, now: number) => watch.feed(text, now);

  it("is not eligible after one connectivity retry", () => {
    const watch = new ProviderOutageWatch(GRACE);
    feed(watch, retryLine(null), 0);
    expect(watch.deadline).toBeNull();
  });

  it("becomes eligible after consecutive retries, with the deadline at the first retry plus the grace", () => {
    const watch = new ProviderOutageWatch(GRACE);
    feed(watch, retryLine(null), 1_000);
    feed(watch, retryLine(null).repeat(2), 1_020);
    expect(watch.deadline).toBeNull();
    feed(watch, retryLine(null).repeat(3), 1_040);
    expect(watch.deadline).toBe(1_000 + GRACE);
  });

  it("keeps the deadline at the first retry while later retries arrive", () => {
    const watch = new ProviderOutageWatch(GRACE);
    const first = retryLine(null).repeat(3);
    feed(watch, first, 0);
    expect(watch.deadline).toBe(GRACE);
    feed(watch, `${first}${retryLine(null)}`, 80);
    expect(watch.deadline).toBe(GRACE);
  });

  it("arms at once on a string provider error", () => {
    const watch = new ProviderOutageWatch(GRACE);
    feed(watch, `${API_ERROR}\n`, 5);
    expect(watch.deadline).toBe(5 + GRACE);
  });

  it("resets on any other complete event, but not on blank lines or an unfinished line", () => {
    const watch = new ProviderOutageWatch(GRACE);
    const retries = retryLine(null).repeat(3);
    feed(watch, retries, 0);
    feed(watch, `${retries}\n  \n`, 10);
    expect(watch.deadline).toBe(GRACE);
    feed(watch, `${retries}\n  \nstill typing`, 20);
    expect(watch.deadline).toBe(GRACE);
    feed(watch, `${retries}\n  \nstill typing\n`, 30);
    expect(watch.deadline).toBeNull();
  });

  it.each([
    ["a 429 retry", retryLine(429)],
    ["an assistant event", assistantLine([textBlock("hi")])],
    ["a tool result", `${JSON.stringify({ type: "tool_result", content: "x" })}\n`],
    ["plain output", "compiling\n"],
  ])("resets on %s", (_name, line) => {
    const watch = new ProviderOutageWatch(GRACE);
    const retries = retryLine(null).repeat(3);
    feed(watch, retries, 0);
    const result = feed(watch, `${retries}${line}`, 10);
    expect(watch.deadline).toBeNull();
    expect(result.modelActivity).toBe(true);
    // A single retry after the reset starts a new run, so it is not eligible yet.
    feed(watch, `${retries}${line}${retryLine(null)}`, 20);
    expect(watch.deadline).toBeNull();
  });

  it("does not count connectivity retries as model activity", () => {
    const watch = new ProviderOutageWatch(GRACE);
    expect(feed(watch, retryLine(null), 0).modelActivity).toBe(false);
  });
});

describe("CliAgentRunner provider fast-fail timing", () => {
  const GRACE = 100;

  const startSession = async () => {
    let now = 1_000_000;
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    const runner = new ClaudeCodeRunner({
      redactor: new Redactor(),
      pollIntervalMs: 1,
      silenceLimitMs: 100_000_000,
      providerUnreachableGraceMs: GRACE,
      clock: () => now,
    });
    const started = runner.run(runInput(sandbox, ref, 1_000_000_000));
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    // The injected clock only moves when the test moves it, and the poll sleeps for 1 ms.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
    const advance = (ms: number) => {
      now += ms;
    };
    const set = (snapshot: { stdout?: string; stderr?: string }) =>
      sandbox.updateProcess("process-2", { running: true, ...snapshot });
    const cancelled = () => sandbox.calls.includes("cancelProcess");
    return { sandbox, started, settle, advance, set, cancelled };
  };

  it("lets a stderr error be cleared by later stdout model activity", async () => {
    const s = await startSession();
    s.set({ stderr: `${API_ERROR}\n` });
    await s.settle();
    s.advance(10);
    s.set({ stderr: `${API_ERROR}\n`, stdout: assistantLine([textBlock("back")]) });
    await s.settle();
    s.advance(10 * GRACE);
    await s.settle();
    expect(s.cancelled()).toBe(false);
    s.sandbox.finishProcess("process-2", { exitCode: 0, stdout: '{"type":"result","result":"ok"}\n' });
    expect((await s.started).completed).toBe(true);
  });

  it("keeps stdout retries armed through unrelated stderr noise", async () => {
    const s = await startSession();
    s.set({ stdout: retryLine(null).repeat(3) });
    await s.settle();
    s.advance(50);
    s.set({ stdout: retryLine(null).repeat(3), stderr: "unrelated noise\n" });
    await s.settle();
    expect(s.cancelled()).toBe(false);
    s.advance(60);
    const result = await s.started;
    expect(result.outcome).toBe("unreachable");
    expect(result.failureKind).toBe("PROVIDER_UNREACHABLE");
  });

  it("arms on a stderr error in the first snapshot with empty stdout", async () => {
    const s = await startSession();
    s.set({ stdout: "", stderr: `${API_ERROR}\n` });
    await s.settle();
    s.advance(GRACE + 1);
    const result = await s.started;
    expect(result.cancelled).toBe(true);
    expect(result.outcome).toBe("unreachable");
  });

  it("does not keep a stale stderr error armed while stdout keeps changing", async () => {
    const s = await startSession();
    s.set({ stderr: `${API_ERROR}\n` });
    await s.settle();
    let stdout = "";
    for (let i = 1; i <= 3; i += 1) {
      s.advance(GRACE / 2);
      stdout += assistantLine([textBlock(`step ${i}`)]);
      s.set({ stderr: `${API_ERROR}\n`, stdout });
      await s.settle();
    }
    expect(s.cancelled()).toBe(false);
    s.sandbox.finishProcess("process-2", { exitCode: 0 });
    await s.started;
  });

  it("neither clears nor arms anything on a stray blank line in either stream", async () => {
    const s = await startSession();
    const retries = retryLine(null).repeat(3);
    s.set({ stdout: retries });
    await s.settle();
    s.advance(50);
    s.set({ stdout: `${retries}\n\n`, stderr: "\n" });
    await s.settle();
    s.advance(60);
    expect((await s.started).outcome).toBe("unreachable");

    const quiet = await startSession();
    quiet.set({ stdout: "\n\n", stderr: "\n  \n" });
    await quiet.settle();
    quiet.advance(10 * GRACE);
    await quiet.settle();
    expect(quiet.cancelled()).toBe(false);
    quiet.sandbox.finishProcess("process-2", { exitCode: 0 });
    await quiet.started;
  });

  it("fires the earlier threshold when both streams carry connectivity errors", async () => {
    const s = await startSession();
    s.set({ stderr: `${API_ERROR}\n` });
    await s.settle();
    s.advance(50);
    s.set({ stderr: `${API_ERROR}\n`, stdout: retryLine(null).repeat(3) });
    await s.settle();
    expect(s.cancelled()).toBe(false);
    s.advance(55);
    expect((await s.started).outcome).toBe("unreachable");
  });

  it("does not cancel one transient retry followed by a long healthy turn", async () => {
    const s = await startSession();
    s.set({ stdout: retryLine(null) });
    await s.settle();
    s.advance(20 * GRACE);
    await s.settle();
    expect(s.cancelled()).toBe(false);
    s.sandbox.finishProcess("process-2", {
      exitCode: 0,
      stdout: `${retryLine(null)}${assistantLine([textBlock("done")])}{"type":"result","result":"ok"}\n`,
    });
    const result = await s.started;
    expect(result.completed).toBe(true);
    expect(result.outcome).toBe("finished");
  });

  it("cancels within the grace of the first retry while the CLI keeps retrying", async () => {
    // docs/specs/provider-unreachable.md. The CLI writes a retry after each failed try, sooner
    // than the grace, so each retry must not move the deadline.
    const s = await startSession();
    let stdout = "";
    for (let i = 0; i < 6; i += 1) {
      stdout += retryLine(null, GRACE / 4);
      s.set({ stdout });
      await s.settle();
      if (i < 5) s.advance(15);
    }
    expect(s.cancelled()).toBe(false);
    s.advance(30);
    expect((await s.started).outcome).toBe("unreachable");
  });

  it.each([429, 529])("never arms the connectivity timer on %i retries", async (status) => {
    const s = await startSession();
    s.set({ stdout: retryLine(status, 1_000).repeat(6) });
    await s.settle();
    s.advance(50 * GRACE);
    await s.settle();
    expect(s.cancelled()).toBe(false);
    s.sandbox.finishProcess("process-2", { exitCode: 1, stdout: retryLine(status).repeat(6) });
    const result = await s.started;
    expect(result.outcome).toBe("failed");
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
