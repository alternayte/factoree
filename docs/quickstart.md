# Quickstart: a live local run

This document runs Factoree from a checkout against a real Linear workspace, a
real GitHub repository, a real sandbox provider, a local Temporal dev server,
and a PostgreSQL container. With Fly Sprites, `docs/live-acceptance.md` calls
this Path A-Sprite. It is not SDD section 66 proof.

The environment file holds infrastructure only. The setup screens of the UI
configure the GitHub App, the Linear app, the sandbox provider and the first
Product. Factoree stores these settings in PostgreSQL and encrypts every
credential with `FACTOREE_MASTER_KEY`. No setting has an environment fallback.

For the local process sandbox instead of a real provider, set
`FACTOREE_UNSAFE_LOCAL_SANDBOX=1` in `.env`, select `local` in the sandbox step
of setup, and run `just live-local` at the end. The local sandbox isolates
nothing. Use it on a development machine only.

## 1. Accounts

1. A Linear test workspace. You must be an admin of it.
2. A GitHub fixture repository. Do not use a production repository.
3. A sandbox provider account: a Fly.io organization that can create a
   Sprite, a Kiln host with a key of the Factoree tenant, or an E2B account.
4. A model provider key, unless the Product uses a free model.
5. `jq`, `docker`, `ngrok`, and the `temporal` CLI on your machine.

## 2. The environment file

Copy `.env.example` to `.env`. Fill these values. Every other value already
holds a working local default.

| Variable | Value |
| --- | --- |
| `FACTOREE_MASTER_KEY` | The output of `openssl rand -hex 32`. Factoree refuses the placeholder. Keep the key. A new key makes every stored credential unreadable. |
| `FACTOREE_PUBLIC_URL` | The URL that `just tunnel` prints. Section 3 starts the tunnel. |
| `LIVE_LINEAR_API_KEY` | A personal API key of the test workspace. The test driver uses it. |
| `LIVE_LINEAR_TEAM_ID` | The team the test driver creates its fixture issue in. |
| `LIVE_GITHUB_TOKEN` | A token with write access to the fixture repository. The test driver uses it. |
| `LIVE_GITHUB_REPOSITORY` | The fixture repository, as `owner/name`. |

Leave an optional value empty. The `justfile` skips an empty value, so an
empty `FACTOREE_TEMPORAL_API_KEY` does not break the start.

`LIVE_GITHUB_TOKEN` belongs to the test driver, which acts as the human
operator. Factoree needs no GitHub token: it mints every clone credential and
every publish credential against the GitHub App installation instead.

## 3. Start the stack

Run each command from the repository root. Run each long-running command in
its own terminal.

    just tunnel      # a public URL for the API
    just install     # npm dependencies of the API and the UI, and the Prisma client
    just up          # the PostgreSQL container
    just migrate     # the Prisma migrations
    just temporal    # the Temporal dev server
    just stubs       # the Backstage stub and the MCP stub
    just worker      # the Temporal worker
    just api         # the HTTP API and the UI

Start `just tunnel` first. Copy the URL it prints into `FACTOREE_PUBLIC_URL`
before you start `just api`. GitHub, Linear and your browser reach the API at
this URL.

`just worker` and `just api` compile the TypeScript first. `just api` also
builds the UI in `ui/dist` and serves it from the same origin as the API.

## 4. Complete setup

Until setup completes, the API log holds this line:

    setup is not complete. Open <FACTOREE_PUBLIC_URL>/setup and enter the setup token <token>

Open that URL and enter the token. Each start of the API before setup
completes issues a new token, and the old token stops working. `/setup`
accepts only the current token until setup completes.

Do the steps in this order.

### 4.1 The GitHub App

Factoree authenticates to GitHub through one GitHub App. Setup creates it
through the GitHub App manifest flow.

1. Enter the App name.
2. To create the App under an organization, enter the organization. Leave it
   empty to create the App under your own account.
3. For GitHub Enterprise, enter its web URL and its API URL. Leave both empty
   for github.com.
4. Continue to GitHub, and create the App there.

GitHub creates the App with exactly these repository permissions:

| Permission | Access |
| --- | --- |
| Contents | Read and write |
| Pull requests | Read and write |
| Deployments | Read |
| Metadata | Read |

The App subscribes to the `Push` and `Deployment status` events. A
`deployment_status` event carries the pull request preview URL that CI
publishes, and Factoree adds it to the Linear session. GitHub delivers the
`installation` and the `installation_repositories` events to every App
automatically. The webhook URL is `<FACTOREE_PUBLIC_URL>/webhooks/github`.

