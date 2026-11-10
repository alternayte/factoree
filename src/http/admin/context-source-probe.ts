import { BackstageCatalogClient } from "~/adapters/backstage/backstage-catalog-client.js";
import { McpJsonRpcClient } from "~/adapters/mcp/mcp-json-rpc-client.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { McpContextSource } from "~/domain/context/mcp-source.js";
import { LlmsTxtClient } from "~/adapters/llms-txt/llms-txt-client.js";
import { LLMS_TXT_INDEX_MAX_BYTES, parseLlmsTxt } from "~/domain/context/llms-txt-source.js";
import type {
  BackstageSourceSettings,
  ContextSourceKind,
  ContextSourceSettings,
  McpSourceSettings,
} from "~/domain/context/context-source-configuration.js";
import { DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION } from "~/domain/context/repository-context-configuration.js";
import { Redactor } from "~/telemetry/redaction.js";

/** The goal the probe sends to a discover tool. A server can tell a test from a Run by it. */
export const PROBE_GOAL = "Factoree connection test. Return the items you would offer for this product.";

/** The most items one probe answer lists. The count still covers every item. */
const MAX_LISTED_ITEMS = 5;

export interface ContextSourceProbeInput {
  sourceId: string;
  kind: ContextSourceKind;
  endpoint: string;
  settings: ContextSourceSettings;
  /** The credential value, or null for a source that needs none. It never reaches the result. */
  credential: string | null;
  /** The `owner/repo` slug of a repository of the Product, or null when it has none yet. */
  repositorySlug: string | null;
}

export interface ContextSourceProbeItem {
  ref: string;
  title: string | null;
}

export interface ContextSourceProbeResult {
  ok: boolean;
  /** One sentence for the operator. */
  message: string;
  itemCount: number;
  items: ContextSourceProbeItem[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const errorText = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? ` ${error.cause.message}` : "";
  return `${message}${cause}`;
};

/** The title an MCP item names for one ref, so the operator sees what the server offers. */
const titlesOf = (answer: string): Map<string, string> => {
  const titles = new Map<string, string>();
  try {
    const parsed = JSON.parse(answer) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed["items"])) return titles;
    for (const item of parsed["items"]) {
      if (isRecord(item) && typeof item["ref"] === "string" && typeof item["title"] === "string") {
        titles.set(item["ref"], item["title"]);
      }
    }
  } catch {
    return titles;
  }
  return titles;
};

const hasItemsList = (answer: string): boolean => {
  try {
    const parsed = JSON.parse(answer) as unknown;
    return isRecord(parsed) && Array.isArray(parsed["items"]);
  } catch {
    return false;
  }
};

/**
 * Issue 8. Calls the discover tool of an MCP server, through the Action Policy of SDD section 58,
 * and reads the answer with the same parser a Run uses. A fault is the result, not a throw, so
 * the operator reads why the source failed.
 */
const probeMcp = async (
  input: ContextSourceProbeInput,
  settings: McpSourceSettings,
  fetchImpl: typeof fetch,
): Promise<ContextSourceProbeResult> => {
  const policy = buildActionPolicy({ mcpAllowedTools: settings.allowedTools });
  try {
    policy.assertMcpTool(settings.discoverTool);
  } catch (error) {
    return { ok: false, message: errorText(error), itemCount: 0, items: [] };
  }
  const client = new McpJsonRpcClient({ endpoint: input.endpoint, token: input.credential, fetch: fetchImpl });
  let answer: string;
  try {
    answer = await client.callTool(settings.discoverTool, {
      goal: PROBE_GOAL,
      topics: [],
      repository: input.repositorySlug ?? "",
    });
  } catch (error) {
    return { ok: false, message: errorText(error), itemCount: 0, items: [] };
  }
  if (!hasItemsList(answer)) {
    return {
      ok: false,
      message: `The tool "${settings.discoverTool}" answered, but the answer is not JSON with an "items" list. A Run reads no item from it.`,
      itemCount: 0,
      items: [],
    };
  }
  const source = new McpContextSource({
    sourceId: input.sourceId,
    settings,
    policy,
    tools: { callTool: () => Promise.resolve(answer) },
  });
  const candidates = await source.discover({
    runId: "connection-test",
    goal: PROBE_GOAL,
    topics: [],
    primaryRepository: { slug: input.repositorySlug ?? "", url: "", ref: "" },
    referenceRepositories: [],
    workItemReferences: [],
    decisions: [],
    contextConfiguration: DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION,
  });
  const titles = titlesOf(answer);
  const prefix = `${input.sourceId}:`;
  const items = candidates.slice(0, MAX_LISTED_ITEMS).map((candidate) => {
    const ref = candidate.reference.ref.startsWith(prefix)
      ? candidate.reference.ref.slice(prefix.length)
      : candidate.reference.ref;
    return { ref, title: titles.get(ref) ?? null };
  });
  return {
    ok: true,
    message:
      candidates.length === 0
        ? `The tool "${settings.discoverTool}" answered with no item that has a ref and a sourceVersion.`
        : `The tool "${settings.discoverTool}" answered with ${candidates.length} ${candidates.length === 1 ? "item" : "items"}.`,
    itemCount: candidates.length,
    items,
  };
};

