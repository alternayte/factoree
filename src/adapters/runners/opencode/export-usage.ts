import type { AgentSessionUsage } from "~/domain/runs/agent-session.js";

/**
 * docs/specs/agent-session-usage-and-hangs.md. Reads the usage of one opencode session from the
 * JSON that `opencode export <session>` prints. Each assistant message is one model call, and
 * its `info` carries the cost in USD, the tokens, and the creation and completion times in epoch
 * milliseconds.
 */
export interface OpenCodeExportUsage {
  usage: AgentSessionUsage;
  /** `provider/model` of the last assistant message, or null. */
  model: string | null;
  /** The identifiers of the messages this reading counted. */
  messageIds: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const numberOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const add = (total: number | null, value: number | null): number | null =>
  value === null ? total : (total ?? 0) + value;

/**
 * The export can follow a log line, so the document starts at the first brace. Returns null when
 * the text holds no export document.
 */
const exportDocument = (text: string): Record<string, unknown> | null => {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * docs/specs/run-speed.md. The length of the union of the tool part intervals of one message,
 * clipped to the message. A message can run tool calls in parallel, and an overlap counts once.
 */
const toolTimeOf = (parts: unknown, created: number, completed: number): number => {
  if (!Array.isArray(parts)) return 0;
  const intervals: Array<[number, number]> = [];
  for (const part of parts as unknown[]) {
    if (!isRecord(part) || part["type"] !== "tool") continue;
    const state = isRecord(part["state"]) ? part["state"] : {};
    const time = isRecord(state["time"]) ? state["time"] : {};
    const start = numberOf(time["start"]);
    const end = numberOf(time["end"]);
    if (start === null || end === null) continue;
    const from = Math.max(start, created);
    const to = Math.min(end, completed);
    if (to > from) intervals.push([from, to]);
  }
  intervals.sort((left, right) => left[0] - right[0]);
  let total = 0;
  let reach = Number.NEGATIVE_INFINITY;
  for (const [from, to] of intervals) {
    const start = Math.max(from, reach);
    if (to > start) total += to - start;
    reach = Math.max(reach, to);
  }
  return total;
};

/**
 * Sums the assistant messages that `counted` does not hold. A resume continues the same session,
 * so the export of a resume also lists the calls of the first invocation, and `counted` keeps
 * them out. Returns null when the text is not an export document.
 */
export const readOpenCodeExport = (text: string, counted: ReadonlySet<string>): OpenCodeExportUsage | null => {
  const document = exportDocument(text);
  if (document === null) return null;
  const messages = document["messages"];
  if (!Array.isArray(messages)) return null;

  const usage: AgentSessionUsage = {
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    turns: 0,
    longestTurnMs: null,
    modelMs: null,
    toolMs: null,
  };
  let model: string | null = null;
  const messageIds: string[] = [];

  messages.forEach((message: unknown, index) => {
    if (!isRecord(message)) return;
    const info = message["info"];
    if (!isRecord(info) || info["role"] !== "assistant") return;
    // A message with no identifier is keyed by its position, which a resume keeps.
    const id = typeof info["id"] === "string" ? info["id"] : `#${index}`;
    if (counted.has(id)) return;
    messageIds.push(id);
    usage.turns = (usage.turns ?? 0) + 1;
    usage.costUsd = add(usage.costUsd, numberOf(info["cost"]));
    const tokens = isRecord(info["tokens"]) ? info["tokens"] : {};
    usage.inputTokens = add(usage.inputTokens, numberOf(tokens["input"]));
    usage.outputTokens = add(usage.outputTokens, numberOf(tokens["output"]));
    usage.reasoningTokens = add(usage.reasoningTokens, numberOf(tokens["reasoning"]));
    const cache = isRecord(tokens["cache"]) ? tokens["cache"] : {};
    usage.cacheReadTokens = add(usage.cacheReadTokens, numberOf(cache["read"]));
    usage.cacheWriteTokens = add(usage.cacheWriteTokens, numberOf(cache["write"]));
    const time = isRecord(info["time"]) ? info["time"] : {};
    const created = numberOf(time["created"]);
    const completed = numberOf(time["completed"]);
    // A call the hang interrupted has no completion time, so it has no length to compare.
    if (created !== null && completed !== null && completed >= created) {
      usage.longestTurnMs = Math.max(usage.longestTurnMs ?? 0, completed - created);
      // The message time holds its tool calls, so the model time is what the tools leave.
      const toolMs = toolTimeOf(message["parts"], created, completed);
      usage.toolMs = (usage.toolMs ?? 0) + toolMs;
      usage.modelMs = (usage.modelMs ?? 0) + (completed - created - toolMs);
    }
    const provider = info["providerID"];
    const modelId = info["modelID"];
    if (typeof modelId === "string" && modelId.length > 0) {
      model = typeof provider === "string" && provider.length > 0 ? `${provider}/${modelId}` : modelId;
    }
  });

  // An invocation that made no model call cost nothing, which is a known value.
  if (messageIds.length === 0) {
    return {
      usage: { ...usage, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      model,
      messageIds,
    };
  }
  return { usage, model, messageIds };
};
