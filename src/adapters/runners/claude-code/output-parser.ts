import type { AgentSessionUsage } from "~/domain/runs/agent-session.js";
import { toolKindOf, type ToolKind } from "~/domain/runs/session-pulse.js";
import { assistantText } from "../assistant-text.js";
import { isProviderUnreachableText } from "../provider-unreachable.js";

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
  /** docs/specs/skill-registry.md. The input of every tool use block, as JSON. */
  toolInputs: string[];
  /**
   * docs/specs/provider-unreachable.md. The failure the CLI reported: the text of an error result,
   * or a plain line that names a provider connectivity error such as `EAI_AGAIN`.
   */
  errorMessage?: string;
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

/** The input of every tool use block of one assistant message, as JSON. */
const toolUseInputs = (message: unknown): string[] => {
  if (!isRecord(message) || !Array.isArray(message["content"])) return [];
  const inputs: string[] = [];
  for (const block of message["content"] as unknown[]) {
    if (isRecord(block) && block["type"] === "tool_use") inputs.push(JSON.stringify({ name: block["name"], input: block["input"] }));
  }
  return inputs;
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
  let errorMessage: string | null = null;
  let lastUnreachableLine: string | null = null;
  // docs/specs/provider-unreachable.md. During its backoff Claude Code writes only
  // `api_retry` system events, with no error text. They name no cause on their own, so the
  // last one becomes the error message when nothing better was written.
  let apiRetry: string | null = null;
  const toolInputs: string[] = [];

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      lastPlainLine = trimmed;
      if (isProviderUnreachableText(trimmed)) lastUnreachableLine = trimmed;
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

    // docs/specs/provider-unreachable.md. A retry of the provider during the CLI backoff. Only a
    // null `error_status` means the CLI could not reach the provider. A status such as 429 or
    // 529 is the provider answering, so the message never says it could not be reached.
    if (parsed["type"] === "system" && parsed["subtype"] === "api_retry") {
      const status = parsed["error_status"];
      const error = parsed["error"];
      const named = typeof error === "string" && error.length > 0 && error !== "unknown" ? `: ${error}` : "";
      apiRetry =
        status === null
          ? `The model provider could not be reached: the Claude CLI retried the API${named}.`
          : typeof status === "number" || typeof status === "string"
            ? `The model provider answered with status ${String(status)} and the Claude CLI retried the API${named}.`
            : `The Claude CLI retried the API${named}.`;
      continue;
    }

    if (parsed["type"] === "result") {
      const value = parsed["result"];
      if (typeof value === "string") resultSummary = value;
      if (parsed["is_error"] === true && typeof value === "string" && value.length > 0) errorMessage = value;
      usage = resultUsage(parsed) ?? usage;
      continue;
    }

    if (parsed["type"] === "assistant") {
      const value = assistantText(parsed["message"]);
      if (value !== null) lastAssistant = value;
      toolInputs.push(...toolUseInputs(parsed["message"]));
    }
  }

  const summary = resultSummary ?? lastAssistant ?? lastPlainLine;
  const failure = errorMessage ?? lastUnreachableLine ?? apiRetry;
  return { sessionId, summary, usage, model, toolInputs, ...(failure === null ? {} : { errorMessage: failure }) };
};

/** The text of a tool input a hang report names: a shell command, or the input as JSON. */
const toolInputText = (input: unknown): string => {
  if (isRecord(input) && typeof input["command"] === "string") return input["command"];
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "";
  }
};

/**
 * GitHub issue 84. The newest tool use whose tool result the stream does not hold yet. Claude Code
 * writes the `tool_use` block when a call starts and the `tool_result` when it returns, and
 * nothing between, so an open call explains a silent session.
 */
export const openClaudeToolCall = (text: string): { name: string; input: string } | null => {
  const open = new Map<string, { name: string; input: string }>();
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed["message"])) continue;
    const content = parsed["message"]["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content as unknown[]) {
      if (!isRecord(block)) continue;
      if (parsed["type"] === "assistant" && block["type"] === "tool_use" && typeof block["id"] === "string") {
        open.set(block["id"], { name: typeof block["name"] === "string" ? block["name"] : "tool", input: toolInputText(block["input"]) });
      }
      if (parsed["type"] === "user" && block["type"] === "tool_result" && typeof block["tool_use_id"] === "string") {
        open.delete(block["tool_use_id"]);
      }
    }
  }
  return [...open.values()].at(-1) ?? null;
};

/**
 * docs/specs/factory-floor.md. What the session does now, from the newest assistant or user event:
 * the kind of the newest tool use, or `think` after a tool result or for model text. Null before
 * the first such event. The scan starts at the end, so a long stream costs one short walk.
 */
export const latestClaudeToolKind = (text: string): ToolKind | null => {
  const lines = text.split(/\r\n|\r|\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index]!.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (parsed["type"] === "user") return "think";
    if (parsed["type"] !== "assistant" || !isRecord(parsed["message"])) continue;
    const content = parsed["message"]["content"];
    if (!Array.isArray(content) || content.length === 0) return "think";
    const last = content.at(-1) as unknown;
    if (isRecord(last) && last["type"] === "tool_use") {
      const input = last["input"];
      const command = isRecord(input) && typeof input["command"] === "string" ? input["command"] : null;
      return toolKindOf(typeof last["name"] === "string" ? last["name"] : "tool", command);
    }
    return "think";
  }
  return null;
};
