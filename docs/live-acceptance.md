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

Path B, the real run, uses every dependency SDD section 66 names, on Fly
Sprites or on Kiln. **Only Path B satisfies SDD section 66.**

Read the whole document before you start any path.

## One environment file for every path

`.env.example` holds every variable the three paths need. Copy it to `.env`
and fill it once. It holds two groups.

Group A is the infrastructure of the API and the worker. `src/config/env.ts`
reads every one of them. Most already carry a working local default. Set
`FACTOREE_MASTER_KEY` to the output of `openssl rand -hex 32`, and set
`FACTOREE_PUBLIC_URL` to the URL that GitHub, Linear and your browser reach the
API at.

Group B is the four live acceptance driver variables:
`LIVE_LINEAR_API_KEY`, `LIVE_LINEAR_TEAM_ID`, `LIVE_GITHUB_TOKEN`, and
`LIVE_GITHUB_REPOSITORY`. `tests/live/scenario.ts` reads exactly these four
values, and no other `LIVE_` variable exists in this codebase. The scenario
acts as the human operator: it creates a Linear issue and delegates it.

The application keeps its own settings in the database, not in the
environment. Setup at `<FACTOREE_PUBLIC_URL>/setup` stores the GitHub App, the
Linear app, the sandbox provider and the first Product. The settings screens
change them. Factoree encrypts every stored credential with
`FACTOREE_MASTER_KEY`. No setting has an environment fallback.

Backstage and MCP are not environment-configured. Each is a
`ContextSourceConfiguration` row in the database, per Product, with `kind`
`backstage` or `mcp`. The UI has no context source screen. Create a row with:

    POST /admin/products/:id/context-sources

Every path, including Path A and Path A-Sprite, needs one enabled `backstage`
row and one enabled `mcp` row for the Product the fixture issue belongs to.
`tests/live/scenario.ts` queries these rows before it delegates the fixture
issue, and it fails with a message naming the endpoint above when a row is
missing. On Path A and Path A-Sprite, point the row endpoint at the local
stub. On Path B, point it at a real test catalog and a real test MCP source.

## `FACTOREE_LIVE_PROFILE`

Set `FACTOREE_LIVE_PROFILE` to select a path. `local` selects Path A,
`sprite` selects Path A-Sprite, and `full` selects Path B. `full` is the
default when the variable is absent or empty. An unknown value throws.

Every profile requires the four driver variables above, plus
`FACTOREE_DATABASE_URL`, `FACTOREE_TEMPORAL_ADDRESS`, and
`FACTOREE_TEMPORAL_NAMESPACE`, because the worker and the scenario both need a
real database and a real Temporal service to run against.

The sandbox provider and its key are install settings, not environment values.
The check reads them from the database where the worker reads them, under the
names below. It needs `FACTOREE_DATABASE_URL` and `FACTOREE_MASTER_KEY` to read
them. Without either value, or with a database it cannot read, the check
reports every install requirement as absent.

| Name | Install setting |
| --- | --- |
| `install.sandbox.provider` | The sandbox provider: `local`, `fly-sprites` or `kiln`. |
| `install.sandbox.apiKey` | The Fly.io token, or the Kiln API key. |
| `install.sandbox.url` | The Kiln host. |
| `install.sandbox.image` | The sandbox image by digest: the image override, or the image the release pins. |

- `local` additionally requires `install.sandbox.provider` to equal `local`,
  and `FACTOREE_UNSAFE_LOCAL_SANDBOX` to equal `1`.
- `sprite` additionally requires `install.sandbox.provider` to equal
  `fly-sprites`, and requires `install.sandbox.apiKey`.
- `full` requires the same as `sprite`. When `install.sandbox.provider` equals
  `kiln`, `full` requires `install.sandbox.url`, `install.sandbox.apiKey` and
  `install.sandbox.image` instead.

The command reports a wrong provider distinctly from an absent one, so an
operator who forgot to switch it back sees the real problem. A missing or wrong
value exits 78 with `BLOCKED_EXTERNAL`.

## Setup: the GitHub App, the Linear app, the sandbox and the Product

Every path below needs a completed setup and two context source rows. Do this
once, before you start Path A, Path A-Sprite, or Path B. Each path below refers
back to this section instead of repeating it.

