import { describe, expect, it } from "vitest";
import { deriveHosts, derivedHostFilesOf, uncoveredDerivedHosts } from "~/domain/setup/derived-hosts.js";

// docs/specs/private-stack-onboarding.md. Each parser reads a real file shape. A wrong match
// either hides a private feed until a setup fails, or offers a host the install never reads.
describe("deriveHosts", () => {
  const hosts = (path: string, text: string) => deriveHosts([{ path, text }]).map((entry) => entry.repository === undefined ? entry.host : `${entry.host} ${entry.repository}`);

  it("reads the registries and the auth lines of .npmrc", () => {
    expect(hosts(".npmrc", "@acme:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\nregistry=https://registry.npmjs.org/\n")).toEqual([
      "npm.pkg.github.com",
      "registry.npmjs.org",
    ]);
  });

  it("reads the package sources of NuGet.config and leaves its credentials out", () => {
    const config = `<configuration><packageSources><clear /><add key="nuget.org" value="https://api.nuget.org/v3/index.json" /><add key="acme" value="https://pkgs.dev.azure.com/acme/_packaging/feed/nuget/v3/index.json" /></packageSources><packageSourceCredentials><acme><add key="Username" value="https://not.a.source.example" /></acme></packageSourceCredentials></configuration>`;
    expect(hosts("NuGet.config", config)).toEqual(["api.nuget.org", "pkgs.dev.azure.com"]);
  });

  it("reads git dependencies of package.json and codeload archives of yarn.lock as github.com repositories", () => {
    expect(hosts("package.json", JSON.stringify({ dependencies: { ui: "github:acme/ui#v2", lib: "git+ssh://git@github.com/acme/lib.git", left: "^1.0.0" } }))).toEqual([
      "github.com acme/lib",
      "github.com acme/ui",
    ]);
    expect(hosts("yarn.lock", 'kit@acme/kit:\n  resolved "https://codeload.github.com/acme/kit/tar.gz/abc"\nleft@1:\n  resolved "https://registry.yarnpkg.com/left/-/left-1.tgz"\n')).toEqual([
      "github.com acme/kit",
      "registry.yarnpkg.com",
    ]);
  });

  it("reads Maven repositories outside distributionManagement, which only publishes", () => {
    const pom = `<project><url>https://acme.example/site</url><repositories><repository><id>a</id><url>https://nexus.acme.example/repository/maven/</url></repository></repositories><distributionManagement><repository><url>https://publish.acme.example/</url></repository></distributionManagement></project>`;
    expect(hosts("pom.xml", pom)).toEqual(["nexus.acme.example"]);
  });

  it("reads pyproject sources and not the project links", () => {
    const pyproject = '[project.urls]\nHomepage = "https://github.com/acme/app"\n\n[[tool.poetry.source]]\nname = "acme"\nurl = "https://pypi.acme.example/simple/"\n';
    expect(hosts("pyproject.toml", pyproject)).toEqual(["pypi.acme.example"]);
  });

  it("reads the registry settings of a CI workflow", () => {
    const workflow = "steps:\n  - uses: actions/setup-node@v4\n    with:\n      registry-url: https://npm.pkg.github.com\n  - run: dotnet restore --source https://pkgs.dev.azure.com/acme/feed/nuget/v3/index.json\n    env:\n      GOPRIVATE: git.acme.example\n";
    expect(hosts(".github/workflows/ci.yml", workflow)).toEqual(["git.acme.example", "npm.pkg.github.com", "pkgs.dev.azure.com"]);
  });
});

describe("derivedHostFilesOf", () => {
  it("reads the workflows first and skips vendored copies", () => {
    expect(derivedHostFilesOf(["web/node_modules/x/package.json", "web/package.json", ".github/workflows/ci.yml", "src/app.ts", ".npmrc"])).toEqual([
      ".github/workflows/ci.yml",
      ".npmrc",
      "web/package.json",
    ]);
  });
});

describe("uncoveredDerivedHosts", () => {
  it("leaves out the ecosystem list, the allow list, the credential hosts and the covered github.com repositories", () => {
    const derived = deriveHosts([
      { path: ".npmrc", text: "registry=https://registry.npmjs.org/\n@acme:registry=https://npm.pkg.github.com\n@b:registry=https://feed.acme.example\n@c:registry=https://allowed.acme.example\n" },
      { path: "package.json", text: JSON.stringify({ dependencies: { a: "github:acme/a", b: "github:acme/b" } }) },
    ]);
    const left = uncoveredDerivedHosts(derived, { allowedDomains: ["*.acme.example"], credentialHosts: ["npm.pkg.github.com"], githubRepositories: ["acme/a"] });
    expect(left.map((entry) => `${entry.host}${entry.repository === undefined ? "" : ` ${entry.repository}`}`)).toEqual(["github.com acme/b"]);
  });

  it("leaves out the private NuGet feed the setup maps to its mirror (nuget-private-feed-mapping.md)", () => {
    const derived = deriveHosts([
      { path: "NuGet.config", text: '<configuration><packageSources><add key="f" value="https://nuget.frontiersin.net/nuget" /><add key="o" value="https://other.example/nuget" /></packageSources></configuration>' },
    ]);
    const left = uncoveredDerivedHosts(derived, { allowedDomains: [], credentialHosts: [], githubRepositories: [] });
    expect(left.map((entry) => entry.host)).toEqual(["other.example"]);
  });
});
