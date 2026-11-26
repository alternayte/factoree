import type { Command } from "~/domain/runs/sandbox.js";
import type { HostCredential } from "~/domain/products/host-credentials.js";
import type { FakeSandbox } from "./fake-sandbox.js";

/**
 * A NuGet world for the pre-check tests, answered through FakeSandbox.onExec: the repository
 * files, nuget.org, the GitHub Packages mirror with its download redirect, and dotnet restore.
 */
export interface NugetWorld {
  /** The repository files, by path relative to the checkout. */
  files: Record<string, string>;
  /** nuget.org by lower-case id: its versions, and the versions it unlisted. */
  nugetOrg?: Record<string, { versions: string[]; unlisted?: string[] }>;
  /** True to make every nuget.org request time out. */
  nugetOrgDown?: boolean;
  /** The raw answer, body then `\n<status>`, of a nuget.org request by URL path. */
  nugetOrgAnswers?: Record<string, string>;
  /** The raw answer, body then `\n<status>`, of the mirror index of a lower-case id. */
  mirrorIndexAnswers?: Record<string, string>;
  /** The mirror by lower-case id: its versions, or the HTTP status of every request for it. */
  mirror?: Record<string, string[] | number>;
  /** The HTTP status of every mirror request, when the token or the network fails them all. */
  mirrorStatus?: number;
  /** The host a mirror download redirects to. */
  redirectHost?: string;
  /** The host the redirect host sends the download on to, when the chain has a second redirect. */
  secondRedirectHost?: string;
  /** The HTTP status at the end of a followed download. Defaults to 206. */
  downloadStatus?: number;
  /** True to make the sandbox reject every mirror request, as a failed exec transport does. */
  mirrorExecRejects?: boolean;
  /** The solutions the find of `*.sln` prints, by path, with their text. */
  solutions?: Record<string, string>;
  /** The exit code of the find of the repository files, to model a scan that did not finish. */
  scanExitCode?: number;
  /**
   * Restore, given the generated config text: the exit code and the output. Defaults to a pass.
   * Return 90 to model a sandbox with no .NET SDK.
   */
  restore?: (config: string, round: number) => { exitCode: number; output: string };
  /** `obj/project.assets.json` by project folder, or an assets file by its whole path. */
  assets?: Record<string, string>;
  /** The `ProjectAssetsFile` MSBuild evaluates, by project path as the restore names it. Unset, MSBuild names none. */
  assetsFiles?: Record<string, string>;
}

const answer = (stdout: string, exitCode = 0, timedOut = false): { exitCode: number; stdout: string; stderr: string; timedOut: boolean } => ({ exitCode, stdout, stderr: "", timedOut });

/** The id and version of a nupkg URL, `/download/<id>/<version>/<id>.<version>.nupkg`. */
const downloadOf = (path: string): { id: string; version: string } | null => {
  const match = /\/download\/([^/]+)\/([^/]+)\/[^/]+\.nupkg$/.exec(path);
  return match === null ? null : { id: match[1]!, version: match[2]! };
};

