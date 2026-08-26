# Live acceptance

SDD section 66 requires one live proof of Factoree Version 1. This document
holds three paths.

Path A, the local run, uses local infrastructure. It proves the scenario code
runs. **It does NOT satisfy SDD section 66 and it is NOT SDD section 66
proof.**

Path A-Sprite, the sprite run, is Path A plus a real Fly Sprite. It lets an
operator debug the Sprite integration without a Backstage instance and
without a Temporal Cloud account. **It does NOT satisfy SDD section 66 and it
is NOT SDD section 66 proof.**

Path B, the real run, uses every dependency SDD section 66 names. **Only Path
B satisfies SDD section 66.**

Read the whole document before you start any path.

## One environment file for every path

`.env.example` holds every variable the three paths need. Copy it to `.env`
and fill it once. It holds two groups.

Group A is the application variables. `src/config/env.ts` reads every one of
them. Most already carry a working local default.

Group B is the four live acceptance driver variables:
`LIVE_LINEAR_API_KEY`, `LIVE_LINEAR_TEAM_ID`, `LIVE_GITHUB_TOKEN`, and
`LIVE_GITHUB_REPOSITORY`. `tests/live/scenario.ts` reads exactly these four
values, and no other `LIVE_` variable exists in this codebase. The scenario
acts as the human operator: it creates a Linear issue and delegates it. The
application itself keeps its own Linear and GitHub credentials in the
database, not in the environment.

Backstage and MCP are not environment-configured. Each is a
`ContextSourceConfiguration` row in the database, per Project, with `kind`
`backstage` or `mcp`. Create a row with:

    POST /admin/projects/:id/context-sources

Every path, including Path A and Path A-Sprite, needs one enabled `backstage`
row and one enabled `mcp` row for the Project the fixture issue belongs to.
`tests/live/scenario.ts` queries these rows before it delegates the fixture
issue, and it fails with a message naming the endpoint above when a row is
missing. On Path A and Path A-Sprite, point the row endpoint at the local
stub. On Path B, point it at a real test catalog and a real test MCP source.

## `FACTOREE_LIVE_PROFILE`

Set `FACTOREE_LIVE_PROFILE` to select a path. `local` selects Path A,
`sprite` selects Path A-Sprite, and `full` selects Path B. `full` is the
default when the variable is absent or empty. An unknown value throws.

Every profile requires the four driver variables above, plus `DATABASE_URL`,
`TEMPORAL_ADDRESS`, and `TEMPORAL_NAMESPACE`, because the worker and the
scenario both need a real database and a real Temporal service to run
against.

- `local` additionally requires `SANDBOX_ADAPTER` to equal `local`.
- `sprite` and `full` additionally require `SANDBOX_ADAPTER` to equal
  `fly-sprites`, and require `SPRITES_TOKEN`.

The command reports a wrong `SANDBOX_ADAPTER` value distinctly from an
absent one, so an operator who forgot to switch it back sees the real
problem.

## Path A: the local run

This path needs only a Linear account and a GitHub account. Both providers
offer a free plan. No other account is required for this path.

### What this path proves and what it does not prove

The local run substitutes local infrastructure for the Fly Sprite, the
Backstage catalog, and the MCP source. A pass proves that
`tests/live/scenario.ts` runs correctly against a real Linear workspace and a
real GitHub repository. **A pass here is NOT SDD section 66 proof.** Only
Path B, the real run against every named dependency, satisfies SDD section
66.

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

### Credentials

Copy `.env.example` to `.env`. Fill the four Group B values. Set
`SANDBOX_ADAPTER=local`. Leave `DATABASE_URL`, `TEMPORAL_ADDRESS`, and
`TEMPORAL_NAMESPACE` at their defaults unless you change a port.

| Variable | Dependency | Value |
| --- | --- | --- |
| `LIVE_LINEAR_API_KEY` | Linear | A personal API key of the Linear test workspace. |
| `LIVE_LINEAR_TEAM_ID` | Linear | The Linear team the live test creates its fixture issue in. |
| `LIVE_GITHUB_TOKEN` | GitHub | A token with write access to the GitHub fixture repository only. |
| `LIVE_GITHUB_REPOSITORY` | GitHub | The fixture repository, as owner/name. It must not be a production repository. |

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
11. Register the local Backstage stub and the local MCP stub as context source rows with
    `POST /admin/projects/:id/context-sources`.
12. Run `just live-local` to run the live acceptance scenario against the local infrastructure.
13. Run `just down` to stop the local PostgreSQL container when you finish.

