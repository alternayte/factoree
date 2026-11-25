import { describe, expect, it } from "vitest";
import { parseFactoreeConfig } from "~/domain/products/factoree-config.js";
import type { NugetPrecheckReport } from "~/domain/setup/nuget-precheck.js";
import { failureExcerpt, parseLeftOutStacks, provenConfigOf, renderSetupReport, withPreviewDependents, type SetupPartResult } from "~/domain/setup/setup-report.js";

const PROPOSAL = `version: 1
identity:
  product: shop
  linear:
    teamKey: SHP
bootstrap:
  command: dotnet restore
verify:
  commands:
    - name: build
      run: dotnet build
    - name: test
      run: dotnet test
services:
  compose: docker-compose.yml
  seed: just seed-catalog
preview:
  enabled: true
  command: dotnet run
  readyUrl: http://localhost:5000/
  timeoutSeconds: 300
accounts:
  - name: member
    username: m@example.test
    password: pass
    steps:
      - action: goto
        path: /login
    check:
      action: expectVisible
      selector: "#profile"
`;

const pass = (kind: SetupPartResult["kind"], name: string = kind): SetupPartResult => ({ kind, name, passed: true, reason: null });
const fail = (kind: SetupPartResult["kind"], name: string = kind): SetupPartResult => ({ kind, name, passed: false, reason: "it failed" });

describe("provenConfigOf (repository-setup-and-services.md)", () => {
  it("keeps every part that passed, unchanged", () => {
    const parts = [pass("bootstrap"), pass("verify", "build"), pass("verify", "test"), pass("services"), pass("preview"), pass("account", "member")];
    expect(provenConfigOf(PROPOSAL, parts)).toBe(PROPOSAL);
  });

  it("leaves out a failed verify command, the services, and an account that cannot sign in, and stays a valid config", () => {
    const parts = [pass("bootstrap"), pass("verify", "build"), fail("verify", "test"), fail("services"), pass("preview"), fail("account", "member")];
    const proven = parseFactoreeConfig(provenConfigOf(PROPOSAL, parts)!);
    expect(proven.verify.commands.map((command) => command.name)).toEqual(["build"]);
    expect(proven.services).toBeNull();
    expect(proven.preview).not.toBeNull();
    expect(proven.accounts).toEqual([]);
  });

  it("proposes nothing when the bootstrap or every verify command failed", () => {
    expect(provenConfigOf(PROPOSAL, [fail("bootstrap")])).toBeNull();
    expect(provenConfigOf(PROPOSAL, [pass("bootstrap"), fail("verify", "build"), fail("verify", "test")])).toBeNull();
  });

  it("fails every account when the preview failed", () => {
    expect(withPreviewDependents([fail("preview"), pass("account", "member")])[1]).toMatchObject({ passed: false, reason: "it needs the preview, which failed" });
  });
});

describe("renderSetupReport", () => {
  it("names each failed part, each fake and each denied host", () => {
    const body = renderSetupReport({
      parts: [pass("bootstrap"), fail("account", "member")],
      observedHosts: ["api.nuget.org"],
      deniedHosts: ["npm.company.internal"],
      egressRecorded: true,
      fakes: [{ service: "tmdb", name: "TMDB API" }],
      appChanges: [],
    });
    expect(body).toContain("- account `member`: it failed");
    expect(body).toContain("TMDB API, answered by the compose service `tmdb`");
    expect(body).toContain("Denied, because they are outside the ecosystem host list: `npm.company.internal`.");
  });

  // GitHub issue 82. The agent left out a .NET API, and the report did not say so.
  it("lists a stack the agent left out, with its output, under Not proven", () => {
    const leftOut = parseLeftOutStacks(
      "dotnet: dotnet restore failed: error NU1301: Unable to load the service index\n  Determining projects to restore...\n  error NU1301\n",
    );
    expect(leftOut).toEqual([
      {
        kind: "stack",
        name: "dotnet",
        passed: false,
        reason: "dotnet restore failed: error NU1301: Unable to load the service index",
        logTail: "Determining projects to restore...\nerror NU1301",
      },
    ]);
    const body = renderSetupReport({ parts: [pass("bootstrap"), ...leftOut], observedHosts: [], deniedHosts: [], egressRecorded: false, fakes: [], appChanges: [] });
    expect(body).toContain("### Not proven, so left out");
    expect(body).toContain("- stack `dotnet` (not proposed): dotnet restore failed");
    // GitHub issue 86. An empty denied list is not evidence on a provider that records none.
    expect(body).toContain("The sandbox provider records no blocked requests");
  });
});

