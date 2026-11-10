import { createHash } from "node:crypto";
import type { LlmsTxtPort } from "~/adapters/llms-txt/llms-txt-client.js";
import type { LlmsTxtSourceSettings } from "./context-source-configuration.js";
import { LLMS_TXT_MAX_PAGE_BYTES } from "./context-source-configuration.js";
import type {
  ContextCandidate,
  ContextDiscoveryRequest,
  ContextDocument,
  ContextReference,
  ContextSource,
} from "./context-source.js";
import { DISCOVERY_PRIORITY } from "./context-source.js";
import { topicsIn } from "./topics.js";

/** One markdown link of an llms.txt file. */
export interface LlmsTxtLink {
  title: string;
  /** The absolute URL, without a fragment. */
  url: string;
  description: string;
}

/** DI-21.35. The llms.txt file itself is read with the largest page cap a configuration can set. */
export const LLMS_TXT_INDEX_MAX_BYTES = LLMS_TXT_MAX_PAGE_BYTES;

const LINK = /\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The path of a URL, decoded where it can be, for a topic match. */
const pathOf = (url: string): string => {
  const path = new URL(url).pathname;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

/**
 * docs/specs/external-context-delivery.md and DI-21.35. Parses the markdown links of an llms.txt
 * file. The `## Optional` section is skipped, because the llms.txt format marks it as safe to
 * skip. A link to another host, a link that is not http or https, and a link to `llms.txt` or
 * `llms-full.txt` are dropped: Factoree reads one host, one level below the file. The first link
 * to one URL wins.
 */
export const parseLlmsTxt = (text: string, endpoint: string): LlmsTxtLink[] => {
  const base = new URL(endpoint);
  const links: LlmsTxtLink[] = [];
  const seen = new Set<string>();
  let optional = false;
  for (const line of text.split(/\r\n|\n|\r/)) {
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      // An H1 is the title of the file. An H2 opens a section, and only `## Optional` is skipped.
      if ((heading[1] ?? "").length <= 2) optional = (heading[2] ?? "").trim().toLowerCase() === "optional";
      continue;
    }
    if (optional) continue;
    for (const match of line.matchAll(LINK)) {
      const title = (match[1] ?? "").trim();
      const href = match[2] ?? "";
      let url: URL;
      try {
        url = new URL(href, base);
      } catch {
        continue;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      if (url.host !== base.host) continue;
      url.hash = "";
      const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1).toLowerCase();
      if (name === "llms.txt" || name === "llms-full.txt") continue;
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      const after = line.slice((match.index ?? 0) + match[0].length);
      const description = after.replace(/^\s*[:\-–—]\s*/, "").trim();
      links.push({ title: title.length > 0 ? title : url.href, url: url.href, description });
    }
  }
  return links;
};

/** DI-21.35. The run topics one link names in its title, its description and its URL path. */
export const linkTopics = (link: LlmsTxtLink, topics: string[]): string[] =>
  topicsIn(`${link.title} ${link.description} ${pathOf(link.url)}`, topics);

/**
 * docs/specs/external-context-delivery.md. Each link scores one point for each run topic it
 * names. The `maxPages` links with the highest scores stay, in file order on a tie. A link with a
 * score of zero is dropped, because SDD section 18 forbids unbounded retrieval.
 */
export const selectLlmsTxtLinks = (
  links: LlmsTxtLink[],
  topics: string[],
  maxPages: number,
): Array<{ link: LlmsTxtLink; topics: string[] }> =>
  links
    .map((link, index) => ({ link, topics: linkTopics(link, topics), index }))
    .filter((entry) => entry.topics.length > 0)
    .sort((a, b) => b.topics.length - a.topics.length || a.index - b.index)
    .slice(0, maxPages)
    .map(({ link, topics: found }) => ({ link, topics: found }));

export interface LlmsTxtContextSourceOptions {
  sourceId: string;
  /** The URL of the llms.txt file. */
  endpoint: string;
  settings: LlmsTxtSourceSettings;
  pages: LlmsTxtPort;
}

/**
 * docs/specs/external-context-delivery.md. A documentation site that publishes an llms.txt file.
 * Discover reads the file, keeps the linked pages that match the run topics, and reads each kept
 * page: its version is the SHA-256 of its content, and its size is its byte length. DI-5.13: a
 * fault of the file or of one page degrades the run and never fails it.
 */
export class LlmsTxtContextSource implements ContextSource {
  constructor(private readonly options: LlmsTxtContextSourceOptions) {}

  id(): string {
    return this.options.sourceId;
  }

  /** The stable reference of one page. It carries the URL, so a new instance can fetch it. */
  private refOf(url: string): string {
    return `${this.id()}:${url}`;
  }

  async discover(request: ContextDiscoveryRequest): Promise<ContextCandidate[]> {
    let index: string | null;
    try {
      index = await this.options.pages.read(this.options.endpoint, LLMS_TXT_INDEX_MAX_BYTES);
    } catch {
      return [];
    }
    if (index === null) return [];

    const host = new URL(this.options.endpoint).host;
    const selected = selectLlmsTxtLinks(parseLlmsTxt(index, this.options.endpoint), request.topics, this.options.settings.maxPages);
    const candidates: ContextCandidate[] = [];
    for (const { link, topics } of selected) {
      let content: string | null;
      try {
        content = await this.options.pages.read(link.url, this.options.settings.maxPageBytes);
      } catch {
        continue;
      }
      // A page above its cap is skipped. A cap that a configuration can raise without limit is no cap.
      if (content === null) continue;
      candidates.push({
        reference: { sourceId: this.id(), ref: this.refOf(link.url), repository: null, sha: null, path: null },
        sourceVersion: sha256(content),
        authority: this.options.settings.authority,
        reason:
          `the llms.txt of ${host} links "${link.title}", which names the run topics ` +
          topics.map((topic) => `"${topic}"`).join(", "),
        priority: DISCOVERY_PRIORITY.scoped_semantic_search,
        topics,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        suggestedClassification: "reference",
      });
    }
    return candidates;
  }

  /**
   * docs/specs/external-context-delivery.md. Works on a new instance: the reference holds the
   * URL, so the page is read again. The version is the SHA-256 of what the page holds now.
   */
  async fetch(reference: ContextReference): Promise<ContextDocument> {
    const prefix = `${this.id()}:`;
    if (!reference.ref.startsWith(prefix)) {
      throw new Error(`The llms.txt context source "${this.id()}" never offers "${reference.ref}".`);
    }
    const url = reference.ref.slice(prefix.length);
    const content = await this.options.pages.read(url, this.options.settings.maxPageBytes);
    if (content === null) {
      throw new Error(`The page is larger than ${this.options.settings.maxPageBytes} bytes, the page cap of "${this.id()}".`);
    }
    return { reference, sourceVersion: sha256(content), content };
  }
}
