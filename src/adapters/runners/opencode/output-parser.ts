export interface OpenCodeOutput {
  sessionId: string | null;
  summary: string;
}

interface OpenCodeEvent {
  type?: unknown;
  text?: unknown;
  session?: { id?: unknown };
}

/**
 * Reads the newline-delimited JSON event stream of the `opencode` CLI. The CLI also writes plain
 * progress lines. The parser skips a line that is not JSON instead of failing the Run.
 */
export const parseOpenCodeOutput = (text: string): OpenCodeOutput => {
  let sessionId: string | null = null;
  let summary = "";
  let lastPlainLine = "";

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: OpenCodeEvent;
    try {
      event = JSON.parse(trimmed) as OpenCodeEvent;
    } catch {
      lastPlainLine = trimmed;
      continue;
    }
    const id = event.session?.id;
    if (sessionId === null && typeof id === "string" && id.length > 0) sessionId = id;
    if (event.type === "message" && typeof event.text === "string") summary = event.text;
  }

  return { sessionId, summary: summary.length > 0 ? summary : lastPlainLine };
};
