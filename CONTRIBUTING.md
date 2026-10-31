# Contribute to Factoree

This document tells you how to set up Factoree, change it and submit the change. For the test layers, read [TESTING.md](TESTING.md).

## Prerequisites

| Tool | Version or note |
|---|---|
| Node | 24 LTS, from `.nvmrc`. Do not use Bun: SDD §11 forbids it for Temporal workers. |
| npm | The npm of Node 24. |
| Docker | The daemon must run. PostgreSQL, the integration tests and the image build need it. |
| just | Every recipe is in `justfile`. `just` lists them. |
| Temporal CLI | `just temporal` starts its dev server. |
| Helm | Only for the chart (`just chart`). |

## Set up

1. Install the packages and generate the Prisma client:

   ```sh
   just install
   ```

2. Start PostgreSQL and apply the migrations:

   ```sh
   just up
   just migrate
   ```

3. Start the Temporal dev server, the worker and the API, each in its own terminal:

   ```sh
   just temporal
   just worker
   just api
   ```

[docs/quickstart.md](docs/quickstart.md) runs one live run end to end against real Linear and GitHub accounts.

## Repository layout

SDD §63 fixes the layout of `src`.

| Path | Content |
|---|---|
| `src/domain` | The domain. It imports no provider SDK. ESLint enforces the rule. |
| `src/workflows` | The Temporal workflows. Code here must stay deterministic for replay. |
| `src/activities` | The Temporal activities. Every side effect of a workflow lives here. |
| `src/adapters` | The provider SDKs: Linear, GitHub, the sandboxes, the agent runners and the browser. |
| `src/persistence/prisma` | The PostgreSQL stores. |
| `src/http` | The Fastify API: webhooks, administration and health. |
| `src/bin` | The entry points of the API and the worker. |
| `prisma/` | The Prisma schema and the migrations. |
| `sandbox/` | The sandbox image. |
| `deploy/` | The Dockerfile, the compose file and the Helm chart. |
| `examples/` | `.factoree/config.yaml` files for new repositories. |
| `tests/` | The unit, integration, acceptance, workflow and live tests. |

Imports use the `~/` alias for `src`. `npm run build` rewrites it.

## Add a migration

1. Change `prisma/schema.prisma`.
2. Create the migration against the development database:

   ```sh
   npm run db:migrate:dev -- --name <what-it-does>
   ```

3. Commit the schema and the new directory in `prisma/migrations` together.

A migration of a released version never changes. `checks/migrations.sh` fails when a migration of the latest release tag changes or disappears. Each change is a new migration. A migration must keep the previous release working during an upgrade: add columns and tables in one release, and remove what the previous release used in a later release.

## Commits and pull requests

1. Make a branch from `main`.
2. Use a conventional commit subject, for example `feat:`, `fix(live):` or `docs(build):`.
3. Name the SDD sections, the specs and the DI entries of the change in the commit message.
4. Run `just verify` before you push. It must pass.
5. Open a pull request against `main`. The CI jobs `verify`, `migrations`, `chart` and `image` must pass.

## Specification and decisions

`docs/factoree-sdd.md` is the authoritative design. Do not edit it. A spec in `docs/specs/` amends it and names the sections it amends.

`docs/build/decisions.md` records each decision that the SDD leaves open as a `DI` entry, and each blocked question as a `B` entry. Code comments cite the SDD sections and the DI IDs. `docs/build/handover.md` records the build state and the open work.

## Release

1. Move the `[Unreleased]` entries of `CHANGELOG.md` to a new section `## [x.y.z] - <date>`.
2. Set the version in `package.json` and `package-lock.json`, and set `version` and `appVersion` in `deploy/helm/factoree/Chart.yaml`.
3. Merge the change to `main`.
4. Tag the merge commit `vx.y.z` and push the tag.

The tag runs `.github/workflows/release.yml`. It fails when the tag, `package.json` and `Chart.yaml` differ, or when the CHANGELOG has no section for the version. It publishes the sandbox image, the factoree image for linux/amd64 and linux/arm64, the Helm chart and the GitHub release.
