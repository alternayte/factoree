import { describe, expect, it } from "vitest";
import { parseClaudeOutput } from "~/adapters/runners/claude-code/output-parser.js";

describe("parseClaudeOutput", () => {
  it("reads the session identifier of the first event that carries one", () => {
    const text = [
      '{"type":"system","subtype":"init","session_id":"ses-abc"}',
      '{"type":"result","subtype":"success","session_id":"ses-def","result":"done"}',
    ].join("\n");
    expect(parseClaudeOutput(text).sessionId).toBe("ses-abc");
  });

  it("reads the summary from the result event", () => {
    const text = '{"type":"result","subtype":"success","session_id":"s","result":"The change is applied."}';
    expect(parseClaudeOutput(text).summary).toBe("The change is applied.");
  });

  it("reads the last assistant text when no result event arrived", () => {
    const text = [
      '{"type":"assistant","session_id":"s","message":{"content":[{"type":"text","text":"first"}]}}',
      '{"type":"assistant","session_id":"s","message":{"content":[{"type":"text","text":"second"}]}}',
    ].join("\n");
    expect(parseClaudeOutput(text).summary).toBe("second");
  });

  it("joins every text block of one assistant message", () => {
    const text =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"a"},{"type":"tool_use"},{"type":"text","text":"b"}]}}';
    expect(parseClaudeOutput(text).summary).toBe("a\nb");
  });

  it("prefers the result event over an earlier assistant message", () => {
    const text = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"}]}}',
      '{"type":"result","subtype":"success","result":"final"}',
    ].join("\n");
    expect(parseClaudeOutput(text).summary).toBe("final");
  });

  it("reads the result of an error event, because the text is still evidence", () => {
    const text = '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"it broke"}';
    expect(parseClaudeOutput(text).summary).toBe("it broke");
  });

  it("skips a line that is not JSON and keeps it as the last resort summary", () => {
    expect(parseClaudeOutput("a plain progress line\n").summary).toBe("a plain progress line");
  });

  it("skips a JSON value that is not an object", () => {
    expect(parseClaudeOutput("null\n42\n[1,2]\n\"text\"\n").sessionId).toBeNull();
  });

  it("reports nothing for empty output", () => {
    expect(parseClaudeOutput("")).toEqual({ sessionId: null, summary: "" });
  });

  it("never throws on malformed input", () => {
    expect(() => parseClaudeOutput('{"type":"result","result":{"nested":true}}')).not.toThrow();
  });
});
