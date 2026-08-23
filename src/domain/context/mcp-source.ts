import type { ActionPolicy } from "~/domain/policy/action-policy.js";
import type { McpToolPort } from "~/adapters/mcp/mcp-json-rpc-client.js";
import type { McpSourceSettings } from "./context-source-configuration.js";
import type {
  ContextCandidate,
  ContextDiscoveryRequest,
  ContextDocument,
  ContextReference,
  ContextSource,
} from "./context-source.js";
import { DISCOVERY_PRIORITY } from "./context-source.js";
import { topicsIn } from "./topics.js";

export interface McpContextSourceOptions {
  sourceId: string;
  settings: McpSourceSettings;
  policy: ActionPolicy;
  tools: McpToolPort;
}

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * SDD section 58. Every path from this class into `tools.callTool` is preceded by
 * `policy.assertMcpTool` for the exact tool name it is about to call. The server is untrusted
 * on the answer side too: a malformed JSON body, a non-array `items`, a non-object item, or a
 * bad `sizeBytes` is handled without a crash and without a wrong value. Controller decision 13:
 * a transport fault or a policy denial degrades the Run to no candidate, never fails it.
 */
export class McpContextSource implements ContextSource {
  private readonly documents = new Map<string, { itemRef: string; sourceVersion: string }>();

  constructor(private readonly options: McpContextSourceOptions) {}

  id(): string {
    return this.options.sourceId;
  }

  async discover(request: ContextDiscoveryRequest): Promise<ContextCandidate[]> {
    this.documents.clear();
    try {
      this.options.policy.assertMcpTool(this.options.settings.discoverTool);
    } catch {
      return [];
    }

    try {
      const answer = await this.options.tools.callTool(this.options.settings.discoverTool, {
        goal: request.goal,
        topics: request.topics,
        repository: request.primaryRepository.slug,
      });
      return this.parse(answer, request);
    } catch {
      return [];
    }
  }

  private parse(answer: string, request: ContextDiscoveryRequest): ContextCandidate[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer) as unknown;
    } catch {
      return [];
    }
    if (!isRecord(parsed) || !Array.isArray(parsed["items"])) return [];

    const candidates: ContextCandidate[] = [];
    // SDD section 21 keeps every `ref` of one Context Contract unique, and controller decision 13
    // keeps an MCP fault from failing a Run. A server that names one item twice must therefore
    // yield one candidate. The first occurrence wins, the same way the Backstage walk works.
    const seen = new Set<string>();
    for (const rawItem of parsed["items"]) {
      if (candidates.length >= this.options.settings.maxCandidates) break;
      if (!isRecord(rawItem)) continue;

      const itemRef = rawItem["ref"];
      const sourceVersion = rawItem["sourceVersion"];
      if (!isNonEmptyString(itemRef) || !isNonEmptyString(sourceVersion)) continue;

      const title = isNonEmptyString(rawItem["title"]) ? rawItem["title"] : "";
      const reason = isNonEmptyString(rawItem["reason"])
        ? rawItem["reason"]
        : "no reason given";
      const sizeBytes = isFiniteNonNegative(rawItem["sizeBytes"]) ? rawItem["sizeBytes"] : null;

      const ref = `${this.id()}:${itemRef}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      this.documents.set(ref, { itemRef, sourceVersion });

      candidates.push({
        reference: { sourceId: this.id(), ref, repository: null, sha: null, path: null },
        sourceVersion,
        authority: this.options.settings.authority,
        reason: `the MCP source "${this.id()}" reports: ${reason}`,
        priority: DISCOVERY_PRIORITY.scoped_semantic_search,
        topics: topicsIn(`${title} ${reason}`, request.topics),
        sizeBytes,
        suggestedClassification: "reference",
      });
    }

    return candidates;
  }

  async fetch(reference: ContextReference): Promise<ContextDocument> {
    const document = this.documents.get(reference.ref);
    if (document === undefined) {
      throw new Error(`The MCP context source "${this.id()}" never offered "${reference.ref}".`);
    }

    this.options.policy.assertMcpTool(this.options.settings.fetchTool);
    const content = await this.options.tools.callTool(this.options.settings.fetchTool, {
      ref: document.itemRef,
    });

    return {
      reference,
      sourceVersion: document.sourceVersion,
      content,
    };
  }
}
