export interface ClaudeOutput {
  sessionId: string | null;
  summary: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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

    if (parsed["type"] === "result") {
      const value = parsed["result"];
      if (typeof value === "string") resultSummary = value;
      continue;
    }

    if (parsed["type"] === "assistant") {
      const value = assistantText(parsed["message"]);
      if (value !== null) lastAssistant = value;
    }
  }

  const summary = resultSummary ?? lastAssistant ?? lastPlainLine;
  return { sessionId, summary };
};