Commands 1, 2, 3, 4, and 13 have recorded evidence from a real run on this
machine. Commands 5 through 12 have not run to completion in this
repository. `tests/live/scenario.ts` has never executed against a real
service.

**Expect defects on the first run of `just live-local`.** Do not assume a
failure is your own setup error. Check the printed report first, then check
the stub logs, then check the worker logs.

## Path A-Sprite: the sprite run

This path needs a Linear account, a GitHub account, and a Fly.io account that
can create a Sprite. It needs no Backstage instance and no Temporal Cloud
account.

### What this path proves and what it does not prove

The sprite run is Path A plus a real Fly Sprite in place of the local
sandbox. It substitutes local infrastructure only for the Backstage catalog
and the MCP source. A pass proves that `tests/live/scenario.ts` runs against
a real Fly Sprite, a real Linear workspace, and a real GitHub repository.
**A pass here is NOT SDD section 66 proof.** Only Path B, the real run
against every named dependency, satisfies SDD section 66. Use this path to
debug the Sprite integration on its own, because `tests/live/scenario.ts` has
never executed against a real Sprite.

### Cost

Linear has a free plan. GitHub is free. The Temporal dev server, the
Backstage stub, and the MCP stub run locally at no cost. **Fly.io charges
money for a Sprite.** Check the Fly.io pricing page for the current rate. Do
not rely on a number in this document to stay accurate. The coding-agent
runner costs a small amount per Run in model tokens.

### Accounts to create first

1. A Linear test workspace. Do not use a production workspace.
2. A GitHub fixture repository. Do not use a production repository.
3. A Fly.io organization that can create a Sprite.

Install the Factoree Linear app on the test workspace before you run the
scenario. Create a Fly.io token that can create and delete a Sprite.

### The sandbox adapter

The worker reads `SANDBOX_ADAPTER` from `src/config/env.ts`. Set
`SANDBOX_ADAPTER=fly-sprites` in your `.env` file. A value left over from a
Path A run can set `SANDBOX_ADAPTER=local`. That value defeats this path,
and the acceptance command now reports it as a wrong value, not an absent
one.

The worker also needs `SPRITES_TOKEN`, the same Fly.io token
`src/config/env.ts` requires whenever `SANDBOX_ADAPTER` is `fly-sprites`.
Set `SPRITES_TOKEN` in your `.env` file too.

### Credentials

Copy `.env.example` to `.env`. Fill the four Group B values, set
`SANDBOX_ADAPTER=fly-sprites`, and set `SPRITES_TOKEN`.

| Variable | Dependency | Value |
| --- | --- | --- |
| `LIVE_LINEAR_API_KEY` | Linear | A personal API key of the Linear test workspace. |
| `LIVE_LINEAR_TEAM_ID` | Linear | The Linear team the live test creates its fixture issue in. |
| `LIVE_GITHUB_TOKEN` | GitHub | A token with write access to the GitHub fixture repository only. |
| `LIVE_GITHUB_REPOSITORY` | GitHub | The fixture repository, as owner/name. It must not be a production repository. |
| `SANDBOX_ADAPTER` | Fly Sprites | Must equal `fly-sprites`. |
| `SPRITES_TOKEN` | Fly Sprites | A Fly.io token that can create and delete a Sprite. |

### Procedure

Run every command from the repository root. The `justfile` drives this path.

1. Run `just` to list every recipe.
2. Run `just install` to install the npm dependencies and generate the Prisma client.
3. Run `just up` to start the local PostgreSQL container.
4. Run `just migrate` to apply the Prisma migrations.
5. In a separate terminal, run `just temporal` to start the Temporal dev server.
6. In a separate terminal, run `just stubs` to start the Backstage stub and the MCP stub.
7. Set `SANDBOX_ADAPTER=fly-sprites` and `SPRITES_TOKEN` in `.env` first.
8. In a separate terminal, run `just worker` to start the Temporal worker.
9. In a separate terminal, run `just api` to start the HTTP API.
10. In a separate terminal, run `just tunnel` to start a public tunnel to the HTTP API. Copy
    the public URL the tunnel command prints.
11. Set the public URL as the webhook target in the Linear app settings of the test workspace.
12. Register the local Backstage stub and the local MCP stub as context source rows with
    `POST /admin/projects/:id/context-sources`.
13. Run `just live-sprite` to run the live acceptance scenario against local infrastructure and
    a real Fly Sprite.
14. Run `just down` to stop the local PostgreSQL container when you finish.

**Expect defects on the first run of `just live-sprite`.** `tests/live/scenario.ts` has never
executed against a real Sprite. Check the printed report first, then check the worker logs.

