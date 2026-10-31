# Changelog

All notable changes to Factoree are in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Factoree uses [Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version can break compatibility.

## [Unreleased]

## [0.1.0] - 2026-11-01

The first release. Another person can install Factoree from released artefacts and run it with no checkout.

### Added

- A Linear issue delegated to Factoree starts one run: one Temporal workflow that freezes a context contract and a validation contract, runs the implementer in a work sprite, and verifies, validates and reviews each attempt in a fresh check sprite.
- A refiner agent proposes criteria and checks as data before the contracts freeze. Factoree takes a determined proposal without a question and asks the human the rest in Linear.
- Factoree publishes the verified patch as a GitHub pull request only when its SHA-256 hash reproduces, and posts a proof pack with visual evidence to Linear.
- Autonomy levels L0 to L3 per product, with risk caps per Linear label.
- Multi-repository tenancy: a tenant is a Linear workspace, a product maps to a Linear team, and a repository registers itself with `.factoree/config.yaml` through the GitHub App.
- Sandbox providers: Kiln, with a warm snapshot per repository, Fly Sprites and a local process sandbox for development.
- Each agent session records its tokens, cost, turns and longest turn. The admin API returns the sessions, and the proof pack shows the totals.
- An agent session that writes no output for the product's silence limit is hung. Factoree stops it and tries once more. A second hang in the same step fails the run with `AGENT_HUNG`.
- Setup in the web UI at `/setup`, guarded by a one-time setup token that the API logs at start: the GitHub App from a manifest, the Linear OAuth app and its install, the GitHub App install, the sandbox provider, and the first product.
- Sign-in with Linear through better-auth. Only members of a set-up Linear workspace get in, and a Linear workspace admin is a Factoree admin.
- API keys per person replace `ADMIN_API_TOKEN`. A script sends a key as `Authorization: Bearer`. Every admin API call records the user or the key.
- A web UI in `ui/`, served by the API from the same origin: install settings, workspaces, products with model, effort per role, silence limit, policy, secrets, retention and concurrency, and API keys.
- The OpenAPI document of the API in `api/openapi.json` and at `GET /api/openapi.json`. `checks/gen-check.sh` fails when the document or the UI client is stale.
- `maxConcurrentRuns` per product, 2 by default. A run over the limit waits in the new run state `QUEUED` before `PREPARING`, and the queue starts in delegation order. The Linear issue shows `Queued: N runs ahead.` and a new line only when the position changes. A stopped run leaves the queue. A wait in the queue does not spend the run budget.
- The install setting `sandboxMaxLive`. Before a sandbox create, Factoree counts its live sandboxes of the provider, retained ones included. At the limit it deletes its oldest retained sandbox. With none retained, the run waits for a slot until its budget ends, and does not fail. Concurrent creates on any worker never pass the limit.
- One image, `ghcr.io/alternayte/factoree`, with the commands `api`, `worker`, `migrate` and `--version`. The image pins the digest of the matching sandbox image, `ghcr.io/alternayte/factoree-sandbox`.
- `GET /version` returns the version, the commit and the build date. The worker logs them at start.
- `deploy/compose/compose.yml` starts PostgreSQL, Temporal on the same PostgreSQL, a one-time migration, the API and the worker from the released images.
- The Helm chart `oci://ghcr.io/alternayte/charts/factoree` deploys the API, the worker and a migration Job against an external PostgreSQL and an external Temporal.
- `examples/` holds a `.factoree/config.yaml` for a Node web app and for a Go service.
- `checks/migrations.sh` fails when a migration of the latest release changes or disappears. `scripts/upgrade-test.sh` migrates a database of the previous release to the working tree.

### Changed

- The environment holds infrastructure only, and every name has the `FACTOREE_` prefix. Rename these variables:

  | Before | 0.1.0 |
  |---|---|
  | `DATABASE_URL` | `FACTOREE_DATABASE_URL` |
  | `FACTOREE_SECRET_KEY` | `FACTOREE_MASTER_KEY` |
  | `TEMPORAL_ADDRESS` | `FACTOREE_TEMPORAL_ADDRESS` |
  | `TEMPORAL_NAMESPACE` | `FACTOREE_TEMPORAL_NAMESPACE` |
  | `TEMPORAL_TASK_QUEUE` | `FACTOREE_TEMPORAL_TASK_QUEUE` |
  | `TEMPORAL_API_KEY` | `FACTOREE_TEMPORAL_API_KEY` |
  | `PORT` | `FACTOREE_PORT` |
  | `LOG_LEVEL` | `FACTOREE_LOG_LEVEL` |
  | `SANDBOX_LOCAL_ROOT` | `FACTOREE_SANDBOX_LOCAL_ROOT` |
  | `EVIDENCE_STORAGE` | `FACTOREE_EVIDENCE_STORAGE` |
  | `EVIDENCE_LOCAL_ROOT` | `FACTOREE_EVIDENCE_LOCAL_ROOT` |

  `FACTOREE_PUBLIC_URL` is new and required. `FACTOREE_UNSAFE_LOCAL_SANDBOX` keeps its name.
- These settings moved from the environment to the install settings in the database. Setup stores them, and Settings, Install changes them. No environment fallback exists:
  `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_BASE_URL`, `GITHUB_API_BASE_URL`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `SANDBOX_ADAPTER`, `SPRITES_TOKEN`, `SPRITES_BASE_URL`, `KILN_URL`, `KILN_API_KEY`, `KILN_IMAGE` (now an override of the image the release pins), `KILN_REGISTRY_USERNAME`, `KILN_REGISTRY_TOKEN`, `FACTOREE_GIT_AUTHOR_NAME` and `FACTOREE_GIT_AUTHOR_EMAIL`.
- These settings moved from the environment to each product: `OPENCODE_MODEL` (the model), `OPENCODE_VARIANT_IMPLEMENTER`, `OPENCODE_VARIANT_REFINER`, `OPENCODE_VARIANT_VALIDATOR` and `OPENCODE_VARIANT_REVIEWER` (the effort per role), and `AGENT_SILENCE_MINUTES` (the silence limit). The product also holds the sandbox retention and `maxConcurrentRuns`.
- Factoree encrypts every stored credential with `FACTOREE_MASTER_KEY`. Setup takes the values again, and nothing imports the old environment values.

### Removed

- `ADMIN_API_TOKEN`. Use an API key.
- `OPENCODE_VARIANT`. Set the effort of each role on the product.
- The `SETUP_*` variables, `just bootstrap` and `tools/local/linear-auth.mjs`. Setup in the web UI does their work.

[Unreleased]: https://github.com/alternayte/factoree/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alternayte/factoree/releases/tag/v0.1.0
