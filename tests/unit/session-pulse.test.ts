import { describe, expect, it } from "vitest";
import { ClaudeCodeRunner } from "~/adapters/runners/claude-code/claude-code-runner.js";
import { latestClaudeToolKind } from "~/adapters/runners/claude-code/output-parser.js";
import { latestOpenCodeToolKind } from "~/adapters/runners/opencode/output-parser.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { toolKindOf, type SessionPulse } from "~/domain/runs/session-pulse.js";
import { Redactor } from "~/telemetry/redaction.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const waitUntil = async (condition: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("waitUntil timed out before the condition held.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

const assistant = (block: Record<string, unknown>): string => JSON.stringify({ type: "assistant", message: { content: [block] } });

// docs/specs/factory-floor.md. The validator drives the browser through a shell command, so a
// shell call must not hide the browser from the floor.
describe("toolKindOf", () => {
  it("names a shell command that drives agent-browser as browser", () => {
    expect(toolKindOf("Bash", "agent-browser open http://localhost:3000")).toBe("browser");
    expect(toolKindOf("bash", "cd app && agent-browser snapshot")).toBe("browser");
    expect(toolKindOf("Bash", "npm test")).toBe("shell");
  });

  it("names read, edit and unknown tools", () => {
    expect(toolKindOf("Grep", null)).toBe("read");
    expect(toolKindOf("MultiEdit", null)).toBe("edit");
    expect(toolKindOf("mcp__context__read", null)).toBe("read");
    expect(toolKindOf("TodoWrite", null)).toBe("think");
  });
});

describe("latest tool kind of a stream", () => {
  it("reads the newest Claude Code event", () => {
    const edit = assistant({ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "a.ts" } });
    const result = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } });
    expect(latestClaudeToolKind(`plain line\n${edit}`)).toBe("edit");
    expect(latestClaudeToolKind(`${edit}\n${result}`)).toBe("think");
    expect(latestClaudeToolKind("not json")).toBeNull();
  });

  it("reads the newest opencode event", () => {
    const shell = JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "bash", state: { input: { command: "agent-browser open /" } } } });
    expect(latestOpenCodeToolKind(shell)).toBe("browser");
    expect(latestOpenCodeToolKind(`${shell}\n${JSON.stringify({ type: "text", part: { text: "done" } })}`)).toBe("think");
  });
});

describe("CliAgentRunner pulses", () => {
  it("writes at most one pulse per 5 seconds, with no tool input", async () => {
    const pulses: SessionPulse[] = [];
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", productId: "p" });
    let now = 0;
    const runner = new ClaudeCodeRunner({
      redactor: new Redactor(),
      pollIntervalMs: 1,
      silenceLimitMs: 60 * 60_000,
      clock: () => now,
      pulses: { record: (pulse) => (pulses.push(pulse), Promise.resolve()) },
    });
    const started = runner.run({
      runId: "run-1",
      tenantId: "tenant-1",
      role: "implementer",
      sandbox,
      ref,
      workingDirectory: "/workspace/primary",
      prompt: "goal",
      promptVersion: "implementer/1",
      environment: {},
      actionPolicy: buildActionPolicy(),
      timeoutMs: 24 * 60 * 60_000,
    });
    await waitUntil(() => sandbox.commands.at(-1)?.file === "sh");
    const secret = "cat /etc/super-secret-token";
    sandbox.updateProcess("process-2", { running: true, stdout: assistant({ type: "tool_use", id: "t1", name: "Bash", input: { command: secret } }) });
    // 30 seconds of polls, many per clock second.
    for (let second = 0; second <= 30; second += 1) {
      now = second * 1_000;
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    sandbox.finishProcess("process-2", { exitCode: 0, stdout: '{"type":"result","result":"ok","session_id":"s"}' });
    await started;
    expect(pulses.length).toBeGreaterThan(0);
    expect(pulses.length).toBeLessThanOrEqual(30 / 5 + 1);
    expect(pulses.every((pulse) => pulse.toolKind === "shell" && pulse.owner === "run-1" && pulse.role === "implementer")).toBe(true);
    expect(JSON.stringify(pulses)).not.toContain("super-secret");
  });
});
