/**
 * docs/specs/repository-setup-and-services.md. The ecosystem host list: the package, toolchain and
 * image hosts a setup sandbox can reach, so a setup agent can install a stack before anyone knows
 * which hosts the repository needs. It is fixed here and the same for every install, so nobody
 * writes an allow list by hand. A new ecosystem is a Factoree release.
 *
 * A general API or object store, such as api.github.com or storage.googleapis.com, stays out: any
 * account can write there, so it is an exfiltration path. A repository that needs one gets it
 * through the product allow list, which the setup report offers for each denied host.
 */
export const ECOSYSTEM_HOSTS: readonly string[] = [
  // Node and TypeScript: npm, Yarn, pnpm through corepack, the Node downloads and node-gyp headers.
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  "nodejs.org",
  // Bun and Deno, with JSR.
  "bun.sh",
  "deno.land",
  "dl.deno.land",
  "jsr.io",
  "npm.jsr.io",
  // Packages that download binaries in their install step: Prisma engines, Playwright and Cypress.
  "binaries.prisma.sh",
  "playwright.azureedge.net",
  "playwright.download.prss.microsoft.com",
  "cdn.playwright.dev",
  "download.cypress.io",
  // .NET: NuGet, dotnet-install.sh and the SDK downloads.
  "api.nuget.org",
  "globalcdn.nuget.org",
  "dot.net",
  "aka.ms",
  "builds.dotnet.microsoft.com",
  "download.visualstudio.microsoft.com",
  "dotnetcli.azureedge.net",
  "dotnetcli.blob.core.windows.net",
  "ci.dot.net",
  // Python: PyPI, uv, Poetry and conda.
  "pypi.org",
  "files.pythonhosted.org",
  "astral.sh",
  "install.python-poetry.org",
  "conda.anaconda.org",
  "repo.anaconda.com",
  // Go.
  "proxy.golang.org",
  "sum.golang.org",
  "go.dev",
  "golang.org",
  "vuln.go.dev",
  "dl.google.com",
  // Rust.
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "static.rust-lang.org",
  "sh.rustup.rs",
  // Java and Kotlin: Maven Central, Gradle with its wrapper and plugin portal, Google Maven for
  // Android, and the JDK downloads.
  "repo.maven.apache.org",
  "repo1.maven.org",
  "plugins.gradle.org",
  "plugins-artifacts.gradle.org",
  "services.gradle.org",
  "downloads.gradle.org",
  "maven.google.com",
  "api.adoptium.net",
  "download.java.net",
  "corretto.aws",
  "cdn.azul.com",
  "download.jetbrains.com",
  "cache-redirector.jetbrains.com",
  // Ruby and PHP: gems, Ruby sources, Packagist and Composer.
  "rubygems.org",
  "index.rubygems.org",
  "cache.ruby-lang.org",
  "repo.packagist.org",
  "getcomposer.org",
  // Container images: Docker Hub, GHCR, MCR, Quay, GCR and ECR Public.
  "registry-1.docker.io",
  "auth.docker.io",
  "production.cloudflare.docker.com",
  "production.cloudfront.docker.com",
  "ghcr.io",
  "pkg-containers.githubusercontent.com",
  "mcr.microsoft.com",
  "*.data.mcr.microsoft.com",
  "quay.io",
  "*.quay.io",
  "gcr.io",
  "public.ecr.aws",
  // GitHub release downloads and raw files, which most toolchain installers and mise use.
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "raw.githubusercontent.com",
  // mise.
  "mise.jdx.dev",
  "mise-versions.jdx.dev",
  "mise-java.jdx.dev",
];
