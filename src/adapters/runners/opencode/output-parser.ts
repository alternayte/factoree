export interface OpenCodeOutput {
  sessionId: string | null;
  summary: string;
}

interface OpenCodeEvent {
  type?: unknown;
  text?: unknown;
  session?: { id?: unknown };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Reads the newline-delimited JSON event stream of the `opencode` CLI. The CLI also writes plain
 * progress lines. The parser skips a line that is not a JSON object instead of failing the Run.
 * A line that parses to a JSON value that is not an object, for example `null`, a number, a
 * string, or an array, is treated the same way, because none of those shapes carries an event.
 */
export const parseOpenCodeOutput = (text: string): OpenCodeOutput => {
  let sessionId: string | null = null;
  let summary = "";
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

    const event = parsed as OpenCodeEvent;
    const session = isRecord(event.session) ? event.session : undefined;
    const id = session?.["id"];
    if (sessionId === null && typeof id === "string" && id.length > 0) sessionId = id;
    if (event.type === "message" && typeof event.text === "string") summary = event.text;
  }

  return { sessionId, summary: summary.length > 0 ? summary : lastPlainLine };
};
