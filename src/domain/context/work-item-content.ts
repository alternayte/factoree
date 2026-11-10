import { createHash } from "node:crypto";
import type { AuthorityClass } from "./authority.js";
import { backstageEntityRef } from "./backstage-source.js";
import type { ContextSourceKind } from "./context-source-configuration.js";

/**
 * docs/specs/work-item-images-and-links.md. The images, the links and the human comments of a
 * delegated Linear issue. This module holds the rules: which comment Factoree keeps, which image
 * it reads, which link it follows. The adapters read Linear and GitHub, and the activity stores
 * the result.
 */

/** The one host an image may come from. Its URLs answer 401 without the install's Linear token. */
export const LINEAR_UPLOADS_HOST = "uploads.linear.app";
/** SDD section 18 forbids unbounded retrieval. */
export const WORK_ITEM_MAX_IMAGES = 10;
export const WORK_ITEM_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const WORK_ITEM_MAX_LINKS = 10;
/** DI-21.41. The largest link content Factoree reads. */
export const WORK_ITEM_MAX_LINK_BYTES = 1024 * 1024;

/** The context ref of the comments item. One run holds one. */
export const WORK_ITEM_COMMENTS_REF = "linear:comments";
export const workItemImageRef = (n: number): string => `linear:image:${n}`;
const LINK_REF_PREFIX = "linear:link:";
export const workItemLinkRef = (url: string): string => `${LINK_REF_PREFIX}${url}`;
export const isWorkItemLinkRef = (ref: string): boolean => ref.startsWith(LINK_REF_PREFIX);

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
};

// ---------------------------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------------------------

/** One comment of the issue, as the Linear adapter reads it. */
export interface WorkItemComment {
  id: string;
  body: string;
  /** ISO 8601. */
  createdAt: string;
  author: string;
  /** True for a comment of a bot or an app user, such as Factoree itself. */
  bot: boolean;
  /** The agent session the comment opens, or null. */
  agentSessionId: string | null;
  parentId: string | null;
}

/**
 * DI-21.39. The human comments Factoree reads: no bot or app comment, no comment of an agent
 * session thread, nothing created after the delegation, and no empty body. A thread is an agent
 * session thread when a comment on its parent chain opens a session or its root is a bot comment.
 * The result is in time order, oldest first.
 */
export const keptComments = (comments: WorkItemComment[], delegatedAt: string | null): WorkItemComment[] => {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const inSessionThread = (comment: WorkItemComment): boolean => {
    let current: WorkItemComment | undefined = comment;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.agentSessionId !== null) return true;
      if (current.parentId === null) return current !== comment && current.bot;
      current = byId.get(current.parentId);
    }
    return false;
  };
  const cutoff = delegatedAt === null ? null : Date.parse(delegatedAt);
  return comments
    .filter((comment) => !comment.bot)
    .filter((comment) => !inSessionThread(comment))
    .filter((comment) => cutoff === null || Number.isNaN(cutoff) || Date.parse(comment.createdAt) <= cutoff)
    .filter((comment) => comment.body.trim() !== "")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

/** The origin of a comment, as a prompt and a post name it. */
export const commentOrigin = (comment: WorkItemComment): string => `the comment of ${comment.author} at ${comment.createdAt}`;

/**
 * The content of the comments item. A later human sentence supersedes an earlier one on the same
 * point, so the text says so above the comments (DI-21.39).
 */
export const renderComments = (comments: WorkItemComment[]): string | null =>
  comments.length === 0
    ? null
    : [
        "# Human comments on the issue",
        "",
        "The comments are in time order, oldest first. They come after the description. A later sentence supersedes an earlier sentence, or a sentence of the description, on the same point.",
        "",
        ...comments.flatMap((comment) => [`## ${comment.author} at ${comment.createdAt}`, "", comment.body.trim(), ""]),
      ].join("\n");

/** One markdown text of the issue: the description, or one kept comment. */
export interface WorkItemText {
  origin: string;
  text: string;
}

// ---------------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------------

/** One markdown image of the issue, in document order. */
export interface ImageReference {
  url: string;
  /** The sentence around the image, without the image itself. */
  caption: string;
  origin: string;
}

const IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const MARKDOWN_NOISE = /[*_`>#]+/g;

const withoutImages = (line: string): string =>
  line.replace(IMAGE, " ").replace(MARKDOWN_NOISE, " ").replace(/\s+/g, " ").trim();

/**
 * DI-21.40. The sentence around an image: the text of its own line without the image, else the
 * nearest line before it with text, else the nearest line after it, else the alt text.
 */
const captionOf = (lines: string[], index: number, alt: string): string => {
  const own = withoutImages(lines[index] ?? "");
  if (own !== "") return oneLine(own, 300);
  for (let before = index - 1; before >= 0; before -= 1) {
    const text = withoutImages(lines[before] ?? "");
    if (text !== "") return oneLine(text, 300);
  }
  for (let after = index + 1; after < lines.length; after += 1) {
    const text = withoutImages(lines[after] ?? "");
    if (text !== "") return oneLine(text, 300);
  }
  return oneLine(alt, 300);
};

/** Every markdown image of the texts, in document order. A URL that appears twice counts once. */
export const imageReferencesIn = (texts: WorkItemText[]): ImageReference[] => {
  const seen = new Set<string>();
  const references: ImageReference[] = [];
  for (const { origin, text } of texts) {
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(IMAGE)) {
        const url = match[2] ?? "";
        if (url === "" || seen.has(url)) continue;
        seen.add(url);
        references.push({ url, caption: captionOf(lines, index, match[1] ?? ""), origin });
      }
    });
  }
  return references;
};

/** The image formats Factoree keeps. SVG is text that can carry instructions, so it is not one. */
export const imageTypeOf = (bytes: Uint8Array): { contentType: string; extension: string } | null => {
  const starts = (signature: number[], offset = 0): boolean =>
    bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: "image/png", extension: "png" };
  if (starts([0xff, 0xd8, 0xff])) return { contentType: "image/jpeg", extension: "jpg" };
  if (starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return { contentType: "image/gif", extension: "gif" };
  }
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return { contentType: "image/webp", extension: "webp" };
  return null;
};

/** One image Factoree kept. `n` numbers the kept images from 1, in document order. */
export interface WorkItemImage {
  n: number;
  url: string;
  sha256: string;
  contentType: string;
  extension: string;
  byteLength: number;
  caption: string;
  origin: string;
}

export interface SkippedImage {
  url: string;
  reason: string;
}

/** The file name of an image in `$HOME/.factoree/context`. */
export const imageFileName = (image: Pick<WorkItemImage, "n" | "extension">): string => `image-${image.n}.${image.extension}`;

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * DI-21.40. Reads the images in document order. An image on another host, a download fault, a
 * format other than PNG, JPEG, GIF and WebP, and an image over 10 MiB are skipped with the reason.
 * The cap of 10 counts kept images only, so a skipped image does not use a place. Every image
 * after the tenth kept one is skipped.
 */
export const collectImages = async (
  references: ImageReference[],
  download: (url: string, maxBytes: number) => Promise<Uint8Array>,
): Promise<{ images: Array<WorkItemImage & { bytes: Uint8Array }>; skipped: SkippedImage[] }> => {
  const images: Array<WorkItemImage & { bytes: Uint8Array }> = [];
  const skipped: SkippedImage[] = [];
  for (const reference of references) {
    const host = hostOf(reference.url);
    if (host !== LINEAR_UPLOADS_HOST || !reference.url.startsWith("https://")) {
      skipped.push({ url: reference.url, reason: `Factoree reads images from https://${LINEAR_UPLOADS_HOST} only, not from ${host ?? "this URL"}.` });
      continue;
    }
    if (images.length >= WORK_ITEM_MAX_IMAGES) {
      skipped.push({ url: reference.url, reason: `Factoree reads at most ${WORK_ITEM_MAX_IMAGES} images of an issue.` });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await download(reference.url, WORK_ITEM_MAX_IMAGE_BYTES);
    } catch (error) {
      skipped.push({ url: reference.url, reason: `The image could not be downloaded: ${reasonOf(error)}` });
      continue;
    }
    if (bytes.byteLength > WORK_ITEM_MAX_IMAGE_BYTES) {
      skipped.push({ url: reference.url, reason: `The image is larger than ${WORK_ITEM_MAX_IMAGE_BYTES} bytes.` });
      continue;
    }
    const type = imageTypeOf(bytes);
    if (type === null) {
      skipped.push({ url: reference.url, reason: "The file is not a PNG, JPEG, GIF or WebP image." });
      continue;
    }
    images.push({
      n: images.length + 1,
      url: reference.url,
      sha256: sha256(bytes),
      contentType: type.contentType,
      extension: type.extension,
      byteLength: bytes.byteLength,
      caption: reference.caption,
      origin: reference.origin,
      bytes,
    });
  }
  return { images, skipped };
};

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