GitHub then returns to `/setup/github/created`. Factoree stores the App id, the
private key, the webhook secret and the client credentials, encrypted.

### 4.2 The Linear app

Create the Linear OAuth application by hand. Linear has no manifest flow.

1. In Linear, open Settings > API > OAuth applications. Create an application.
2. Add the two callback URLs that setup shows:
   - `<FACTOREE_PUBLIC_URL>/api/linear/callback`, for the app install.
   - `<FACTOREE_PUBLIC_URL>/api/auth/callback/linear`, for sign-in.
3. Turn on webhooks. Set the webhook URL to `<FACTOREE_PUBLIC_URL>/webhooks/linear`.
   Select the Agent session events.
4. In setup, enter the client id, the client secret and the webhook signing
   secret.
5. Click Install in Linear, and approve the grant.

The install grant acts as the app (`actor=app`), with the scopes `read`,
`write`, `app:assignable` and `app:mentionable`. The callback stores the
installation with its refresh token and creates the Tenant. Factoree refreshes
the Linear access token itself, with the client credentials from this step.

### 4.3 Install the GitHub App

Install the App on the fixture repository. GitHub returns to
`/setup/github/installed`. Factoree checks that the installation belongs to the
App, binds it to the Tenant, and starts discovery.

### 4.4 The sandbox provider

Select one provider.

- `kiln`: enter the Kiln URL and the API key. A build from a checkout pins no
  sandbox image, so enter the image by digest, as `<name>@sha256:<hex>`. For
  a private image, enter the registry username and the registry token.
- `e2b`: enter the E2B API key. The URL is optional. Enter it only for a
  self-hosted E2B. Its host name is the E2B domain. The image rules of `kiln`
  apply.
- `fly-sprites`: enter the Fly.io token. The API URL is optional.
- `local`: setup offers it only when `FACTOREE_UNSAFE_LOCAL_SANDBOX=1`.

The sandbox limit (`sandboxMaxLive`) is optional. At the limit Factoree deletes
its oldest retained sandbox, or the run waits for a free one. One run holds two
live sandboxes: the work sprite and its check sprite.

For `kiln` and `e2b`, the vCPUs and the memory of each sandbox are optional. Empty fields
use 4 vCPUs and 4096 MB. Kiln does not refuse a size the host cannot hold, so
make memory × the sandbox limit fit the memory of the Kiln host. On a Scaleway
Dedibox Start-2-L (12 threads, 32 GB), 4096 MB and a limit of 6 leave headroom
for three runs. A size change builds a new Kiln template, and the next run of
each repository starts cold.

### 4.5 The first Product

1. Select the Linear team of the fixture issue. One Linear team maps to one
   Product.
2. Enter the slug and the name.
3. Select the autonomy level. The default is L2.
4. Enter the model as `provider/model`, for example `deepseek/deepseek-flash`.
5. For a paid model, enter the name and the value of the model key. The name
   is the environment variable the agent reads, for example
   `DEEPSEEK_API_KEY`. Factoree stores the key as a `runner_credential`
   Product secret.

Factoree creates the Product and activates it at the selected level.

### 4.6 Finish and sign in

Click Finish. Then click "Sign in with Linear". Sign-in is a separate grant
from the app install.

Only a member of a Linear workspace that has Factoree installed can sign in.
Factoree refuses every other account. A Linear workspace admin is a Factoree
admin of that workspace. A member reads the settings. An admin changes them.

## 5. The repository file

Factoree does not create a Repository row through setup. Discovery creates it
from the `.factoree/config.yaml` file of the fixture repository. Discovery reads
the file when the App is installed on the repository, and on each push to the
default branch that changes the file.

The Sprite holds Claude Code and no opencode, so a repository that uses
opencode installs it in its bootstrap. The Sprite runs npm 12, which runs no
install script, so the bootstrap also runs the opencode postinstall (DI-14.19).
This file runs a Run with opencode:

    version: 1
    identity:
      product: <PRODUCT_SLUG>
      linear:
        teamKey: <LINEAR_TEAM_KEY>
    bootstrap:
      command: npm install -g --prefix /home/sprite/.local opencode-ai && cd /home/sprite/.local/lib/node_modules/opencode-ai && node postinstall.mjs
    verify:
      commands:
        - name: tree-clean
          run: git diff --check HEAD
    agents:
      implementer: opencode
      validator: opencode
      reviewer: opencode
    sandbox:
      allowedDomains: [registry.npmjs.org, opencode.ai, models.dev]

