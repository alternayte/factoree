import { credentialHostsOf, type HostCredential } from "~/domain/products/host-credentials.js";
import { allowListCovers } from "~/domain/runs/sandbox.js";
import { ECOSYSTEM_HOSTS } from "./ecosystem-hosts.js";
import { NUGET_FEED_MAPPING } from "./nuget-feeds.js";

/**
 * docs/specs/private-stack-onboarding.md. A derived host: a host that the committed files of a
 * repository name for its packages or its git dependencies. Factoree reads it before the setup
 * agent starts, so a private registry needs no failed setup run to show.
 */
export interface DerivedHost {
  host: string;
  /** The first committed file that names the host. */
  source: string;
  /** `registry` for a package feed, `git` for a git dependency. */
  kind: "registry" | "git";
  /** For a git dependency on github.com: the `owner/name` it clones. */
  repository?: string;
}

/** One committed file, by its path in the repository. */
export interface RepositoryTextFile {
  path: string;
  text: string;
}

/** The base names of the files that can name a derived host. */
const FILE_NAMES = new Set([
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "nuget.config",
  "pip.conf",
  "pip.ini",
  "pyproject.toml",
  "poetry.lock",
  "pipfile",
  "pipfile.lock",
  "requirements.txt",
  "settings.xml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "cargo.toml",
  "config.toml",
  "dockerfile",
  "devcontainer.json",
]);

/** Folders that hold copies of other code, never the repository's own registry config. */
const SKIPPED_FOLDERS = /(^|\/)(node_modules|vendor|\.venv|venv|dist|build|target|bin|obj|\.git|third_party|testdata|fixtures)\//;

/** The longest list of files Factoree reads for one repository, so a large monorepo stays cheap. */
export const DERIVED_HOST_FILE_LIMIT = 40;

/** The paths Factoree reads when the repository tree is too large to list. */
export const DERIVED_HOST_ROOT_FILES = [
  ".npmrc",
  ".yarnrc.yml",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "NuGet.config",
  "nuget.config",
  "pip.conf",
  "pyproject.toml",
  "poetry.lock",
  "Pipfile.lock",
  "requirements.txt",
  "pom.xml",
  ".mvn/settings.xml",
  "settings.gradle",
  "settings.gradle.kts",
  "build.gradle",
  "build.gradle.kts",
  "Cargo.toml",
  ".cargo/config.toml",
  "Dockerfile",
  ".devcontainer/devcontainer.json",
];

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1).toLowerCase();

const isWorkflow = (path: string): boolean => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path);

const isRequirements = (name: string): boolean => /^requirements[\w.-]*\.(txt|in)$/.test(name);

/** True when Factoree reads the file for derived hosts. A `config.toml` counts only under `.cargo/`. */
export const isDerivedHostFile = (path: string): boolean => {
  if (isWorkflow(path)) return true;
  if (SKIPPED_FOLDERS.test(path)) return false;
  const name = baseName(path);
  if (name === "config.toml") return /(^|\/)\.cargo\/config\.toml$/i.test(path);
  if (name === "settings.xml") return /(^|\/)\.mvn\/settings\.xml$|^settings\.xml$/i.test(path);
  return FILE_NAMES.has(name) || isRequirements(name);
};

/**
 * The files to read, from the full list of the repository: the workflows first, then the shallowest
 * paths, at most DERIVED_HOST_FILE_LIMIT of them.
 */
export const derivedHostFilesOf = (paths: readonly string[]): string[] =>
  paths
    .filter(isDerivedHostFile)
    .sort((left, right) => {
      const workflow = Number(isWorkflow(right)) - Number(isWorkflow(left));
      if (workflow !== 0) return workflow;
      const depth = left.split("/").length - right.split("/").length;
      return depth !== 0 ? depth : left.localeCompare(right);
    })
    .slice(0, DERIVED_HOST_FILE_LIMIT);

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The host of a URL, lower case, or null when the text is no http(s) URL with a dotted host. */
const hostOfUrl = (raw: string): string | null => {
  const text = raw.trim().replace(/^sparse\+/, "").replace(/^git\+/, "");
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ssh:" && url.protocol !== "git:") return null;
    const host = url.hostname.toLowerCase();
    return HOST.test(host) ? host : null;
  } catch {
    return null;
  }
};

