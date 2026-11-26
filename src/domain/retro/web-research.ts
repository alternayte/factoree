import { createHash, randomBytes } from "node:crypto";

/**
 * docs/specs/retro-web-research.md. The limits of one retro session on the retro gateway. An
 * agent loop cannot spend without limit, and one result stays small enough to read.
 */
export const GATEWAY_LIMITS = {
  searches: 20,
  pages: 40,
  signalCalls: 50,
  resultBytes: 256 * 1024,
  queryChars: 400,
  resultsPerSearch: 8,
} as const;

/** Exa list prices, read 2026-11-26: a search of up to 10 results, and the text of one page. */
export const EXA_SEARCH_USD = 0.007;
export const EXA_PAGE_USD = 0.001;

/** The longest a gateway token lives: the session timeout and its hang retry, with a margin. */
export const GATEWAY_TOKEN_TTL_MS = 75 * 60_000;

/** The name of the gateway in the MCP config of a session. Its tools reach the agent as mcp__factoree__<tool>. */
export const GATEWAY_SERVER_NAME = "factoree";

export const GATEWAY_PATH = "/retro-gateway/mcp";

/** The gateway name of a ticked tool: letters, digits, _ and -, at most 64 characters, as MCP clients accept. */
export const gatewayToolNameOf = (source: string, tool: string): string => `${source}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

/** A new random gateway token and the SHA-256 the store keeps. */
export const newGatewayToken = (): { token: string; sha256: string } => {
  const token = `frg_${randomBytes(32).toString("base64url")}`;
  return { token, sha256: gatewayTokenSha256(token) };
};

export const gatewayTokenSha256 = (token: string): string => createHash("sha256").update(token).digest("hex");

/** The gateway URL a session calls: the Factoree public URL plus the gateway path. */
export const gatewayUrlOf = (publicUrl: string): string => `${publicUrl.replace(/\/+$/, "")}${GATEWAY_PATH}`;

/** One hit of a web search, before the store gives it its id. */
export interface SearchHit {
  url: string;
  title: string | null;
  publishedDate: string | null;
  snippet: string;
}

/** docs/specs/retro-web-research.md. The search service behind web_search and fetch_page. */
export interface WebSearchPort {
  search(query: string, limit: number): Promise<SearchHit[]>;
  /** The text of one page, or null when the service has none for it. */
  contents(url: string): Promise<{ title: string | null; text: string } | null>;
}

/** URLs match after the fragment is removed: a search result and a fetch name the same page. */
export const normalizeUrl = (raw: string): string | null => {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
};

/** Cuts a text to a byte cap on a character boundary, and says so. */
export const capText = (text: string, maxBytes: number): string => {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const note = "\n\n[Factoree cut this text at the size cap.]";
  let cut = text.slice(0, maxBytes);
  while (Buffer.byteLength(cut, "utf8") > maxBytes - note.length) cut = cut.slice(0, Math.floor(cut.length * 0.95));
  return cut + note;
};