## Path B: the real run, SDD section 66 proof

This path uses every dependency SDD section 66 names: a real Linear
workspace, a real GitHub fixture repository, a real Fly Sprite, a real
Temporal service, at least one real coding-agent runner, a test Backstage
catalog, and a test MCP source. Only a pass on this path satisfies SDD
section 66.

### Command

    FACTOREE_LIVE_PROFILE=full npm run acceptance:live

`full` is the default profile, so `npm run acceptance:live` alone runs Path
B too.

The command exits 0 only when every live fact of the SDD section 67 "Live
proof" list holds. It exits 78 and prints `BLOCKED_EXTERNAL` when a required
value is absent or holds the wrong value. `BLOCKED_EXTERNAL` is not
equivalent to `DONE`. See SDD section 66.

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
2. Create a Fly.io token that can create and delete a Sprite. Put it in
   `SPRITES_TOKEN`. Set `SANDBOX_ADAPTER=fly-sprites`.

**Temporal**

1. Create a real Temporal service. Temporal Cloud and a self-hosted service
   both work. The local dev server of Path A does not satisfy this path.
2. Copy the host and port of that service. Put it in `TEMPORAL_ADDRESS`.
3. Copy the namespace of that service. Put it in `TEMPORAL_NAMESPACE`.

**Runner**

1. Choose one coding-agent runner and configure it through the worker's own
   runner registry. This path needs no `LIVE_` credential for the runner,
   because the worker reads its own runner configuration.

**Backstage**

1. Create a test Backstage catalog with at least one component entity.
2. Register it as a context source row for the Project with
   `POST /admin/projects/:id/context-sources`, `kind` `backstage`, and
   `enabled` true.

**MCP**

1. Create a test MCP source that answers a search.
2. Register it as a context source row for the Project with
   `POST /admin/projects/:id/context-sources`, `kind` `mcp`, and `enabled`
   true.

### Full requirement table

| Variable | Dependency | Requirement |
| --- | --- | --- |
| `LIVE_LINEAR_API_KEY` | Linear | Present. A personal API key of the Linear test workspace. |
| `LIVE_LINEAR_TEAM_ID` | Linear | Present. The Linear team the live test creates its fixture issue in. |
| `LIVE_GITHUB_TOKEN` | GitHub | Present. A token with write access to the GitHub fixture repository only. |
| `LIVE_GITHUB_REPOSITORY` | GitHub | Present. The fixture repository, as owner/name. It must not be a production repository. |
| `DATABASE_URL` | Database | Present. The PostgreSQL connection string src/config/env.ts requires. |
| `TEMPORAL_ADDRESS` | Temporal | Present. The host and port of the real Temporal service. |
| `TEMPORAL_NAMESPACE` | Temporal | Present. The Temporal namespace of the live acceptance run. |
| `SANDBOX_ADAPTER` | Fly Sprites | Must equal `fly-sprites`. |
| `SPRITES_TOKEN` | Fly Sprites | Present. A Fly.io token that can create and delete a Sprite. |

Backstage and MCP name no environment variable. Each needs one enabled
`ContextSourceConfiguration` row, registered through
`POST /admin/projects/:id/context-sources`.

### Procedure

1. Copy `.env.example` to `.env`. Fill every Group B value listed above, and
   set `SANDBOX_ADAPTER` and `SPRITES_TOKEN`.
2. Start PostgreSQL and apply the migrations with `npm run db:migrate`.
3. Start the worker against the real Temporal service.
4. Register the test Backstage catalog and the test MCP source as context
   source rows with `POST /admin/projects/:id/context-sources`, so the
   worker can reach them.
5. Run `npm run acceptance:live`.
6. Read the printed report.

### What the command proves

The command exits 0 only when every fact of the SDD section 67 "Live proof"
list holds. It first confirms the Project carries an enabled Backstage row
and an enabled MCP row. It then creates a real fixture issue in the Linear
test workspace, delegates it to Factoree, and waits for the Proof Pack
comment. It reads the Proof Pack sections to confirm that context resolution
ran, the Validation Contract froze, deterministic verification ran, review
ran, and the Fly Sprite changed code. It then confirms the linked pull
request exists in the real GitHub fixture repository. The command names each
fact it cannot prove, and it prints one line for each.

### What the command cannot prove alone

The scenario reads facts from the Proof Pack comment Factoree posts in
Linear. It does not itself drive the coding-agent runner. It does not itself
create the Fly Sprite. An operator must confirm the worker process runs
against every value above before the command starts. Otherwise the scenario
times out and reports every fact absent.

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
