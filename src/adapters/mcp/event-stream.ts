/**
 * docs/specs/external-context-delivery.md and DI-21.34. The Streamable HTTP transport of MCP can answer a POST
 * with a `text/event-stream` body. This parser splits the stream into events and gives the joined
 * `data` lines of each one. It knows nothing of JSON-RPC: the client reads each event's data.
 *
 * The format follows the WHATWG server-sent events rules: a line ends at CRLF, LF or CR, a blank
 * line ends an event, a line that starts with ":" is a comment, a `data` field strips one leading
 * space, and every other field is ignored, because the client needs only the message.
 */
export class EventStreamParser {
  private buffer = "";
  private data: string[] = [];
  /** A CR at the end of one chunk may be the first half of a CRLF in the next chunk. */
  private pendingCr = false;

  /** Feeds decoded text and answers the data of every event the text completed. */
  push(text: string): string[] {
    let input = text;
    if (this.pendingCr) {
      this.pendingCr = false;
      if (input.startsWith("\n")) input = input.slice(1);
    }
    this.buffer += input;
    const events: string[] = [];
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (match === null) break;
      // A CR as the last character can still become a CRLF, so it waits for the next chunk,
      // unless the caller ends the stream.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) {
        this.pendingCr = true;
        const line = this.buffer.slice(0, match.index);
        this.buffer = "";
        this.line(line, events);
        break;
      }
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.line(line, events);
    }
    return events;
  }

  /** Ends the stream. An event that no blank line closed is dispatched, as a lenient reader does. */
  end(): string[] {
    const events: string[] = [];
    if (this.buffer.length > 0) {
      this.line(this.buffer, events);
      this.buffer = "";
    }
    if (this.data.length > 0) {
      events.push(this.data.join("\n"));
      this.data = [];
    }
    return events;
  }

  private line(line: string, events: string[]): void {
    if (line === "") {
      if (this.data.length > 0) events.push(this.data.join("\n"));
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") return;
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    this.data.push(value);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The JSON-RPC answer to request `id` inside one event's data, or null. A notification (no id) or
 * a server request (a `method`) is no answer, and data that is not JSON is ignored: Factoree calls
 * tools and answers no server request. A batch array is searched for the answer.
 */
export const answerIn = (data: string, id: number): Record<string, unknown> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  const messages = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if ("method" in message) continue;
    if (message["id"] !== id) continue;
    if (!("result" in message) && !("error" in message)) continue;
    return message;
  }
  return null;
};

export type EventStreamOutcome =
  | { kind: "answer"; message: Record<string, unknown> }
  | { kind: "too_large" }
  | { kind: "ended" };

/**
 * Reads a `text/event-stream` body until the answer to request `id` arrives, then cancels the rest
 * of the stream. `maxBytes` covers every byte read from the stream, and the caller's abort signal
 * covers the whole read, so a stream that never answers cannot hold a run open.
 */
export const readEventStreamAnswer = async (
  response: Response,
  id: number,
  maxBytes: number,
): Promise<EventStreamOutcome> => {
  const parser = new EventStreamParser();
  const body = response.body;
  if (body === null) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) return { kind: "too_large" };
    for (const data of [...parser.push(text), ...parser.end()]) {
      const message = answerIn(data, id);
      if (message !== null) return { kind: "answer", message };
    }
    return { kind: "ended" };
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const events = done ? [...parser.push(decoder.decode()), ...parser.end()] : [];
      if (!done && value !== undefined) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { kind: "too_large" };
        }
        events.push(...parser.push(decoder.decode(value, { stream: true })));
      }
      for (const data of events) {
        const message = answerIn(data, id);
        if (message !== null) {
          // The answer is complete. The server may keep the stream open, so the rest is dropped.
          await reader.cancel().catch(() => undefined);
          return { kind: "answer", message };
        }
      }
      if (done) return { kind: "ended" };
    }
  } finally {
    reader.releaseLock();
  }
};
