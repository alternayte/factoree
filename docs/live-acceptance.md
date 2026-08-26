# Live acceptance

SDD section 66 requires one live proof of Factoree Version 1. This document
holds two paths.

Path A, the local run, uses local infrastructure. It proves the scenario code
runs. **It does NOT satisfy SDD section 66 and it is NOT SDD section 66
proof.**

Path B, the real run, uses every dependency SDD section 66 names. **Only Path
B satisfies SDD section 66.**

Read the whole document before you start either path.

## Path A: the local run

This path needs only a Linear account and a GitHub account. Both providers
offer a free plan. No other account is required for this path.

### What this path proves and what it does not prove

The local run substitutes local infrastructure for the Fly Sprite, the
Temporal service, the Backstage catalog, and the MCP source. A pass proves
that `tests/live/scenario.ts` runs correctly against a real Linear workspace
and a real GitHub repository. **A pass here is NOT SDD section 66 proof.**
Only Path B, the real run against every named dependency, satisfies SDD
section 66.

### Cost

Linear has a free plan. GitHub is free. The Temporal dev server runs from the
installed `temporal` CLI at no cost. The Backstage stub and the MCP stub run
locally at no cost. The coding-agent runner costs a small amount per Run in
model tokens.

### Accounts to create first

1. A Linear test workspace. Do not use a production workspace.
2. A GitHub fixture repository. Do not use a production repository.

Install the Factoree Linear app on the test workspace before you run the
scenario. The scenario delegates its fixture issue to that app user.

If `gh` is already authenticated on your machine, the GitHub step can reuse
that session. Run `gh auth status` to check.

### Local credentials

Copy `.env.local.example` to `.env` and fill the values below.

| Variable | Dependency | Value |
| --- | --- | --- |
| `LIVE_LINEAR_API_KEY` | Linear | A personal API key of the Linear test workspace. |
| `LIVE_LINEAR_TEAM_ID` | Linear | The Linear team the live test creates its fixture issue in. |
| `LIVE_GITHUB_TOKEN` | GitHub | A token with write access to the GitHub fixture repository only. |
| `LIVE_GITHUB_REPOSITORY` | GitHub | The fixture repository, as owner/name. It must not be a production repository. |
| `LIVE_RUNNER_NAME` | Runner | The coding-agent runner to drive. Use `opencode` or `claude`. |
| `LIVE_RUNNER_API_KEY` | Runner | The model provider key that runner authenticates with. |
| `LIVE_LOCAL_TEMPORAL_ADDRESS` | Temporal (local) | The host and port of the local Temporal dev server. |
| `LIVE_LOCAL_TEMPORAL_NAMESPACE` | Temporal (local) | The Temporal namespace the local dev server uses. |
| `LIVE_LOCAL_BACKSTAGE_BASE_URL` | Backstage (local) | The base URL of the local Backstage stub. |
| `LIVE_LOCAL_MCP_ENDPOINT` | MCP (local) | The endpoint of the local MCP stub. |

`.env.local.example` fills `LIVE_LOCAL_TEMPORAL_ADDRESS`,
`LIVE_LOCAL_TEMPORAL_NAMESPACE`, `LIVE_LOCAL_BACKSTAGE_BASE_URL`, and
`LIVE_LOCAL_MCP_ENDPOINT` with working defaults. Leave those four values as
they are unless you change a stub port.

**These four values gate the scenario check. They do not configure the**
**worker.** The scenario reads them only to confirm the local infrastructure
is present. The worker reads its own Temporal setting from the `.env` keys
`TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE`. The worker reads its own
Backstage and MCP settings from its topology configuration, not from an
`.env` key. Keep `LIVE_LOCAL_TEMPORAL_ADDRESS` equal to `TEMPORAL_ADDRESS`
and `LIVE_LOCAL_TEMPORAL_NAMESPACE` equal to `TEMPORAL_NAMESPACE`. Keep
`LIVE_LOCAL_BACKSTAGE_BASE_URL` and `LIVE_LOCAL_MCP_ENDPOINT` equal to the
endpoint each worker topology row names. A mismatch between the two sets
goes undetected.

### Procedure

Run every command from the repository root. The `justfile` drives this path.