describe("failureExcerpt", () => {
  it("keeps the reason of the first failure, not only the list of failed tests (anthology setup, 2026-11-05)", () => {
    const log = [
      ...Array.from({ length: 40 }, (_, index) => `  Restored project ${String(index)}`),
      "[xUnit.net 00:00:21.10]     Anthology.Tests.ListIntegrationTests.Create_list_returns_ok_and_persists [FAIL]",
      "  Failed Anthology.Tests.ListIntegrationTests.Create_list_returns_ok_and_persists [3 s]",
      "  Error Message:",
      "   System.InvalidOperationException: Docker is either not running or misconfigured.",
      ...Array.from({ length: 60 }, (_, index) => `[xUnit.net 00:00:23.${String(index)}]     Anthology.Tests.Other.Test_${String(index)} [FAIL]`),
    ].join("\n");
    const excerpt = failureExcerpt(log);
    expect(excerpt).toContain("System.InvalidOperationException: Docker is either not running or misconfigured.");
    expect(excerpt).toContain("Anthology.Tests.Other.Test_59 [FAIL]");
    expect(excerpt).not.toContain("Restored project 0");
    expect(excerpt).toMatch(/… \d+ lines …/);
  });

  it("keeps a short log whole", () => {
    expect(failureExcerpt("error: one\ntwo")).toBe("error: one\ntwo");
  });
});

describe("renderSetupReport, the NuGet pre-check (nuget-private-feed-mapping.md)", () => {
  const nuget: NugetPrecheckReport = {
    outcome: "passed",
    feeds: [
      { key: "nuget.org", url: "https://api.nuget.org/v3/index.json", kind: "public", file: "NuGet.config" },
      { key: "frontiers", url: "https://nuget.frontiersin.net/nuget", kind: "mapped", file: "NuGet.config" },
    ],
    credential: "present",
    publicPackages: 12,
    packages: [
      { id: "Frontiers.Core", version: "3.1.0", projects: ["src/Api/Api.csproj"], status: "mirrored", detail: "on the mirror, and its download reads" },
      { id: "Frontiers.Transitive", version: "1.0.0", projects: ["src/Api/Api.csproj"], parents: ["Frontiers.Core 3.1.0"], status: "mirrored", detail: "found by the restore, and on the mirror" },
    ],
    configPath: ".factoree/nuget.config",
    mirroredIds: ["Frontiers.Core", "Frontiers.Transitive"],
    restore: { outcome: "passed", rounds: 2, detail: null },
    failure: null,
  };
  const base = { parts: [{ kind: "bootstrap" as const, name: "bootstrap", passed: true, reason: null }], observedHosts: [], deniedHosts: [], egressRecorded: true, fakes: [], appChanges: [] };

  it("names the file, the mapped ids, the credential and each private package with its evidence", () => {
    const text = renderSetupReport({ ...base, nuget });
    expect(text).toContain("### NuGet feeds");
    expect(text).toContain("Factoree wrote `.factoree/nuget.config`: it replaces `nuget.frontiersin.net` with `nuget.pkg.github.com/frontiersin` and maps `Frontiers.Core`, `Frontiers.Transitive` to it");
    expect(text).toContain("nuget.org has 12 of the referenced packages");
    expect(text).toContain("The host credential for nuget.pkg.github.com is present.");
    expect(text).toContain("- `Frontiers.Transitive` 1.0.0 (src/Api/Api.csproj, through Frontiers.Core 3.1.0): found by the restore, and on the mirror");
    expect(text).toContain("Factoree proved every part");
  });

  it("names what a passed restore did not cover", () => {
    const detail = "Factoree restored the first 20 of 23 solutions and projects, so 3 went unchecked.";
    const text = renderSetupReport({ ...base, nuget: { ...nuget, restore: { outcome: "passed", rounds: 1, detail } } });
    expect(text).toContain(`\`dotnet restore\` with the file passed after 1 round. ${detail}`);
  });

  it("renders only the pre-check evidence when it failed, and never the parts of the setup before it", () => {
    const failure = "The NuGet pre-check failed: 1 of 1 private packages do not read from nuget.pkg.github.com/frontiersin.\n- Frontiers.Missing 2.0.0 (src/Api/Api.csproj): not on the mirror, or the token cannot read it.";
    const text = renderSetupReport({
      ...base,
      nuget: { ...nuget, outcome: "failed", configPath: null, mirroredIds: [], restore: { outcome: "not_run", rounds: 0, detail: null }, failure, packages: [{ id: "Frontiers.Missing", version: "2.0.0", projects: ["src/Api/Api.csproj"], status: "not_found", detail: "not on the mirror" }] },
    });
    expect(text).toContain("The NuGet pre-check failed, so Factoree started no setup agent and proved nothing.");
    expect(text).toContain("- Frontiers.Missing 2.0.0 (src/Api/Api.csproj): not on the mirror, or the token cannot read it.");
    expect(text).not.toContain("Factoree proved");
    expect(text).not.toContain("bootstrap");
  });
});
