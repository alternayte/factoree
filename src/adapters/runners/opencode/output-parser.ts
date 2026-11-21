import { toolKindOf, type ToolKind } from "~/domain/runs/session-pulse.js";

export interface OpenCodeOutput {
  sessionId: string | null;
  summary: string;
  /** The message of the last error event, when the stream carries one. */
  errorMessage?: string;
}

interface OpenCodeEvent {
  type?: unknown;
  text?: unknown;
  sessionID?: unknown;
  session?: { id?: unknown };
  part?: unknown;
  error?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Reads the newline-delimited JSON event stream of the `opencode` CLI. The CLI also writes plain
 * progress lines. The parser skips a line that is not a JSON object instead of failing the Run.
 * A line that parses to a JSON value that is not an object, for example `null`, a number, a
 * string, or an array, is treated the same way, because none of those shapes carries an event.
 */
/**
 * The message of one `error` event. The CLI nests it as `error.data.message`, and it also writes
 * a flat `error.message` in an older shape. A string error is taken as the message itself.
 */
const errorMessageOf = (error: unknown): string | null => {
  if (typeof error === "string") return error.length > 0 ? error : null;
  if (!isRecord(error)) return null;
  const data = isRecord(error["data"]) ? error["data"] : undefined;
  for (const candidate of [data?.["message"], error["message"], error["name"]]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
};

export const parseOpenCodeOutput = (text: string): OpenCodeOutput => {
  let sessionId: string | null = null;
  let summary = "";
  let lastPlainLine = "";
  let errorMessage: string | null = null;

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

    const event = parsed as OpenCodeEvent;
    // opencode 1.x writes the identifier as the top-level `sessionID` of every event. The nested
    // `session.id` is the shape of the older stream.
    const session = isRecord(event.session) ? event.session : undefined;
    const id = typeof event.sessionID === "string" ? event.sessionID : session?.["id"];
    if (sessionId === null && typeof id === "string" && id.length > 0) sessionId = id;
    if (event.type === "message" && typeof event.text === "string") summary = event.text;
    // opencode 1.x writes the agent's text as a `text` event whose part holds the text.
    const part = isRecord(event.part) ? event.part : undefined;
    if (event.type === "text" && typeof part?.["text"] === "string" && part["text"].length > 0) summary = part["text"];
    // The last error wins. A retry writes a second error, and the last one names the outcome.
    if (event.type === "error") {
      const message = errorMessageOf(event.error);
      if (message !== null) errorMessage = message;
    }
  }

  return {
    sessionId,
    summary: summary.length > 0 ? summary : lastPlainLine,
    ...(errorMessage === null ? {} : { errorMessage }),
  };
};

/**
 * docs/specs/factory-floor.md. What the session does now, from the newest event: the kind of the
 * newest tool call, or `think` for model text or reasoning. opencode writes a tool call when it
 * returns, so a running call shows as the kind before it. Null before the first such event.
 */
export const latestOpenCodeToolKind = (text: string): ToolKind | null => {
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
    const type = parsed["type"];
    if (type === "text" || type === "reasoning") return "think";
    if (type !== "tool_use") continue;
    const part = isRecord(parsed["part"]) ? parsed["part"] : {};
    const state = isRecord(part["state"]) ? part["state"] : {};
    const input = isRecord(state["input"]) ? state["input"] : {};
    const command = typeof input["command"] === "string" ? input["command"] : null;
    return toolKindOf(typeof part["tool"] === "string" ? part["tool"] : "tool", command);
  }
  return null;
};