1. Run `just` to list every recipe.
2. Run `just install` to install the npm dependencies and generate the Prisma client.
3. Run `just up` to start the local PostgreSQL container.
4. Run `just migrate` to apply the Prisma migrations.
5. In a separate terminal, run `just temporal` to start the Temporal dev server.
6. In a separate terminal, run `just stubs` to start the Backstage stub and the MCP stub.
7. In a separate terminal, run `just worker` to start the Temporal worker.
8. In a separate terminal, run `just api` to start the HTTP API.
9. In a separate terminal, run `just tunnel` to start a public tunnel to the HTTP API. Copy the
   public URL the tunnel command prints.
10. Set the public URL as the webhook target in the Linear app settings of the test workspace.
    Linear delivers the delegation webhook to that URL. Linear must reach the API over the
    public internet. This is the one part of the local path that is not purely local.
11. Run `just live-local` to run the live acceptance scenario against the local infrastructure.
12. Run `just down` to stop the local PostgreSQL container when you finish.

Commands 1, 2, 3, 4, and 12 have recorded evidence from a real run on this
machine. Commands 5, 6, 7, 8, 9, 10, and 11 have not run to completion in
this repository. `tests/live/scenario.ts` has never executed against a real
service.

**Expect defects on the first run of `just live-local`.** Do not assume a
failure is your own setup error. Check the printed report first, then check
the stub logs, then check the worker logs.

## Path B: the real run, SDD section 66 proof

This path uses every dependency SDD section 66 names: a real Linear
workspace, a real GitHub fixture repository, a real Fly Sprite, a real
Temporal service, at least one real coding-agent runner, a test Backstage
catalog, and a test MCP source. Only a pass on this path satisfies SDD
section 66.

### Command

    npm run acceptance:live

The command exits 0 only when every live fact of the SDD section 67 "Live
proof" list holds. It exits 78 and prints `BLOCKED_EXTERNAL` when a required
credential is absent. `BLOCKED_EXTERNAL` is not equivalent to `DONE`. See SDD
section 66.

The repository has no `tsx` dependency and no `ts-node` dependency. The
command runs the entry point with the Node.js 24 built-in TypeScript support
instead, through a small module-resolution hook at
`tests/live/path-alias-loader.mjs`. That hook exists only to let the entry
point resolve the repository's `~/` import alias. It adds no new dependency.

### Cost per provider

Check each provider's own pricing page for the current rate. Do not rely on a
number in this document to stay accurate.

- Linear has a free plan.
- GitHub is free.
- Temporal Cloud costs money. A self-hosted Temporal service can avoid that
  cost, but it is not the local dev server of Path A.
- Fly.io charges money for a Sprite.
- The coding-agent runner costs a small amount per Run in model tokens.
- Check the Backstage host and the MCP source you choose for their own cost.

### Setup, one numbered list per provider

**Linear**

1. Create a Linear test workspace. Do not use a production workspace.
2. Install the Factoree Linear app on that workspace.
3. Create a personal API key in the workspace settings. Put it in
   `LIVE_LINEAR_API_KEY`.
4. Copy the ID of the Linear team the live test must create its fixture
   issue in. Put it in `LIVE_LINEAR_TEAM_ID`.

**GitHub**

1. Create a GitHub fixture repository. Do not use a production repository.
2. If `gh` is already authenticated as your account, reuse that session
   instead of a new token.
3. Create a token with write access to the fixture repository only. Put it
   in `LIVE_GITHUB_TOKEN`.
4. Copy the repository name as `owner/name`. Put it in
   `LIVE_GITHUB_REPOSITORY`.

**Fly**

1. Create or choose a Fly.io organization that can create a Sprite.
2. Copy the organization name. Put it in `LIVE_FLY_ORGANIZATION`.
3. Create a Fly.io token that can create and delete a Sprite. Put it in
   `LIVE_FLY_API_TOKEN`.

**Temporal**

1. Create a real Temporal service. Temporal Cloud and a self-hosted service
   both work. The local dev server of Path A does not satisfy this path.
2. Copy the host and port of that service. Put it in `LIVE_TEMPORAL_ADDRESS`.
3. Copy the namespace of that service. Put it in `LIVE_TEMPORAL_NAMESPACE`.

