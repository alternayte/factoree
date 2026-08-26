/**
 * A local stand-in for the MCP JSON-RPC server of `src/adapters/mcp/mcp-json-rpc-client.ts`. It
 * answers the `initialize` handshake, the `notifications/initialized` notification, and one
 * `tools/call` request with a fixture text answer. It is not a mock of a live dependency; SDD
 * section 66 excludes the MCP source from the local profile on purpose.
 */
import Fastify from "fastify";

const PORT = Number(process.env["MCP_STUB_PORT"] ?? 4200);
const SESSION_ID = "local-mcp-stub-session";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const app = Fastify({ logger: true });

app.post<{ Body: JsonRpcRequest }>("/", async (request, reply) => {
  const body = request.body;

  if (body.method === "initialize") {
    reply.header("mcp-session-id", SESSION_ID);
    return { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } };
  }

  if (body.method === "notifications/initialized") {
    // A notification carries no id and expects no body.
    return reply.code(202).send();
  }

  if (body.method === "tools/call") {
    const name = body.params?.name ?? "unknown-tool";
    return {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [{ type: "text", text: `local mcp stub answer for tool "${name}"` }],
        isError: false,
      },
    };
  }

  return {
    jsonrpc: "2.0",
    id: body.id,
    error: { code: -32601, message: `the local MCP stub does not implement "${body.method}"` },
  };
});

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`MCP stub listens on port ${PORT}.`);
  })
  .catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });
