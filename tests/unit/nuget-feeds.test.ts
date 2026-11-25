import { describe, expect, it } from "vitest";
import {
  classifyNugetFeeds,
  githubPackagesOwnerOf,
  isNugetConfigPath,
  MISSING_MIRROR_CREDENTIAL,
  mirrorCredentialFailure,
  mirrorStatusOf,
  mirrorStatusText,
  needsNugetPrecheck,
  NUGET_FEED_MAPPING,
  parentChainOf,
  parseNugetConfig,
  pinnedToPrivateFeed,
  readNugetConfigFiles,
  renderNugetConfig,
  requestedVersionOf,
  restoreFailuresOf,
  unloadedSourcesOf,
  unsupportedFeedFailure,
} from "~/domain/setup/nuget-feeds.js";
import { descendantsNamed, parseXml, attributeOf } from "~/domain/setup/xml-elements.js";
import { mirrorCredential, PRIVATE_FEED_CONFIG } from "../support/fake-nuget.js";

const NO_COVERAGE = { credentialHosts: [], allowedDomains: [] };

describe("parseNugetConfig", () => {
  it("reads clear, add, remove and the disabled sources", () => {
    const config = parseNugetConfig(
      "NuGet.config",
      `<configuration>
        <packageSources>
          <add key="old" value="https://old.example/nuget" />
          <clear />
          <add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />
          <add key="frontiers" value="https://nuget.frontiersin.net/nuget" />
          <add key="gone" value="https://gone.example/nuget" />
          <remove key="gone" />
          <add key="local" value="./packages" />
        </packageSources>
        <disabledPackageSources><add key="local" value="true" /></disabledPackageSources>
      </configuration>`,
    );
    expect(config.clear).toBe(true);
    expect(config.sources.map((source) => [source.key, source.host])).toEqual([
      ["nuget.org", "api.nuget.org"],
      ["frontiers", "nuget.frontiersin.net"],
      ["local", null],
    ]);
    expect(config.disabled).toEqual(["local"]);
  });

  it("finds a NuGet.config in any case outside build output", () => {
    expect(isNugetConfigPath("NuGet.Config")).toBe(true);
    expect(isNugetConfigPath("src/nuget.config")).toBe(true);
    expect(isNugetConfigPath("node_modules/x/NuGet.config")).toBe(false);
  });

  it("reads every config the GitHub tree lists, or the root names when it lists nothing", async () => {
    const read: string[] = [];
    const source = {
      readFile: (_name: string, path: string) => {
        read.push(path);
        return Promise.resolve(path === "NuGet.config" || path === "src/NuGet.Config" ? PRIVATE_FEED_CONFIG : null);
      },
      listFiles: () => Promise.resolve([{ path: "NuGet.config" }, { path: "src/NuGet.Config" }, { path: "README.md" }]),
    };
    expect((await readNugetConfigFiles(source as never, "o/r", "sha", "1"))?.map((file) => file.path)).toEqual(["NuGet.config", "src/NuGet.Config"]);
    const rootOnly = { readFile: source.readFile };
    read.length = 0;
    expect((await readNugetConfigFiles(rootOnly as never, "o/r", "sha", "1"))?.map((file) => file.path)).toEqual(["NuGet.config"]);
    expect(read).toEqual(["NuGet.config", "nuget.config", "NuGet.Config"]);
  });

  it("calls a tree too large to list an incomplete inventory, and lets a failed read throw", async () => {
    const truncated = { readFile: () => Promise.resolve(PRIVATE_FEED_CONFIG), listFiles: () => Promise.resolve(null) };
    expect(await readNugetConfigFiles(truncated as never, "o/r", "sha", "1")).toBeNull();
    const failing = { readFile: () => Promise.reject(new Error("HTTP 502")), listFiles: () => Promise.resolve([{ path: "src/NuGet.Config" }]) };
    await expect(readNugetConfigFiles(failing as never, "o/r", "sha", "1")).rejects.toThrow("HTTP 502");
  });

  it("reads the package source mapping of each key", () => {
    const config = parseNugetConfig(
      "NuGet.config",
      `<configuration><packageSourceMapping>
        <packageSource key="nuget.org"><package pattern="*" /></packageSource>
        <packageSource key="frontiers"><package pattern="Frontiers.*" /><package pattern="Hangfire.Pro" /></packageSource>
      </packageSourceMapping></configuration>`,
    );
    expect(config.mappings).toEqual([
      { key: "nuget.org", patterns: ["*"] },
      { key: "frontiers", patterns: ["Frontiers.*", "Hangfire.Pro"] },
    ]);
  });
});

describe("pinnedToPrivateFeed", () => {
  const config = parseNugetConfig(
    "NuGet.config",
    `<configuration><packageSources>
      <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
      <add key="frontiers" value="https://nuget.frontiersin.net/nuget" />
    </packageSources><packageSourceMapping>
      <packageSource key="nuget.org"><package pattern="*" /><package pattern="Frontiers.Public.*" /></packageSource>
      <packageSource key="frontiers"><package pattern="Frontiers.*" /></packageSource>
    </packageSourceMapping></configuration>`,
  );
  const feeds = classifyNugetFeeds([config], NO_COVERAGE);

  it("pins an id whose most specific pattern names only the private feed", () => {
    expect(pinnedToPrivateFeed([config], feeds, "frontiers.core")).toBe(true);
    expect(pinnedToPrivateFeed([config], feeds, "Frontiers.Public.Lib")).toBe(false);
    expect(pinnedToPrivateFeed([config], feeds, "Serilog")).toBe(false);
  });

  it("pins nothing when the repository maps no source", () => {
    const plain = parseNugetConfig("NuGet.config", PRIVATE_FEED_CONFIG);
    expect(pinnedToPrivateFeed([plain], classifyNugetFeeds([plain], NO_COVERAGE), "Frontiers.Core")).toBe(false);
  });
});

describe("classifyNugetFeeds", () => {
  it("names the mapped feed, the mirror, public, credential, local and unsupported feeds", () => {
    const config = parseNugetConfig(
      "NuGet.config",
      `<configuration><packageSources>
        <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
        <add key="frontiers" value="https://nuget.frontiersin.net/nuget" />
        <add key="gh" value="https://nuget.pkg.github.com/frontiersin/index.json" />
        <add key="allowed" value="https://packages.allowed.example/v3/index.json" />
        <add key="covered" value="https://private.covered.example/v3/index.json" />
        <add key="other" value="https://other-private.example/nuget" />
        <add key="local" value="../packages" />
      </packageSources></configuration>`,
    );
    const feeds = classifyNugetFeeds([config], { credentialHosts: ["private.covered.example"], allowedDomains: ["*.allowed.example"] });
    expect(feeds.map((feed) => [feed.key, feed.kind])).toEqual([
      ["nuget.org", "public"],
      ["frontiers", "mapped"],
      ["gh", "mirror"],
      ["allowed", "public"],
      ["covered", "credential"],
      ["other", "unsupported"],
      ["local", "local"],
    ]);
    expect(needsNugetPrecheck(feeds)).toBe(true);
    expect(unsupportedFeedFailure(feeds)).toContain("unsupported private feed `other-private.example`");
  });

  it("needs no pre-check for public sources only, and leaves a disabled source out", () => {
    const config = parseNugetConfig(
      "NuGet.config",
      `<configuration><packageSources>
        <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
        <add key="frontiers" value="https://nuget.frontiersin.net/nuget" />
      </packageSources><disabledPackageSources><add key="frontiers" value="true" /></disabledPackageSources></configuration>`,
    );
    const feeds = classifyNugetFeeds([config], NO_COVERAGE);
    expect(feeds.map((feed) => feed.key)).toEqual(["nuget.org"]);
    expect(needsNugetPrecheck(feeds)).toBe(false);
  });
});

