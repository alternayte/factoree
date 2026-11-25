import { posix } from "node:path";
import type { HostCredential } from "~/domain/products/host-credentials.js";
import { allowListCovers, type Sandbox, type SandboxRef } from "~/domain/runs/sandbox.js";
import type { RepositoryTextFile } from "./derived-hosts.js";
import {
  classifyNugetFeeds,
  FACTOREE_NUGET_CONFIG,
  githubPackagesOwnerOf,
  githubPackagesPageOf,
  isNugetConfigPath,
  mirrorCredentialFailure,
  mirrorStatusOf,
  mirrorStatusText,
  NUGET_FEED_MAPPING,
  NUGET_MIRROR_HOST,
  NUGET_MIRROR_OWNER,
  parentChainOf,
  parseNugetConfig,
  pinnedToPrivateFeed,
  renderNugetConfig,
  requestedVersionOf,
  restoreFailuresOf,
  unloadedSourcesOf,
  unsupportedFeedFailure,
  type MirrorStatus,
  type NugetFeedCoverage,
  type NugetFeedKind,
} from "./nuget-feeds.js";
import { isNugetPackageFile, lookupsOf, normalizeNugetVersion, readNugetPackageReferences, type NugetPackageLookup } from "./nuget-packages.js";
import { failureExcerpt } from "./setup-report.js";
import { attributeOf, descendantsNamed, parseXml } from "./xml-elements.js";

/** docs/specs/nuget-private-feed-mapping.md. What Factoree found for one package. */
export type NugetPackageStatus = MirrorStatus | "unchecked" | "not_looked_up";

export interface NugetPrecheckPackage {
  id: string;
  /** The version Factoree checked, or the text as written for an unchecked one. */
  version: string;
  /** The files that reference it. A package only a restore found names the project that restored. */
  projects: string[];
  /** For a package only a restore found: the direct reference first, down to its parent. */
  parents?: string[];
  status: NugetPackageStatus;
  /** The reason it is unchecked, or the text of its status. */
  detail: string;
}

/** The pre-check of one setup, as the setup report and the setup input key hold it. */
export interface NugetPrecheckReport {
  outcome: "passed" | "failed";
  feeds: Array<{ key: string; url: string; kind: NugetFeedKind; file: string }>;
  /** Whether the mirror credential was present and valid, or not needed because no package needs the mirror. */
  credential: "present" | "missing" | "invalid" | "not_needed";
  /** The packages nuget.org has, listed, at the exact version. */
  publicPackages: number;
  /** Every package that is not public: private, unchecked, or found only by a restore. */
  packages: NugetPrecheckPackage[];
  /** The file Factoree wrote, or null when it wrote none. */
  configPath: string | null;
  /** The ids the file maps to the mirror. */
  mirroredIds: string[];
  restore: { outcome: "passed" | "failed" | "not_run"; rounds: number; detail: string | null };
  /** The diagnosis of a failed pre-check, or null. */
  failure: string | null;
}

export interface NugetPrecheckInput {
  sandbox: Sandbox;
  ref: SandboxRef;
  repositoryPath: string;
  /** The product's host credentials. Their values stay with the sandbox provider. */
  credentials: readonly HostCredential[];
  coverage: NugetFeedCoverage;
  /** Every host the sandbox reaches, for the redirect check of a download. */
  egressHosts: readonly string[];
}

export interface NugetPrecheckResult {
  report: NugetPrecheckReport;
  /** The text of `.factoree/nuget.config`, or null when Factoree wrote none. */
  config: string | null;
}

/** DI-21.228. The most restore rounds the transitive loop runs. */
export const NUGET_RESTORE_ROUNDS = 5;
const RESTORE_TIMEOUT_MS = 20 * 60_000;
const LOOKUP_CONCURRENCY = 6;
const MAX_RESTORE_TARGETS = 20;
const ASSETS_READ_LIMIT = 8_000_000;
/** The exit code the restore script gives when no .NET SDK runs or installs. */
const NO_SDK_EXIT = 90;

const PRUNE = "\\( -name node_modules -o -name bin -o -name obj -o -name .git \\) -prune -o";

