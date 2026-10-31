import type { AgentSessionUsage } from "~/domain/runs/agent-session.js";

export interface ClaudeOutput {
  sessionId: string | null;
  summary: string;
  /**
   * docs/specs/agent-session-usage-and-hangs.md. The `usage` and `total_cost_usd` of the result
   * event, or null when the process wrote no result event, for example a hung session.
   */
  usage: AgentSessionUsage | null;
  /** The model the init event names, or null. */
  model: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const numberOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The usage of one result event. Claude Code reports the thinking tokens inside the output
 * tokens and no time per model call, so those two fields stay null. DI-14.43.
 */
const resultUsage = (event: Record<string, unknown>): AgentSessionUsage | null => {
  const usage = event["usage"];
  const cost = numberOf(event["total_cost_usd"]);
  if (!isRecord(usage) && cost === null) return null;
  const tokens = isRecord(usage) ? usage : {};
  return {
    inputTokens: numberOf(tokens["input_tokens"]),
    outputTokens: numberOf(tokens["output_tokens"]),
    reasoningTokens: null,
    cacheReadTokens: numberOf(tokens["cache_read_input_tokens"]),
    cacheWriteTokens: numberOf(tokens["cache_creation_input_tokens"]),
    costUsd: cost,
    turns: numberOf(event["num_turns"]),
    longestTurnMs: null,
  };
};

/** Joins every text block of one assistant message. A tool use block carries no text. */
const assistantText = (message: unknown): string | null => {
  if (!isRecord(message)) return null;
  const content = message["content"];
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] !== "text") continue;
    const text = block["text"];
    if (typeof text === "string" && text.length > 0) parts.push(text);
  }
  return parts.length === 0 ? null : parts.join("\n");
};

/**
 * Reads the newline-delimited JSON event stream of `claude -p --output-format stream-json`. The
 * CLI also writes plain progress lines. The parser skips a line that is not a JSON object, and
 * it does not fail the Run. A line that parses to a JSON value that is not an object, for
 * example `null`, a number, a string, or an array, is treated the same way, because none of
 * those shapes carries an event.
 *
 * The `result` event carries the final message, and it wins over every assistant message. An
 * error result still carries its text, because that text is evidence. SDD section P-01 states
 * that the claim of the agent never decides the outcome, so this parser never reads a success
 * flag as a verdict.
 */
export const parseClaudeOutput = (text: string): ClaudeOutput => {
  let sessionId: string | null = null;
  let resultSummary: string | null = null;
  let lastAssistant: string | null = null;
  let lastPlainLine = "";
  let usage: AgentSessionUsage | null = null;
  let model: string | null = null;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      lastPlainLine = trimmed;
      continue;
    }
    if (!isRecord(parsed)) {
      lastPlainLine = trimmed;
      continue;
    }

    const id = parsed["session_id"];
    if (sessionId === null && typeof id === "string" && id.length > 0) sessionId = id;

    if (parsed["type"] === "system" && parsed["subtype"] === "init") {
      const named = parsed["model"];
      if (typeof named === "string" && named.length > 0) model = named;
      continue;
    }

    if (parsed["type"] === "result") {
      const value = parsed["result"];
      if (typeof value === "string") resultSummary = value;
      usage = resultUsage(parsed) ?? usage;
      continue;
    }

    if (parsed["type"] === "assistant") {
      const value = assistantText(parsed["message"]);
      if (value !== null) lastAssistant = value;
    }
  }

  const summary = resultSummary ?? lastAssistant ?? lastPlainLine;
  return { sessionId, summary, usage, model };
};