const MARKDOWN_LINK = /(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const AUTOLINK = /<(https?:\/\/[^>\s]+)>/g;
const BARE_URL = /https?:\/\/[^\s<>()[\]"'`]+/g;
const TRAILING = /[.,;:!?'"]+$/;

/**
 * Every http or https link of the texts, in document order, without the images. A markdown link
 * gives its target, and a bare URL loses its trailing punctuation. A URL counts once.
 */
export const linkUrlsIn = (texts: WorkItemText[]): string[] => {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (url: string): void => {
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };
  for (const { text } of texts) {
    const images = new Set<string>();
    let rest = text;
    for (const match of text.matchAll(MARKDOWN_LINK)) {
      const url = match[2] ?? "";
      if (match[1] === "!") images.add(url);
      else add(url);
    }
    rest = rest.replace(MARKDOWN_LINK, " ");
    for (const match of rest.matchAll(AUTOLINK)) add(match[1] ?? "");
    rest = rest.replace(AUTOLINK, " ");
    for (const match of rest.matchAll(BARE_URL)) {
      const url = (match[0] ?? "").replace(TRAILING, "");
      if (!images.has(url)) add(url);
    }
  }
  return urls;
};

/** A configured context source of the product, as link classification needs it. */
export interface LinkSourceHost {
  sourceId: string;
  kind: ContextSourceKind;
  endpoint: string;
  authority: AuthorityClass;
}

/** A repository of the product, with the App installation that grants it. */
export interface LinkRepository {
  fullName: string;
  githubInstallationId: string;
}

export interface LinkHosts {
  /** The GitHub web URL of the install, such as https://github.com. */
  githubWebUrl: string;
  repositories: LinkRepository[];
  sources: LinkSourceHost[];
}

/** What a followed link reads. */
export type LinkTarget =
  | { kind: "linear_issue"; identifier: string }
  | { kind: "github_issue" | "github_pull"; repository: string; number: number; githubInstallationId: string }
  | { kind: "github_file"; repository: string; ref: string; path: string; githubInstallationId: string }
  | { kind: "source"; sourceId: string; sourceKind: ContextSourceKind; ref: string; authority: AuthorityClass };

export type LinkClassification = { kind: "follow"; target: LinkTarget } | { kind: "not_read"; host: string; reason: string };

const LINEAR_ISSUE_PATH = /^\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[^/]*)?\/?$/;
const GITHUB_NUMBERED = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/.*)?$/;
const GITHUB_BLOB = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/;
const BACKSTAGE_ENTITY = /^\/catalog\/([^/]+)\/([^/]+)\/([^/]+)\/?/;

/**
 * DI-21.41. A link is followed only to a host a human chose: a Linear issue, a GitHub issue, pull
 * request or file of a repository of the product, or the host of a registered llms.txt, MCP or
 * Backstage source. Every other link stays text. The scheme must be https, except that a source
 * endpoint on http keeps its own scheme.
 */
export const classifyLink = (url: string, hosts: LinkHosts): LinkClassification => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "not_read", host: "", reason: "The link is not a URL." };
  }
  const host = parsed.host.toLowerCase();
  const notRead = (reason: string): LinkClassification => ({ kind: "not_read", host, reason });
  if (parsed.username !== "" || parsed.password !== "") return notRead("The link carries a user name or a password.");

  if (host === "linear.app" && parsed.protocol === "https:") {
    const issue = LINEAR_ISSUE_PATH.exec(parsed.pathname);
    if (issue !== null) return { kind: "follow", target: { kind: "linear_issue", identifier: (issue[1] ?? "").toUpperCase() } };
    return notRead("Factoree reads a Linear link only when it names an issue.");
  }

  const githubHost = hostOf(hosts.githubWebUrl);
  if (githubHost !== null && host === githubHost && parsed.protocol === "https:") {
    const repositoryOf = (owner: string, name: string): LinkRepository | undefined =>
      hosts.repositories.find((repository) => repository.fullName.toLowerCase() === `${owner}/${name}`.toLowerCase());
    const numbered = GITHUB_NUMBERED.exec(parsed.pathname);
    const blob = GITHUB_BLOB.exec(parsed.pathname);
    const owner = numbered?.[1] ?? blob?.[1];
    const name = numbered?.[2] ?? blob?.[2];
    if (owner === undefined || name === undefined) {
      return notRead("Factoree reads a GitHub link only when it names an issue, a pull request or a file.");
    }
    const repository = repositoryOf(owner, name);
    if (repository === undefined) return notRead(`${owner}/${name} is not a repository of this product.`);
    if (numbered !== null) {
      return {
        kind: "follow",
        target: {
          kind: numbered[3] === "pull" ? "github_pull" : "github_issue",
          repository: repository.fullName,
          number: Number(numbered[4]),
          githubInstallationId: repository.githubInstallationId,
        },
      };
    }
    let path: string;
    let ref: string;
    try {
      path = decodeURIComponent(blob?.[4] ?? "");
      ref = decodeURIComponent(blob?.[3] ?? "");
    } catch {
      return notRead("The file path of the link does not decode.");
    }
    if ([...path.split("/"), ref].some((segment) => segment === "." || segment === ".." || segment === "")) {
      return notRead("The file path of the link holds an empty, \".\" or \"..\" segment.");
    }
    return {
      kind: "follow",
      target: {
        kind: "github_file",
        repository: repository.fullName,
        ref,
        path,
        githubInstallationId: repository.githubInstallationId,
      },
    };
  }

  for (const source of hosts.sources) {
    let endpoint: URL;
    try {
      endpoint = new URL(source.endpoint);
    } catch {
      continue;
    }
    if (endpoint.host.toLowerCase() !== host || endpoint.protocol !== parsed.protocol) continue;
    const clean = new URL(parsed.href);
    clean.hash = "";
    if (source.kind === "backstage") {
      const entity = BACKSTAGE_ENTITY.exec(parsed.pathname);
      if (entity === null) return notRead(`Factoree reads a link to the Backstage host ${host} only when it names a catalog entity.`);
      let entityRef: string;
      try {
        const [namespace, kind, name] = [entity[1], entity[2], entity[3]].map((part) => decodeURIComponent(part ?? ""));
        entityRef = `${(kind ?? "").toLowerCase()}:${namespace ?? ""}/${name ?? ""}`;
      } catch {
        return notRead("The catalog entity of the link does not decode.");
      }
      return {
        kind: "follow",
        target: { kind: "source", sourceId: source.sourceId, sourceKind: source.kind, ref: backstageEntityRef(entityRef), authority: source.authority },
      };
    }
    return {
      kind: "follow",
      target: { kind: "source", sourceId: source.sourceId, sourceKind: source.kind, ref: `${source.sourceId}:${clean.href}`, authority: source.authority },
    };
  }

  return notRead(`No registered context source of this product reads the host ${host}.`);
};