**Runner**

1. Choose one coding-agent runner, `opencode` or `claude`. Put the name in
   `LIVE_RUNNER_NAME`.
2. Create a model provider key for that runner. Put it in
   `LIVE_RUNNER_API_KEY`.

**Backstage**

1. Create a test Backstage catalog with at least one component entity.
2. Copy the base URL of that catalog. Put it in `LIVE_BACKSTAGE_BASE_URL`.
3. Create a read token for that catalog. Put it in `LIVE_BACKSTAGE_TOKEN`.

**MCP**

1. Create a test MCP source that answers a search.
2. Copy the endpoint of that source. Put it in `LIVE_MCP_ENDPOINT`.
3. Create a bearer token for that source. Put it in `LIVE_MCP_TOKEN`.

### Full credential table

| Variable | Dependency | Value |
| --- | --- | --- |
| `LIVE_LINEAR_API_KEY` | Linear | A personal API key of the Linear test workspace. |
| `LIVE_LINEAR_TEAM_ID` | Linear | The Linear team the live test creates its fixture issue in. |
| `LIVE_GITHUB_TOKEN` | GitHub | A token with write access to the GitHub fixture repository only. |
| `LIVE_GITHUB_REPOSITORY` | GitHub | The fixture repository, as owner/name. It must not be a production repository. |
| `LIVE_FLY_API_TOKEN` | Fly Sprites | A Fly.io token that can create and delete a Sprite. |
| `LIVE_FLY_ORGANIZATION` | Fly Sprites | The Fly.io organization the live Sprite belongs to. |
| `LIVE_TEMPORAL_ADDRESS` | Temporal | The host and port of the real Temporal service. |
| `LIVE_TEMPORAL_NAMESPACE` | Temporal | The Temporal namespace of the live acceptance run. |
| `LIVE_RUNNER_NAME` | Runner | The coding-agent runner to drive. Use `opencode` or `claude`. |
| `LIVE_RUNNER_API_KEY` | Runner | The model provider key that runner authenticates with. |
| `LIVE_BACKSTAGE_BASE_URL` | Backstage | The base URL of the test Backstage catalog. |
| `LIVE_BACKSTAGE_TOKEN` | Backstage | A read token for that Backstage catalog. |
| `LIVE_MCP_ENDPOINT` | MCP | The endpoint of the test MCP source. |
| `LIVE_MCP_TOKEN` | MCP | The bearer token of that MCP source. |

### Procedure

1. Copy `.env.example` to `.env`. Fill every `LIVE_` value listed above.
2. Start PostgreSQL and apply the migrations with `npm run db:migrate`.
3. Start the worker against the real Temporal service.
4. Configure the Backstage source and the MCP source through Factoree's
   normal configuration path, so the worker can reach the test catalog and
   the test MCP source.
5. Run `npm run acceptance:live`.
6. Read the printed report.

### What the command proves

The command exits 0 only when every fact of the SDD section 67 "Live proof"
list holds. It creates a real fixture issue in the Linear test workspace,
delegates it to Factoree, and waits for the Proof Pack comment. It reads the
Proof Pack sections to confirm that context resolution ran, the Validation
Contract froze, deterministic verification ran, review ran, and the Fly
Sprite changed code. It then confirms the linked pull request exists in the
real GitHub fixture repository. The command names each fact it cannot prove,
and it prints one line for each.

### What the command cannot prove alone

The scenario reads facts from the Proof Pack comment Factoree posts in
Linear. It does not itself drive the coding-agent runner. It does not itself
create the Fly Sprite. An operator must confirm the worker process runs
against every credential above before the command starts. Otherwise the
scenario times out and reports every fact absent.

`tests/live/scenario.ts` has never executed against a real service. Expect
defects on the first run, on both Path A and Path B.

## Troubleshooting: disk space

Docker can hold a large amount of reclaimable disk space in build cache. If
the disk fills, run `docker builder prune` first. This reclaim is safe.

**Warning.** Do not run `docker volume prune`. It can destroy data belonging
to other projects on this machine, not only Factoree data.

`just down` stops the local PostgreSQL container and keeps the named volume
`factoree_postgres_data`. Only `just nuke` deletes that volume, and it prints
a warning before it does.