The Product allow list is the ceiling, so the repository list cannot add a host
the Product does not allow. Open the Product on the Products screen. Add
`registry.npmjs.org`, `opencode.ai` and `models.dev` to its allowed domains,
plus the host of the model provider.

On Kiln, the bootstrap runs again in every sandbox that forks the warm
snapshot: the work sprite and each check sprite. Write it so that a second run
with the same lockfile does almost nothing, and so that it never rewrites a
tracked file, because a rewritten lockfile enters the verified patch.

- `go mod download`, `dotnet restore --locked-mode`, `uv sync --frozen` and
  `pnpm install --frozen-lockfile` already skip work that is done.
- `npm ci` deletes `node_modules` on every run. Skip it when the lockfile is
  unchanged:

      h=$(sha256sum package-lock.json | cut -c1-64) && { [ "$(cat node_modules/.lock-sha 2>/dev/null)" = "$h" ] || { npm ci && echo "$h" > node_modules/.lock-sha; }; }

- `npm install` rewrites `package-lock.json`. Do not use it in a bootstrap.
- Do not build the app in the bootstrap. Each sandbox pays for the build, and
  the preview builds again.

`warm.command` runs once, after the bootstrap, only when Factoree takes the
warm snapshot. It does not run in a fork. Use it to fill the build caches of
the stack, so that the builds in each sandbox are incremental
(docs/specs/run-speed.md):

    warm:
      command: go build ./... && go test -run '^$' ./...

- Go: `go build ./...` fills `GOCACHE`.
- .NET: `dotnet build` fills `obj/`.
- Node: `npm run build` fills the cache of the build tool, for example
  `.next/cache`.

A failed warm command does not stop the run. Factoree records the exit code on
the warm snapshot and takes the snapshot.

Factoree builds a new warm snapshot ahead of the next run when the bootstrap
key changes. The bootstrap key covers the bootstrap command, the warm command
and the effective allow list. A change to `verify`, `agents`, `preview` or
`identity` keeps the snapshot.

## 6. The settings screens

After sign-in, the UI holds four screens.

- **Install settings**: the GitHub Enterprise URLs, the Linear client
  credentials and webhook secret, the sandbox provider, its key, image and
  limit, and the git author. A change applies with no restart.
- **Workspaces**: the Linear workspaces with Factoree installed. Only an admin
  of the workspace that ran setup installs Factoree in another workspace or
  changes the install settings.
- **Products**: the model, the effort per role (implementer, refiner,
  validator, reviewer), the silence limit in minutes, the retention hours, the
  maximum Run minutes, the autonomy level, the risk caps, the allowed domains
  and the secrets. `maxConcurrentRuns` (default 2) is stored, but this build
  does not enforce it.
- **API keys**: the keys that scripts use for the admin API.

A change to the model, the effort or the silence limit applies to the next
agent session. The model and the effort apply to opencode sessions. Claude Code
runs at its own defaults.

`docs/specs/autonomy-levels.md` defines the levels. L0 reports, L1 checks and
opens no pull request, L2 opens a draft pull request, and L3 opens a pull
request that is ready for review. Only an operator raises a Product. To lower
the level of one ticket, add the Linear label `factoree:l0`, `factoree:l1` or
`factoree:l2`. A label never raises the level.

With no model and no key, opencode uses its own default model.

The **Runs** page lists every run of a workspace. A run page shows why the
run ended, where its time went and what it cost. An admin also opens the
workflow of a run in the Temporal UI at `<FACTOREE_PUBLIC_URL>/temporal`,
read-only, with the same sign-in. The compose file runs the Temporal UI with
no published port.

### 6.1 A skill registry

`docs/specs/skill-registry.md` defines it. A Product can name one Skael server
in the Skill registry section of its page.

1. In Skael, create a service account. Give its key the scopes `sets:read`,
   `events:write`, `outcomes:write` and `submissions:write`. To give every
   released skill, add `skills:read` and do not limit the key to a set.
2. On the Product page, enter the registry URL, the set name and the service
   key. Leave the set name empty to give every released skill.
3. Select Save product. Factoree stores the key as the secret
   `SKILL_REGISTRY_KEY`, resolves the registry once and refuses a setting
   that does not resolve.

For each Run, the worker resolves the set, checks the SHA-256 of every
archive and unpacks the skills outside the repository checkout. The sandbox
gets no key and no route to Skael. The Run records the set, the resolution id
and each skill version. Skael receives the skills each session loaded, the Run
outcome, and the one skill proposal the implementer may write.

