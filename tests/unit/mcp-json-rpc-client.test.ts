import { describe, expect, it, vi } from "vitest";
import { McpError, McpJsonRpcClient } from "~/adapters/mcp/mcp-json-rpc-client.js";

const answer = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

describe("McpJsonRpcClient", () => {
  it("initializes once and reuses the session header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } }, { "mcp-session-id": "session-1" }))
      .mockResolvedValueOnce(new Response("", { status: 202 }))
      .mockResolvedValueOnce(answer({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "hello" }] } }))
      .mockResolvedValueOnce(answer({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "again" }] } }));

    const client = new McpJsonRpcClient({
      endpoint: "https://mcp.test/rpc",
      token: "secret-token",
      fetch: fetchMock,
    });

    expect(await client.callTool("search_docs", { query: "a" })).toBe("hello");
    expect(await client.callTool("search_docs", { query: "b" })).toBe("again");

    // One initialize, one initialized notification, two calls.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const last = fetchMock.mock.calls[3] as [string, RequestInit];
    expect((last[1].headers as Record<string, string>)["Mcp-Session-Id"]).toBe("session-1");
    expect((last[1].headers as Record<string, string>)["Authorization"]).toBe("Bearer secret-token");
  });

  it("reports a JSON-RPC error as an McpError", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer({ jsonrpc: "2.0", id: 1, result: {} }))
      .mockResolvedValueOnce(new Response("", { status: 202 }))
      .mockResolvedValueOnce(answer({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "no such tool" } }));
    const client = new McpJsonRpcClient({ endpoint: "https://mcp.test/rpc", token: null, fetch: fetchMock });
    await expect(client.callTool("missing", {})).rejects.toBeInstanceOf(McpError);
    await expect(client.callTool("missing", {})).rejects.toThrow(/no such tool/);
  });

  it("reports a tool that answered isError as a failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer({ jsonrpc: "2.0", id: 1, result: {} }))
      .mockResolvedValueOnce(new Response("", { status: 202 }))
      .mockResolvedValueOnce(answer({ jsonrpc: "2.0", id: 2, result: { isError: true, content: [{ type: "text", text: "denied" }] } }));
    const client = new McpJsonRpcClient({ endpoint: "https://mcp.test/rpc", token: null, fetch: fetchMock });
    await expect(client.callTool("search_docs", {})).rejects.toThrow(/denied/);
  });

  it("keeps the token out of an error message", async () => {
    const client = new McpJsonRpcClient({
      endpoint: "https://mcp.test/rpc",
      token: "secret-token",
      fetch: () => Promise.resolve(new Response("boom", { status: 500 })),
    });
    await expect(client.callTool("search_docs", {})).rejects.not.toThrow(/secret-token/);
  });
});