describe("the mirror credential", () => {
  it("passes a header credential with the owner's path prefix or none", () => {
    expect(mirrorCredentialFailure([mirrorCredential()])).toBeNull();
    expect(mirrorCredentialFailure([mirrorCredential({ pathPrefix: null })])).toBeNull();
    expect(mirrorCredentialFailure([mirrorCredential({ pathPrefix: "/" })])).toBeNull();
    expect(mirrorCredentialFailure([mirrorCredential({ pathPrefix: "/frontiersin" })])).toBeNull();
  });

  it("fails a path prefix in another case, since the provider matches the path as written", () => {
    expect(mirrorCredentialFailure([mirrorCredential({ pathPrefix: "/FrontiersIn/" })])).toContain("path prefix /FrontiersIn/");
  });

  it("fails a path prefix that names only part of the owner, since it also covers other owners", () => {
    expect(mirrorCredentialFailure([mirrorCredential({ pathPrefix: "/f" })])).toContain("path prefix /f");
    expect(mirrorCredentialFailure([mirrorCredential({ pathPrefix: "/frontiers" })])).toContain("path prefix /frontiers");
  });

  it("names the host when the credential is missing", () => {
    expect(mirrorCredentialFailure([])).toContain(MISSING_MIRROR_CREDENTIAL);
    expect(MISSING_MIRROR_CREDENTIAL).toBe("add a host credential for nuget.pkg.github.com");
  });

  it("fails a path prefix of another owner and a credential of another kind", () => {
    expect(mirrorCredentialFailure([mirrorCredential({ pathPrefix: "/acme/" })])).toContain("path prefix /acme/");
    expect(mirrorCredentialFailure([mirrorCredential({ kind: "registry", headerName: null, pathPrefix: null })])).toContain("registry credential");
  });

  it("fails a path prefix that leaves out the index or the downloads, and a header other than Authorization", () => {
    expect(mirrorCredentialFailure([mirrorCredential({ pathPrefix: "/frontiersin/metadata/" })])).toContain("path prefix /frontiersin/metadata/");
    expect(mirrorCredentialFailure([mirrorCredential({ headerName: "X-NuGet-ApiKey" })])).toContain("sends the header X-NuGet-ApiKey");
    expect(mirrorCredentialFailure([mirrorCredential({ headerName: "authorization" })])).toBeNull();
  });

  it("reads the owner of a GitHub Packages URL", () => {
    expect(githubPackagesOwnerOf("https://nuget.pkg.github.com/acme/index.json")).toBe("acme");
    expect(githubPackagesOwnerOf("https://api.nuget.org/v3/index.json")).toBeNull();
  });
});

describe("mirror statuses", () => {
  it("maps 404, 401, 403, a timeout and a block", () => {
    expect(mirrorStatusOf({ exitCode: 0, timedOut: false, httpCode: 404 })).toBe("not_found");
    expect(mirrorStatusOf({ exitCode: 0, timedOut: false, httpCode: 401 })).toBe("unauthorized");
    expect(mirrorStatusOf({ exitCode: 0, timedOut: false, httpCode: 403 })).toBe("unauthorized");
    expect(mirrorStatusOf({ exitCode: 28, timedOut: true, httpCode: 0 })).toBe("unreachable");
    expect(mirrorStatusOf({ exitCode: 56, timedOut: false, httpCode: 0 })).toBe("unreachable");
    expect(mirrorStatusOf({ exitCode: 0, timedOut: false, httpCode: 302 })).toBe("mirrored");
  });

  it("says a 404 is a missing package or a token that cannot read it, with both fixes", () => {
    const text = mirrorStatusText("not_found");
    expect(text).toContain("not on the mirror, or the token cannot read it");
    expect(text).toContain("https://github.com/orgs/frontiersin/packages");
    expect(text).toContain("read:packages");
    expect(mirrorStatusText("unauthorized")).toContain("credential");
    expect(mirrorStatusText("unreachable")).toContain("feed unreachable");
  });
});

