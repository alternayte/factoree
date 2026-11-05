/**
 * docs/specs/repository-setup-and-services.md. The ecosystem host list: the package, toolchain and
 * image hosts a setup sandbox can reach, so a setup agent can install a stack before anyone knows
 * which hosts the repository needs. It is fixed here and the same for every install, so nobody
 * writes an allow list by hand. A new ecosystem is a Factoree release.
 */
export const ECOSYSTEM_HOSTS: readonly string[] = [
  // Node: npm, Yarn and the Node downloads.
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "nodejs.org",
  // .NET: NuGet and the SDK downloads.
  "api.nuget.org",
  "globalcdn.nuget.org",
  "builds.dotnet.microsoft.com",
  "dotnetcli.azureedge.net",
  "dotnetcli.blob.core.windows.net",
  "ci.dot.net",
  // Python: PyPI, and uv.
  "pypi.org",
  "files.pythonhosted.org",
  "astral.sh",
  // Go.
  "proxy.golang.org",
  "sum.golang.org",
  "go.dev",
  "dl.google.com",
  // Rust.
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "static.rust-lang.org",
  // Java: Maven Central and Gradle.
  "repo.maven.apache.org",
  "repo1.maven.org",
  "plugins.gradle.org",
  "services.gradle.org",
  // Ruby and PHP.
  "rubygems.org",
  "index.rubygems.org",
  "repo.packagist.org",
  // Container images: Docker Hub, GHCR, MCR and Quay.
  "registry-1.docker.io",
  "auth.docker.io",
  "production.cloudflare.docker.com",
  "ghcr.io",
  "pkg-containers.githubusercontent.com",
  "mcr.microsoft.com",
  "*.data.mcr.microsoft.com",
  "quay.io",
  "*.quay.io",
  // GitHub release downloads, which most toolchain installers and mise use.
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  // mise.
  "mise.jdx.dev",
  "mise-versions.jdx.dev",
];