### 1. Complete setup in the UI

Start the stack, then open `<FACTOREE_PUBLIC_URL>/setup` with the setup token
from the API log. `docs/quickstart.md` section 4 holds the full procedure. The
steps are:

1. The GitHub App, through the GitHub App manifest flow.
2. The Linear OAuth application, created by hand in Linear, and its install
   in the test workspace.
3. The GitHub App install on the fixture repository. Factoree binds the
   installation to the Tenant and starts discovery.
4. The sandbox provider: `local`, `fly-sprites` or `kiln`, with its key.
5. The first Product, from the Linear team of the fixture issue. Setup
   creates the Product and activates it at the selected autonomy level.
6. Finish, then sign in with Linear.

Setup replaces the old Tenant, Product, GitHub installation and Linear
installation calls of the admin API. The Linear install callback creates the
Tenant. The Product screen changes a Product after setup.

### 2. Let the Repository register itself

Factoree does not create a Repository row through setup or through the
administration API. It discovers one from the `.factoree/config.yaml` file of
the GitHub fixture repository, when the installed GitHub App reports the
repository to Factoree.

Add a `.factoree/config.yaml` file to the fixture repository. It must name the
same Product slug and Linear team key as the Product of setup, under
`identity`, and at least one `verify` command. Discovery registers the
Repository the next time the GitHub App reports the repository, and attaches
it to the Product whose slug and team match.

### 3. Publication needs no `GITHUB_TOKEN` Product secret

Factoree reads no per-Product `GITHUB_TOKEN` secret. The Factoree GitHub App
mints a scoped installation access token for each operation instead. The clone
step mints a token with `{ contents: "read" }`. The publish step mints a token
with `{ contents: "write", pull_requests: "write" }`. Neither token outlives
the operation it was minted for, and neither reaches an Implementer session.

### 3b. The one remaining credential, when a Run needs it

A Product secret carries a kind, and the kind decides which carrier holds the
value. SDD section 30 fixes the rule. `repository_read` and `publish` are
retired kinds: the GitHub App installation replaced both as the one credential
source for the sandbox checkout, for context discovery, and for publication.
`src/domain/products/secret-store.ts` documents the retirement.

A paid model needs a `runner_credential` secret. The secret name becomes the
environment variable name of the agent process. The product step of setup
stores it from the model key name and value. The Products screen adds or
replaces it later.

This secret takes no injection mark. The API also refuses a
`runner_credential` whose value holds a GitHub or a Linear credential, because
SDD section 30 forbids either in an agent session.

A free model needs no `runner_credential`.

### The Linear access token refreshes itself

A Linear access token is valid for one day. The install callback of setup
stores the refresh token and the expiry with the installation. The worker
refreshes the token with the Linear client credentials of the install
settings. The Workspaces screen shows the token expiry and whether it is
refreshable.

### Why Factoree mints a token per operation, instead of holding one

An environment variable is process wide. The worker starts agent sessions from
the same process, so a long-lived GitHub credential in the environment can
reach an agent. SDD section 30 forbids the Implementer from holding a GitHub
write credential. A scoped installation access token, minted for one operation
and discarded after, never reaches the Implementer.

Factoree also serves more than one Product, each bound to its own GitHub App
installation. A token minted per operation carries only the scope and the
repository access that operation needs, so one Product can never use another
Product's access by accident.

`LIVE_GITHUB_TOKEN` is a DIFFERENT credential from the installation access
token Factoree mints for itself. `tests/live/scenario.ts` reads
`LIVE_GITHUB_TOKEN` from the environment to act as the human operator, and to
confirm the pull request Factoree opens actually exists. Factoree mints its own
token from the GitHub App installation to push and to open that pull request.
Keep the two credentials distinct in your head, and in your `.env` file.

### 4. Create an API key

Every admin call below carries an API key in the `Authorization` header, as a
bearer token:

    Authorization: Bearer <API_KEY>

Create the key on the API keys screen of the UI. Factoree shows it only once.
It starts with `fct_`. A key acts as the person who created it, in that
person's workspaces. Only a Linear workspace admin changes records. A key
cannot create keys. Revoke the key on the same screen. The next call with it
gets 401. Factoree records every `/admin` call with the user or key id in the
`AdminAuditEntry` table.

Never write the real key into this document or into a command you paste
somewhere else.

The Workspaces screen shows the Linear workspace id. The Product page URL ends
with the Product id.

### 5. Create the Backstage context source row

Call `POST /admin/products/:id/context-sources`, defined in
`src/http/admin/context-sources.routes.ts`. Set `kind` to `"backstage"`.

    curl -s -X POST \
      "$API_BASE/admin/products/<PRODUCT_ID>/context-sources?linearWorkspaceId=<LINEAR_WORKSPACE_ID>" \
      -H "Authorization: Bearer <API_KEY>" \
      -H "Content-Type: application/json" \
      -d '{
        "sourceId": "backstage-catalog",
        "kind": "backstage",
        "endpoint": "<BACKSTAGE_CATALOG_URL>",
        "enabled": true
      }'

The local Backstage stub of `just stubs` listens at `http://localhost:4100`.

### 6. Create the MCP context source row

Call the same endpoint again. Set `kind` to `"mcp"`. An `mcp` row must name
its discover tool and its fetch tool in `settings`.

    curl -s -X POST \
      "$API_BASE/admin/products/<PRODUCT_ID>/context-sources?linearWorkspaceId=<LINEAR_WORKSPACE_ID>" \
      -H "Authorization: Bearer <API_KEY>" \
      -H "Content-Type: application/json" \
      -d '{
        "sourceId": "mcp-source",
        "kind": "mcp",
        "endpoint": "<MCP_SOURCE_URL>",
        "enabled": true,
        "settings": { "kind": "mcp", "discoverTool": "search", "fetchTool": "fetch" }
      }'

The local MCP stub of `just stubs` listens at `http://localhost:4200` and
answers any tool name.

`src/domain/context/context-source-configuration.ts` fixes the two valid
`kind` values to `"backstage"` and `"mcp"`. Every path, including Path A and
Path A-Sprite, needs one enabled row of each kind for the Product the fixture
issue belongs to.

## Path A: the local run

This path needs only a Linear account and a GitHub account. Both providers
offer a free plan. No other account is required for this path.

### What this path proves and what it does not prove

The local run substitutes local infrastructure for the sandbox provider, the
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

1. A Linear test workspace. Do not use a production workspace. You must be an
   admin of it.
2. A GitHub fixture repository. Do not use a production repository.

If `gh` is already authenticated on your machine, the GitHub step can reuse
that session. Run `gh auth status` to check.

### Credentials

Copy `.env.example` to `.env`. Fill the four Group B values, and set
`FACTOREE_MASTER_KEY` and `FACTOREE_PUBLIC_URL`. Set
`FACTOREE_UNSAFE_LOCAL_SANDBOX=1`. The install settings refuse the local
sandbox without that flag, because it isolates nothing. Leave
`FACTOREE_DATABASE_URL`, `FACTOREE_TEMPORAL_ADDRESS`, and
`FACTOREE_TEMPORAL_NAMESPACE` at their defaults unless you change a port.

| Name | Dependency | Value |
| --- | --- | --- |
| `LIVE_LINEAR_API_KEY` | Linear | A personal API key of the Linear test workspace. |
| `LIVE_LINEAR_TEAM_ID` | Linear | The Linear team the live test creates its fixture issue in. |
| `LIVE_GITHUB_TOKEN` | GitHub | A token with write access to the GitHub fixture repository only. |
| `LIVE_GITHUB_REPOSITORY` | GitHub | The fixture repository, as owner/name. It must not be a production repository. |
| `FACTOREE_UNSAFE_LOCAL_SANDBOX` | Sandbox | Must equal `1`. |
| `install.sandbox.provider` | Sandbox | Must equal `local`. Select it in the sandbox step of setup. |

### Procedure

Run every command from the repository root. The `justfile` drives this path.

1. Run `just` to list every recipe.
2. In a separate terminal, run `just tunnel` to start a public tunnel to the
   HTTP API. Copy the public URL it prints into `FACTOREE_PUBLIC_URL`. Linear
   and GitHub must reach the API over the public internet. This is the one
   part of the local path that is not purely local.