/**
 * Issue 8. Reads the start entity of a Backstage catalog: the configured component, else the
 * entity of a repository of the Product. A catalog that answers with no entity still proves the
 * URL and the credential.
 */
const probeBackstage = async (
  input: ContextSourceProbeInput,
  settings: BackstageSourceSettings,
  fetchImpl: typeof fetch,
): Promise<ContextSourceProbeResult> => {
  const catalog = new BackstageCatalogClient({ endpoint: input.endpoint, token: input.credential, fetch: fetchImpl });
  try {
    if (settings.primaryComponent !== null) {
      const entity = await catalog.getByRef(settings.primaryComponent);
      return entity === null
        ? {
            ok: false,
            message: `The catalog answered, but it holds no entity "${settings.primaryComponent}".`,
            itemCount: 0,
            items: [],
          }
        : {
            ok: true,
            message: `The catalog answered with the entity "${entity.ref}".`,
            itemCount: 1,
            items: [{ ref: entity.ref, title: entity.title }],
          };
    }
    if (input.repositorySlug === null) {
      // No repository and no component: one bounded query proves the URL and the credential.
      await catalog.findByRepositorySlug("factoree/connection-test", null);
      return {
        ok: true,
        message: "The catalog answered. The product has no repository yet, so Factoree looked up no entity.",
        itemCount: 0,
        items: [],
      };
    }
    const entity = await catalog.findByRepositorySlug(input.repositorySlug, null);
    return entity === null
      ? {
          ok: true,
          message: `The catalog answered, but no component names the repository "${input.repositorySlug}".`,
          itemCount: 0,
          items: [],
        }
      : {
          ok: true,
          message: `The catalog answered with the entity "${entity.ref}" for "${input.repositorySlug}".`,
          itemCount: 1,
          items: [{ ref: entity.ref, title: entity.title }],
        };
  } catch (error) {
    return { ok: false, message: errorText(error), itemCount: 0, items: [] };
  }
};

/**
 * docs/specs/external-context-delivery.md. Reads the llms.txt file and reports the links a run
 * can read, with the first five titles, so the operator sees what a run can read. The count
 * leaves out the Optional section and every link to another host (DI-21.37).
 */
const probeLlmsTxt = async (
  input: ContextSourceProbeInput,
  fetchImpl: typeof fetch,
): Promise<ContextSourceProbeResult> => {
  const client = new LlmsTxtClient({ endpoint: input.endpoint, token: input.credential, fetch: fetchImpl });
  let text: string | null;
  try {
    text = await client.read(input.endpoint, LLMS_TXT_INDEX_MAX_BYTES);
  } catch (error) {
    return { ok: false, message: errorText(error), itemCount: 0, items: [] };
  }
  if (text === null) {
    return {
      ok: false,
      message: `The llms.txt file is larger than ${LLMS_TXT_INDEX_MAX_BYTES} bytes. A run reads no page from it.`,
      itemCount: 0,
      items: [],
    };
  }
  const links = parseLlmsTxt(text, input.endpoint);
  return {
    ok: links.length > 0,
    message:
      links.length === 0
        ? "The llms.txt file answered, but it links no page on its host outside the Optional section. A run reads no page from it."
        : `The llms.txt file links ${links.length} ${links.length === 1 ? "page" : "pages"} a run can read.`,
    itemCount: links.length,
    items: links.slice(0, MAX_LISTED_ITEMS).map((link) => ({ ref: link.url, title: link.title })),
  };
};

/**
 * Issue 8. Tests one context source configuration before it is saved. SDD section 60: a server
 * can echo the credential back, so every text of the result passes a redactor that knows it.
 */
export const probeContextSource = async (
  input: ContextSourceProbeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ContextSourceProbeResult> => {
  const result =
    input.settings.kind === "mcp"
      ? await probeMcp(input, input.settings, fetchImpl)
      : input.settings.kind === "llms_txt"
        ? await probeLlmsTxt(input, fetchImpl)
        : await probeBackstage(input, input.settings, fetchImpl);
  const redactor = new Redactor(input.credential === null ? [] : [input.credential]);
  return {
    ok: result.ok,
    message: redactor.redactText(result.message),
    itemCount: result.itemCount,
    items: result.items.map((item) => ({
      ref: redactor.redactText(item.ref),
      title: item.title === null ? null : redactor.redactText(item.title),
    })),
  };
};
