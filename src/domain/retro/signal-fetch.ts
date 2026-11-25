import type { McpToolPort } from "~/adapters/mcp/mcp-json-rpc-client.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { renderSignalArguments, sha256Of, type SignalSourceKind, type SignalSourceRecord } from "./signal-source.js";

/** One query result, redacted, before the store gives it its id. */
export interface FetchedSignal {
  sourceName: string;
  sourceKind: SignalSourceKind;
  queryName: string;
  content: string;
  sha256: string;
  bytes: number;
}

export interface SkippedSignal {
  sourceName: string;
  queryName: string;
  reason: string;
}

export interface SignalFetchDependencies {
  /** The MCP client of one endpoint with its bearer token, or null for none. */
  tools: (endpoint: string, token: string | null) => McpToolPort;
  /** The bearer token a product secret holds, or null when the secret is missing. */
  token: (secretName: string) => Promise<string | null>;
  redactor: Pick<Redactor, "redactText">;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * docs/specs/retro-agent.md. Calls every query of every enabled source in order. A failed, denied
 * or capped query is skipped with its reason, and the others go on: a signal source never fails a
 * retro. The token stays in the worker, and the result is redacted before anything stores it.
 */
export const fetchSignals = async (
  sources: readonly SignalSourceRecord[],
  since: Date,
  dependencies: SignalFetchDependencies,
): Promise<{ results: FetchedSignal[]; skipped: SkippedSignal[] }> => {
  const results: FetchedSignal[] = [];
  const skipped: SkippedSignal[] = [];
  for (const source of sources) {
    if (!source.enabled) continue;
    const skipAll = (reason: string) => {
      for (const query of source.queries) skipped.push({ sourceName: source.name, queryName: query.name, reason });
    };
    let token: string | null = null;
    if (source.secretName !== null) {
      token = await dependencies.token(source.secretName);
      if (token === null) {
        skipAll(`the product secret ${source.secretName} is missing`);
        continue;
      }
    }
    // SDD section 58. Each call passes the Action Policy, whose allow list is this source's tools.
    const policy = buildActionPolicy({ role: "retro", mcpAllowedTools: source.queries.map((query) => query.tool) });
    const tools = dependencies.tools(source.endpoint, token);
    for (const query of source.queries) {
      try {
        policy.assertMcpTool(query.tool);
        const args = renderSignalArguments(query.arguments, since) as Record<string, unknown>;
        const text = dependencies.redactor.redactText(await tools.callTool(query.tool, args));
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > query.maxBytes) {
          skipped.push({ sourceName: source.name, queryName: query.name, reason: `the result has ${bytes} bytes, above the cap of ${query.maxBytes}` });
          continue;
        }
        results.push({ sourceName: source.name, sourceKind: source.kind, queryName: query.name, content: text, sha256: sha256Of(text), bytes });
      } catch (error) {
        skipped.push({ sourceName: source.name, queryName: query.name, reason: dependencies.redactor.redactText(messageOf(error)).slice(0, 500) });
      }
    }
  }
  return { results, skipped };
};
