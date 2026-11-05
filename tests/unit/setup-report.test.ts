import { describe, expect, it } from "vitest";
import { parseFactoreeConfig } from "~/domain/products/factoree-config.js";
import { failureExcerpt, provenConfigOf, renderSetupReport, withPreviewDependents, type SetupPartResult } from "~/domain/setup/setup-report.js";

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