/** Installs the world on the sandbox and returns the restore rounds it ran. */
export const installNugetWorld = (sandbox: FakeSandbox, world: NugetWorld, repositoryPath: string, fallback?: (command: Command) => { exitCode: number; stdout: string; stderr: string } | null): { rounds: () => number; requests: string[] } => {
  let rounds = 0;
  const requests: string[] = [];
  sandbox.onExec = (command) => {
    const script = command.file === "sh" ? (command.args[1] ?? "") : "";
    if (script.includes("dotnet-tools.json") && script.includes("find")) {
      return answer(Object.entries(world.files).map(([path, text]) => `\u001e./${path}\u001f${text}`).join(""), world.scanExitCode ?? 0);
    }
    if (script.includes("*.sln")) return answer(Object.entries(world.solutions ?? {}).map(([path, text]) => `\u001e./${path}\u001f${text}`).join(""));
    if (script.includes("dotnet restore")) {
      rounds += 1;
      const config = sandbox.files.get(`${repositoryPath}/.factoree/nuget.config`) ?? "";
      const result = world.restore?.(config, rounds) ?? { exitCode: 0, output: "Restore complete." };
      return answer(result.output, result.exitCode);
    }
    if (script.includes("-getProperty:ProjectAssetsFile")) {
      const evaluated = world.assetsFiles?.[command.args[3] ?? ""];
      return evaluated === undefined ? answer("", 1) : answer(`${evaluated}\n`);
    }
    if (command.file === "head") {
      const path = command.args[2] ?? "";
      const text = world.assets?.[path] ?? world.assets?.[path.replace(/\/obj\/project\.assets\.json$/, "")];
      return answer(text ?? "", text === undefined ? 1 : 0);
    }
    if (command.file === "curl") {
      const url = new URL(command.args[command.args.length - 1]!);
      requests.push(url.toString());
      const format = command.args[command.args.indexOf("-w") + 1] ?? "";
      if (world.mirrorExecRejects === true && url.hostname === "nuget.pkg.github.com") throw new Error("the sandbox exec transport closed");
      const redirectHost = world.redirectHost ?? "nugetregistryv2prod.blob.core.windows.net";
      if (url.hostname === redirectHost && world.secondRedirectHost !== undefined) return answer(`302 https://${world.secondRedirectHost}/blobs/abc?sig=secret`);
      if (url.hostname === (world.secondRedirectHost ?? redirectHost)) return answer(`${String(world.downloadStatus ?? 206)} `);
      if (url.hostname === "api.nuget.org") {
        if (world.nugetOrgDown === true) return answer("", 28, true);
        const raw = world.nugetOrgAnswers?.[url.pathname];
        if (raw !== undefined) return answer(raw);
        const flat = /^\/v3-flatcontainer\/([^/]+)\/index\.json$/.exec(url.pathname);
        if (flat !== null) {
          const entry = world.nugetOrg?.[flat[1]!];
          return entry === undefined ? answer("<Error/>\n404") : answer(`${JSON.stringify({ versions: entry.versions })}\n200`);
        }
        const leaf = /^\/v3\/registration5-gz-semver2\/([^/]+)\/([^/]+)\.json$/.exec(url.pathname);
        if (leaf !== null) {
          const entry = world.nugetOrg?.[leaf[1]!];
          if (entry === undefined) return answer("\n404");
          return answer(`${JSON.stringify({ listed: !(entry.unlisted ?? []).includes(leaf[2]!) })}\n200`);
        }
        return answer("\n404");
      }
      if (url.hostname === "nuget.pkg.github.com") {
        const index = /\/download\/([^/]+)\/index\.json$/.exec(url.pathname);
        const download = downloadOf(url.pathname);
        const id = index?.[1] ?? download?.id ?? "";
        const entry = world.mirror?.[id];
        const status = world.mirrorStatus ?? (typeof entry === "number" ? entry : entry === undefined ? 404 : 200);
        if (status === 0) return answer("", 28, true);
        const rawIndex = index === null ? undefined : world.mirrorIndexAnswers?.[id];
        if (rawIndex !== undefined) return answer(rawIndex);
        if (index !== null) return answer(status === 200 ? `${JSON.stringify({ versions: entry })}\n200` : `\n${String(status)}`);
        if (download !== null) {
          const versions = Array.isArray(entry) ? entry : [];
          const code = status !== 200 ? status : versions.includes(download.version) ? 302 : 404;
          if (format.includes("redirect_url")) return answer(code === 302 ? `302 https://${redirectHost}/ghcr1/blobs/sha256:abc?sig=secret` : `${String(code)} `);
          return answer(String(code));
        }
        return answer("\n404");
      }
      return answer("", 6);
    }
    return fallback?.(command) ?? answer("");
  };
  return { rounds: () => rounds, requests };
};

/** The host credential of the mirror, as the product holds it. */
export const mirrorCredential = (overrides: Partial<HostCredential> = {}): HostCredential => ({
  kind: "header",
  host: "nuget.pkg.github.com",
  username: null,
  headerName: "Authorization",
  pathPrefix: "/frontiersin/",
  realmHost: null,
  realmPath: null,
  redirectHosts: ["nugetregistryv2prod.blob.core.windows.net"],
  repositories: [],
  githubInstallationId: null,
  ...overrides,
});

export const PRIVATE_FEED_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />
    <add key="frontiers" value="https://nuget.frontiersin.net/nuget" />
  </packageSources>
</configuration>
`;

export const project = (references: Record<string, string>): string => `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
${Object.entries(references).map(([id, version]) => `    <PackageReference Include="${id}" Version="${version}" />`).join("\n")}
  </ItemGroup>
</Project>
`;