const PACKAGE_FILES =
  `find . ${PRUNE} -type f -size -1024k \\( -iname '*.csproj' -o -iname '*.fsproj' -o -iname '*.vbproj' -o -iname directory.packages.props ` +
  "-o -iname directory.build.props -o -iname directory.build.targets -o -iname packages.config -o -iname dotnet-tools.json -o -iname nuget.config \\) " +
  `-exec sh -c 'for f; do printf "\\036%s\\037" "$f"; cat "$f"; done' sh {} +`;

const SOLUTIONS = `find . ${PRUNE} -type f -size -4096k \\( -iname '*.sln' -o -iname '*.slnx' \\) -exec sh -c 'for f; do printf "\\036%s\\037" "$f"; cat "$f"; done' sh {} +`;

/**
 * DI-21.228. Restores each target with the generated file. A sandbox image with no .NET SDK gets
 * the one global.json names, or the LTS one, from dotnet-install.sh on the ecosystem host list.
 */
const RESTORE_SCRIPT = `if ! dotnet --version >/dev/null 2>&1; then
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/factoree-dotnet-install.sh || exit ${String(NO_SDK_EXIT)}
  if [ -f global.json ]; then channel="--jsonfile global.json"; else channel="--channel LTS"; fi
  bash /tmp/factoree-dotnet-install.sh $channel --install-dir "$HOME/.dotnet" >/dev/null 2>&1 || exit ${String(NO_SDK_EXIT)}
  export PATH="$HOME/.dotnet:$PATH"
fi
status=0
for target in "$@"; do dotnet restore "$target" --configfile ${FACTOREE_NUGET_CONFIG} || status=1; done
exit $status`;

const relative = (path: string): string => path.replace(/^\.\//, "");
const depthOf = (path: string): number => path.split("/").length;

/**
 * The files one command prints, each as `\036path\037text`. A scan that did not finish throws:
 * a missing config or project would pass the pre-check unseen.
 */
const readCheckoutFiles = async (sandbox: Sandbox, ref: SandboxRef, path: string, script: string, what: string): Promise<RepositoryTextFile[]> => {
  const result = await sandbox.exec(ref, { file: "sh", args: ["-c", script], cwd: path, timeoutMs: 120_000 });
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`the scan of the checkout for ${what} did not finish (${result.timedOut ? "timed out" : `exit ${String(result.exitCode)}`})`);
  }
  return result.stdout
    .split("\u001e")
    .filter((chunk) => chunk.includes("\u001f"))
    .map((chunk) => {
      const split = chunk.indexOf("\u001f");
      return { path: relative(chunk.slice(0, split)), text: chunk.slice(split + 1) };
    });
};