3. Run `just install` to install the npm dependencies and generate the Prisma
   client.
4. Run `just up` to start the local PostgreSQL container.
5. Run `just migrate` to apply the Prisma migrations.
6. In a separate terminal, run `just temporal` to start the Temporal dev
   server.
7. In a separate terminal, run `just stubs` to start the Backstage stub and
   the MCP stub.
8. In a separate terminal, run `just worker` to start the Temporal worker.
9. In a separate terminal, run `just api` to start the HTTP API and the UI.
10. Complete the "Setup" section above. Select the `local` sandbox provider.
    Register the local Backstage stub and the local MCP stub as context source
    rows.
11. Run `just live-local` to run the live acceptance scenario against the
    local infrastructure.
12. Run `just down` to stop the local PostgreSQL container when you finish.

If the run fails, check the printed report first, then check the stub logs,
then check the worker logs.

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
debug the Sprite integration on its own.

### Cost

Linear has a free plan. GitHub is free. The Temporal dev server, the
Backstage stub, and the MCP stub run locally at no cost. **Fly.io charges
money for a Sprite.** Check the Fly.io pricing page for the current rate. Do
not rely on a number in this document to stay accurate. The coding-agent
runner costs a small amount per Run in model tokens.

### Accounts to create first

1. A Linear test workspace. Do not use a production workspace. You must be an
   admin of it.
2. A GitHub fixture repository. Do not use a production repository.
3. A Fly.io organization that can create a Sprite.

Create a Fly.io token that can create and delete a Sprite.

### The sandbox provider

The worker reads the sandbox provider from the install settings. Select
`fly-sprites` in the sandbox step of setup, and enter the Fly.io token. After
setup, change the provider on the Install settings screen. A provider left
over from a Path A run can be `local`. That value defeats this path, and the
acceptance command reports it as a wrong value, not an absent one.

### Credentials

Copy `.env.example` to `.env`. Fill the four Group B values, and set
`FACTOREE_MASTER_KEY` and `FACTOREE_PUBLIC_URL`.

| Name | Dependency | Value |
| --- | --- | --- |
| `LIVE_LINEAR_API_KEY` | Linear | A personal API key of the Linear test workspace. |
| `LIVE_LINEAR_TEAM_ID` | Linear | The Linear team the live test creates its fixture issue in. |
| `LIVE_GITHUB_TOKEN` | GitHub | A token with write access to the GitHub fixture repository only. |
| `LIVE_GITHUB_REPOSITORY` | GitHub | The fixture repository, as owner/name. It must not be a production repository. |
| `install.sandbox.provider` | Fly Sprites | Must equal `fly-sprites`. |
| `install.sandbox.apiKey` | Fly Sprites | A Fly.io token that can create and delete a Sprite. |

### Procedure

Run every command from the repository root. The `justfile` drives this path.

1. Run `just` to list every recipe.
2. In a separate terminal, run `just tunnel`. Copy the public URL it prints
   into `FACTOREE_PUBLIC_URL`.
3. Run `just install` to install the npm dependencies and generate the Prisma
   client.
4. Run `just up` to start the local PostgreSQL container.
5. Run `just migrate` to apply the Prisma migrations.
6. In a separate terminal, run `just temporal` to start the Temporal dev
   server.
7. In a separate terminal, run `just stubs` to start the Backstage stub and
   the MCP stub.
8. In a separate terminal, run `just worker` to start the Temporal worker.
9. In a separate terminal, run `just api` to start the HTTP API and the UI.
10. Complete the "Setup" section above. Select the `fly-sprites` sandbox
    provider. Register the local Backstage stub and the local MCP stub as
    context source rows.
11. Optionally, run `just smoke owner/name` to drive one Sprite through every
    sandbox step of a Run. It reads the Sprites token from the install
    settings.
12. Run `just live-sprite` to run the live acceptance scenario against local
    infrastructure and a real Fly Sprite.
13. Run `just down` to stop the local PostgreSQL container when you finish.

If the run fails, check the printed report first, then check the worker logs.

## Path B: the real run, SDD section 66 proof

