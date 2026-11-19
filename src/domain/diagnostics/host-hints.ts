import { allowListCovers } from "~/domain/runs/sandbox.js";
import { normalizeHost } from "~/domain/runs/egress.js";

/** The most host hints one event lists. */
export const MAX_HOST_HINTS = 20;

/** A host in a URL: `https://registry.example.com/x`. */
const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/'"`<>()[\]{},;]+)/gi;

/** A bare name with at least two dots and an alphabetic last label: `cdn.functions.azure.com`. */
const BARE_HOST = /(?<![\w.@/-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,24})(?![\w-]|\.[a-z0-9])/gi;

/**
 * Last labels that name a file, not a host. A source tree prints `src.app.module.ts` and
 * `tests.unit.config.json` far more often than a host, so these are never hints.
 */
const FILE_SUFFIXES = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "md", "py", "cs", "go", "rs", "rb", "php", "java", "kt",
  "yml", "yaml", "toml", "xml", "txt", "log", "lock", "html", "css", "scss", "sh", "dll", "exe", "so",
  "zip", "gz", "tar", "tgz", "csproj", "sln", "props", "targets", "ini", "cfg", "conf", "env", "sql",
  "png", "jpg", "svg", "map", "wasm", "pdb", "nupkg", "whl", "jar", "class", "swift", "dart", "ex", "exs",
]);

const isHostLike = (host: string): boolean => {
  if (host.length === 0 || host.length > 253 || !host.includes(".")) return false;
  if (/^[\d.]+$/.test(host)) return false;
  const last = host.slice(host.lastIndexOf(".") + 1);
  return /^[a-z]{2,24}$/.test(last) && !FILE_SUFFIXES.has(last);
};

/**
 * docs/specs/run-diagnostics.md. Each host name in a failed output tail that the effective allow
 * list does not hold. It reads host names only, never an error format, so it works for any stack.
 * The result is a hint: the output can name a host that had nothing to do with the failure.
 */
export const hostHintsOf = (text: string | null, allowList: readonly string[]): string[] => {
  if (text === null || text.length === 0) return [];
  const found = new Set<string>();
  const consider = (raw: string): void => {
    const host = normalizeHost(raw);
    if (!isHostLike(host) || allowListCovers(allowList, host)) return;
    found.add(host);
  };
  for (const match of text.matchAll(URL_HOST)) consider(match[0]);
  for (const match of text.matchAll(BARE_HOST)) consider(match[1] ?? "");
  return [...found].sort().slice(0, MAX_HOST_HINTS);
};
