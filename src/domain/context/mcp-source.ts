import { createHash } from "node:crypto";
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
 * bad `sizeBytes` is handled without a crash and without a wrong value. DI-5.13:
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
    // SDD section 21 keeps every `ref` of one Context Contract unique, and DI-5.13
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

  /**
   * docs/specs/external-context-delivery.md and DI-21.37. Works on a new instance without an
   * earlier `discover`: the reference is `<source id>:<item ref>`, so the fetch tool receives the
   * item ref. A new instance does not know the version the server reported, so the version is
   * then the SHA-256 of the content, which names that exact content.
   */
  async fetch(reference: ContextReference): Promise<ContextDocument> {
    const prefix = `${this.id()}:`;
    const known = this.documents.get(reference.ref);
    if (known === undefined && !reference.ref.startsWith(prefix)) {
      throw new Error(`The MCP context source "${this.id()}" never offers "${reference.ref}".`);
    }
    const itemRef = known?.itemRef ?? reference.ref.slice(prefix.length);

    this.options.policy.assertMcpTool(this.options.settings.fetchTool);
    const content = await this.options.tools.callTool(this.options.settings.fetchTool, {
      ref: itemRef,
    });

    return {
      reference,
      sourceVersion: known?.sourceVersion ?? createHash("sha256").update(content, "utf8").digest("hex"),
      content,
    };
  }
}