This path uses every dependency SDD section 66 names: a real Linear
workspace, a real GitHub fixture repository, a real sandbox (a Fly Sprite or a
Kiln sandbox), a real Temporal service, at least one real coding-agent runner,
a test Backstage catalog, and a test MCP source. Only a pass on this path
satisfies SDD section 66.

### Command

    FACTOREE_LIVE_PROFILE=full npm run acceptance:live

`full` is the default profile, so `npm run acceptance:live` alone runs Path
B too. `just live` runs the same command with the values of `.env`.

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
- Fly.io charges money for a Sprite. Check the Kiln host for its own cost.
- The coding-agent runner costs a small amount per Run in model tokens.
- Check the Backstage host and the MCP source you choose for their own cost.

### Setup, one numbered list per provider

**Linear**

1. Create a Linear test workspace. Do not use a production workspace. You
   must be an admin of it.
2. Create the Linear OAuth application and install it through setup.
   `docs/quickstart.md` section 4.2 holds the steps.
3. Create a personal API key in the workspace settings. Put it in
   `LIVE_LINEAR_API_KEY`.
4. Copy the ID of the Linear team the live test must create its fixture
   issue in. Put it in `LIVE_LINEAR_TEAM_ID`.

**GitHub**

1. Create a GitHub fixture repository. Do not use a production repository.
2. Create the GitHub App and install it on the fixture repository through
   setup.
3. If `gh` is already authenticated as your account, reuse that session
   instead of a new token.
4. Create a token with write access to the fixture repository only. Put it
   in `LIVE_GITHUB_TOKEN`.
5. Copy the repository name as `owner/name`. Put it in
   `LIVE_GITHUB_REPOSITORY`.

**Sandbox: Fly**

1. Create or choose a Fly.io organization that can create a Sprite.
2. Create a Fly.io token that can create and delete a Sprite.
3. In setup, or on the Install settings screen, select `fly-sprites` and
   enter the token.

**Sandbox: Kiln**

1. Get the Kiln host URL and a key of the Factoree tenant on that host.
2. In setup, or on the Install settings screen, select `kiln`. Enter the URL
   and the key.
3. A build from a checkout pins no sandbox image. Enter the sandbox image by
   digest, as `<name>@sha256:<hex>`. For a private image, enter the registry
   username and the registry token.

**Temporal**

1. Create a real Temporal service. Temporal Cloud and a self-hosted service
   both work. The local dev server of Path A does not satisfy this path.
2. Copy the host and port of that service. Put it in
   `FACTOREE_TEMPORAL_ADDRESS`.
3. Copy the namespace of that service. Put it in
   `FACTOREE_TEMPORAL_NAMESPACE`.
4. If the service demands an API key, put it in `FACTOREE_TEMPORAL_API_KEY`.

**Runner**

1. Choose the coding-agent runners in the `agents` section of
   `.factoree/config.yaml`.
2. Set the Product model, the effort per role and the model key on the
   Products screen. This path needs no `LIVE_` credential for the runner,
   because the worker reads the Product settings.

**Backstage**

1. Create a test Backstage catalog with at least one component entity.
2. Register it as a context source row for the Product with
   `POST /admin/products/:id/context-sources`, `kind` `backstage`, and
   `enabled` true.

**MCP**

1. Create a test MCP source that answers a search.
2. Register it as a context source row for the Product with
   `POST /admin/products/:id/context-sources`, `kind` `mcp`, `enabled` true,
   and the discover tool and the fetch tool in `settings`.

### Full requirement table

The `full` profile checks these values. `FACTOREE_MASTER_KEY` must also be
present, so the check can read the install settings.

| Name | Dependency | Requirement |
| --- | --- | --- |
| `LIVE_LINEAR_API_KEY` | Linear | Present. A personal API key of the Linear test workspace. |
| `LIVE_LINEAR_TEAM_ID` | Linear | Present. The Linear team the live test creates its fixture issue in. |
| `LIVE_GITHUB_TOKEN` | GitHub | Present. A token with write access to the GitHub fixture repository only. |
| `LIVE_GITHUB_REPOSITORY` | GitHub | Present. The fixture repository, as owner/name. It must not be a production repository. |
| `FACTOREE_DATABASE_URL` | Database | Present. The PostgreSQL connection string src/config/env.ts requires. |
| `FACTOREE_TEMPORAL_ADDRESS` | Temporal | Present. The host and port of the real Temporal service. |
| `FACTOREE_TEMPORAL_NAMESPACE` | Temporal | Present. The Temporal namespace of the live acceptance run. |

