import { posix } from "node:path";
import type { HostCredential } from "~/domain/products/host-credentials.js";
import { allowListCovers } from "~/domain/runs/sandbox.js";
import type { DerivedHostFileSource } from "./derived-hosts.js";
import { ECOSYSTEM_HOSTS } from "./ecosystem-hosts.js";
import { compareNugetVersions, normalizeNugetVersion } from "./nuget-packages.js";
import { attributeOf, childrenNamed, descendantsNamed, parseXml } from "./xml-elements.js";

/**
 * docs/specs/nuget-private-feed-mapping.md. The one private NuGet feed Factoree maps, and the
 * GitHub Packages feed that mirrors it, as `<host>/<owner>`. Every other private feed fails the
 * setup. Widening this is a code change on purpose.
 */
export const NUGET_FEED_MAPPING = { from: "nuget.frontiersin.net", to: "nuget.pkg.github.com/frontiersin" } as const;

const [mirrorHost = "", mirrorOwner = ""] = NUGET_FEED_MAPPING.to.split("/");
/** The host of the mirror, which a `header` host credential must cover. */
export const NUGET_MIRROR_HOST = mirrorHost;
/** The GitHub owner of the mirror. It is never guessed from a credential. */
export const NUGET_MIRROR_OWNER = mirrorOwner;

/** The file Factoree writes, under `.factoree/` like every setup file. */
export const FACTOREE_NUGET_CONFIG = ".factoree/nuget.config";

/** The NuGet v3 service index of nuget.org. */
export const NUGET_ORG_INDEX = "https://api.nuget.org/v3/index.json";
const NUGET_ORG_HOST = "api.nuget.org";

/** The service index of a GitHub Packages NuGet feed. */
export const githubPackagesIndexOf = (owner: string): string => `https://${NUGET_MIRROR_HOST}/${owner}/index.json`;

/** Where an owner's packages are listed and mirrored. */
export const githubPackagesPageOf = (owner: string): string => `https://github.com/orgs/${owner}/packages`;

/** One `<add>` of `<packageSources>`. */
export interface NugetSource {
  key: string;
  url: string;
  protocolVersion: string | null;
  /** The host of an http(s) source, lower case, or null for a local folder. */
  host: string | null;
}

/** One `NuGet.config` file of the repository. */
export interface NugetConfigFile {
  path: string;
  /** True when `<packageSources>` starts with `<clear />`. */
  clear: boolean;
  sources: NugetSource[];
  /** The keys `<disabledPackageSources>` turns off. */
  disabled: string[];
  /** The package patterns `<packageSourceMapping>` gives each source key, in file order. */
  mappings: Array<{ key: string; patterns: string[] }>;
}

