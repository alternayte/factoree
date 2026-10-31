import { describe, expect, it } from "vitest";
import { readOpenCodeExport } from "~/adapters/runners/opencode/export-usage.js";

/** One assistant message of `opencode export`, in the shape the CLI prints. */
const assistant = (id: string, cost: number, created: number, completed: number | null) => ({
  info: {
    id,
    role: "assistant",
    providerID: "deepseek",
    modelID: "deepseek-flash",
    cost,
    tokens: { total: 1_160, input: 100, output: 50, reasoning: 10, cache: { read: 1_000, write: 0 } },
    time: completed === null ? { created } : { created, completed },
  },
  parts: [],
});

const exportOf = (messages: unknown[]): string =>
  JSON.stringify({ info: { id: "ses_1" }, messages });

describe("readOpenCodeExport", () => {
  it("sums the cost and the tokens of every assistant message and finds the longest call", () => {
    const text = exportOf([
      { info: { id: "u1", role: "user", time: { created: 0 } }, parts: [] },
      assistant("a1", 0.01, 1_000, 4_000),
      assistant("a2", 0.02, 5_000, 65_000),
    ]);
    const reading = readOpenCodeExport(text, new Set());
    expect(reading?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      reasoningTokens: 20,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 0,
      costUsd: 0.03,
      turns: 2,
      longestTurnMs: 60_000,
    });
    expect(reading?.model).toBe("deepseek/deepseek-flash");
    expect(reading?.messageIds).toEqual(["a1", "a2"]);
  });

  it("counts only the calls an earlier invocation of the session did not report", () => {
    // A resume continues the session, so its export repeats the calls of the first run.
    const text = exportOf([assistant("a1", 0.01, 0, 1_000), assistant("a2", 0.02, 2_000, 2_500)]);
    const reading = readOpenCodeExport(text, new Set(["a1"]));
    expect(reading?.usage.turns).toBe(1);
    expect(reading?.usage.costUsd).toBe(0.02);
    expect(reading?.usage.longestTurnMs).toBe(500);
  });

  it("counts the cost of a call the hang interrupted, but gives it no length", () => {
    const text = exportOf([assistant("a1", 0.01, 0, 1_000), assistant("a2", 0.05, 2_000, null)]);
    const reading = readOpenCodeExport(text, new Set());
    expect(reading?.usage.costUsd).toBeCloseTo(0.06, 10);
    expect(reading?.usage.longestTurnMs).toBe(1_000);
  });

  it("reads an export that follows a log line", () => {
    const text = `Exporting session: ses_1\n${exportOf([assistant("a1", 0.01, 0, 1_000)])}`;
    expect(readOpenCodeExport(text, new Set())?.usage.turns).toBe(1);
  });

  it("reports a known zero for an invocation that made no model call", () => {
    const reading = readOpenCodeExport(exportOf([]), new Set());
    expect(reading?.usage.costUsd).toBe(0);
    expect(reading?.usage.turns).toBe(0);
  });

  it("answers null for text that is no export", () => {
    expect(readOpenCodeExport("Session not found", new Set())).toBeNull();
    expect(readOpenCodeExport('{"info":{}}', new Set())).toBeNull();
  });
});