/** The authority of what a link reads. */
export const linkAuthority = (target: LinkTarget): AuthorityClass => {
  switch (target.kind) {
    case "linear_issue":
      return "product_documentation";
    case "github_issue":
    case "github_pull":
      return "prose_documentation";
    case "github_file":
      return "source_code";
    case "source":
      return target.authority;
  }
};

/** The context source and the ref of a followed link's item. */
export const linkReference = (url: string, target: LinkTarget): { sourceId: string; ref: string } =>
  target.kind === "source" ? { sourceId: target.sourceId, ref: target.ref } : { sourceId: "linear", ref: workItemLinkRef(url) };

/** Reads the content of one followed link. A throw leaves the link not read, with the reason. */
export interface WorkItemLinkReaders {
  linearIssue(identifier: string): Promise<{ title: string; content: string }>;
  github(target: Extract<LinkTarget, { kind: "github_issue" | "github_pull" | "github_file" }>): Promise<{ title: string; content: string }>;
  source(target: Extract<LinkTarget, { kind: "source" }>): Promise<{ content: string }>;
}

export const readLinkTarget = async (target: LinkTarget, readers: WorkItemLinkReaders): Promise<{ title: string; content: string }> => {
  switch (target.kind) {
    case "linear_issue":
      return await readers.linearIssue(target.identifier);
    case "github_issue":
    case "github_pull":
    case "github_file":
      return await readers.github(target);
    case "source": {
      const read = await readers.source(target);
      return { title: target.ref, content: read.content };
    }
  }
};