## 7. Register the context sources

`tests/live/scenario.ts` refuses to start unless the Product carries one
enabled `backstage` row and one enabled `mcp` row. The UI has no context source
screen, so use the admin API.

1. On the API keys screen, create a key. Copy it. Factoree shows it only once.
   The key starts with `fct_`.
2. Set the shell values. The Workspaces screen shows the Linear workspace id.
   The Product page URL ends with the Product id.

       export API_BASE=http://localhost:3000
       export API_KEY=<API_KEY>
       export WORKSPACE=<LINEAR_WORKSPACE_ID>
       export PRODUCT_ID=<PRODUCT_ID>

3. Register the Backstage stub of `just stubs`:

       curl -sS -X POST \
         "$API_BASE/admin/products/$PRODUCT_ID/context-sources?linearWorkspaceId=$WORKSPACE" \
         -H "Authorization: Bearer $API_KEY" \
         -H "Content-Type: application/json" \
         -d '{"sourceId":"backstage-catalog","kind":"backstage","endpoint":"http://localhost:4100","enabled":true}'

4. Register the MCP stub. An `mcp` row must name its discover tool and its
   fetch tool. The stub answers any tool name.

       curl -sS -X POST \
         "$API_BASE/admin/products/$PRODUCT_ID/context-sources?linearWorkspaceId=$WORKSPACE" \
         -H "Authorization: Bearer $API_KEY" \
         -H "Content-Type: application/json" \
         -d '{"sourceId":"mcp-source","kind":"mcp","endpoint":"http://localhost:4200","enabled":true,"settings":{"kind":"mcp","discoverTool":"search","fetchTool":"fetch"}}'

You need no real Backstage instance and no real MCP server for this path. To
use a real catalog and a real MCP source, put their URLs in the `endpoint`
fields.

A key acts as the person who created it, in that person's workspaces. A key
cannot create keys. Factoree records every `/admin` call with the user or key
id. Revoke a key on the API keys screen. The next call with it gets 401.

## 8. Run the scenario

With Fly Sprites:

    just live-sprite

With the local sandbox, run `just live-local`. With Kiln or E2B, run `just live`.
`docs/live-acceptance.md` explains each profile.

The command creates a fixture issue in Linear, delegates it to Factoree, and
waits for the Proof Pack comment. It prints one line per fact it proves, and
one line per fact it cannot prove.

Exit code 0 means every fact holds. Exit code 78 with `BLOCKED_EXTERNAL` means
a required value is absent or wrong.

If the run fails, read the printed report first, then the worker log, then the
stub log.

To test the Fly Sprite steps alone, run `just smoke owner/name`. Add `--keep`
to keep the Sprite. The command reads the Sprites token from the install
settings.

## 9. Stop

    just down        # stops PostgreSQL and keeps the data volume

## Troubleshooting

**The setup token is not valid.** The API issues a new token on each start
until setup completes. Use the token from the latest log line.

**The API rejects an admin call with 401.** The `Authorization` header must
carry `Bearer <API_KEY>`. The key is absent, wrong, expired or revoked. Create
a new key on the API keys screen.

**The API rejects an admin call with 403.** The key or the session belongs to a
person who is not a member of the workspace, or a member who is not an admin
makes a change.

**Sign-in is refused.** The Linear account is not a member of a workspace that
has Factoree installed.

**Publication fails with a configuration error naming the GitHub App
installation.** The target repository carries no installation, or the
installation was removed. Install the Factoree GitHub App on the repository
again. A new installation has a new id, and after setup completes `/setup`
cannot bind it. `docs/live-acceptance.md`, "Troubleshooting: missing GitHub
App installation", holds the admin API call that binds it.

**Factoree never comments in Linear.** The Linear installation is absent or
its token is not valid. Open the Workspaces screen. Check the token expiry and
that it is refreshable. Install Factoree in the workspace again if needed.

**The worker starts no Run.** Linear cannot reach the API. Check that the
tunnel still runs, and check the webhook URL in the Linear app settings.

**The tunnel URL changed.** A free tunnel URL changes on each restart. Put the
new URL in `FACTOREE_PUBLIC_URL` and restart the API. Then change the webhook
URL of the GitHub App, and the two callback URLs and the webhook URL of the
Linear app, to the new URL. The Install settings screen shows each URL.

**The disk fills.** Run `docker builder prune`. Do not run
`docker volume prune`. It can destroy data of other projects.