/** A host written as `//host/path` in `.npmrc` and `.yarnrc.yml`. */
const hostOfProtocolRelative = (raw: string): string | null => (raw.startsWith("//") ? hostOfUrl(`https:${raw}`) : null);

/** `owner/name` of a github.com URL path, or null. */
const githubRepositoryOf = (url: string): string | null => {
  const text = url.trim().replace(/^git\+/, "");
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:#.*)?$/i.exec(text);
  if (scp !== null) return `${scp[1]!}/${scp[2]!}`;
  try {
    const parsed = new URL(text);
    const host = parsed.hostname.toLowerCase();
    if (host !== "github.com" && host !== "codeload.github.com") return null;
    const parts = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
    return parts.length >= 2 && parts[0] !== "" && parts[1] !== "" ? `${parts[0]!}/${parts[1]!}` : null;
  } catch {
    return null;
  }
};

/** A git dependency spec of a package manifest: `git+…`, `git://…`, `github:owner/name`, or `git@github.com:…`. */
const gitDependencyOf = (spec: string): { host: string; repository?: string } | null => {
  const value = spec.trim();
  const shorthand = /^github:([^/\s]+)\/([^/\s#]+)/.exec(value);
  if (shorthand !== null) return { host: "github.com", repository: `${shorthand[1]!}/${shorthand[2]!.replace(/\.git$/, "")}` };
  const scp = /^(?:git\+)?(?:ssh:\/\/)?git@([^:/\s]+)[:/]/.exec(value);
  if (scp !== null) {
    const host = scp[1]!.toLowerCase();
    const repository = host === "github.com" ? githubRepositoryOf(value.replace(/^git\+ssh:\/\//, "").replace("github.com/", "github.com:")) : null;
    return { host, ...(repository === null ? {} : { repository }) };
  }
  if (!/^(git\+|git:\/\/)/.test(value) && !/\.git(#.*)?$/.test(value)) return null;
  const host = hostOfUrl(value);
  if (host === null) return null;
  const repository = githubRepositoryOf(value);
  return { host, ...(repository === null ? {} : { repository }) };
};

type Found = Omit<DerivedHost, "source">;

const registry = (host: string | null): Found[] => (host === null ? [] : [{ host, kind: "registry" }]);

const git = (dependency: { host: string; repository?: string } | null): Found[] => (dependency === null ? [] : [{ kind: "git", ...dependency }]);

/** A lockfile URL: `codeload.github.com` and `github.com` archives are git dependencies, the rest are feeds. */
const fromLockUrl = (url: string): Found[] => {
  const host = hostOfUrl(url);
  if (host === null) return [];
  if (host === "codeload.github.com" || host === "github.com") {
    const repository = githubRepositoryOf(url);
    return [{ host: "github.com", kind: "git", ...(repository === null ? {} : { repository }) }];
  }
  return /^git\+|^git:\/\/|^ssh:\/\//.test(url) ? git(gitDependencyOf(url)) : registry(host);
};

const fromNpmrc = (text: string): Found[] => {
  const found: Found[] = [];
  for (const line of text.split("\n")) {
    const entry = line.trim();
    if (entry.startsWith("#") || entry.startsWith(";")) continue;
    const value = /^(?:@[^:=\s]+:)?registry\s*=\s*(\S+)/.exec(entry);
    if (value !== null) found.push(...registry(hostOfUrl(value[1]!)));
    const auth = /^(\/\/[^:\s]+):/.exec(entry);
    if (auth !== null) found.push(...registry(hostOfProtocolRelative(auth[1]!)));
  }
  return found;
};

const fromYarnrc = (text: string): Found[] => {
  const found: Found[] = [];
  for (const match of text.matchAll(/(?:npmRegistryServer|registry)\s*[:\s]\s*["']?([^"'\s]+)/g)) found.push(...registry(hostOfUrl(match[1]!)));
  for (const match of text.matchAll(/^\s*["']?(\/\/[^"':\s]+)["']?\s*:/gm)) found.push(...registry(hostOfProtocolRelative(match[1]!)));
  return found;
};

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

const fromPackageJson = (text: string): Found[] => {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof manifest !== "object" || manifest === null) return [];
  const found: Found[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = (manifest as Record<string, unknown>)[field];
    if (typeof dependencies !== "object" || dependencies === null) continue;
    for (const spec of Object.values(dependencies as Record<string, unknown>)) {
      if (typeof spec === "string") found.push(...git(gitDependencyOf(spec)));
    }
  }
  // `publishConfig.registry` is where a release goes, not where an install reads, so it stays out.
  return found;
};

/** `resolved`, `tarball` and `resolution` values of a lockfile. */
const fromLockfile = (text: string): Found[] => {
  const found: Found[] = [];
  for (const match of text.matchAll(/(?:"resolved"\s*:\s*"|resolved\s+"|tarball:\s*|resolution:\s*"?[^@\s"]*@)((?:git\+|sparse\+)?(?:https?|ssh|git):\/\/[^\s"',}]+)/g)) {
    found.push(...fromLockUrl(match[1]!));
  }
  return found;
};

const fromNugetConfig = (text: string): Found[] => {
  const sources = /<packageSources>([\s\S]*?)<\/packageSources>/i.exec(text)?.[1] ?? "";
  return [...sources.matchAll(/<add\b[^>]*\bvalue\s*=\s*"([^"]+)"/gi)].flatMap((match) => registry(hostOfUrl(match[1]!)));
};

const fromPipConfig = (text: string): Found[] =>
  [...text.matchAll(/^\s*(?:index-url|extra-index-url|find-links)\s*[=:]\s*(\S+)/gim)].flatMap((match) => registry(hostOfUrl(match[1]!)));

const fromRequirements = (text: string): Found[] => {
  const found: Found[] = [];
  for (const line of text.split("\n")) {
    const entry = line.trim();
    const option = /^(?:-i|--index-url|--extra-index-url|-f|--find-links)[=\s]+(\S+)/.exec(entry);
    if (option !== null) found.push(...registry(hostOfUrl(option[1]!)));
    const vcs = /(?:^|@\s*)(git\+\S+)/.exec(entry);
    if (vcs !== null) found.push(...git(gitDependencyOf(vcs[1]!.replace(/@[^@/]*$/, ""))));
  }
  return found;
};

/** TOML: each `url`, `index` or `registry` value inside a table whose name names a source or an index. */
const fromToml = (text: string): Found[] => {
  const found: Found[] = [];
  let table = "";
  for (const line of text.split("\n")) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?/.exec(line);
    if (header !== null) {
      table = header[1]!.toLowerCase();
      continue;
    }
    const value = /^\s*(url|index|registry)\s*=\s*["']([^"']+)["']/.exec(line);
    if (value !== null && /source|index|registr|repositor/.test(table)) found.push(...registry(hostOfUrl(value[2]!)));
    const gitValue = /\bgit\s*=\s*["']([^"']+)["']/.exec(line);
    if (gitValue !== null) {
      const host = hostOfUrl(gitValue[1]!);
      if (host !== null) {
        const repository = githubRepositoryOf(gitValue[1]!);
        found.push({ host, kind: "git", ...(repository === null ? {} : { repository }) });
      }
    }
  }
  return found;
};

/** Pipfile.lock: `_meta.sources[].url`. */
const fromPipfileLock = (text: string): Found[] => {
  try {
    const sources = (JSON.parse(text) as { _meta?: { sources?: Array<{ url?: unknown }> } })._meta?.sources ?? [];
    return sources.flatMap((source) => (typeof source.url === "string" ? registry(hostOfUrl(source.url)) : []));
  } catch {
    return [];
  }
};

/** Maven: the `<url>` of each repository and mirror, outside `<distributionManagement>`, which publishes. */
const fromMaven = (text: string): Found[] => {
  const reads = text.replace(/<distributionManagement>[\s\S]*?<\/distributionManagement>/gi, "");
  const found: Found[] = [];
  for (const block of reads.matchAll(/<(repository|pluginRepository|mirror)>([\s\S]*?)<\/\1>/gi)) {
    const url = /<url>\s*([^<\s]+)\s*<\/url>/i.exec(block[2]!)?.[1];
    if (url !== undefined) found.push(...registry(hostOfUrl(url)));
  }
  return found;
};

/** Gradle: the URL of each `maven { … }` or `maven(…)` repository. */
const fromGradle = (text: string): Found[] =>
  [...text.matchAll(/maven\s*[({][^})]*?["']((?:https?):\/\/[^"']+)["']/g)].flatMap((match) => registry(hostOfUrl(match[1]!)));

/**
 * CI workflows, Dockerfiles and devcontainer files: the registry settings they pass to the package
 * managers, such as `registry-url`, `source-url`, `NUGET_SOURCE`, `PIP_INDEX_URL` or `GOPROXY`.
 */
const SETTING = /(?<![\w-])(registry-url|source-url|nuget[_-]source|npm_config_registry|pip_index_url|pip_extra_index_url|uv_index_url|uv_extra_index_url|poetry_repositories_[a-z0-9_]+_url|goproxy|--source|--index-url|--extra-index-url|--registry)(?![\w-])["']?\s*[:=\s]\s*["']?([^\s"'#]+)/gi;

const fromBuildSettings = (text: string): Found[] => {
  const found: Found[] = [];
  for (const match of text.matchAll(SETTING)) {
    for (const part of match[2]!.split(",")) found.push(...registry(hostOfUrl(part)));
  }
  // GOPRIVATE names module path patterns. An exact host is a git dependency host.
  for (const match of text.matchAll(/\bgo(?:private|noproxy)\b["']?\s*[:=\s]\s*["']?([^\s"'#]+)/gi)) {
    for (const part of match[1]!.split(",")) {
      const host = part.trim().toLowerCase().split("/")[0] ?? "";
      if (HOST.test(host)) found.push({ host, kind: "git" });
    }
  }
  return found;
};

const parserOf = (path: string): ((text: string) => Found[]) | null => {
  if (isWorkflow(path)) return fromBuildSettings;
  const name = baseName(path);
  if (name === ".npmrc") return fromNpmrc;
  if (name === ".yarnrc" || name === ".yarnrc.yml") return fromYarnrc;
  if (name === "package.json") return fromPackageJson;
  if (name === "package-lock.json" || name === "npm-shrinkwrap.json" || name === "yarn.lock" || name === "pnpm-lock.yaml") return fromLockfile;
  if (name === "nuget.config") return fromNugetConfig;
  if (name === "pip.conf" || name === "pip.ini") return fromPipConfig;
  if (isRequirements(name)) return fromRequirements;
  if (name === "pyproject.toml" || name === "poetry.lock" || name === "pipfile" || name === "cargo.toml" || name === "config.toml") return fromToml;
  if (name === "pipfile.lock") return fromPipfileLock;
  if (name === "pom.xml" || name === "settings.xml") return fromMaven;
  if (name.startsWith("build.gradle") || name.startsWith("settings.gradle")) return fromGradle;
  if (name === "dockerfile" || name === "devcontainer.json") return fromBuildSettings;
  return null;
};

/**
 * The derived hosts of a repository, one entry per host, from the first file that names it. A git
 * dependency host keeps every `owner/name` it clones, as separate entries.
 */
export const deriveHosts = (files: readonly RepositoryTextFile[]): DerivedHost[] => {
  const byKey = new Map<string, DerivedHost>();
  for (const file of files) {
    const parse = parserOf(file.path);
    if (parse === null) continue;
    for (const found of parse(file.text)) {
      const key = `${found.kind}:${found.host}:${found.repository ?? ""}`;
      if (!byKey.has(key)) byKey.set(key, { ...found, source: file.path });
    }
  }
  return [...byKey.values()].sort((left, right) => left.host.localeCompare(right.host) || (left.repository ?? "").localeCompare(right.repository ?? ""));
};

/** What already lets a sandbox reach a derived host. */
export interface DerivedHostCoverage {
  /** The product allow list. */
  allowedDomains: readonly string[];
  /** The hosts and redirect hosts of the product's host credentials. */
  credentialHosts: readonly string[];
  /** The `owner/name` repositories that the product's `github` host credential and its registered repositories cover. */
  githubRepositories: readonly string[];
}

/** The coverage of one product: its allow list, its host credentials, and its registered repositories. */
export const derivedHostCoverageOf = (
  allowedDomains: readonly string[],
  credentials: readonly HostCredential[],
  registeredRepositories: readonly string[],
): DerivedHostCoverage => ({
  allowedDomains,
  credentialHosts: credentialHostsOf(credentials).filter((host) => host !== "github.com"),
  githubRepositories: [...new Set([...credentials.flatMap((credential) => (credential.kind === "github" ? credential.repositories : [])), ...registeredRepositories])],
});

/**
 * The derived hosts that need the operator: neither the ecosystem host list, the product allow
 * list, a host credential nor the `github` credential covers them.
 */
export const uncoveredDerivedHosts = (derived: readonly DerivedHost[], coverage: DerivedHostCoverage): DerivedHost[] => {
  const repositories = new Set(coverage.githubRepositories.map((name) => name.toLowerCase()));
  return derived.filter((entry) => {
    if (entry.kind === "git" && entry.host === "github.com") {
      return entry.repository !== undefined && !repositories.has(entry.repository.toLowerCase());
    }
    if (entry.host === "github.com") return false;
    // docs/specs/nuget-private-feed-mapping.md. The setup maps this feed to its mirror, and no sandbox reaches it.
    if (entry.host === NUGET_FEED_MAPPING.from) return false;
    if (ECOSYSTEM_HOSTS.includes(entry.host)) return false;
    if (coverage.credentialHosts.some((host) => host.toLowerCase() === entry.host)) return false;
    return !allowListCovers(coverage.allowedDomains, entry.host);
  });
};

/** The reader of the committed files at one commit, through the GitHub App. */
export interface DerivedHostFileSource {
  readFile(fullName: string, path: string, ref: string, githubInstallationId: string): Promise<string | null>;
  /** Every file path at the ref, or null when the tree is too large for one listing. */
  listFiles?(fullName: string, ref: string, githubInstallationId: string): Promise<Array<{ path: string }> | null>;
}

/** Reads the derived hosts of a repository at a commit. A file that does not read is skipped. */
export const readDerivedHosts = async (
  source: DerivedHostFileSource,
  fullName: string,
  ref: string,
  githubInstallationId: string,
): Promise<DerivedHost[]> => {
  const listed = source.listFiles === undefined ? null : await source.listFiles(fullName, ref, githubInstallationId).catch(() => null);
  const paths = listed === null ? DERIVED_HOST_ROOT_FILES : derivedHostFilesOf(listed.map((entry) => entry.path));
  const files = await Promise.all(
    paths.map(async (path) => {
      const text = await source.readFile(fullName, path, ref, githubInstallationId).catch(() => null);
      return text === null ? null : { path, text };
    }),
  );
  return deriveHosts(files.filter((file): file is RepositoryTextFile => file !== null));
};
