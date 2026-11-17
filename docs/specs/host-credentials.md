# Host credentials

Amends `docs/factoree-sdd.md` §29 and §30 and `docs/specs/repository-setup-and-services.md`. Closes GitHub issue 51.

## What it does
An operator adds host credentials to a product: a registry login, a header for a private package feed, or GitHub git access for private repositories of the installation. Every sandbox of the product reaches those hosts in every phase. The sandbox provider adds the credential to each matching request outside the guest, so no agent, script or file in the sandbox holds the value. A compose stack pulls private images, a bootstrap restores private npm, NuGet, Maven and RubyGems packages and private Go, npm and pip git dependencies, and an implementer adds a private dependency, with no `docker login` and no token in a committed file.

## Decisions
- A host credential belongs to the product, and a product holds at most 8 — Kiln allows 16 bindings per sandbox, and E2B allows 10 rule domains.
- Kind `registry` holds host, username and secret. Kind `header` holds host, header name, secret and an optional path prefix. Kind `github` holds a list of at most 50 `owner/name` repositories and no secret — one list covers images, feeds and git dependencies, with one cap and one bind path.
- The host is one exact name with no wildcard. The `github` host is `github.com` — a wildcard sends the key to every subdomain, and Kiln refuses it.
- Each credential holds at most 4 redirect hosts, exact names, that join its egress with no key — a package download redirects to a host such as `pkg-containers.githubusercontent.com`, and GitHub documents no list of them.
- The form suggests redirect hosts for known GitHub Packages hosts, and the operator confirms them — the suggestions come from community sources, not from GitHub docs.
- A `header` secret goes out as entered, with no `Bearer` or `Basic` prefix added — GitHub Packages npm wants Bearer, and NuGet, Maven and RubyGems want Basic.
- The secret is a product secret of the new kind `host_credential`. It never reaches an environment, a prompt or the implementer input. The redactor holds the value and, for `registry`, the base64 of `username:secret` — SDD §30 keeps credentials out of agent sessions, and Kiln sends the base64 form.
- Host credentials save through their own route, which checks everything before it writes. A failed check answers 422, and the product keeps its old list — a wrong setting fails where the operator reads it (DI-17.06).
- On save, a `registry` credential gets an anonymous `GET /v2/`, and Factoree stores the realm host and path from `WWW-Authenticate`. A realm `GET` with Basic must answer 200 — Docker Hub and Artifactory put the token service elsewhere.
- On save, each `github` repository must be visible to the product's GitHub App installation — a missing repository otherwise fails deep in a bootstrap.
- A `header` credential gets no check on save — Factoree cannot know a valid path, and the setup report shows the first failure.
- A `github` credential binds a `contents: read` installation token for the listed repositories and the product's registered repositories as `Authorization: Basic base64(x-access-token:TOKEN)` — GitHub documents this form for git, and a product's agents read no other product's code.
- A worker interval mints a new `github` token and binds it again on each live sandbox at least every 30 minutes — an installation token expires after 1 hour, and Kiln and E2B have no refresh callback.
- Kiln binds through `PUT /v1/sandboxes/{id}/credentials`, with methods GET and HEAD for `registry` and `header`, and GET, HEAD and POST for `github` — a publish or a push leaves with no key, a git fetch POSTs to `git-upload-pack`, and GitHub refuses a push with a read-only token.
- E2B binds through `network.rules` on the host, with no method or path narrowing. Every E2B egress update sends the rules again — E2B offers no narrowing, and `updateNetwork` clears a field it does not get.
- The header that Kiln sets replaces a guest header of the same name — a committed `.npmrc` or `nuget.config` with an unset `${VAR}` or `%VAR%` sends that literal text, and the bound value replaces it.
- The product form states that each token must be read-only, and names E2B as the provider where a write-capable token can publish — only the operator can choose the token's rights.
- Each credential applies in every phase: setup, bootstrap, warm, agent and check sprite. Its host and redirect hosts join the egress list of each phase, outside the product allow list — the implementer must add a private dependency, and the check sprite must restore it.
- Factoree passes the bindings on every create and restore, including setup and build-ahead sandboxes — Kiln restores with no bindings, and a snapshot holds none.
- The bootstrap key adds each credential host, its redirect hosts and the `github` repository list, sorted. A change requests a build-ahead, as an allow list change does (DI-16.05) — a token rotation needs no new snapshot.
- At preparation, Factoree connects from inside the sandbox to each credential host. A failed DNS lookup or connection fails with `CONFIGURATION_INVALID` and names the host and the provider — a feed on a private network is reachable only from some providers.
- When the provider cannot bind, preparation fails with `CONFIGURATION_INVALID` and names the provider: Fly Sprites, the local adapter, and a Kiln template that answers `conflict` on `PUT /credentials` — a silent restore failure costs a whole run.
- The setup prompt names the credential hosts as reachable and says to commit no credential entry. The setup report lists each credential host and redirect host it reached — the setup agent can then prove a private restore, and the report shows it.
- The release is 0.11.0 — this adds a feature.

## Out
- AWS ECR, and any entered credential that expires in hours. Only the `github` token, which Factoree mints, refreshes.
- A credential per repository. Every repository of the product gets all of the product's credentials.
- Publishing to GitHub Packages from a sandbox, and a check that a token is read-only.
- A `docker login`, a `.npmrc` token or any other credential file in the guest.
- Python on GitHub Packages. GitHub Packages has no PyPI registry.
- Private registries for the sandbox image beyond the existing install login.

## How I know it works
- A `registry` credential with a wrong password and a `github` credential with a repository outside the installation each answer 422 on save, and the product keeps its old list.
- On Kiln, a setup run proves services that pull a private `ghcr.io` image, and the setup report lists `ghcr.io` and its redirect host as reached.
- On Kiln, the bootstrap restores a private package from `nuget.pkg.github.com/<org>` with package source mapping, `npm ci` restores a private `@<org>` package from `npm.pkg.github.com`, Maven resolves from `maven.pkg.github.com`, and `go mod download` fetches a private module of the installation.
- An implementer adds a new private dependency in each ecosystem, and the check sprite restores it.
- A run that lasts more than 1 hour still fetches a private git dependency in its last check sprite.
- In each work sprite, `env`, `cat ~/.npmrc ~/.nuget/NuGet/NuGet.Config ~/.docker/config.json` and `grep -r <token prefix> / 2>/dev/null` show no token.
- `npm publish`, `dotnet nuget push` and `docker push` fail, and Kiln's `egress/requests` shows each publish with no binding name. `git push` to a listed repository gets 403 from GitHub.
- A product with a credential host that does not resolve from its provider fails at preparation and names the host and the provider. The same product on the local adapter fails and names the provider.
- The npm and `ghcr.io` checks pass on E2B, and a committed `.npmrc` with an unset `${NODE_AUTH_TOKEN}` restores there. BLOCKED_EXTERNAL until an E2B account with network rules exists.
