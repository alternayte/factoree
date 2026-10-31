# Release 0.1.0

Amends SDD §4 (non-goals: an operator UI for setup and settings is not a project-management UI), §12 (deployment model), §26 (Linear integration: install from setup), §31 (sandbox abstraction: provider chosen in settings), §48 (run states: QUEUED) and §59 (administration API: sessions and API keys).

## What it does
Another person installs Factoree from released artefacts and runs it without a checkout. The repository has the front door and release machinery of `~/Development/sluice`. An operator starts the stack with Docker Compose or Helm, opens the public URL, and completes setup in a web UI: GitHub App, Linear app, sandbox provider and the first product. After setup the operator signs in with Linear and changes install and product settings in the UI. Runs over a product's limit wait in a queue, and Factoree never exceeds the sandbox provider's limit.

## Decisions
- License AGPL-3.0 and a public repository. — The README install pulls public images and raw files from `main`, and AGPL keeps a hosted fork open.
- Root files: README with a compose install and a quickstart, LICENSE, CHANGELOG in Keep a Changelog form, CONTRIBUTING, SECURITY, TESTING. `package.json` version is the release version. — Sluice parity for the front door.
- One image `ghcr.io/alternayte/factoree` with the commands `api`, `worker` and `migrate`, with Playwright Chromium for the worker. — The API and the worker always run the same version.
- `deploy/compose/compose.yml` starts PostgreSQL, Temporal on the same PostgreSQL, a one-time `migrate`, the API and the worker. — A trial install on one machine with no checkout.
- `deploy/helm/factoree` deploys the API, the worker and a `migrate` pre-upgrade Job. Its values take an external PostgreSQL URL and an external Temporal address. — Production installs already run Temporal.
- A `v*.*.*` tag runs `release.yml`: multi-arch images, the sandbox image with its digest, the chart, and release notes from the CHANGELOG section. The workflow fails when the chart version, `package.json` and the tag differ. — One tag gives one consistent release.
- Each release pins its sandbox image digest in the build. Install settings keep an override for a custom image. — An upgrade brings the matching runner CLIs.
- `GET /version` and `factoree --version` report version, commit and build date. — An operator and a bug report name the exact build.
- `checks/migrations.sh` fails when a migration in the latest release tag changes or disappears. `scripts/upgrade-test.sh` migrates a database of the previous release to the working tree. — A released migration never changes.
- Env holds only infrastructure, every name with the `FACTOREE_` prefix: `FACTOREE_DATABASE_URL`, `FACTOREE_MASTER_KEY`, `FACTOREE_TEMPORAL_ADDRESS`, `_NAMESPACE`, `_TASK_QUEUE`, `_API_KEY`, `FACTOREE_PUBLIC_URL`, `FACTOREE_PORT`, `FACTOREE_LOG_LEVEL`, and the test-only local sandbox and evidence settings. — Settings that need no restart belong in the UI.
- GitHub App, Linear app, GitHub Enterprise URLs, sandbox provider and its key, image override and git author move to install settings in the database. Model, effort per role, silence limit, policy, secrets, retention and `maxConcurrentRuns` are product settings. No env fallback exists for a moved setting. Credentials are encrypted with `FACTOREE_MASTER_KEY`. — One source per setting.
- No import of the old env values. — No install before 0.1.0 exists outside development, and setup takes the same values again.
- The UI is a Vite React SPA in `ui/` with TanStack Router, TanStack Query, Tailwind and Radix, and a client generated from the OpenAPI document that `@fastify/swagger` writes. Fastify serves `ui/dist` from the same origin with a `default-src 'self'` Content-Security-Policy. — An operator tool behind a login needs no server rendering, and one origin keeps one image and one port.
- Setup: on first start the API logs a one-time setup token. `/setup` accepts only that token until setup ends. Steps: GitHub App through the manifest flow, Linear OAuth app credentials and the app install, sandbox provider and key, the first product from a Linear team with its model key. — The manifest flow and OAuth need a browser in any case.
- Sign-in uses better-auth with its Linear provider and its Prisma adapter. A hook admits only members of a set-up tenant's workspace. A Linear workspace admin is a Factoree admin. — Factoree stores no password and reuses tested session, CSRF and OAuth state code.
- better-auth API keys replace `ADMIN_API_TOKEN`. Scripts send a key as `Authorization: Bearer`. Every admin API call records the user or key. — A key can be revoked per person.
- Settings in the UI: install settings, workspaces, products with model and effort, policy, secrets, retention, concurrency, and API keys. — Every admin API change has a screen.
- `maxConcurrentRuns` per product, default 2. A run over the limit enters the state `QUEUED` before PREPARING, starts in delegation order, and the Linear issue shows "Queued: N runs ahead". A cancelled run leaves the queue. — It caps model spend per product.
- The install setting `sandboxMaxLive` is the provider's sandbox limit. Before a create, Factoree counts its live sandboxes, retained ones included. At the limit it deletes its oldest retained sandbox. With none retained, the step waits for a slot and does not fail. — Retained sandboxes filled the shared Kiln limit on 2026-10-31.
- `examples/` holds a `.factoree/config.yaml` for a Node web app and for a Go service. — A new repository starts from a working file.

## Out
- A runs list or run page in the UI. Linear and GitHub show runs.
- A docs site.
- Merge, deploy, merge feedback and the §62 success metrics, rebasing open pull requests, changes across repositories.
- A sandbox provider per product.
- A model gateway.

## How I know it works
- On a clean machine, the README compose commands start Factoree from the released image, and `GET /version` returns 0.1.0.
- `/setup` with the logged token creates the GitHub App, installs the Linear app, stores the Kiln key and creates a product. A c-dash issue delegated afterwards reaches READY_FOR_HUMAN with no value in `.env` beyond the infrastructure list.
- Sign-in with a Linear account outside the workspace is refused. A workspace admin sees the settings and creates an API key. `curl` with that key reads `/admin/products`, and after revoking it gets 401.
- With `maxConcurrentRuns` 1, a second delegated issue shows "Queued: 1 runs ahead" in Linear and starts when the first ends.
- With `sandboxMaxLive` equal to the live count and one retained sandbox, a new run deletes the retained sandbox and starts.
- Pushing tag `v0.1.0` publishes the images, the chart and a GitHub release with the CHANGELOG notes. `checks/migrations.sh` passes. `just verify` passes.