describe("renderNugetConfig", () => {
  const sourcesOf = (text: string): string[][] =>
    descendantsNamed(descendantsNamed(parseXml(text), "packageSources")[0]!, "add").map((entry) => [attributeOf(entry, "key") ?? "", attributeOf(entry, "value") ?? ""]);
  const mappingOf = (text: string): Record<string, string[]> =>
    Object.fromEntries(descendantsNamed(parseXml(text), "packageSource").map((entry) => [attributeOf(entry, "key") ?? "", descendantsNamed(entry, "package").map((item) => attributeOf(item, "pattern") ?? "")]));

  it("replaces only the private feed, under its key, keeps clear and maps each private id", () => {
    const configs = [parseNugetConfig("NuGet.config", PRIVATE_FEED_CONFIG)];
    const text = renderNugetConfig(configs, classifyNugetFeeds(configs, NO_COVERAGE), ["Frontiers.Core", "Hangfire.Pro"]);
    expect(text).toContain("<clear />");
    expect(sourcesOf(text)).toEqual([
      ["nuget.org", "https://api.nuget.org/v3/index.json"],
      ["frontiers", "https://nuget.pkg.github.com/frontiersin/index.json"],
    ]);
    expect(mappingOf(text)).toEqual({ "nuget.org": ["*"], frontiers: ["Frontiers.Core", "Hangfire.Pro"] });
    expect(text).not.toContain(NUGET_FEED_MAPPING.from + "/nuget");
  });

  it("writes no clear when the repository had none, keeps every public source and adds nuget.org when absent", () => {
    const configs = [
      parseNugetConfig(
        "NuGet.config",
        `<configuration><packageSources>
          <add key="frontiers" value="https://nuget.frontiersin.net/nuget" />
          <add key="covered" value="https://private.covered.example/v3/index.json" />
        </packageSources></configuration>`,
      ),
    ];
    const text = renderNugetConfig(configs, classifyNugetFeeds(configs, { credentialHosts: ["private.covered.example"], allowedDomains: [] }), ["Frontiers.Core"]);
    expect(text).not.toContain("<clear />");
    expect(sourcesOf(text).map(([key]) => key)).toEqual(["frontiers", "covered", "nuget.org"]);
    expect(mappingOf(text)).toEqual({ frontiers: ["Frontiers.Core"], covered: ["*"], "nuget.org": ["*"] });
  });

  it("drops the private feed and writes no mapping when no package needs the mirror", () => {
    const configs = [parseNugetConfig("NuGet.config", PRIVATE_FEED_CONFIG)];
    const text = renderNugetConfig(configs, classifyNugetFeeds(configs, NO_COVERAGE), []);
    expect(sourcesOf(text)).toEqual([["nuget.org", "https://api.nuget.org/v3/index.json"]]);
    expect(text).not.toContain("packageSourceMapping");
  });

  it("writes comments with no `--`, which .NET refuses, whatever the config paths are", () => {
    const configs = [parseNugetConfig("src/api--legacy/NuGet.Config", PRIVATE_FEED_CONFIG)];
    const text = renderNugetConfig(configs, classifyNugetFeeds(configs, NO_COVERAGE), ["Frontiers.Core"]);
    const comments = [...text.matchAll(/<!--([\s\S]*?)-->/g)].map((match) => match[1]!);
    expect(comments).toHaveLength(2);
    for (const comment of comments) expect(comment).not.toContain("--");
  });

  it("rebases a relative local folder from the config that names it", () => {
    const configs = [
      parseNugetConfig(
        "src/NuGet.config",
        `<configuration><packageSources>
          <add key="frontiers" value="https://nuget.frontiersin.net/nuget" />
          <add key="local" value=".\\packages" />
          <add key="absolute" value="/opt/packages" />
        </packageSources></configuration>`,
      ),
    ];
    const text = renderNugetConfig(configs, classifyNugetFeeds(configs, NO_COVERAGE), ["Frontiers.Core"]);
    expect(Object.fromEntries(sourcesOf(text))).toMatchObject({ local: "../src/packages", absolute: "/opt/packages" });
  });

  it("keeps the repository's own source mapping and moves the patterns of the private feed to the mirror", () => {
    const configs = [
      parseNugetConfig(
        "NuGet.config",
        `<configuration><packageSources>
          <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
          <add key="frontiers" value="https://nuget.frontiersin.net/nuget" />
        </packageSources><packageSourceMapping>
          <packageSource key="nuget.org"><package pattern="*" /></packageSource>
          <packageSource key="frontiers"><package pattern="Frontiers.*" /></packageSource>
        </packageSourceMapping></configuration>`,
      ),
    ];
    const text = renderNugetConfig(configs, classifyNugetFeeds(configs, NO_COVERAGE), ["Hangfire.Pro"]);
    expect(mappingOf(text)).toEqual({ "nuget.org": ["*"], frontiers: ["Hangfire.Pro", "Frontiers.*"] });
  });

  it("adds nuget.org with no pattern when the repository maps every id elsewhere, so it widens nothing", () => {
    const configs = [
      parseNugetConfig(
        "NuGet.config",
        `<configuration><packageSources>
          <clear />
          <add key="proxy" value="https://packages.allowed.example/v3/index.json" />
          <add key="frontiers" value="https://nuget.frontiersin.net/nuget" />
        </packageSources><packageSourceMapping>
          <packageSource key="proxy"><package pattern="*" /></packageSource>
          <packageSource key="frontiers"><package pattern="Frontiers.*" /></packageSource>
        </packageSourceMapping></configuration>`,
      ),
    ];
    const text = renderNugetConfig(configs, classifyNugetFeeds(configs, { credentialHosts: [], allowedDomains: ["packages.allowed.example"] }), ["Frontiers.Core"]);
    expect(sourcesOf(text).map(([key]) => key)).toEqual(["proxy", "frontiers", "nuget.org"]);
    expect(mappingOf(text)).toEqual({ proxy: ["*"], frontiers: ["Frontiers.Core", "Frontiers.*"] });
  });

  it("drops an exact pattern of a mirrored id from every other source, so only the mirror serves it", () => {
    const configs = [
      parseNugetConfig(
        "NuGet.config",
        `<configuration><packageSources>
          <clear />
          <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
          <add key="frontiers" value="https://nuget.frontiersin.net/nuget" />
        </packageSources><packageSourceMapping>
          <packageSource key="nuget.org"><package pattern="*" /><package pattern="hangfire.pro" /></packageSource>
          <packageSource key="frontiers"><package pattern="Frontiers.*" /></packageSource>
        </packageSourceMapping></configuration>`,
      ),
    ];
    const text = renderNugetConfig(configs, classifyNugetFeeds(configs, NO_COVERAGE), ["Hangfire.Pro"]);
    expect(mappingOf(text)).toEqual({ "nuget.org": ["*"], frontiers: ["Hangfire.Pro", "Frontiers.*"] });
  });

  it("moves a `*` of the private feed to nuget.org, not to the mirror", () => {
    const configs = [
      parseNugetConfig(
        "NuGet.config",
        `<configuration><packageSources>
          <clear />
          <add key="frontiers" value="https://nuget.frontiersin.net/nuget" />
        </packageSources><packageSourceMapping>
          <packageSource key="frontiers"><package pattern="*" /></packageSource>
        </packageSourceMapping></configuration>`,
      ),
    ];
    const feeds = classifyNugetFeeds(configs, NO_COVERAGE);
    expect(pinnedToPrivateFeed(configs, feeds, "Serilog")).toBe(false);
    const text = renderNugetConfig(configs, feeds, ["Frontiers.Core"]);
    expect(mappingOf(text)).toEqual({ frontiers: ["Frontiers.Core"], "nuget.org": ["*"] });
  });
});

