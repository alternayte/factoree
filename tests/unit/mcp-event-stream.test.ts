import { describe, expect, it } from "vitest";
import { EventStreamParser } from "~/adapters/mcp/event-stream.js";
import { MCP_MAX_RESPONSE_BYTES, McpError, McpJsonRpcClient } from "~/adapters/mcp/mcp-json-rpc-client.js";

/** A stream body that sends each chunk as its own read, so a split event is exercised. */
const streamOf = (chunks: string[], keepOpen = false): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk !== undefined) controller.enqueue(encoder.encode(chunk));
      else if (!keepOpen) controller.close();
    },
  });
};

const sse = (chunks: string[], keepOpen = false) =>
  new Response(streamOf(chunks, keepOpen), { status: 200, headers: { "content-type": "text/event-stream" } });

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** The initialize answer and the initialized notification, then the given tool call answer. */
const clientWith = (call: Response) => {
  const answers = [json({ jsonrpc: "2.0", id: 1, result: {} }), new Response("", { status: 202 }), call];
  const fetchImpl = (() => Promise.resolve(answers.shift() as Response)) as unknown as typeof fetch;
  return new McpJsonRpcClient({ endpoint: "https://mcp.test/mcp", token: null, fetch: fetchImpl });
};

describe("EventStreamParser", () => {
  it("joins data lines, skips comments and other fields, and handles CRLF split across chunks", () => {
    const parser = new EventStreamParser();
    expect(parser.push(": keep-alive\r\nevent: message\r\nid: 7\r\ndata: {\"a\":\r")).toEqual([]);
    expect(parser.push("\ndata:1}\r\n\r\n")).toEqual(['{"a":\n1}']);
    expect(parser.push("data: tail")).toEqual([]);
    expect(parser.end()).toEqual(["tail"]);
  });
});

describe("McpJsonRpcClient over a server-sent event stream", () => {
  it("takes the answer with the request id and ignores notifications and server requests", async () => {
    const client = clientWith(
      sse([
        'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
        'data: {"jsonrpc":"2.0","id":99,"method":"sampling/createMessage","params":{}}\n\n',
        'data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","te',
        'xt":"items"}]}}\n\n',
      ]),
    );
    expect(await client.callTool("search", {})).toBe("items");
  });

  it("returns once the answer arrives, while the server keeps the stream open", async () => {
    const client = clientWith(
      sse(['data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"done"}]}}\n\n'], true),
    );
    expect(await client.callTool("search", {})).toBe("done");
  });

  it("fails a stream that ends without the answer", async () => {
    const client = clientWith(sse(['data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n']));
    await expect(client.callTool("search", {})).rejects.toThrow(/without the answer/);
  });

  it("fails a stream past the response cap", async () => {
    const filler = `: ${"x".repeat(1024 * 1024)}\n`;
    const client = clientWith(sse([filler, filler, filler, filler, filler]));
    const call = client.callTool("search", {});
    await expect(call).rejects.toBeInstanceOf(McpError);
    await expect(call).rejects.toThrow(String(MCP_MAX_RESPONSE_BYTES));
  });
});
