# Host credentials

Amends `docs/factoree-sdd.md` §29 and §30 and `docs/specs/repository-setup-and-services.md`.

## What it does
An operator adds host credentials to a product: a login for a private container registry, such as Azure Container Registry, or a header for a private package feed, such as an Azure Artifacts npm or NuGet feed. Every sandbox of the product reaches those hosts in every phase. The sandbox provider adds the credential to each matching request outside the guest, so no agent, script or file in the sandbox holds the value. A compose stack pulls private images, a bootstrap restores private packages, and an implementer adds a private dependency, with no `docker login` and no token in `.npmrc`.

## Decisions
- A host credential belongs to the product, and a product holds at most 8 — one install holds many tenants, and Kiln allows 16 bindings per sandbox and E2B 10 domains.
- A host credential has a kind. `registry` holds host, username and secret. `header` holds host, header name, secret and an optional path prefix — one model covers images and npm, NuGet, PyPI and Maven feeds.
- The host is one exact name with no wildcard — a wildcard sends the key to every subdomain, and Kiln refuses it.
- The value is a product secret of the new kind `host_credential`. It never reaches an environment, a prompt or the implementer input, and the redactor holds it — SDD §30 keeps credentials out of agent sessions.
- On save, Factoree sends an anonymous `GET /v2/` to a `registry` host and stores the realm host and path from the `WWW-Authenticate` header — Docker Hub uses `auth.docker.io`, and Artifactory's realm path names the repository.
- On save, Factoree sends a realm `GET` with Basic for a `registry` credential, and anything but 200 answers 422 with the registry's status, and the product keeps its old list — a wrong setting fails where the operator reads it (DI-17.06).
- A `header` credential gets no check on save — Factoree cannot know a valid path, and the setup report shows the first failure.
- The sandbox provider injects each credential. A `registry` credential binds `Authorization: Basic` on the realm path and on `/v2/` of the registry host. A `header` credential binds its header on its path — the guest never runs `docker login`.
- Kiln binds each credential through `PUT /v1/sandboxes/{id}/credentials` with methods `GET` and `HEAD` only — a publish or a push leaves with no key.
- E2B binds each credential through `network.rules` on the host, with no method or path narrowing — E2B offers none.
- The product form states that each token must be read-only, and names E2B as the provider where a write-capable token can publish — only the operator can choose the token's rights.
- Each credential applies in every phase: setup, bootstrap, warm, agent and check sprite. Its hosts join the egress list of each phase, outside the product allow list — the implementer must add or bump a private dependency, and the check sprite must pull an image that the patch changes.
- Factoree passes the bindings on every create, fork and restore, including setup and build-ahead sandboxes — Kiln starts a fork or a restore with no bindings, and a snapshot holds none.
- The bootstrap key adds the sorted host list of the product's credentials. A change to that list requests a build-ahead, as an allow list change does (DI-16.05) — a new host can make a failing pull pass, and a token rotation needs no new snapshot.
- The setup prompt names the credential hosts as reachable — the setup agent can then write a compose file with private images and prove it.
- When the product has host credentials and the provider cannot bind them, preparation fails with `CONFIGURATION_INVALID` and names the provider. This applies to Fly Sprites, the local adapter, an E2B account without network rules, and a Kiln template built before credential injection — a silent pull failure costs a whole run.
- The install setting that holds the username and token for the sandbox image stays as it is — it reaches only the template build.

## Out
- AWS ECR and any credential that expires in hours — Kiln has no refresh callback.
- A credential per repository. Every repository of the product gets all of the product's credentials.
- A check that a token is read-only.
- A `docker login`, a `.npmrc` token or any other credential file in the guest.
- Private registries for the sandbox image beyond the existing install login.

## How I know it works
- An ACR `registry` credential with a wrong password answers 422 on save, and the product page keeps its old list.
- On Kiln, a setup run on a repository whose compose file names a private ACR image proves services and seed, and the setup report lists the ACR host as reached.
- In that run's work sprite, `cat ~/.docker/config.json`, `env` and `grep -r <token prefix> / 2>/dev/null` show no token.
- In that work sprite, `docker push` to the ACR host fails, and Kiln's `egress/requests` shows the push request with no binding name.
- A patch that changes the image tag to another private tag passes the check sprite, which pulls the new tag.
- A `header` credential for an Azure Artifacts npm feed lets the bootstrap run `npm ci` with a private package, with no `.npmrc` token in the repository.
- The same product on the local adapter fails at preparation with `CONFIGURATION_INVALID` naming the provider.
- The ACR and npm checks on E2B pass. BLOCKED_EXTERNAL until an E2B account with network rules exists.