With Fly Sprites:

| Name | Dependency | Requirement |
| --- | --- | --- |
| `install.sandbox.provider` | Fly Sprites | Must equal `fly-sprites`. |
| `install.sandbox.apiKey` | Fly Sprites | Present. A Fly.io token that can create and delete a Sprite. |

With Kiln:

| Name | Dependency | Requirement |
| --- | --- | --- |
| `install.sandbox.provider` | Kiln | Must equal `kiln`. |
| `install.sandbox.url` | Kiln | Present. The Kiln host. |
| `install.sandbox.apiKey` | Kiln | Present. A key of the Factoree tenant on the Kiln host. |
| `install.sandbox.image` | Kiln | Present. The sandbox image by digest: the image override, or the image the release pins. |

Backstage and MCP name no environment variable. Each needs one enabled
`ContextSourceConfiguration` row, registered through
`POST /admin/products/:id/context-sources`.

### Procedure

1. Copy `.env.example` to `.env`. Fill every Group B value listed above, and
   set the Group A values of the real Temporal service, `FACTOREE_MASTER_KEY`
   and `FACTOREE_PUBLIC_URL`.
2. Start PostgreSQL and apply the migrations with `npm run db:migrate`.
3. Start the worker against the real Temporal service, and start the API.
4. Complete the "Setup" section above. Select `fly-sprites` or `kiln` as the
   sandbox provider. Register the test Backstage catalog and the test MCP
   source as context source rows, so the worker can reach them.
5. Run `npm run acceptance:live`.
6. Read the printed report.

### What the command proves

The command exits 0 only when every fact of the SDD section 67 "Live proof"
list holds. It first confirms the Product carries an enabled Backstage row
and an enabled MCP row. It then creates a real fixture issue in the Linear
test workspace, delegates it to Factoree, and waits for the Proof Pack
comment. It reads the Proof Pack sections to confirm that context resolution
ran, the Validation Contract froze, deterministic verification ran, review
ran, and the sandbox changed code. It then confirms the linked pull request
exists in the real GitHub fixture repository. The command names each fact it
cannot prove, and it prints one line for each.

### What the command cannot prove alone

The scenario reads facts from the Proof Pack comment Factoree posts in
Linear. It does not itself drive the coding-agent runner. It does not itself
create the sandbox. An operator must confirm the worker process runs against
every value above before the command starts. Otherwise the scenario times out
and reports every fact absent.

`docs/build/handover.md` records each live pass.

## Troubleshooting: disk space

Docker can hold a large amount of reclaimable disk space in build cache. If
the disk fills, run `docker builder prune` first. This reclaim is safe.

**Warning.** Do not run `docker volume prune`. It can destroy data belonging
to other projects on this machine, not only Factoree data.

`just down` stops the local PostgreSQL container and keeps the named volume
`factoree_postgres_data`. Only `just nuke` deletes that volume, and it prints
a warning before it does.

## Troubleshooting: missing GitHub App installation

A run can fail at the last step, after refinement, context resolution,
validation, implementation, verification, and review already ran, with a
configuration error naming the GitHub App installation. The target
repository carries no installation, or the installation was removed.

To add the repository to an installation that is already bound, add it in the
GitHub App settings. Discovery reads it from the `installation_repositories`
event.

A new installation has a new id. Before setup completes, GitHub returns to
`/setup/github/installed`, and Factoree binds the installation to the Tenant.
After setup completes, `/setup` refuses the call. Bind the new installation
with the admin API instead:

    curl -s -X PUT "$API_BASE/admin/github-installations" \
      -H "Authorization: Bearer <API_KEY>" \
      -H "Content-Type: application/json" \
      -d '{
        "linearWorkspaceId": "<LINEAR_WORKSPACE_ID>",
        "githubInstallationId": "<GITHUB_INSTALLATION_ID>",
        "accountLogin": "<GITHUB_OWNER>"
      }'

The Workspaces screen shows the GitHub installations of each workspace.
