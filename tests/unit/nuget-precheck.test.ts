import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostCredential } from "~/domain/products/host-credentials.js";
import { NUGET_RESTORE_ROUNDS, nugetPrecheckKeyOf, nugetPromptFactsOf, runNugetPrecheck } from "~/domain/setup/nuget-precheck.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { installNugetWorld, mirrorCredential, PRIVATE_FEED_CONFIG, project, type NugetWorld } from "../support/fake-nuget.js";

const PATH = "/workspace/primary";
const REF = { id: "fake-1", adapter: "fake", workspacePath: "/workspace" };
const EGRESS = ["github.com", "api.nuget.org", "nuget.pkg.github.com", "nugetregistryv2prod.blob.core.windows.net"];

const PUBLIC = { "serilog": { versions: ["3.0.0", "3.1.1"] } };

const run = async (world: NugetWorld, credentials: HostCredential[] = [mirrorCredential()], egressHosts: string[] = EGRESS) => {
  const sandbox = new FakeSandbox();
  const installed = installNugetWorld(sandbox, world, PATH);
  const result = await runNugetPrecheck({
    sandbox,
    ref: REF,
    repositoryPath: PATH,
    credentials,
    coverage: { credentialHosts: credentials.map((entry) => entry.host), allowedDomains: [] },
    egressHosts,
  });
  return { ...result, sandbox, ...installed };
};

const files = (references: Record<string, string>, config = PRIVATE_FEED_CONFIG): Record<string, string> => ({
  "NuGet.config": config,
  "src/Api/Api.csproj": project(references),
});

