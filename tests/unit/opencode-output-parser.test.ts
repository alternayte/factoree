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