describe("restore output", () => {
  it("reads NU1101 and NU1102 with the project and the lowest version", () => {
    const output = [
      "/repo/src/Api/Api.csproj : error NU1101: Unable to find package Frontiers.Transitive. No packages exist with this id in source(s): nuget.org, frontiers [/repo/App.sln]",
      "/repo/src/Api/Api.csproj : error NU1102: Unable to find package Hangfire.Pro with version (>= 1.8.6)",
      "  - Found 3 version(s) in frontiers [ Nearest version: 1.8.5 ]",
      "/repo/src/Web/Web.csproj : error NU1101: Unable to find package Frontiers.Transitive. No packages exist with this id",
    ].join("\n");
    expect(restoreFailuresOf(output)).toEqual([
      { id: "Frontiers.Transitive", code: "NU1101", version: null, exact: false, project: "/repo/src/Api/Api.csproj" },
      { id: "Hangfire.Pro", code: "NU1102", version: "1.8.6", exact: false, project: "/repo/src/Api/Api.csproj" },
    ]);
  });

  it("takes no lowest version from an upper bound in NU1102, and marks `= x` exact", () => {
    expect(restoreFailuresOf("A.csproj : error NU1102: Unable to find package Lib with version (<= 2.0.0)")[0]?.version).toBeNull();
    expect(restoreFailuresOf("A.csproj : error NU1102: Unable to find package Lib with version (= 2.0.0)")[0]).toMatchObject({ version: "2.0.0", exact: true });
    expect(restoreFailuresOf("A.csproj : error NU1102: Unable to find package Lib with version (>= 1.0.0 && <= 2.0.0)")[0]).toMatchObject({ version: "1.0.0", maximum: { version: "2.0.0", inclusive: true } });
  });

  it("names the sources whose service index the restore could not load", () => {
    const output = "/repo/A.csproj : error NU1301: Unable to load the service index for source https://nuget.pkg.github.com/frontiersin/index.json.\nRestore failed.";
    expect(unloadedSourcesOf(output)).toEqual(["https://nuget.pkg.github.com/frontiersin/index.json"]);
    expect(unloadedSourcesOf("error NU1101: Unable to find package X.")).toEqual([]);
  });

  it("names the parent chain from project.assets.json, direct reference first", () => {
    const assets = JSON.stringify({
      targets: {
        "net8.0": {
          "Frontiers.Core/3.1.0": { dependencies: { "Frontiers.Http": "2.0.0" } },
          "Frontiers.Http/2.0.0": { dependencies: { "Frontiers.Transitive": "1.0.0" } },
        },
      },
      project: { frameworks: { "net8.0": { dependencies: { "Frontiers.Core": {} } } } },
    });
    expect(parentChainOf(assets, "Frontiers.Transitive")).toEqual(["Frontiers.Core 3.1.0", "Frontiers.Http 2.0.0"]);
    expect(parentChainOf("not json", "x")).toBeNull();
  });

  it("reads the lowest version the parents ask for, normalised, since NU1101 names none", () => {
    const assets = JSON.stringify({
      targets: {
        "net8.0": { "Hangfire.Pro.Redis/2.8.20": { dependencies: { "Hangfire.Pro": "[2.3.2.0, )" } } },
        "net6.0": { "Hangfire.Pro.Redis/2.8.20": { dependencies: { "hangfire.pro": "2.4.0" } } },
      },
    });
    expect(requestedVersionOf(assets, "Hangfire.Pro")).toEqual({ version: "2.3.2", exact: false });
    expect(requestedVersionOf(assets, "Frontiers.Other")).toBeNull();
    expect(requestedVersionOf("not json", "x")).toBeNull();
  });

  it("takes no version from a range with no inclusive lower bound, and only `[x]` as exact", () => {
    const assetsOf = (range: string): string => JSON.stringify({ targets: { "net8.0": { "Parent/1.0.0": { dependencies: { Lib: range } } } } });
    expect(requestedVersionOf(assetsOf("(, 2.0.0]"), "Lib")).toBeNull();
    expect(requestedVersionOf(assetsOf("(1.0.0, )"), "Lib")).toBeNull();
    expect(requestedVersionOf(assetsOf("[1.5.0]"), "Lib")).toEqual({ version: "1.5.0", exact: true });
    expect(requestedVersionOf(assetsOf("[1.0.0, 2.0.0]"), "Lib")).toEqual({ version: "1.0.0", exact: false, maximum: { version: "2.0.0", inclusive: true } });
    expect(requestedVersionOf(assetsOf("[1.0.0, 2.0.0)"), "Lib")).toEqual({ version: "1.0.0", exact: false, maximum: { version: "2.0.0", inclusive: false } });
    expect(requestedVersionOf(assetsOf("[1.0.0, )"), "Lib")).toEqual({ version: "1.0.0", exact: false });
  });
});
