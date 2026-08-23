/**
 * SDD section 17 and SDD section 10. One MCP server, reached over JSON-RPC 2.0 on HTTP.
 * Controller decision 9: this is a small hand-written JSON-RPC client over `fetch`, not an npm
 * dependency. SDD section 60 forbids the token in any error message or log line, so no message
 * built here interpolates it.
 */
export interface McpToolPort {
  /** Calls one tool and returns the concatenated text content of the answer. */
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export class McpError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "McpError";
  }
}

/** The longest one MCP request may take. A slow MCP server must not hold a Run. */
export const MCP_TIMEOUT_MS = 15_000;

const MCP_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isJsonRpcFailure = (value: JsonRpcResponse): value is JsonRpcFailure =>
  "error" in value && value.error !== undefined;

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

export interface McpJsonRpcClientOptions {
  endpoint: string;
  /** The bearer token, or null when the MCP server needs none. */
  token: string | null;
  fetch: typeof fetch;
}

/**
 * A small hand-written JSON-RPC 2.0 client for one MCP server, reached over HTTP. It performs
 * the `initialize` handshake once, lazily, before the first tool call, then reuses the session
 * header the server returned on every later request. SDD section 58 gates every tool call
 * through the Action Policy before it reaches this client; this client itself trusts its caller.
 */
export class McpJsonRpcClient implements McpToolPort {
  private readonly endpoint: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;
  private sessionId: string | null = null;
  private initializePromise: Promise<void> | null = null;

  constructor(options: McpJsonRpcClientOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.fetchImpl = options.fetch;
  }

  /**
   * Calls the server on every invocation. An MCP server is a live source, so two identical calls
   * at different moments can legitimately answer differently, and a Run that retries a failed
   * call needs a real retry, not a replayed failure. See SDD section 17 and SDD section 58.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureInitialized();
    const result = asRecord(await this.request("tools/call", { name, arguments: args }));
    const content = Array.isArray(result["content"]) ? (result["content"] as unknown[]) : [];
    const text = content
      .map((entry) => asRecord(entry))
      .filter((entry) => entry["type"] === "text" && typeof entry["text"] === "string")
      .map((entry) => entry["text"] as string)
      .join("");

    if (result["isError"] === true) {
      throw new McpError(`The MCP tool "${name}" answered with an error: ${text || "no message"}.`);
    }

    return text;
  }

  private ensureInitialized(): Promise<void> {
    this.initializePromise ??= this.initialize().catch((error: unknown) => {
      // A failed handshake must not poison the client for its whole life. Clear the cached
      // promise so the next call retries the handshake, the same way a repeat tool call
      // reaches the server again instead of replaying a stale failure.
      this.initializePromise = null;
      throw error;
    });
    return this.initializePromise;
  }

  private async initialize(): Promise<void> {
    const { headers } = await this.send("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "factoree", version: "1" },
    });

    const sessionId = headers.get("mcp-session-id");
    if (sessionId !== null && sessionId.length > 0) this.sessionId = sessionId;

    await this.notify("notifications/initialized", {});
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const { body } = await this.send(method, params);
    if (!isRecord(body)) {
      throw new McpError(
        `The MCP server at ${this.endpoint} answered "${method}" with a body that was not a JSON-RPC object.`,
      );
    }
    const rpcBody = body as unknown as JsonRpcResponse;
    if (isJsonRpcFailure(rpcBody)) {
      throw new McpError(`The MCP server refused "${method}": ${rpcBody.error.message}.`);
    }
    if (!("result" in rpcBody)) {
      throw new McpError(
        `The MCP server at ${this.endpoint} answered "${method}" with neither a result nor an error.`,
      );
    }
    return rpcBody.result;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.token !== null) headers["Authorization"] = `Bearer ${this.token}`;
    if (this.sessionId !== null) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  private async send(method: string, params: Record<string, unknown>): Promise<{ body: unknown; headers: Headers }> {
    const id = this.nextId;
    this.nextId += 1;

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new McpError(`The MCP request "${method}" failed before it received a response.`, { cause });
    }

    if (!response.ok) {
      throw new McpError(`The MCP request "${method}" received an unexpected status ${response.status}.`);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      throw new McpError(`The MCP request "${method}" returned a body that could not be read.`, { cause });
    }

    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new McpError(`The MCP request "${method}" returned a body that was not JSON.`, { cause });
    }

    return { body, headers: response.headers };
  }

  /** A notification carries no id and expects no body. */
  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
        signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new McpError(`The MCP notification "${method}" failed before it received a response.`, { cause });
    }
  }
}
