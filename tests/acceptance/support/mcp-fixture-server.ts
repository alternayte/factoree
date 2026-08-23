import Fastify from "fastify";

/**
 * A real Fastify HTTP server that answers JSON-RPC 2.0 over one POST route, in the shape
 * `McpJsonRpcClient` expects: `initialize` returns a protocol version and an `Mcp-Session-Id`
 * header, `notifications/initialized` answers 202, and `tools/call` answers `search_docs` with
 * one item and `read_doc` with a text body. AT-36 runs the real JSON-RPC client against this
 * server, so nothing here is a stub of the client itself.
 */
export interface McpFixtureServer {
  url: string;
  close(): Promise<void>;
  calls: Array<{ method: string; tool: string | null }>;
}

const SESSION_ID = "fixture-session-1";

/** The one document `search_docs` reports and `read_doc` answers. */
export const MCP_FIXTURE_ITEM_REF = "runbook/notification-retry";
export const MCP_FIXTURE_SOURCE_VERSION = "2026-02-01T00:00:00Z";
export const MCP_FIXTURE_REASON = "the runbook documents the notification retry procedure";
export const MCP_FIXTURE_CONTENT = "Retry a failed notification delivery up to three times.";

const textResult = (text: string): { content: Array<{ type: string; text: string }>; isError: false } => ({
  content: [{ type: "text", text }],
  isError: false,
});

export const start = async (): Promise<McpFixtureServer> => {
  const app = Fastify({ logger: false });
  const calls: Array<{ method: string; tool: string | null }> = [];

  app.post("/", async (request, reply) => {
    const body = request.body as {
      jsonrpc: "2.0";
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    const params = body.params ?? {};
    const toolName = body.method === "tools/call" ? (params["name"] as string | undefined) ?? null : null;
    calls.push({ method: body.method, tool: toolName });

    if (body.method === "notifications/initialized") {
      return reply.code(202).send();
    }

    if (body.method === "initialize") {
      reply.header("Mcp-Session-Id", SESSION_ID);
      return reply.send({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "factoree-fixture-mcp", version: "1" },
        },
      });
    }

    if (body.method === "tools/call") {
      const name = toolName;
      if (name === "search_docs") {
        return reply.send({
          jsonrpc: "2.0",
          id: body.id,
          result: textResult(
            JSON.stringify({
              items: [
                {
                  ref: MCP_FIXTURE_ITEM_REF,
                  sourceVersion: MCP_FIXTURE_SOURCE_VERSION,
                  title: "Notification retry runbook",
                  reason: MCP_FIXTURE_REASON,
                  sizeBytes: Buffer.byteLength(MCP_FIXTURE_CONTENT, "utf8"),
                },
              ],
            }),
          ),
        });
      }
      if (name === "read_doc") {
        return reply.send({ jsonrpc: "2.0", id: body.id, result: textResult(MCP_FIXTURE_CONTENT) });
      }
      return reply.send({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `unknown tool "${String(name)}"` },
      });
    }

    return reply.send({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: `unknown method "${body.method}"` },
    });
  });

  const url = await app.listen({ port: 0, host: "127.0.0.1" });

  return {
    url,
    calls,
    close: () => app.close(),
  };
};
