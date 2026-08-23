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

const isJsonRpcFailure = (value: JsonRpcResponse): value is JsonRpcFailure =>
  "error" in value && value.error !== undefined;

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

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
  /**
   * Coalesces an identical tool call, by name and arguments, to a single outbound request for
   * the life of this client. The cached promise is reused whether it settled or is still in
   * flight, so a repeat of the same call never doubles a side effect on the MCP server.
   */
  private readonly callCache = new Map<string, Promise<string>>();

  constructor(options: McpJsonRpcClientOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.fetchImpl = options.fetch;
  }

  callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const key = `${name}:${JSON.stringify(args)}`;
    const cached = this.callCache.get(key);
    if (cached !== undefined) return cached;

    const promise = this.callToolUncached(name, args);
    this.callCache.set(key, promise);
    return promise;
  }

  private async callToolUncached(name: string, args: Record<string, unknown>): Promise<string> {
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
    this.initializePromise ??= this.initialize();
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
    if (isJsonRpcFailure(body)) {
      throw new McpError(`The MCP server refused "${method}": ${body.error.message}.`);
    }
    return body.result;
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

  private async send(method: string, params: Record<string, unknown>): Promise<{ body: JsonRpcResponse; headers: Headers }> {
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

    return { body: body as JsonRpcResponse, headers: response.headers };
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