/** One followed link, as the contract freezes it. It holds no content. */
export interface WorkItemLink {
  url: string;
  host: string;
  sourceId: string;
  ref: string;
  authority: AuthorityClass;
  sha256: string;
  sizeBytes: number;
  title: string;
  target: LinkTarget;
}

export interface LinkNotRead {
  url: string;
  host: string;
  reason: string;
}

/**
 * DI-21.41. Follows the links one level deep, in document order, and stops at 10 followed links.
 * A read fault and content over 1 MiB leave the link not read, and it does not use a place.
 */
export const readLinks = async (
  urls: string[],
  hosts: LinkHosts,
  readers: WorkItemLinkReaders,
): Promise<{ links: WorkItemLink[]; notRead: LinkNotRead[] }> => {
  const links: WorkItemLink[] = [];
  const notRead: LinkNotRead[] = [];
  const refs = new Set<string>();
  for (const url of urls) {
    const classified = classifyLink(url, hosts);
    if (classified.kind === "not_read") {
      notRead.push({ url, host: classified.host, reason: classified.reason });
      continue;
    }
    const target = classified.target;
    const host = hostOf(url) ?? "";
    const reference = linkReference(url, target);
    if (refs.has(reference.ref)) continue;
    if (links.length >= WORK_ITEM_MAX_LINKS) {
      notRead.push({ url, host, reason: `Factoree follows at most ${WORK_ITEM_MAX_LINKS} links of an issue.` });
      continue;
    }
    let read: { title: string; content: string };
    try {
      read = await readLinkTarget(target, readers);
    } catch (error) {
      notRead.push({ url, host, reason: `The link could not be read: ${reasonOf(error)}` });
      continue;
    }
    const sizeBytes = Buffer.byteLength(read.content, "utf8");
    if (sizeBytes > WORK_ITEM_MAX_LINK_BYTES) {
      notRead.push({ url, host, reason: `The content is larger than ${WORK_ITEM_MAX_LINK_BYTES} bytes.` });
      continue;
    }
    refs.add(reference.ref);
    links.push({
      url,
      host,
      ...reference,
      authority: linkAuthority(target),
      sha256: sha256(read.content),
      sizeBytes,
      title: oneLine(read.title, 200),
      target,
    });
  }
  return { links, notRead };
};

// ---------------------------------------------------------------------------------------------
// The post
// ---------------------------------------------------------------------------------------------

/** The lines the context post adds for what Factoree did not read. Empty when it read everything. */
export const unreadContentLines = (skipped: SkippedImage[], notRead: LinkNotRead[]): string[] => [
  ...(skipped.length === 0 ? [] : ["", "Images skipped:", ...skipped.map((image) => `- ${image.url}: ${image.reason}`)]),
  ...(notRead.length === 0
    ? []
    : ["", "Links not read:", ...notRead.map((link) => `- ${link.host === "" ? link.url : `${link.host}: ${link.url}`}. ${link.reason}`)]),
];

/**
 * docs/specs/work-item-images-and-links.md. The reads the control plane makes for one tenant. The
 * Linear token and the GitHub App token stay in the worker: no agent session holds either.
 */
export interface WorkItemContentPort {
  /** Every comment of the issue, with its author, its thread and its agent session. */
  comments(tenantId: string, issueId: string): Promise<WorkItemComment[]>;
  /** The bytes of one `uploads.linear.app` image, read with the Linear token. */
  downloadImage(tenantId: string, url: string, maxBytes: number): Promise<Uint8Array>;
  /** The title and the description of one Linear issue, as one text. */
  linearIssue(tenantId: string, identifier: string): Promise<{ title: string; content: string }>;
  /** One GitHub issue, pull request or file, read with a read-only App token. */
  github(target: Extract<LinkTarget, { kind: "github_issue" | "github_pull" | "github_file" }>): Promise<{ title: string; content: string }>;
}