describe("runNugetPrecheck", () => {
  it("passes when every private package is on the mirror, and writes the mapped file", async () => {
    const { report, config, sandbox } = await run({
      files: files({ Serilog: "3.1.1", "Frontiers.Core": "3.1.0", "Hangfire.Pro": "1.8.6" }),
      nugetOrg: PUBLIC,
      mirror: { "frontiers.core": ["3.1.0"], "hangfire.pro": ["1.8.5", "1.8.6"] },
    });
    expect(report.outcome).toBe("passed");
    expect(report.credential).toBe("present");
    expect(report.publicPackages).toBe(1);
    expect(report.packages.map((entry) => `${entry.id} ${entry.status}`)).toEqual(["Frontiers.Core mirrored", "Hangfire.Pro mirrored"]);
    expect(report.mirroredIds).toEqual(["Frontiers.Core", "Hangfire.Pro"]);
    expect(report.restore).toEqual({ outcome: "passed", rounds: 1, detail: null });
    expect(report.configPath).toBe(".factoree/nuget.config");
    expect(config).toContain('<package pattern="Hangfire.Pro" />');
    expect(sandbox.files.get(`${PATH}/.factoree/nuget.config`)).toBe(config);
  });

  it("maps the packages of setup 0cedbd4f, with 0.2.6.0 as 0.2.6 and a prerelease in any case", async () => {
    const { report, config, requests } = await run({
      files: files({ Serilog: "3.1.1", "Terminology.Provider": "0.2.6.0", "Hangfire.Pro": "2.3.2", "Hasura.Auth0.Service": "1.4.0-Beta" }),
      nugetOrg: { ...PUBLIC, "hangfire.pro": { versions: ["1.0.0"] } },
      mirror: { "terminology.provider": ["0.2.6"], "hangfire.pro": ["2.3.2"], "hasura.auth0.service": ["1.4.0-beta"] },
    });
    expect(report.outcome).toBe("passed");
    expect(report.restore).toEqual({ outcome: "passed", rounds: 1, detail: null });
    expect(report.mirroredIds).toEqual(["Hangfire.Pro", "Hasura.Auth0.Service", "Terminology.Provider"]);
    expect(report.packages.map((entry) => `${entry.id} ${entry.version} ${entry.status}`)).toEqual([
      "Hangfire.Pro 2.3.2 mirrored",
      "Hasura.Auth0.Service 1.4.0-beta mirrored",
      "Terminology.Provider 0.2.6 mirrored",
    ]);
    expect(requests).toContain("https://nuget.pkg.github.com/frontiersin/download/terminology.provider/0.2.6/terminology.provider.0.2.6.nupkg");
    expect(config).toContain('value="https://nuget.pkg.github.com/frontiersin/index.json"');
    expect(config).not.toContain("nuget.frontiersin.net/nuget");
    for (const id of report.mirroredIds) expect(config).toContain(`<package pattern="${id}" />`);
  });

  it("maps Hangfire.Pro that Hangfire.Pro.Redis pulls in, at the version the parent asks for", async () => {
    const { report, config, rounds, requests } = await run({
      files: files({ "Hangfire.Pro.Redis": "2.8.20" }),
      mirror: { "hangfire.pro.redis": ["2.8.20"], "hangfire.pro": ["2.3.2"] },
      restore: (text) =>
        text.includes('pattern="Hangfire.Pro" />')
          ? { exitCode: 0, output: "Restore complete." }
          : { exitCode: 1, output: `${PATH}/src/Api/Api.csproj : error NU1101: Unable to find package Hangfire.Pro. No packages exist with this id in source(s): nuget.org` },
      assets: {
        [`${PATH}/src/Api`]: JSON.stringify({
          targets: { "net8.0": { "Hangfire.Pro.Redis/2.8.20": { dependencies: { "Hangfire.Pro": "2.3.2" } } } },
          project: { frameworks: { "net8.0": { dependencies: { "Hangfire.Pro.Redis": {} } } } },
        }),
      },
    });
    expect(report.outcome).toBe("passed");
    expect(rounds()).toBe(2);
    expect(report.mirroredIds).toEqual(["Hangfire.Pro", "Hangfire.Pro.Redis"]);
    expect(report.packages.find((entry) => entry.id === "Hangfire.Pro")).toMatchObject({ version: "2.3.2", status: "mirrored", parents: ["Hangfire.Pro.Redis 2.8.20"] });
    expect(requests).toContain("https://nuget.pkg.github.com/frontiersin/download/hangfire.pro/2.3.2/hangfire.pro.2.3.2.nupkg");
    expect(config).toContain('<package pattern="Hangfire.Pro" />');
  });

  it("fails when the mirror lacks Hangfire.Pro that Hangfire.Pro.Redis pulls in, naming the parent chain", async () => {
    const { report } = await run({
      files: files({ "Hangfire.Pro.Redis": "2.8.20" }),
      mirror: { "hangfire.pro.redis": ["2.8.20"] },
      restore: () => ({ exitCode: 1, output: `${PATH}/src/Api/Api.csproj : error NU1101: Unable to find package Hangfire.Pro. No packages exist with this id in source(s): nuget.org` }),
      assets: {
        [`${PATH}/src/Api`]: JSON.stringify({
          targets: { "net8.0": { "Hangfire.Pro.Redis/2.8.20": { dependencies: { "Hangfire.Pro": "[2.3.2, )" } } } },
          project: { frameworks: { "net8.0": { dependencies: { "Hangfire.Pro.Redis": {} } } } },
        }),
      },
    });
    expect(report.outcome).toBe("failed");
    expect(report.failure).toContain("Hangfire.Pro 2.3.2 (src/Api/Api.csproj, through Hangfire.Pro.Redis 2.8.20): not on the mirror, or the token cannot read it");
    expect(report.failure).toContain("mirror these packages to https://github.com/orgs/frontiersin/packages: Hangfire.Pro 2.3.2");
  });

  it("finds a transitive private package through the restore loop and maps it", async () => {
    const { report, config, rounds } = await run({
      files: files({ "Frontiers.Core": "3.1.0" }),
      mirror: { "frontiers.core": ["3.1.0"], "frontiers.transitive": ["1.0.0"] },
      restore: (text) =>
        text.includes('pattern="Frontiers.Transitive"')
          ? { exitCode: 0, output: "Restore complete." }
          : { exitCode: 1, output: `${PATH}/src/Api/Api.csproj : error NU1101: Unable to find package Frontiers.Transitive. No packages exist with this id in source(s): nuget.org` },
    });
    expect(report.outcome).toBe("passed");
    expect(rounds()).toBe(2);
    expect(report.mirroredIds).toEqual(["Frontiers.Core", "Frontiers.Transitive"]);
    expect(report.packages.find((entry) => entry.id === "Frontiers.Transitive")).toMatchObject({ status: "mirrored", projects: ["src/Api/Api.csproj"] });
    expect(config).toContain('<package pattern="Frontiers.Transitive" />');
  });

  it("fails on a transitive package the mirror lacks, with its parent chain", async () => {
    const { report } = await run({
      files: files({ "Frontiers.Core": "3.1.0" }),
      mirror: { "frontiers.core": ["3.1.0"] },
      restore: () => ({ exitCode: 1, output: `${PATH}/src/Api/Api.csproj : error NU1102: Unable to find package Frontiers.Transitive with version (>= 1.0.0)` }),
      assets: {
        [`${PATH}/src/Api`]: JSON.stringify({
          targets: { "net8.0": { "Frontiers.Core/3.1.0": { dependencies: { "Frontiers.Transitive": "1.0.0" } } } },
          project: { frameworks: { "net8.0": { dependencies: { "Frontiers.Core": {} } } } },
        }),
      },
    });
    expect(report.outcome).toBe("failed");
    expect(report.packages.find((entry) => entry.id === "Frontiers.Transitive")).toMatchObject({ status: "not_found", version: "1.0.0", parents: ["Frontiers.Core 3.1.0"] });
    expect(report.failure).toContain("Frontiers.Transitive 1.0.0 (src/Api/Api.csproj, through Frontiers.Core 3.1.0)");
  });

  it("fails on a package the mirror lacks, with the file that references it and both fixes", async () => {
    const { report, config, rounds } = await run({
      files: files({ "Frontiers.Core": "3.1.0", "Frontiers.Missing": "2.0.0" }),
      mirror: { "frontiers.core": ["3.1.0"] },
    });
    expect(report.outcome).toBe("failed");
    expect(config).toBeNull();
    expect(rounds()).toBe(0);
    expect(report.failure).toContain("Frontiers.Missing 2.0.0 (src/Api/Api.csproj): not on the mirror, or the token cannot read it");
    expect(report.failure).toContain("mirror these packages to https://github.com/orgs/frontiersin/packages: Frontiers.Missing 2.0.0");
    expect(report.failure).toContain("Factoree started no setup agent and created no app-change issue.");
  });

  it("names a version the mirror lacks apart from a missing package", async () => {
    const { report } = await run({ files: files({ "Hangfire.Pro": "1.8.6" }), mirror: { "hangfire.pro": ["1.8.5"] } });
    expect(report.packages[0]).toMatchObject({ status: "version_missing" });
    expect(report.failure).toContain("Mirror this version");
  });

  it("fails before any mirror request when the credential is missing, and names the host", async () => {
    const { report, requests } = await run({ files: files({ "Frontiers.Core": "3.1.0" }), mirror: { "frontiers.core": ["3.1.0"] } }, []);
    expect(report.outcome).toBe("failed");
    expect(report.credential).toBe("missing");
    expect(report.failure).toContain("add a host credential for nuget.pkg.github.com");
    expect(requests.some((url) => url.includes("nuget.pkg.github.com"))).toBe(false);
    expect(report.packages[0]).toMatchObject({ status: "not_looked_up" });
  });

  it("fails a credential whose path prefix names another owner", async () => {
    const { report } = await run({ files: files({ "Frontiers.Core": "3.1.0" }) }, [mirrorCredential({ pathPrefix: "/acme/" })]);
    expect(report.credential).toBe("invalid");
    expect(report.failure).toContain("path prefix /acme/");
  });

  it("needs no credential when every package is public, and drops the unused private feed", async () => {
    const { report, config, requests } = await run({ files: files({ Serilog: "3.1.1" }), nugetOrg: PUBLIC }, []);
    expect(report.outcome).toBe("passed");
    expect(report.credential).toBe("not_needed");
    expect(requests.some((url) => url.includes("nuget.pkg.github.com"))).toBe(false);
    expect(report.mirroredIds).toEqual([]);
    expect(config).not.toContain('value="https://nuget.frontiersin.net');
    expect(config).not.toContain('value="https://nuget.pkg.github.com');
    expect(nugetPromptFactsOf(report)).toEqual({ configPath: ".factoree/nuget.config", replacedHost: "nuget.frontiersin.net", mirror: null, mirroredIds: [] });
  });

  it("keeps a package private when nuget.org unlisted that version or has only the id", async () => {
    const { report } = await run({
      files: files({ Serilog: "3.0.0", "Frontiers.Core": "3.1.0" }),
      nugetOrg: { serilog: { versions: ["3.0.0"], unlisted: ["3.0.0"] }, "frontiers.core": { versions: ["1.0.0"] } },
      mirror: { serilog: ["3.0.0"], "frontiers.core": ["3.1.0"] },
    });
    expect(report.publicPackages).toBe(0);
    expect(report.mirroredIds).toEqual(["Frontiers.Core", "Serilog"]);
  });

  it("fails an unsupported second private feed before it reads any package", async () => {
    const config = PRIVATE_FEED_CONFIG.replace("</packageSources>", '  <add key="other" value="https://myget.example/F/x/api/v3/index.json" />\n  </packageSources>');
    const { report, requests } = await run({ files: files({ "Frontiers.Core": "3.1.0" }, config) });
    expect(report.outcome).toBe("failed");
    expect(report.failure).toContain("unsupported private feed `myget.example`");
    expect(requests).toEqual([]);
  });

  it("keeps the public sources in the file it writes", async () => {
    const config = PRIVATE_FEED_CONFIG.replace("<clear />\n", "").replace("</packageSources>", '  <add key="dotnet-tools" value="https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-tools/nuget/v3/index.json" />\n  </packageSources>');
    const sandbox = new FakeSandbox();
    installNugetWorld(sandbox, { files: files({ "Frontiers.Core": "3.1.0" }, config), mirror: { "frontiers.core": ["3.1.0"] } }, PATH);
    const result = await runNugetPrecheck({
      sandbox,
      ref: REF,
      repositoryPath: PATH,
      credentials: [mirrorCredential()],
      coverage: { credentialHosts: ["nuget.pkg.github.com"], allowedDomains: ["pkgs.dev.azure.com"] },
      egressHosts: EGRESS,
    });
    expect(result.report.outcome).toBe("passed");
    expect(result.config).not.toContain("<clear />");
    expect(result.config).toContain('key="dotnet-tools"');
    expect(result.config).toContain('key="nuget.org" value="https://api.nuget.org/v3/index.json"');
  });

  it("tells a 403 from a 404", async () => {
    const forbidden = await run({ files: files({ "Frontiers.Core": "3.1.0" }), mirrorStatus: 403 });
    const missing = await run({ files: files({ "Frontiers.Core": "3.1.0" }), mirror: {} });
    expect(forbidden.report.packages[0]).toMatchObject({ status: "unauthorized" });
    expect(forbidden.report.failure).toContain("the credential cannot read it");
    expect(forbidden.report.failure).not.toContain("mirror these packages");
    expect(missing.report.packages[0]).toMatchObject({ status: "not_found" });
  });

  it("calls a blocked or timed-out mirror unreachable", async () => {
    const { report } = await run({ files: files({ "Frontiers.Core": "3.1.0" }), mirrorStatus: 0 });
    expect(report.packages[0]).toMatchObject({ status: "unreachable" });
    expect(report.failure).toContain("feed unreachable");
  });

  it("fails a download that redirects to a host no egress list holds, naming only the host", async () => {
    const { report } = await run({ files: files({ "Frontiers.Core": "3.1.0" }), mirror: { "frontiers.core": ["3.1.0"] }, redirectHost: "blobs.elsewhere.example" });
    expect(report.packages[0]).toMatchObject({ status: "redirect_blocked" });
    expect(report.failure).toContain("blobs.elsewhere.example");
    expect(report.failure).not.toContain("sig=secret");
  });

  it("leaves a floating or unresolved version to the restore without failing", async () => {
    const { report, requests } = await run({ files: files({ "Frontiers.Core": "3.1.0", "Frontiers.Float": "1.*", "Frontiers.Prop": "$(Missing)" }), mirror: { "frontiers.core": ["3.1.0"] } });
    expect(report.outcome).toBe("passed");
    expect(report.packages.filter((entry) => entry.status === "unchecked").map((entry) => `${entry.id} ${entry.version}`)).toEqual(["Frontiers.Float 1.*", "Frontiers.Prop $(Missing)"]);
    expect(report.packages.filter((entry) => entry.status === "unchecked").every((entry) => entry.detail.startsWith("unchecked, restore decides"))).toBe(true);
    expect(requests.some((url) => /frontiers\.(float|prop)/.test(url))).toBe(false);
  });

  it("checks only the credential of a repository that already restores from GitHub Packages", async () => {
    const config = `<configuration><packageSources><add key="nuget.org" value="https://api.nuget.org/v3/index.json" /><add key="gh" value="https://nuget.pkg.github.com/acme/index.json" /></packageSources></configuration>`;
    const passed = await run({ files: files({ "Acme.Core": "1.0.0" }, config) }, [mirrorCredential({ pathPrefix: "/acme/" })]);
    expect(passed.report).toMatchObject({ outcome: "passed", credential: "present", configPath: null });
    expect(passed.config).toBeNull();
    expect(passed.requests.some((url) => url.includes("nuget.pkg.github.com"))).toBe(false);
    const failed = await run({ files: files({ "Acme.Core": "1.0.0" }, config) }, []);
    expect(failed.report.failure).toContain("add a host credential for nuget.pkg.github.com");
  });

  it("fails when nuget.org does not answer, since it cannot tell public from private", async () => {
    const { report } = await run({ files: files({ "Frontiers.Core": "3.1.0" }), nugetOrgDown: true });
    expect(report.outcome).toBe("failed");
    expect(report.failure).toContain("api.nuget.org did not answer");
  });

  it("passes with a note when the restore fails for a reason other than a missing package", async () => {
    const { report } = await run({ files: files({ "Frontiers.Core": "3.1.0" }), mirror: { "frontiers.core": ["3.1.0"] }, restore: () => ({ exitCode: 1, output: "error NETSDK1045: The current .NET SDK does not support targeting .NET 9.0." }) });
    expect(report.outcome).toBe("passed");
    expect(report.restore.outcome).toBe("failed");
    expect(report.restore.detail).toContain("NETSDK1045");
  });

  it("checks the direct references only when no .NET SDK runs", async () => {
    const { report } = await run({ files: files({ "Frontiers.Core": "3.1.0" }), mirror: { "frontiers.core": ["3.1.0"] }, restore: () => ({ exitCode: 90, output: "" }) });
    expect(report.outcome).toBe("passed");
    expect(report.restore.outcome).toBe("not_run");
  });

  it("stops after the round limit", async () => {
    let next = 0;
    const mirror: Record<string, string[]> = { "frontiers.core": ["3.1.0"] };
    for (let index = 1; index <= NUGET_RESTORE_ROUNDS; index += 1) mirror[`frontiers.t${String(index)}`] = ["1.0.0"];
    const { report, rounds } = await run({
      files: files({ "Frontiers.Core": "3.1.0" }),
      mirror,
      restore: () => {
        next += 1;
        return { exitCode: 1, output: `x.csproj : error NU1101: Unable to find package Frontiers.T${String(next)}. No packages exist` };
      },
    });
    expect(rounds()).toBe(NUGET_RESTORE_ROUNDS);
    expect(report.outcome).toBe("failed");
    expect(report.failure).toContain(`after ${String(NUGET_RESTORE_ROUNDS)} restore rounds`);
  });

  it("fails, and asks for a new setup, when the scan of the checkout did not finish", async () => {
    const { report, requests } = await run({ files: files({ "Frontiers.Core": "3.1.0" }), scanExitCode: 1 });
    expect(report.outcome).toBe("failed");
    expect(report.failure).toContain("the scan of the checkout for NuGet configs and projects did not finish (exit 1)");
    expect(requests).toEqual([]);
  });

  it("fails a download whose redirect chain ends on another redirect", async () => {
    const { report } = await run({ files: files({ "Frontiers.Core": "3.1.0" }), mirror: { "frontiers.core": ["3.1.0"] }, downloadStatus: 302 });
    expect(report.packages[0]).toMatchObject({ status: "unreachable" });
    expect(report.outcome).toBe("failed");
  });

  it("checks on the mirror the nuget.org version of an id another version of which is private", async () => {
    const { report, requests } = await run({
      files: { ...files({ Lib: "2.0.0" }), "src/Old/Old.csproj": project({ Lib: "1.0.0" }) },
      nugetOrg: { lib: { versions: ["1.0.0"] } },
      mirror: { lib: ["2.0.0"] },
    });
    expect(report.outcome).toBe("failed");
    expect(report.publicPackages).toBe(0);
    expect(report.packages.map((entry) => `${entry.id} ${entry.version} ${entry.status}`)).toEqual(["Lib 1.0.0 version_missing", "Lib 2.0.0 mirrored"]);
    expect(requests).toContain("https://nuget.pkg.github.com/frontiersin/download/lib/index.json");
  });

  it("keeps private an id the repository maps only to the private feed, whatever nuget.org has", async () => {
    const config = `<configuration><packageSources>
      <clear />
      <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
      <add key="frontiers" value="https://nuget.frontiersin.net/nuget" />
    </packageSources><packageSourceMapping>
      <packageSource key="nuget.org"><package pattern="*" /></packageSource>
      <packageSource key="frontiers"><package pattern="Frontiers.*" /></packageSource>
    </packageSourceMapping></configuration>`;
    const { report, config: written, requests } = await run({
      files: files({ "Frontiers.Core": "3.1.0", Serilog: "3.1.1" }, config),
      nugetOrg: { ...PUBLIC, "frontiers.core": { versions: ["3.1.0"] } },
      mirror: { "frontiers.core": ["3.1.0"] },
    });
    expect(report.outcome).toBe("passed");
    expect(report.mirroredIds).toEqual(["Frontiers.Core"]);
    expect(requests.some((url) => url.includes("api.nuget.org/v3-flatcontainer/frontiers.core"))).toBe(false);
    expect(written).toContain('<package pattern="Frontiers.*" />');
  });

  it("restores each solution and each project no solution names", async () => {
    const { report, sandbox } = await run({
      files: { ...files({ "Frontiers.Core": "3.1.0" }), "tools/B/B.csproj": project({}) },
      mirror: { "frontiers.core": ["3.1.0"] },
      solutions: { "App.sln": 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "src\\Api\\Api.csproj", "{1}"\nEndProject\n' },
    });
    expect(report.outcome).toBe("passed");
    const restore = sandbox.commands.find((command) => command.file === "sh" && (command.args[1] ?? "").includes("dotnet restore"));
    expect(restore?.args.slice(3)).toEqual(["App.sln", "tools/B/B.csproj"]);
  });

  it("restores into an emptied packages folder and HTTP cache, so no package a warm sandbox holds skips the mirror", async () => {
    const { sandbox } = await run({ files: files({ "Frontiers.Core": "3.1.0" }), mirror: { "frontiers.core": ["3.1.0"] } });
    const emptied = sandbox.commands.findIndex((command) => command.file === "rm" && command.args.join(" ") === "-rf /tmp/factoree-nuget-precheck");
    const restore = sandbox.commands.findIndex((command) => command.file === "sh" && (command.args[1] ?? "").includes("dotnet restore"));
    expect(emptied).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThan(emptied);
    expect(sandbox.commands[restore]?.args[1]).toContain("export NUGET_HTTP_CACHE_PATH=/tmp/factoree-nuget-precheck/http-cache");
    expect(sandbox.commands[restore]?.args[1]).toContain("--packages /tmp/factoree-nuget-precheck/packages");
  });

  it("fails when the restore cannot load the mirror's service index", async () => {
    const { report } = await run({
      files: files({ "Frontiers.Core": "3.1.0" }),
      mirror: { "frontiers.core": ["3.1.0"] },
      restore: () => ({ exitCode: 1, output: `${PATH}/src/Api/Api.csproj : error NU1301: Unable to load the service index for source https://nuget.pkg.github.com/frontiersin/index.json.` }),
    });
    expect(report.outcome).toBe("failed");
    expect(report.failure).toContain("could not load the service index https://nuget.pkg.github.com/frontiersin/index.json (NU1301)");
  });

  it("reads the assets file of a project at the root of the checkout", async () => {
    const { report, sandbox } = await run({
      files: { "NuGet.config": PRIVATE_FEED_CONFIG, "App.csproj": project({ "Frontiers.Core": "3.1.0" }) },
      mirror: { "frontiers.core": ["3.1.0"], "frontiers.transitive": ["1.0.0"] },
      restore: (text) =>
        text.includes('pattern="Frontiers.Transitive"')
          ? { exitCode: 0, output: "Restore complete." }
          : { exitCode: 1, output: "App.csproj : error NU1101: Unable to find package Frontiers.Transitive. No packages exist with this id" },
      assets: { ".": JSON.stringify({ targets: { "net8.0": { "Frontiers.Core/3.1.0": { dependencies: { "Frontiers.Transitive": "1.0.0" } } } }, project: { frameworks: { "net8.0": { dependencies: { "Frontiers.Core": {} } } } } }) },
    });
    expect(sandbox.commands.find((command) => command.file === "head")?.args[2]).toBe("./obj/project.assets.json");
    expect(report.packages.find((entry) => entry.id === "Frontiers.Transitive")).toMatchObject({ version: "1.0.0", parents: ["Frontiers.Core 3.1.0"] });
  });

  it("takes the lowest mirror version at or above a non-exact transitive request", async () => {
    const { report, requests } = await run({
      files: files({ "Frontiers.Core": "3.1.0" }),
      mirror: { "frontiers.core": ["3.1.0"], "frontiers.transitive": ["0.9.0", "1.5.0-beta", "1.5.0", "1.6.0"] },
      restore: (text) =>
        text.includes('pattern="Frontiers.Transitive"')
          ? { exitCode: 0, output: "Restore complete." }
          : { exitCode: 1, output: `${PATH}/src/Api/Api.csproj : error NU1101: Unable to find package Frontiers.Transitive. No packages exist with this id` },
      assets: {
        [`${PATH}/src/Api`]: JSON.stringify({
          targets: { "net8.0": { "Frontiers.Core/3.1.0": { dependencies: { "Frontiers.Transitive": "[1.0.0, 2.0.0]" } } } },
          project: { frameworks: { "net8.0": { dependencies: { "Frontiers.Core": {} } } } },
        }),
      },
    });
    expect(report.outcome).toBe("passed");
    expect(report.packages.find((entry) => entry.id === "Frontiers.Transitive")).toMatchObject({ version: "1.5.0", status: "mirrored" });
    expect(requests).toContain("https://nuget.pkg.github.com/frontiersin/download/frontiers.transitive/1.5.0/frontiers.transitive.1.5.0.nupkg");
  });

  it("finds no version when the mirror lists none within the range's upper bound", async () => {
    const { report, requests } = await run({
      files: files({ "Frontiers.Core": "3.1.0" }),
      mirror: { "frontiers.core": ["3.1.0"], "frontiers.transitive": ["2.0.0", "3.0.0"] },
      restore: () => ({ exitCode: 1, output: `${PATH}/src/Api/Api.csproj : error NU1101: Unable to find package Frontiers.Transitive. No packages exist with this id` }),
      assets: {
        [`${PATH}/src/Api`]: JSON.stringify({
          targets: { "net8.0": { "Frontiers.Core/3.1.0": { dependencies: { "Frontiers.Transitive": "[1.0.0, 2.0.0)" } } } },
          project: { frameworks: { "net8.0": { dependencies: { "Frontiers.Core": {} } } } },
        }),
      },
    });
    expect(report.outcome).toBe("failed");
    expect(report.packages.find((entry) => entry.id === "Frontiers.Transitive")).toMatchObject({ version: "1.0.0", status: "version_missing" });
    expect(requests.some((url) => url.endsWith(".nupkg") && url.includes("frontiers.transitive"))).toBe(false);
  });

  it("keeps the upper bound NU1102 names", async () => {
    const { report } = await run({
      files: files({ "Frontiers.Core": "3.1.0" }),
      mirror: { "frontiers.core": ["3.1.0"], "frontiers.transitive": ["3.0.0"] },
      restore: () => ({ exitCode: 1, output: `${PATH}/src/Api/Api.csproj : error NU1102: Unable to find package Frontiers.Transitive with version (>= 1.0.0 && < 2.0.0)` }),
    });
    expect(report.outcome).toBe("failed");
    expect(report.packages.find((entry) => entry.id === "Frontiers.Transitive")).toMatchObject({ version: "1.0.0", status: "version_missing" });
  });

  it("looks up a narrower NU1102 range of the same id and lower bound on its own", async () => {
    const { report } = await run({
      files: files({ "Frontiers.Core": "3.1.0" }),
      mirror: { "frontiers.core": ["3.1.0"], "frontiers.transitive": ["3.0.0"] },
      restore: () => ({
        exitCode: 1,
        output: [
          `${PATH}/src/Api/Api.csproj : error NU1102: Unable to find package Frontiers.Transitive with version (>= 1.0.0 && < 4.0.0)`,
          `${PATH}/src/Web/Web.csproj : error NU1102: Unable to find package Frontiers.Transitive with version (>= 1.0.0 && < 2.0.0)`,
        ].join("\n"),
      }),
    });
    expect(report.outcome).toBe("failed");
    expect(report.packages.filter((entry) => entry.id === "Frontiers.Transitive")).toMatchObject([
      { version: "3.0.0", status: "mirrored", projects: ["src/Api/Api.csproj"] },
      { version: "1.0.0", status: "version_missing", projects: ["src/Web/Web.csproj"] },
    ]);
  });

  it("needs the exact version for a request NuGet pins", async () => {
    const { report } = await run({
      files: files({ "Frontiers.Core": "3.1.0" }),
      mirror: { "frontiers.core": ["3.1.0"], "frontiers.transitive": ["1.6.0"] },
      restore: () => ({ exitCode: 1, output: `${PATH}/src/Api/Api.csproj : error NU1102: Unable to find package Frontiers.Transitive with version (= 1.5.0)` }),
    });
    expect(report.outcome).toBe("failed");
    expect(report.packages.find((entry) => entry.id === "Frontiers.Transitive")).toMatchObject({ version: "1.5.0", status: "version_missing" });
  });

  it("empties the restore cache before every round, so a version an earlier round took from nuget.org is read again", async () => {
    const { sandbox, rounds } = await run({
      files: files({ "Hangfire.Pro.Redis": "2.8.20" }),
      mirror: { "hangfire.pro.redis": ["2.8.20"], "hangfire.pro": ["2.3.2"] },
      restore: (text) =>
        text.includes('pattern="Hangfire.Pro" />')
          ? { exitCode: 0, output: "Restore complete." }
          : { exitCode: 1, output: `${PATH}/src/Api/Api.csproj : error NU1101: Unable to find package Hangfire.Pro. No packages exist with this id` },
    });
    expect(rounds()).toBe(2);
    const steps = sandbox.commands
      .map((command) => (command.file === "rm" && command.args.join(" ") === "-rf /tmp/factoree-nuget-precheck" ? "empty" : command.file === "sh" && (command.args[1] ?? "").includes("dotnet restore") ? "restore" : null))
      .filter((step) => step !== null);
    expect(steps).toEqual(["empty", "restore", "empty", "restore"]);
  });

  it("looks up each project's version of a NU1101 package and names every project", async () => {
    const assetsOf = (range: string) =>
      JSON.stringify({ targets: { "net8.0": { "Frontiers.Core/3.1.0": { dependencies: { Lib: range } } } }, project: { frameworks: { "net8.0": { dependencies: { "Frontiers.Core": {} } } } } });
    const { report } = await run({
      files: files({ "Frontiers.Core": "3.1.0" }),
      mirror: { "frontiers.core": ["3.1.0"], lib: ["1.0.0"] },
      restore: () => ({
        exitCode: 1,
        output: [
          `${PATH}/src/Api/Api.csproj : error NU1101: Unable to find package Lib. No packages exist with this id`,
          `${PATH}/src/Web/Web.csproj : error NU1101: Unable to find package Lib. No packages exist with this id`,
          `${PATH}/src/Old/Old.csproj : error NU1101: Unable to find package Lib. No packages exist with this id`,
        ].join("\n"),
      }),
      assets: { [`${PATH}/src/Api`]: assetsOf("[1.0.0]"), [`${PATH}/src/Web`]: assetsOf("[2.0.0]"), [`${PATH}/src/Old`]: assetsOf("[1.0.0]") },
    });
    expect(report.outcome).toBe("failed");
    expect(report.packages.filter((entry) => entry.id === "Lib")).toMatchObject([
      { version: "1.0.0", status: "mirrored", projects: ["src/Api/Api.csproj", "src/Old/Old.csproj"], parents: ["Frontiers.Core 3.1.0"] },
      { version: "2.0.0", status: "version_missing", projects: ["src/Web/Web.csproj"] },
    ]);
    expect(report.failure).toContain("Lib 2.0.0 (src/Web/Web.csproj, through Frontiers.Core 3.1.0)");
  });

  it("looks up a NU1100 package the repository maps only to the private feed, and maps it", async () => {
    const config = `<configuration><packageSources>
      <clear />
      <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
      <add key="frontiers" value="https://nuget.frontiersin.net/nuget" />
    </packageSources><packageSourceMapping>
      <packageSource key="nuget.org"><package pattern="Public.Parent" /></packageSource>
      <packageSource key="frontiers"><package pattern="Frontiers.*" /></packageSource>
    </packageSourceMapping></configuration>`;
    const unrouted = (id: string) => `${PATH}/src/Api/Api.csproj : error NU1100: Unable to resolve '${id} (>= 1.0.0)' for 'net8.0'. PackageSourceMapping is enabled, the following source(s) were not considered: nuget.org.`;
    const pinned = await run({
      files: files({ "Public.Parent": "1.0.0" }, config),
      nugetOrg: { "public.parent": { versions: ["1.0.0"] } },
      mirror: { "frontiers.child": ["1.0.0"] },
      restore: (text) => (text.includes('pattern="Frontiers.Child" />') ? { exitCode: 0, output: "Restore complete." } : { exitCode: 1, output: unrouted("Frontiers.Child") }),
    });
    expect(pinned.report.outcome).toBe("passed");
    expect(pinned.rounds()).toBe(2);
    expect(pinned.report.mirroredIds).toEqual(["Frontiers.Child"]);
    expect(pinned.report.packages).toMatchObject([{ id: "Frontiers.Child", version: "1.0.0", status: "mirrored" }]);
    expect(pinned.config).toContain('<package pattern="Frontiers.*" />');

    const other = await run({
      files: files({ "Public.Parent": "1.0.0" }, config),
      nugetOrg: { "public.parent": { versions: ["1.0.0"] } },
      restore: () => ({ exitCode: 1, output: unrouted("Other.Lib") }),
    });
    expect(other.report.outcome).toBe("passed");
    expect(other.report.restore.outcome).toBe("failed");
    expect(other.requests.some((url) => url.includes("other.lib"))).toBe(false);
  });

  it("fails an index-only lookup whose index answers a redirect instead of a version list", async () => {
    const { report } = await run({
      files: files({ "Frontiers.Core": "3.1.0" }),
      mirror: { "frontiers.core": ["3.1.0"], "frontiers.transitive": ["1.0.0"] },
      mirrorIndexAnswers: { "frontiers.transitive": "\n302" },
      restore: () => ({ exitCode: 1, output: `${PATH}/src/Api/Api.csproj : error NU1101: Unable to find package Frontiers.Transitive. No packages exist with this id` }),
    });
    expect(report.outcome).toBe("failed");
    expect(report.packages.find((entry) => entry.id === "Frontiers.Transitive")).toMatchObject({ version: "(any)", status: "unreachable" });
  });

  it("fails, and guesses no class, when nuget.org answers 200 with a body that does not parse", async () => {
    const truncated = await run({ files: files({ Serilog: "3.1.1" }), nugetOrgAnswers: { "/v3-flatcontainer/serilog/index.json": '{"versions":["3.1.\n200' } });
    expect(truncated.report.outcome).toBe("failed");
    expect(truncated.report.failure).toContain("api.nuget.org answered for Serilog with a version list that does not parse");
    expect(truncated.requests.some((url) => url.includes("nuget.pkg.github.com"))).toBe(false);
    const leaf = await run({ files: files({ Serilog: "3.1.1" }), nugetOrg: PUBLIC, nugetOrgAnswers: { "/v3/registration5-gz-semver2/serilog/3.1.1.json": "<html>\n200" } });
    expect(leaf.report.outcome).toBe("failed");
    expect(leaf.report.failure).toContain("registration leaf that does not parse");
  });

  it("starts no nuget.org lookup after the first fault, and returns only once the running ones finish", async () => {
    const ids = ["Pkg.A", "Pkg.B", "Pkg.C", "Pkg.D", "Pkg.E", "Pkg.F", "Pkg.G", "Pkg.H"];
    const { report, requests } = await run({
      files: files(Object.fromEntries(ids.map((id) => [id, "1.0.0"]))),
      nugetOrg: Object.fromEntries(ids.map((id) => [id.toLowerCase(), { versions: ["1.0.0"] }])),
      nugetOrgAnswers: { "/v3-flatcontainer/pkg.a/index.json": "\n503" },
    });
    const atReturn = requests.length;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(report.failure).toContain("api.nuget.org did not answer for Pkg.A");
    expect(requests).toHaveLength(atReturn);
    expect(requests.some((url) => /pkg\.(g|h)\//.test(url))).toBe(false);
  });

  it("changes the key part when the mirrored packages change", async () => {
    const one = await run({ files: files({ "Frontiers.Core": "3.1.0" }), mirror: { "frontiers.core": ["3.1.0"] } });
    const two = await run({ files: files({ "Frontiers.Core": "3.1.0", "Hangfire.Pro": "1.8.6" }), mirror: { "frontiers.core": ["3.1.0"], "hangfire.pro": ["1.8.6"] } });
    expect(JSON.stringify(nugetPrecheckKeyOf(one.report))).not.toBe(JSON.stringify(nugetPrecheckKeyOf(two.report)));
  });
});

describe("the checkout scan in a real shell", () => {
  const scan = async (write: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "factoree-nuget-scan-"));
    try {
      write(dir);
      const sandbox = new FakeSandbox();
      sandbox.onExec = (command) => {
        if (command.file !== "sh") return { exitCode: 0, stdout: "", stderr: "" };
        const result = spawnSync("sh", ["-c", command.args[1] ?? ""], { cwd: dir, encoding: "utf8" });
        return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      };
      return await runNugetPrecheck({ sandbox, ref: REF, repositoryPath: dir, credentials: [mirrorCredential()], coverage: { credentialHosts: ["nuget.pkg.github.com"], allowedDomains: [] }, egressHosts: EGRESS });
    } finally {
      for (const path of [dir, join(dir, "NuGet.config")]) chmodSync(path, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it.skipIf(process.getuid?.() === 0)("fails when one file does not read, even when the files after it do", async () => {
    const { report } = await scan((dir) => {
      writeFileSync(join(dir, "NuGet.config"), PRIVATE_FEED_CONFIG);
      chmodSync(join(dir, "NuGet.config"), 0o000);
      for (const name of ["A", "B", "C"]) {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, `${name}.csproj`), project({ "Frontiers.Core": "3.1.0" }));
      }
    });
    expect(report.outcome).toBe("failed");
    expect(report.failure).toContain("the scan of the checkout for NuGet configs and projects did not finish (exit 1)");
  });

  it("fails on a project too large to read instead of skipping it", async () => {
    const { report } = await scan((dir) => {
      writeFileSync(join(dir, "NuGet.config"), PRIVATE_FEED_CONFIG);
      writeFileSync(join(dir, "Big.csproj"), `${project({ "Frontiers.Core": "3.1.0" })}<!--${"x".repeat(1_100_000)}-->`);
    });
    expect(report.outcome).toBe("failed");
    expect(report.failure).toContain("found files too large to read: Big.csproj");
  });
});