const hostOf = (url: string): string | null => {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** Reads the package sources of one `NuGet.config`, in file order. */
export const parseNugetConfig = (path: string, text: string): NugetConfigFile => {
  const document = parseXml(text);
  const sources: NugetSource[] = [];
  let clear = false;
  for (const block of descendantsNamed(document, "packageSources")) {
    for (const child of block.children) {
      const name = child.name.toLowerCase();
      if (name === "clear") {
        clear = true;
        sources.length = 0;
      }
      if (name === "remove") {
        const key = attributeOf(child, "key");
        if (key !== null) sources.splice(0, sources.length, ...sources.filter((source) => source.key.toLowerCase() !== key.toLowerCase()));
      }
      if (name !== "add") continue;
      const key = attributeOf(child, "key");
      const url = attributeOf(child, "value");
      if (key === null || url === null) continue;
      sources.push({ key, url, protocolVersion: attributeOf(child, "protocolVersion"), host: hostOf(url) });
    }
  }
  const disabled = descendantsNamed(document, "disabledPackageSources").flatMap((block) =>
    childrenNamed(block, "add")
      .filter((entry) => (attributeOf(entry, "value") ?? "").trim().toLowerCase() === "true")
      .map((entry) => attributeOf(entry, "key") ?? "")
      .filter((key) => key !== ""),
  );
  const mappings = descendantsNamed(document, "packageSourceMapping").flatMap((block) =>
    childrenNamed(block, "packageSource").flatMap((entry) => {
      const key = attributeOf(entry, "key");
      const patterns = childrenNamed(entry, "package")
        .map((item) => (attributeOf(item, "pattern") ?? "").trim())
        .filter((pattern) => pattern !== "");
      return key === null || patterns.length === 0 ? [] : [{ key, patterns }];
    }),
  );
  return { path, clear, sources, disabled, mappings };
};

/** The patterns every config maps to each source key, by lower-case key. */
const mappingsOf = (configs: readonly NugetConfigFile[]): Map<string, string[]> => {
  const byKey = new Map<string, string[]>();
  for (const { key, patterns } of configs.flatMap((config) => config.mappings)) {
    const current = byKey.get(key.toLowerCase()) ?? [];
    byKey.set(key.toLowerCase(), [...current, ...patterns.filter((pattern) => !current.some((entry) => entry.toLowerCase() === pattern.toLowerCase()))]);
  }
  return byKey;
};

/**
 * The source keys package source mapping sends an id to, lower case, by its most specific
 * pattern: the exact id, then the longest prefix `Name.*`, then `*`, which ranks 0. Null when no
 * pattern matches.
 */
const mappedKeysOf = (mappings: ReadonlyMap<string, readonly string[]>, id: string): { keys: string[]; rank: number } | null => {
  const lower = id.toLowerCase();
  const rankOf = (pattern: string): number => {
    const text = pattern.toLowerCase();
    if (text === lower) return Number.MAX_SAFE_INTEGER;
    return text.endsWith("*") && lower.startsWith(text.slice(0, -1)) ? text.length - 1 : -1;
  };
  let best: { keys: string[]; rank: number } | null = null;
  for (const [key, patterns] of mappings) {
    const rank = Math.max(...patterns.map(rankOf));
    if (rank < 0 || (best !== null && rank < best.rank)) continue;
    best = best === null || rank > best.rank ? { keys: [key], rank } : { keys: [...best.keys, key], rank };
  }
  return best;
};

/**
 * DI-21.227. True when the repository's package source mapping sends the id only to the mapped
 * feed or the mirror by a pattern more specific than `*`. Such an id is private whatever nuget.org
 * has, because the repository never lets nuget.org serve it. A `*` on the mapped feed makes it the
 * fallback for every id, such as a proxy of nuget.org, and pins nothing.
 */
export const pinnedToPrivateFeed = (configs: readonly NugetConfigFile[], feeds: readonly NugetFeed[], id: string): boolean => {
  const mapped = mappedKeysOf(mappingsOf(configs), id);
  const privateKeys = new Set(feeds.filter((feed) => feed.kind === "mapped" || feed.kind === "mirror").map((feed) => feed.key.toLowerCase()));
  return mapped !== null && mapped.rank > 0 && mapped.keys.every((key) => privateKeys.has(key));
};

const SKIPPED_FOLDERS = /(^|\/)(node_modules|vendor|bin|obj|\.git|third_party|testdata|fixtures)\//;

/** True when the path is a `NuGet.config` that a restore of the repository reads. */
export const isNugetConfigPath = (path: string): boolean => !SKIPPED_FOLDERS.test(path) && /(^|\/)nuget\.config$/i.test(path);

/** The paths read when the repository tree is too large to list. */
const ROOT_NUGET_CONFIGS = ["NuGet.config", "nuget.config", "NuGet.Config"];

/**
 * Reads every `NuGet.config` of the repository at a commit through the GitHub App. A source that
 * lists no files reads the root names. Null when the tree is too large to list, because a config
 * below the root may name the private feed. A failed listing or read throws: only a missing file
 * is no config.
 */
export const readNugetConfigFiles = async (
  source: DerivedHostFileSource,
  fullName: string,
  ref: string,
  githubInstallationId: string,
): Promise<NugetConfigFile[] | null> => {
  const listed = source.listFiles === undefined ? undefined : await source.listFiles(fullName, ref, githubInstallationId);
  if (listed === null) return null;
  const paths = listed === undefined ? ROOT_NUGET_CONFIGS : listed.map((entry) => entry.path).filter(isNugetConfigPath);
  const files = await Promise.all(
    paths.map(async (path) => {
      const text = await source.readFile(fullName, path, ref, githubInstallationId);
      return text === null ? null : parseNugetConfig(path, text);
    }),
  );
  return files.filter((file): file is NugetConfigFile => file !== null);
};

/**
 * DI-21.223. What one enabled source is to the pre-check:
 * - `public`: on the ecosystem host list or the product allow list, so a sandbox reaches it.
 * - `credential`: a product host credential covers it.
 * - `mapped`: the private feed of NUGET_FEED_MAPPING, which the mirror replaces.
 * - `mirror`: the GitHub Packages host of the mirror, which needs the credential check.
 * - `unsupported`: any other private feed. It fails the setup.
 * - `local`: a folder, kept as it is.
 */
export type NugetFeedKind = "public" | "credential" | "mapped" | "mirror" | "unsupported" | "local";

export interface NugetFeed extends NugetSource {
  kind: NugetFeedKind;
  /** The `NuGet.config` that names the source. */
  file: string;
}

export interface NugetFeedCoverage {
  /** The hosts and redirect hosts of the product's host credentials. */
  credentialHosts: readonly string[];
  /** The product allow list. */
  allowedDomains: readonly string[];
}

/** Every enabled source of the repository's configs, once per key and URL, classified. */
export const classifyNugetFeeds = (configs: readonly NugetConfigFile[], coverage: NugetFeedCoverage): NugetFeed[] => {
  const feeds: NugetFeed[] = [];
  const seen = new Set<string>();
  for (const config of configs) {
    const disabled = new Set(config.disabled.map((key) => key.toLowerCase()));
    for (const source of config.sources) {
      if (disabled.has(source.key.toLowerCase())) continue;
      const identity = `${source.key.toLowerCase()} ${source.url.toLowerCase()}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const host = source.host;
      const kind: NugetFeedKind =
        host === null
          ? "local"
          : host === NUGET_MIRROR_HOST
            ? "mirror"
            : host === NUGET_FEED_MAPPING.from
              ? "mapped"
              : allowListCovers(ECOSYSTEM_HOSTS, host) || allowListCovers(coverage.allowedDomains, host)
                ? "public"
                : coverage.credentialHosts.some((entry) => entry.toLowerCase() === host)
                  ? "credential"
                  : "unsupported";
      feeds.push({ ...source, kind, file: config.path });
    }
  }
  return feeds;
};

/** True when a feed needs the pre-check: the mapped feed, the mirror, or an unsupported feed. */
export const needsNugetPrecheck = (feeds: readonly NugetFeed[]): boolean =>
  feeds.some((feed) => feed.kind === "mapped" || feed.kind === "mirror" || feed.kind === "unsupported");

/** The failure of an unsupported private feed, or null when there is none. */
export const unsupportedFeedFailure = (feeds: readonly NugetFeed[]): string | null => {
  const hosts = [...new Set(feeds.filter((feed) => feed.kind === "unsupported").map((feed) => feed.host ?? feed.url))];
  if (hosts.length === 0) return null;
  return (
    `${hosts.map((host) => `unsupported private feed \`${host}\``).join(", ")}. ` +
    `Factoree maps only ${NUGET_FEED_MAPPING.from} to ${NUGET_FEED_MAPPING.to}, and no sandbox reaches another private feed. ` +
    "Move its packages to a feed a host credential covers, or add its host to the product allow list when it is public."
  );
};

/** The owner of a GitHub Packages source URL, `https://nuget.pkg.github.com/<owner>/index.json`. */
export const githubPackagesOwnerOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== NUGET_MIRROR_HOST) return null;
    const owner = parsed.pathname.split("/").filter((part) => part !== "")[0];
    return owner === undefined ? null : owner;
  } catch {
    return null;
  }
};

/** The first message of a missing mirror credential. Its text is fixed by the issue. */
export const MISSING_MIRROR_CREDENTIAL = `add a host credential for ${NUGET_MIRROR_HOST}`;

/**
 * docs/specs/nuget-private-feed-mapping.md. The check of the mirror's host credential, or null
 * when it passes. NuGet on GitHub Packages takes a `header` credential, `Authorization` with a
 * Basic value entered as is. A path prefix, when set, must cover `/<owner>/`, or the provider
 * leaves the header off the index and download requests of the mirror.
 */
export const mirrorCredentialFailure = (credentials: readonly HostCredential[], owner: string = NUGET_MIRROR_OWNER): string | null => {
  const credential = credentials.find((entry) => entry.host.toLowerCase() === NUGET_MIRROR_HOST);
  const shape = `a header credential with the header name Authorization and the value \`Basic <base64 of user:PAT>\` entered as is, the path prefix /${owner}/ or none`;
  if (credential === undefined) {
    return `The product holds no host credential for ${NUGET_MIRROR_HOST}: ${MISSING_MIRROR_CREDENTIAL}, ${shape}. The PAT needs read:packages and SSO access to ${owner}.`;
  }
  if (credential.kind !== "header") {
    return `The host credential for ${NUGET_MIRROR_HOST} is a ${credential.kind} credential, and NuGet on GitHub Packages needs ${shape}.`;
  }
  if ((credential.headerName ?? "").toLowerCase() !== "authorization") {
    return `The host credential for ${NUGET_MIRROR_HOST} sends the header ${credential.headerName ?? "(none)"}, and NuGet on GitHub Packages needs ${shape}.`;
  }
  // `/`, `/<owner>` and `/<owner>/` cover every request of the mirror. A longer prefix leaves some
  // out, and a part of the owner name also covers other owners. The provider matches the path as
  // written, and Factoree requests the owner as it names it.
  if (credential.pathPrefix !== null && !["/", `/${owner}`, `/${owner}/`].includes(credential.pathPrefix)) {
    return (
      `The host credential for ${NUGET_MIRROR_HOST} has the path prefix ${credential.pathPrefix}, and the mirror is ${NUGET_MIRROR_HOST}/${owner}, ` +
      `so the credential does not reach the index and the downloads of the mirror. Set the path prefix to /${owner}/ or leave it empty.`
    );
  }
  return null;
};

/**
 * DI-21.226. The result of one package on the mirror. `not_found` is a 404, which GitHub Packages
 * also answers for a package the token cannot read.
 */
export type MirrorStatus = "mirrored" | "not_found" | "version_missing" | "unauthorized" | "unreachable" | "redirect_blocked";

/** The status of one curl answer from the mirror. */
export const mirrorStatusOf = (answer: { exitCode: number; timedOut: boolean; httpCode: number }): MirrorStatus => {
  if (answer.timedOut || answer.exitCode !== 0 || answer.httpCode === 0) return "unreachable";
  if (answer.httpCode === 404) return "not_found";
  if (answer.httpCode === 401 || answer.httpCode === 403) return "unauthorized";
  if (answer.httpCode >= 200 && answer.httpCode < 400) return "mirrored";
  return "unreachable";
};

/** The text of a mirror status, with the fix the operator makes. */
export const mirrorStatusText = (status: MirrorStatus, detail: string | null = null, owner: string = NUGET_MIRROR_OWNER): string => {
  const credential = `the host credential for ${NUGET_MIRROR_HOST}`;
  switch (status) {
    case "mirrored":
      return "on the mirror, and its download reads";
    case "not_found":
      return (
        `not on the mirror, or the token cannot read it. Mirror the package to ${githubPackagesPageOf(owner)}, ` +
        `or check the PAT scope (read:packages), the SSO authorization and the package access of ${credential}`
      );
    case "version_missing":
      return `the mirror has the package and not this version. Mirror this version to ${githubPackagesPageOf(owner)}`;
    case "unauthorized":
      return `the credential cannot read it: check the PAT, the SSO authorization and the package access of ${credential}`;
    case "unreachable":
      return `feed unreachable: the request to ${NUGET_MIRROR_HOST} was blocked or timed out${detail === null ? "" : ` (${detail})`}`;
    case "redirect_blocked":
      return `the download redirects to ${detail ?? "a host"}, which no egress list holds. Add it as a redirect host of ${credential}`;
  }
};

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** XML forbids `--` in a comment, and .NET refuses a config that has it. */
const xmlCommentText = (text: string): string => text.replace(/-(?=-)/g, "- ");

/**
 * A local folder source as `.factoree/nuget.config` reads it. NuGet resolves a relative folder
 * from the config that names it, so the path is rebased from that config's folder. An absolute
 * path, a drive, a share, an environment variable or a URI stays as written.
 */
const rebasedLocalSource = (url: string, configPath: string): string => {
  const text = url.trim();
  if (/^([/\\~%$]|[A-Za-z]:|[A-Za-z][\w+.-]*:\/\/)/.test(text)) return url;
  const configFolder = posix.dirname(configPath);
  const target = posix.normalize(posix.join(configFolder, text.replace(/\\/g, "/")));
  return posix.relative(posix.dirname(FACTOREE_NUGET_CONFIG), target) || ".";
};

/**
 * DI-21.227. The `.factoree/nuget.config` Factoree writes. It copies the sources of the
 * repository's configs in order, leaves out a disabled source, and replaces only the mapped
 * private feed: with the mirror when a package needs it, and with nothing when none does,
 * because a source no sandbox reaches fails every restore. It keeps `<clear />` only when the
 * repository had it. `restore --configfile` reads no other file, so it adds nuget.org when no
 * kept source is nuget.org: every package Factoree found public came from there. A local folder
 * source moves to the generated file's folder, so a relative path is rebased.
 * `packageSourceMapping` sends each mirrored id to the mirror and `*` to every other source, so
 * no other source can serve a private id. When the repository maps its sources itself, its
 * patterns stay, but for an exact pattern of a mirrored id on another source, since two equal
 * exact patterns leave both sources eligible. Those of the mapped feed move to the mirror, except
 * `*`: a `*` made the mapped feed the fallback for every id, as a proxy of nuget.org does, and the
 * mirror serves only mirrored packages, so the fallback moves to nuget.org. An added nuget.org
 * then gets `*` only when it takes that fallback, so it widens no restriction of the repository.
 */
export const renderNugetConfig = (configs: readonly NugetConfigFile[], feeds: readonly NugetFeed[], mirroredIds: readonly string[]): string => {
  const ids = [...new Set(mirroredIds.map((id) => id.trim()).filter((id) => id !== ""))].sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
  const mirroredKeys = new Set(ids.map((id) => id.toLowerCase()));
  const clear = configs[0]?.clear ?? false;
  const existingMirror = feeds.find((feed) => feed.kind === "mirror" && githubPackagesOwnerOf(feed.url)?.toLowerCase() === NUGET_MIRROR_OWNER.toLowerCase());
  const mapped = feeds.find((feed) => feed.kind === "mapped");
  const mirrorKey = existingMirror?.key ?? mapped?.key ?? "github-packages";
  const repositoryMappings = mappingsOf(configs);
  const patternsOf = (key: string): string[] => repositoryMappings.get(key.toLowerCase()) ?? [];
  const mappedPatterns = mapped === undefined ? [] : patternsOf(mapped.key);
  const mirrorPatterns = mappedPatterns.filter((pattern) => pattern !== "*");
  const fallback = repositoryMappings.size === 0 || mappedPatterns.includes("*") ? ["*"] : [];
  const sources: Array<{ key: string; url: string; protocolVersion: string | null; patterns: string[]; mirror: boolean }> = [];
  for (const feed of feeds) {
    if (feed.kind === "unsupported") continue;
    if (feed.kind === "mapped") {
      if (ids.length > 0 && existingMirror === undefined) sources.push({ key: feed.key, url: githubPackagesIndexOf(NUGET_MIRROR_OWNER), protocolVersion: "3", patterns: mirrorPatterns, mirror: true });
      continue;
    }
    if (feed.kind === "mirror" && feed === existingMirror) {
      sources.push({ key: feed.key, url: feed.url, protocolVersion: feed.protocolVersion, patterns: [...patternsOf(feed.key), ...mirrorPatterns], mirror: ids.length > 0 });
      continue;
    }
    const url = feed.kind === "local" ? rebasedLocalSource(feed.url, feed.file) : feed.url;
    const patterns = patternsOf(feed.key).filter((pattern) => !mirroredKeys.has(pattern.toLowerCase()));
    sources.push({ key: feed.key, url, protocolVersion: feed.protocolVersion, patterns: [...patterns, ...(hostOf(url) === NUGET_ORG_HOST ? fallback : [])], mirror: false });
  }
  if (ids.length > 0 && !sources.some((source) => source.mirror)) {
    sources.push({ key: mirrorKey, url: githubPackagesIndexOf(NUGET_MIRROR_OWNER), protocolVersion: "3", patterns: mirrorPatterns, mirror: true });
  }
  if (!sources.some((source) => hostOf(source.url) === NUGET_ORG_HOST)) {
    const key = sources.some((source) => source.key.toLowerCase() === "nuget.org") ? "nuget.org (Factoree)" : "nuget.org";
    sources.push({ key, url: NUGET_ORG_INDEX, protocolVersion: "3", patterns: fallback, mirror: false });
  }
  const add = (source: (typeof sources)[number]): string =>
    `    <add key="${escapeXml(source.key)}" value="${escapeXml(source.url)}"${source.protocolVersion === null ? "" : ` protocolVersion="${escapeXml(source.protocolVersion)}"`} />`;
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<!-- Written by Factoree from ${xmlCommentText(configs.map((config) => config.path).join(", ") || "no NuGet.config")}. docs/specs/nuget-private-feed-mapping.md -->`,
    `<!-- ${NUGET_FEED_MAPPING.from} maps to ${NUGET_FEED_MAPPING.to}. Every restore passes this file as its configfile. -->`,
    "<configuration>",
    "  <packageSources>",
    ...(clear ? ["    <clear />"] : []),
    ...sources.map(add),
    "  </packageSources>",
  ];
  const mapping = sources
    .map((source) => {
      const patterns = source.mirror ? [...ids, ...source.patterns] : repositoryMappings.size > 0 ? source.patterns : ["*"];
      return { key: source.key, patterns: patterns.filter((pattern, index) => patterns.findIndex((entry) => entry.toLowerCase() === pattern.toLowerCase()) === index) };
    })
    .filter((entry) => entry.patterns.length > 0);
  if (ids.length > 0 || repositoryMappings.size > 0) {
    lines.push("  <packageSourceMapping>");
    for (const entry of mapping) {
      lines.push(`    <packageSource key="${escapeXml(entry.key)}">`);
      lines.push(...entry.patterns.map((pattern) => `      <package pattern="${escapeXml(pattern)}" />`));
      lines.push("    </packageSource>");
    }
    lines.push("  </packageSourceMapping>");
  }
  lines.push("</configuration>", "");
  return lines.join("\n");
};

/** One package a restore could not find. */
export interface RestoreFailure {
  id: string;
  code: "NU1101" | "NU1102";
  /** The lowest version the restore asked for, normalised by the caller, or null for NU1101. */
  version: string | null;
  /** True when the restore asked for exactly that version, `(= x)`, and not for it or higher. */
  exact: boolean;
  /** The upper bound of the range, `&& < x` or `&& <= x`, when it has one. */
  maximum?: { version: string; inclusive: boolean };
  /** The whole request: the lower id, then each bound with its operator and normalised version. Two failures with the same request are one. */
  request: string;
  /** The project file the line names, or null. */
  project: string | null;
}

const RESTORE_FAILURE = /^\s*(?:(.+?)\s*:\s*)?error (NU1101|NU1102):\s*Unable to find package '?([A-Za-z0-9_.-]+)'?(?:\s+with version \(([^)]*)\))?/gim;

/**
 * DI-21.228. The packages a `dotnet restore` output names as not found, once per id and whole
 * range, so a narrower range of the same id and lower bound is looked up on its own. Factoree
 * looks each one up on the mirror itself: the restore text alone proves nothing.
 */
export const restoreFailuresOf = (output: string): RestoreFailure[] => {
  const byRequest = new Map<string, RestoreFailure>();
  for (const match of output.matchAll(RESTORE_FAILURE)) {
    // The sentence ends with a period right after the id.
    const id = match[3]!.replace(/\.+$/, "");
    // Only `>= x` or `= x` names a lowest version. `< x`, `<= x` and `> x` name none to check.
    const lower = /^\s*(>=|>|=)?\s*(\d[^\s,)\]&]*)/.exec(match[4] ?? "");
    const bound = lower?.[1] === ">" ? null : lower;
    const version = bound?.[2] ?? null;
    const upper = /(?:^|&&)\s*(<=|<)\s*(\d[^\s,)\]&]*)/.exec(match[4] ?? "");
    const maximum = upper === null ? {} : { maximum: { version: upper[2]!, inclusive: upper[1] === "<=" } };
    const project = match[1] === undefined ? null : match[1].trim().replace(/\s*\[.*$/, "");
    const boundText = (operator: string, text: string): string => `${operator}${normalizeNugetVersion(text) ?? text}`;
    const request = [id.toLowerCase(), ...(lower === null ? [] : [boundText(lower[1] ?? ">=", lower[2]!)]), ...(upper === null ? [] : [boundText(upper[1]!, upper[2]!)])].join(" ");
    if (!byRequest.has(request)) {
      byRequest.set(request, { id, code: match[2]!.toUpperCase() as RestoreFailure["code"], version, exact: bound?.[1] === "=", ...maximum, request, project: project === "" ? null : project });
    }
  }
  return [...byRequest.values()];
};

const SERVICE_INDEX_FAILURE = /error NU1301:[^\n]*?(https?:\/\/[^\s'"]+)/gi;

/** The sources whose service index a `dotnet restore` output says it could not load (NU1301). */
export const unloadedSourcesOf = (output: string): string[] => [
  ...new Set([...output.matchAll(SERVICE_INDEX_FAILURE)].map((match) => match[1]!.replace(/[.,;]+$/, ""))),
];
/**
 * The parents of a package that a restore could not find, from `obj/project.assets.json`: the
 * direct reference first, then each package down to the one that depends on it, as `id version`.
 * Null when the assets file names no parent.
 */
export const parentChainOf = (assetsText: string, id: string): string[] | null => {
  let assets: { targets?: Record<string, Record<string, { dependencies?: Record<string, string> }>>; project?: { frameworks?: Record<string, { dependencies?: Record<string, unknown> }> } };
  try {
    assets = JSON.parse(assetsText) as typeof assets;
  } catch {
    return null;
  }
  const direct = new Set(Object.values(assets.project?.frameworks ?? {}).flatMap((framework) => Object.keys(framework.dependencies ?? {}).map((name) => name.toLowerCase())));
  const parentsOf = (child: string): string[] => {
    const found: string[] = [];
    for (const target of Object.values(assets.targets ?? {})) {
      for (const [library, entry] of Object.entries(target)) {
        if (Object.keys(entry.dependencies ?? {}).some((name) => name.toLowerCase() === child.toLowerCase()) && !found.includes(library)) found.push(library);
      }
    }
    return found;
  };
  const visited = new Set<string>([id.toLowerCase()]);
  const walk = (child: string, chain: string[]): string[] | null => {
    for (const library of parentsOf(child)) {
      const name = library.split("/")[0] ?? library;
      if (visited.has(name.toLowerCase())) continue;
      visited.add(name.toLowerCase());
      const next = [library.replace("/", " "), ...chain];
      if (direct.has(name.toLowerCase())) return next;
      const found = walk(name, next);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(id, []);
};

/**
 * A version a restore asks for: the exact one, or the lowest one it accepts, which the restore
 * takes when no lower version exists.
 */
export interface RequestedVersion {
  version: string;
  exact: boolean;
  /** The upper bound of a range, when it has one. */
  maximum?: { version: string; inclusive: boolean };
}

/**
 * The inclusive lower bound of a NuGet dependency version, normalised, with its upper bound, or
 * null when it has no lower bound: `1.0` and `[1.0, )` accept 1.0 and up, `[1.0, 2.0)` stops
 * below 2.0, `[1.0]` is exactly 1.0, and `(1.0, )` and `(, 2.0]` name no version.
 */
const lowerBoundOf = (range: string): RequestedVersion | null => {
  const text = range.trim();
  if (text.startsWith("(")) return null;
  if (!text.startsWith("[")) {
    const version = normalizeNugetVersion(text);
    return version === null ? null : { version, exact: false };
  }
  const [lower = "", upper] = text.slice(1).split(",");
  const version = normalizeNugetVersion(lower.replace(/\]$/, "").trim());
  if (version === null) return null;
  if (upper === undefined) return { version, exact: true };
  const close = upper.trim();
  const maximum = normalizeNugetVersion(close.slice(0, -1).trim());
  return maximum === null ? { version, exact: false } : { version, exact: false, maximum: { version: maximum, inclusive: close.endsWith("]") } };
};

/**
 * DI-21.232. The lowest version the parents of a package ask for in `obj/project.assets.json`,
 * normalised, or null. NU1101 names no version. A range with no inclusive lower bound names none.
 */
export const requestedVersionOf = (assetsText: string, id: string): RequestedVersion | null => {
  let assets: { targets?: Record<string, Record<string, { dependencies?: Record<string, string> }>> };
  try {
    assets = JSON.parse(assetsText) as typeof assets;
  } catch {
    return null;
  }
  const versions = Object.values(assets.targets ?? {})
    .flatMap((target) => Object.values(target))
    .flatMap((entry) => Object.entries(entry.dependencies ?? {}))
    .filter(([name]) => name.toLowerCase() === id.toLowerCase())
    .map(([, range]) => lowerBoundOf(range))
    .filter((requested): requested is RequestedVersion => requested !== null);
  return versions.reduce<RequestedVersion | null>((lowest, requested) => (lowest === null || (compareNugetVersions(requested.version, lowest.version) ?? 0) < 0 ? requested : lowest), null);
};