/** The project paths a `.sln` or `.slnx` names, relative to the checkout, lower case. */
const solutionProjectsOf = (solution: RepositoryTextFile): string[] => {
  const written = solution.path.toLowerCase().endsWith(".slnx")
    ? descendantsNamed(parseXml(solution.text), "Project").map((element) => attributeOf(element, "Path") ?? "")
    : [...solution.text.matchAll(/^\s*Project\("[^"]*"\)\s*=\s*"[^"]*"\s*,\s*"([^"]+)"/gm)].map((match) => match[1]!);
  return written
    .filter((path) => /\.(cs|fs|vb)proj$/i.test(path))
    .map((path) => posix.normalize(posix.join(posix.dirname(solution.path), path.replace(/\\/g, "/"))).toLowerCase());
};

interface HttpAnswer {
  exitCode: number;
  timedOut: boolean;
  httpCode: number;
  body: string;
}

const CURL = ["-sS", "--connect-timeout", "10", "--max-time", "30"];

/** One GET from inside the sandbox, where the provider adds a bound credential. */
const get = async (sandbox: Sandbox, ref: SandboxRef, url: string): Promise<HttpAnswer> => {
  const result = await sandbox.exec(ref, { file: "curl", args: [...CURL, "--compressed", "-o", "-", "-w", "\n%{http_code}", url], cwd: "/", timeoutMs: 45_000 });
  const split = result.stdout.lastIndexOf("\n");
  const httpCode = Number.parseInt(result.stdout.slice(split + 1).trim(), 10);
  return { exitCode: result.exitCode, timedOut: result.timedOut, httpCode: Number.isNaN(httpCode) ? 0 : httpCode, body: split < 0 ? "" : result.stdout.slice(0, split) };
};

const versionsOf = (body: string): string[] => {
  try {
    const versions = (JSON.parse(body) as { versions?: unknown }).versions;
    return Array.isArray(versions) ? versions.filter((entry): entry is string => typeof entry === "string").map((entry) => normalizeNugetVersion(entry) ?? entry.toLowerCase()) : [];
  } catch {
    return [];
  }
};

const mapLimit = async <T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

/**
 * DI-21.225. True when nuget.org has the exact id and version and lists it: the flat container
 * names the version, and its registration leaf is not unlisted. A package that shares an id with a
 * public one, or a public version that was unlisted, stays private. An answer that is no answer
 * throws, because a guess either way sends people to the wrong fix.
 */
const onNugetOrg = async (sandbox: Sandbox, ref: SandboxRef, lookup: NugetPackageLookup): Promise<boolean> => {
  const id = lookup.id.toLowerCase();
  const flat = await get(sandbox, ref, `https://api.nuget.org/v3-flatcontainer/${id}/index.json`);
  const fault = (answer: HttpAnswer): boolean => answer.timedOut || answer.exitCode !== 0 || answer.httpCode === 0 || answer.httpCode >= 500;
  if (fault(flat)) throw new Error(`api.nuget.org did not answer for ${lookup.id} (curl exit ${String(flat.exitCode)}, HTTP ${String(flat.httpCode)})`);
  if (flat.httpCode !== 200 || !versionsOf(flat.body).includes(lookup.version)) return false;
  const leaf = await get(sandbox, ref, `https://api.nuget.org/v3/registration5-gz-semver2/${id}/${lookup.version}.json`);
  if (fault(leaf)) throw new Error(`api.nuget.org did not answer for ${lookup.id} ${lookup.version} (curl exit ${String(leaf.exitCode)}, HTTP ${String(leaf.httpCode)})`);
  if (leaf.httpCode !== 200) return false;
  try {
    return (JSON.parse(leaf.body) as { listed?: unknown }).listed !== false;
  } catch {
    return false;
  }
};

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * DI-21.226. One package on the mirror: the flat container index, then a one-byte download of
 * the exact version, because the download redirects to another host and the index alone passes
 * where the file fails. A null version checks the index only.
 */
const onMirror = async (
  input: NugetPrecheckInput,
  owner: string,
  id: string,
  version: string | null,
): Promise<{ status: MirrorStatus; detail: string | null }> => {
  const base = `https://${NUGET_MIRROR_HOST}/${owner}/download/${id.toLowerCase()}`;
  const index = await get(input.sandbox, input.ref, `${base}/index.json`);
  const indexStatus = mirrorStatusOf(index);
  if (indexStatus !== "mirrored") return { status: indexStatus, detail: indexStatus === "unreachable" ? `HTTP ${String(index.httpCode)}, curl exit ${String(index.exitCode)}` : null };
  if (version === null) return { status: "mirrored", detail: null };
  if (!versionsOf(index.body).includes(version)) return { status: "version_missing", detail: null };
  const file = `${base}/${version}/${id.toLowerCase()}.${version}.nupkg`;
  const first = await input.sandbox.exec(input.ref, { file: "curl", args: [...CURL, "-o", "/dev/null", "-w", "%{http_code} %{redirect_url}", file], cwd: "/", timeoutMs: 45_000 });
  const [code = "0", redirect = ""] = first.stdout.trim().split(" ");
  const firstCode = Number.parseInt(code, 10) || 0;
  const firstStatus = mirrorStatusOf({ exitCode: first.exitCode, timedOut: first.timedOut, httpCode: firstCode });
  if (firstStatus !== "mirrored") return { status: firstStatus, detail: firstStatus === "unreachable" ? `HTTP ${String(firstCode)}, curl exit ${String(first.exitCode)}` : null };
  if (firstCode < 300 || firstCode >= 400) return { status: "mirrored", detail: null };
  // The redirect URL holds a signed query, so only its host leaves this function.
  const redirectHost = hostOf(redirect);
  if (redirectHost === null || !allowListCovers(input.egressHosts, redirectHost)) return { status: "redirect_blocked", detail: redirectHost ?? "an unnamed host" };
  const follow = await input.sandbox.exec(input.ref, { file: "curl", args: [...CURL, "-L", "-r", "0-0", "-o", "/dev/null", "-w", "%{http_code}", file], cwd: "/", timeoutMs: 45_000 });
  const followCode = Number.parseInt(follow.stdout.trim(), 10) || 0;
  // Only a 2xx read the byte. A redirect at the end of the chain downloaded nothing.
  const followStatus = followCode >= 300 && followCode < 400 ? "unreachable" : mirrorStatusOf({ exitCode: follow.exitCode, timedOut: follow.timedOut, httpCode: followCode });
  return { status: followStatus, detail: followStatus === "unreachable" ? `the download from ${redirectHost}: HTTP ${String(followCode)}, curl exit ${String(follow.exitCode)}` : null };
};

const packageLabel = (entry: NugetPrecheckPackage): string => {
  const where = entry.projects.length === 0 ? "" : ` (${entry.projects.join(", ")}${entry.parents === undefined || entry.parents.length === 0 ? "" : `, through ${entry.parents.join(" > ")}`})`;
  return `${entry.id} ${entry.version}${where}`;
};

/**
 * The diagnosis of a failed pre-check: the headline, each failing package with the file that
 * references it, the parent chain of a transitive one and the text of its status.
 */
export const nugetFailureOf = (headline: string, packages: readonly NugetPrecheckPackage[], owner: string = NUGET_MIRROR_OWNER): string => {
  const failing = packages.filter((entry) => entry.status !== "mirrored" && entry.status !== "unchecked" && entry.status !== "not_looked_up");
  const missing = failing.filter((entry) => entry.status === "not_found" || entry.status === "version_missing");
  return [
    `The NuGet pre-check failed: ${headline}`,
    ...failing.map((entry) => `- ${packageLabel(entry)}: ${entry.detail}.`),
    ...(missing.length === 0
      ? []
      : [`For each package not on the mirror, mirror these packages to ${githubPackagesPageOf(owner)}: ${missing.map((entry) => `${entry.id} ${entry.version}`).join(", ")}.`]),
    "Factoree started no setup agent and created no app-change issue.",
  ].join("\n");
};

/**
 * docs/specs/nuget-private-feed-mapping.md. The NuGet pre-check of a setup, before the agent
 * session: read the feeds, collect the packages, drop those nuget.org has, and stop when none is
 * left. Only then check the mirror credential, look each package up on the mirror, write
 * `.factoree/nuget.config` and restore with it, looking up each package the restore cannot find.
 * Every decision comes from a Factoree check, never from an agent.
 */
export const runNugetPrecheck = async (input: NugetPrecheckInput): Promise<NugetPrecheckResult> => {
  const report: NugetPrecheckReport = {
    outcome: "passed",
    feeds: [],
    credential: "not_needed",
    publicPackages: 0,
    packages: [],
    configPath: null,
    mirroredIds: [],
    restore: { outcome: "not_run", rounds: 0, detail: null },
    failure: null,
  };
  const fail = (headline: string, owner: string = NUGET_MIRROR_OWNER): NugetPrecheckResult => {
    report.outcome = "failed";
    report.failure = nugetFailureOf(headline, report.packages, owner);
    return { report, config: null };
  };
  const failedScan = (error: unknown): NugetPrecheckResult => fail(`${error instanceof Error ? error.message : String(error)}. Run the setup again.`);

  let files: RepositoryTextFile[];
  try {
    files = await readCheckoutFiles(input.sandbox, input.ref, input.repositoryPath, PACKAGE_FILES, "NuGet configs and projects");
  } catch (error) {
    return failedScan(error);
  }
  const configs = files
    .filter((file) => isNugetConfigPath(file.path))
    .sort((left, right) => depthOf(left.path) - depthOf(right.path) || left.path.localeCompare(right.path))
    .map((file) => parseNugetConfig(file.path, file.text));
  const feeds = classifyNugetFeeds(configs, input.coverage);
  report.feeds = feeds.map((feed) => ({ key: feed.key, url: feed.url, kind: feed.kind, file: feed.file }));

  const unsupported = unsupportedFeedFailure(feeds);
  if (unsupported !== null) return fail(unsupported);
  const mapped = feeds.some((feed) => feed.kind === "mapped");
  const mirrorFeed = feeds.find((feed) => feed.kind === "mirror");
  if (!mapped && mirrorFeed === undefined) return { report, config: null };

  const references = readNugetPackageReferences(files.filter((file) => isNugetPackageFile(file.path)));
  const unchecked = new Map<string, NugetPrecheckPackage>();
  for (const entry of references.filter((reference) => reference.version === null)) {
    const key = `${entry.id.toLowerCase()} ${entry.versionText}`;
    const current = unchecked.get(key);
    if (current !== undefined && !current.projects.includes(entry.project)) current.projects.push(entry.project);
    if (current === undefined) {
      unchecked.set(key, { id: entry.id, version: entry.versionText === "" ? "(none)" : entry.versionText, projects: [entry.project], status: "unchecked", detail: `unchecked, restore decides: ${entry.unchecked ?? "no version"}` });
    }
  }
  report.packages.push(...unchecked.values());

  const lookups = lookupsOf(references);
  // DI-21.227. An id the repository's own source mapping sends only to the private feed never
  // comes from nuget.org, whatever nuget.org has.
  const pinned = lookups.filter((lookup) => pinnedToPrivateFeed(configs, feeds, lookup.id));
  const open = lookups.filter((lookup) => !pinned.includes(lookup));
  let publicFlags: boolean[];
  try {
    publicFlags = await mapLimit(open, LOOKUP_CONCURRENCY, (lookup) => onNugetOrg(input.sandbox, input.ref, lookup));
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Factoree could not tell the public packages from the private ones. Run the setup again.`);
  }
  // DI-21.227. The file maps a whole id to the mirror, so each version of a private id reads from the mirror.
  const privateIds = new Set([...pinned, ...open.filter((_, index) => publicFlags[index] !== true)].map((lookup) => lookup.id.toLowerCase()));
  const privatePackages = lookups.filter((lookup) => privateIds.has(lookup.id.toLowerCase()));
  report.publicPackages = lookups.length - privatePackages.length;

  // DI-21.231. A repository that already restores from GitHub Packages needs no swap: only the
  // credential, and only when a package needs that feed.
  if (!mapped) {
    const owner = githubPackagesOwnerOf(mirrorFeed!.url) ?? NUGET_MIRROR_OWNER;
    const detail = `the repository restores from ${mirrorFeed!.url} itself, so Factoree checks only the credential`;
    report.packages.push(...privatePackages.map((lookup) => ({ id: lookup.id, version: lookup.version, projects: lookup.projects, status: "not_looked_up" as const, detail })));
    if (privatePackages.length === 0) return { report, config: null };
    const credentialFailure = mirrorCredentialFailure(input.credentials, owner);
    report.credential = credentialFailure === null ? "present" : input.credentials.some((entry) => entry.host.toLowerCase() === NUGET_MIRROR_HOST) ? "invalid" : "missing";
    return credentialFailure === null ? { report, config: null } : fail(credentialFailure, owner);
  }

  let credentialChecked = false;
  const checkCredential = (): string | null => {
    if (credentialChecked) return null;
    credentialChecked = true;
    const failure = mirrorCredentialFailure(input.credentials);
    report.credential = failure === null ? "present" : input.credentials.some((entry) => entry.host.toLowerCase() === NUGET_MIRROR_HOST) ? "invalid" : "missing";
    return failure;
  };

  if (privatePackages.length > 0) {
    const credentialFailure = checkCredential();
    if (credentialFailure !== null) {
      report.packages.push(...privatePackages.map((lookup) => ({ id: lookup.id, version: lookup.version, projects: lookup.projects, status: "not_looked_up" as const, detail: "not looked up, because the credential check failed" })));
      return fail(credentialFailure);
    }
    const results = await mapLimit(privatePackages, LOOKUP_CONCURRENCY, (lookup) => onMirror(input, NUGET_MIRROR_OWNER, lookup.id, lookup.version));
    report.packages.push(
      ...privatePackages.map((lookup, index) => ({
        id: lookup.id,
        version: lookup.version,
        projects: lookup.projects,
        status: results[index]!.status,
        detail: mirrorStatusText(results[index]!.status, results[index]!.detail),
      })),
    );
    const failing = results.filter((result) => result.status !== "mirrored").length;
    if (failing > 0) return fail(`${String(failing)} of ${String(privatePackages.length)} private packages do not read from ${NUGET_FEED_MAPPING.to}.`);
  }

  const mirroredIds = new Set(privatePackages.map((lookup) => lookup.id));
  const configFile = `${input.repositoryPath}/${FACTOREE_NUGET_CONFIG}`;
  let config = renderNugetConfig(configs, feeds, [...mirroredIds]);
  await input.sandbox.exec(input.ref, { file: "mkdir", args: ["-p", `${input.repositoryPath}/.factoree`], cwd: "/" });
  await input.sandbox.writeFile(input.ref, configFile, config);

  let solutionFiles: RepositoryTextFile[];
  try {
    solutionFiles = await readCheckoutFiles(input.sandbox, input.ref, input.repositoryPath, SOLUTIONS, "solutions");
  } catch (error) {
    return failedScan(error);
  }
  // DI-21.228. Each solution, and each project no solution names, so no project goes unrestored.
  const inSolutions = new Set(solutionFiles.flatMap(solutionProjectsOf));
  const solutions = solutionFiles.map((file) => file.path).sort();
  const standalone = files
    .map((file) => file.path)
    .filter((path) => /\.(cs|fs|vb)proj$/i.test(path) && !inSolutions.has(path.toLowerCase()))
    .sort();
  const allTargets = [...solutions, ...standalone];
  const targets = allTargets.slice(0, MAX_RESTORE_TARGETS);
  const unrestored = allTargets.length - targets.length;
  const coverage = unrestored === 0 ? null : `Factoree restored the first ${String(targets.length)} of ${String(allTargets.length)} solutions and projects, so ${String(unrestored)} went unchecked.`;

  const handled = new Set<string>();
  for (let round = 1; round <= NUGET_RESTORE_ROUNDS && targets.length > 0; round += 1) {
    report.restore.rounds = round;
    const restore = await input.sandbox.exec(input.ref, { file: "sh", args: ["-c", RESTORE_SCRIPT, "sh", ...targets], cwd: input.repositoryPath, timeoutMs: RESTORE_TIMEOUT_MS });
    const output = `${restore.stdout}\n${restore.stderr}`;
    if (restore.exitCode === NO_SDK_EXIT) {
      report.restore = { outcome: "not_run", rounds: round, detail: "No .NET SDK ran or installed in the sandbox, so Factoree checked the direct references only." };
      break;
    }
    // The setup agent cannot change `.factoree/nuget.config`, so a mirror the restore cannot load fails here.
    const unloaded = unloadedSourcesOf(output).filter((url) => hostOf(url) === NUGET_MIRROR_HOST);
    if (unloaded.length > 0) {
      report.restore = { outcome: "failed", rounds: round, detail: failureExcerpt(output) };
      return fail(checkCredential() ?? `the restore could not load the service index ${unloaded.join(", ")} (NU1301): ${mirrorStatusText("unreachable")}.`);
    }
    const failures = restoreFailuresOf(output);
    if (failures.length === 0) {
      // DI-21.228. A restore that fails for a reason other than a missing package is no feed
      // fault. The setup agent sees the same failure and repairs it from `.factoree/`.
      report.restore = restore.exitCode === 0 && !restore.timedOut
        ? { outcome: "passed", rounds: round, detail: coverage }
        : { outcome: "failed", rounds: round, detail: [coverage, failureExcerpt(output)].filter((part) => part !== null).join("\n") };
      break;
    }
    if (round === NUGET_RESTORE_ROUNDS) {
      report.restore = { outcome: "failed", rounds: round, detail: failureExcerpt(output) };
      return fail(`after ${String(NUGET_RESTORE_ROUNDS)} restore rounds the restore still finds no ${failures.map((failure) => failure.id).join(", ")}.`);
    }
    const credentialFailure = checkCredential();
    if (credentialFailure !== null) return fail(credentialFailure);
    const fresh = failures.filter((failure) => !handled.has(`${failure.id.toLowerCase()}/${failure.version === null ? "" : (normalizeNugetVersion(failure.version) ?? "")}`));
    if (fresh.length === 0) {
      report.restore = { outcome: "failed", rounds: round, detail: failureExcerpt(output) };
      return fail(`the restore still finds no ${failures.map((failure) => failure.id).join(", ")} with ${failures.length === 1 ? "it" : "them"} mapped to ${NUGET_FEED_MAPPING.to}.`);
    }
    let failing = 0;
    for (const failure of fresh) {
      const version = failure.version === null ? null : normalizeNugetVersion(failure.version);
      handled.add(`${failure.id.toLowerCase()}/${version ?? ""}`);
      const assets =
        failure.project === null
          ? null
          : (await input.sandbox.exec(input.ref, { file: "head", args: ["-c", String(ASSETS_READ_LIMIT), `${posix.dirname(failure.project)}/obj/project.assets.json`], cwd: input.repositoryPath })).stdout;
      const parents = assets === null ? null : parentChainOf(assets, failure.id);
      const lookupVersion = version ?? (assets === null ? null : requestedVersionOf(assets, failure.id));
      const result = await onMirror(input, NUGET_MIRROR_OWNER, failure.id, lookupVersion);
      const project = failure.project === null ? [] : [failure.project.startsWith(`${input.repositoryPath}/`) ? failure.project.slice(input.repositoryPath.length + 1) : failure.project];
      report.packages.push({
        id: failure.id,
        version: lookupVersion ?? "(any)",
        projects: project,
        ...(parents === null ? {} : { parents }),
        status: result.status,
        detail: result.status === "mirrored" ? "found by the restore, and on the mirror" : mirrorStatusText(result.status, result.detail),
      });
      if (result.status === "mirrored" && ![...mirroredIds].some((id) => id.toLowerCase() === failure.id.toLowerCase())) mirroredIds.add(failure.id);
      if (result.status !== "mirrored") failing += 1;
    }
    if (failing > 0) {
      report.restore = { outcome: "failed", rounds: round, detail: failureExcerpt(output) };
      return fail(`the restore needs ${String(failing)} more package${failing === 1 ? "" : "s"} that ${failing === 1 ? "does" : "do"} not read from ${NUGET_FEED_MAPPING.to}.`);
    }
    config = renderNugetConfig(configs, feeds, [...mirroredIds]);
    await input.sandbox.writeFile(input.ref, configFile, config);
  }

  report.configPath = FACTOREE_NUGET_CONFIG;
  report.mirroredIds = [...mirroredIds].sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
  return { report, config };
};

/** docs/specs/nuget-private-feed-mapping.md. The part of the setup input key the pre-check decides. */
export const nugetPrecheckKeyOf = (report: NugetPrecheckReport): unknown => ({
  outcome: report.outcome,
  credential: report.credential,
  configPath: report.configPath,
  mirroredIds: report.mirroredIds.map((id) => id.toLowerCase()),
  packages: report.packages.map((entry) => `${entry.id.toLowerCase()} ${entry.version} ${entry.status}`).sort(),
});

/** What the setup prompt says about the file Factoree wrote. */
export interface NugetPromptFacts {
  configPath: string;
  /** The private feed the file replaces. */
  replacedHost: string;
  /** The mirror the file restores private packages from, or null when no package needs it. */
  mirror: string | null;
  mirroredIds: string[];
}

export const nugetPromptFactsOf = (report: NugetPrecheckReport): NugetPromptFacts | null =>
  report.configPath === null
    ? null
    : { configPath: report.configPath, replacedHost: NUGET_FEED_MAPPING.from, mirror: report.mirroredIds.length === 0 ? null : NUGET_FEED_MAPPING.to, mirroredIds: report.mirroredIds };
