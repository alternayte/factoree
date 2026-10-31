import { describe, expect, it } from "vitest";
import { parseOpenCodeOutput } from "~/adapters/runners/opencode/output-parser.js";

describe("parseOpenCodeOutput", () => {
  it("reads the session identifier from the first event that carries one", () => {
    const text = [
      '{"type":"session.start","session":{"id":"ses_abc"}}',
      '{"type":"session.update","session":{"id":"ses_def"}}',
    ].join("\n");
    expect(parseOpenCodeOutput(text).sessionId).toBe("ses_abc");
  });

  it("returns the text of the last message event as the summary", () => {
    const text = [
      '{"type":"message","text":"first"}',
      '{"type":"message","text":"second"}',
    ].join("\n");
    expect(parseOpenCodeOutput(text).summary).toBe("second");
  });

  it("ignores a line that is not JSON", () => {
    const text = ['plain progress line', '{"type":"message","text":"done"}'].join("\n");
    expect(parseOpenCodeOutput(text).summary).toBe("done");
  });

  it("returns a null session identifier when no event carries one", () => {
    expect(parseOpenCodeOutput('{"type":"message","text":"done"}').sessionId).toBeNull();
  });

  it("falls back to the last non-empty line when no message event exists", () => {
    expect(parseOpenCodeOutput("first line\nlast line\n").summary).toBe("last line");
  });

  it("returns an empty summary for empty output", () => {
    expect(parseOpenCodeOutput("")).toEqual({ sessionId: null, summary: "" });
  });

  it("does not throw on a line that parses to JSON null", () => {
    const text = ["null", '{"type":"message","text":"done"}'].join("\n");
    expect(() => parseOpenCodeOutput(text)).not.toThrow();
    expect(parseOpenCodeOutput(text).summary).toBe("done");
  });

  it("does not throw on a line that parses to a bare number", () => {
    const text = ["42", '{"type":"message","text":"done"}'].join("\n");
    expect(() => parseOpenCodeOutput(text)).not.toThrow();
    expect(parseOpenCodeOutput(text).summary).toBe("done");
  });

  it("does not throw on a line that parses to a JSON array", () => {
    const text = ["[1,2,3]", '{"type":"message","text":"done"}'].join("\n");
    expect(() => parseOpenCodeOutput(text)).not.toThrow();
    expect(parseOpenCodeOutput(text).summary).toBe("done");
  });

  it("does not throw on a line that parses to a quoted string", () => {
    const text = ['"a bare string"', '{"type":"message","text":"done"}'].join("\n");
    expect(() => parseOpenCodeOutput(text)).not.toThrow();
    expect(parseOpenCodeOutput(text).summary).toBe("done");
  });

  it("does not throw on a partial line with no closing brace", () => {
    const text = ['{"type":"message","text":"trunc', '{"type":"message","text":"done"}'].join("\n");
    expect(() => parseOpenCodeOutput(text)).not.toThrow();
    expect(parseOpenCodeOutput(text).summary).toBe("done");
  });

  it("handles output that uses carriage returns as line separators", () => {
    const text = ['{"type":"session.start","session":{"id":"ses_1"}}', '{"type":"message","text":"done"}'].join(
      "\r\n",
    );
    const result = parseOpenCodeOutput(text);
    expect(result.sessionId).toBe("ses_1");
    expect(result.summary).toBe("done");
  });
});

describe("parseOpenCodeOutput, an error event", () => {
  it("reads the nested message of an error event", () => {
    // The shape a real Run produced: the CLI writes the error, then an ordinary shutdown line.
    const text = [
      '{"type":"session.start","session":{"id":"ses_1"}}',
      '{"type":"error","error":{"name":"APIError","data":{"message":"Insufficient balance."}}}',
      'timestamp=2026-08-27T14:13:31.415Z level=INFO message="disposing instance"',
    ].join("\n");

    const parsed = parseOpenCodeOutput(text);

    expect(parsed.errorMessage).toBe("Insufficient balance.");
    expect(parsed.sessionId).toBe("ses_1");
  });

  it("reads a flat message and a string error", () => {
    expect(parseOpenCodeOutput('{"type":"error","error":{"message":"boom"}}').errorMessage).toBe("boom");
    expect(parseOpenCodeOutput('{"type":"error","error":"plain"}').errorMessage).toBe("plain");
  });

  it("keeps the last error when the agent retried", () => {
    const text = [
      '{"type":"error","error":{"data":{"message":"first"}}}',
      '{"type":"error","error":{"data":{"message":"second"}}}',
    ].join("\n");

    expect(parseOpenCodeOutput(text).errorMessage).toBe("second");
  });

  it("names no error when the stream carries none", () => {
    expect(parseOpenCodeOutput('{"type":"message","text":"done"}').errorMessage).toBeUndefined();
  });
});

// The events of `opencode run --format json`, as opencode 1.19 writes them: the session
// identifier is the top-level `sessionID`, and the agent's text is a `text` event with a part.
describe("parseOpenCodeOutput with the events opencode writes", () => {
  const events = [
    '{"type":"step_start","timestamp":1,"sessionID":"ses_real_1","part":{"type":"step-start"}}',
    '{"type":"text","timestamp":2,"sessionID":"ses_real_1","part":{"type":"text","text":"First draft."}}',
    '{"type":"tool_use","timestamp":3,"sessionID":"ses_real_1","part":{"type":"tool","tool":"bash"}}',
    '{"type":"text","timestamp":4,"sessionID":"ses_real_1","part":{"type":"text","text":"The change is applied."}}',
    '{"type":"step_finish","timestamp":5,"sessionID":"ses_real_1","part":{"type":"step-finish"}}',
  ].join("\n");

  it("reads the session identifier from the top-level sessionID", () => {
    expect(parseOpenCodeOutput(events).sessionId).toBe("ses_real_1");
  });

  it("returns the text of the last text event as the summary", () => {
    expect(parseOpenCodeOutput(events).summary).toBe("The change is applied.");
  });
});
