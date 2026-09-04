# Quickstart: a live local run

This document runs Factoree against a real Linear workspace, a real GitHub
repository, a real Fly Sprite, a local Temporal dev server, and a PostgreSQL
container. `docs/live-acceptance.md` calls this Path A-Sprite. It is not SDD
section 66 proof.

For the local process sandbox instead of a Fly Sprite, set
`SANDBOX_ADAPTER=local` and run `just live-local` at the end.

## 1. Accounts

1. A Linear test workspace. Install the Factoree Linear app on it.
2. A GitHub fixture repository. Do not use a production repository.
3. A Fly.io organization that can create a Sprite.
4. `jq`, `docker`, and the `temporal` CLI on your machine.

## 2. The environment file

Copy `.env.example` to `.env`. Fill these values. Every other value already
holds a working local default.

| Variable | Value |
| --- | --- |
| `ADMIN_API_TOKEN` | Any token of 32 characters. It guards `/admin/*`. |
| `FACTOREE_SECRET_KEY` | 64 hexadecimal characters. It encrypts the stored secrets. |
| `LINEAR_WEBHOOK_SECRET` | The webhook signing secret of the Linear app. |
| `SANDBOX_ADAPTER` | `fly-sprites` |
| `SPRITES_TOKEN` | A Fly.io token that can create and delete a Sprite. |
| `LIVE_LINEAR_API_KEY` | A personal API key of the test workspace. The test driver uses it. |
| `LIVE_LINEAR_TEAM_ID` | The team the test driver creates its fixture issue in. |
| `LIVE_GITHUB_TOKEN` | A token with write access to the fixture repository. The test driver uses it. |
| `LIVE_GITHUB_REPOSITORY` | The fixture repository, as `owner/name`. |
| `SETUP_LINEAR_WORKSPACE_ID` | The ID of the test workspace. |
| `SETUP_LINEAR_ACCESS_TOKEN` | The access token of the installed Factoree Linear app. Factoree comments with it. |
| `SETUP_PRODUCT_SLUG` | A short unique identifier for the bootstrap Product. |
| `SETUP_LINEAR_TEAM_KEY` | The key of the Linear team the fixture issue belongs to. |
| `SETUP_GITHUB_INSTALLATION_ID` | The numeric installation ID GitHub assigned to the Factoree app. |
| `SETUP_GITHUB_ACCOUNT_LOGIN` | The GitHub account or organization the app is installed on. |
| `SETUP_GITHUB_REPOSITORY` | The fixture repository, as `owner/name`. |

Leave an optional value empty. The `justfile` skips an empty value, so an
empty `TEMPORAL_API_KEY` or `SPRITES_BASE_URL` does not break the start.

`LIVE_GITHUB_TOKEN` belongs to the test driver, which acts as the human
operator. Factoree needs no GitHub secret: it mints every clone credential
and every publish credential against the GitHub App installation instead.

## 3. Start the stack

Run each command from the repository root, each one in its own terminal.

    just install     # npm dependencies and the Prisma client
    just up          # the PostgreSQL container
    just migrate     # the Prisma migrations
    just temporal    # the Temporal dev server
    just stubs       # the Backstage stub and the MCP stub
    just worker      # the Temporal worker
    just api         # the HTTP API
    just tunnel      # a public URL for the Linear webhook

`just worker` and `just api` compile the TypeScript first, so the first start
is slow.

Copy the URL `just tunnel` prints. Set it as the webhook target in the Linear
app settings of the test workspace.

## 4. Bootstrap the database records

    just bootstrap

The command reads `.env` and does several calls against the API. It
registers the Linear installation, creates the Tenant and the Product, binds
the GitHub installation, and registers the Backstage row and the MCP row. It
prints the new Product ID.

Bootstrap does not create a Repository row. Discovery creates it from the
`.factoree/config.yaml` file of the fixture repository, when the GitHub App
reports the repository push to Factoree.

The two context source rows point at the local stubs of `just stubs`. You
need no real Backstage instance and no real MCP server for this path.
`tests/live/scenario.ts` refuses to start unless the Product carries one
enabled `backstage` row and one enabled `mcp` row, and the stubs answer both.
To point the rows at a real catalog and a real MCP source instead, set
`SETUP_BACKSTAGE_URL` and `SETUP_MCP_URL` in `.env`.

An `mcp` row must name two tools. `SETUP_MCP_DISCOVER_TOOL` and
`SETUP_MCP_FETCH_TOOL` hold them, and default to `search` and `fetch`. The
local stub answers any tool name, so the defaults work.

The command is safe to run again. It reuses a Product that already carries
the same slug, and it overwrites the other records.

## 4b. Paid models and private repositories

A model provider credential needs a Product secret with the right kind. A
private repository needs no Product secret at all: bind its GitHub App
installation instead, and Factoree mints a read-only credential for it.

A model provider credential, for opencode Zen, DeepSeek, or Anthropic:

    curl -sS -X PUT \
      "$API_BASE/admin/products/$PRODUCT_ID/secrets/OPENCODE_API_KEY?linearWorkspaceId=$SETUP_LINEAR_WORKSPACE_ID" \
      -H "Authorization: Bearer $ADMIN_API_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"value": "<THE KEY>", "kind": "runner_credential"}'

The secret name becomes the environment variable name inside the sandbox, so
name it exactly as the tool expects. The value reaches the agent process and
nothing else. It never enters a prompt.

A read-only repository credential, for a private repository:

    curl -sS -X PUT \
      "$API_BASE/admin/products/$PRODUCT_ID/secrets/GITHUB_READ_TOKEN?linearWorkspaceId=$SETUP_LINEAR_WORKSPACE_ID" \
      -H "Authorization: Bearer $ADMIN_API_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"value": "<THE TOKEN>", "kind": "repository_read"}'

Give this token Contents read only. Factoree uses it for the checkout and for
context discovery. It never stays inside the sandbox.

Do not set `injectIntoImplementer` on either secret. The API refuses the
combination, because SDD section 30 permits the mark on a `test` secret only.

Free models need no credential at all. opencode answers with its own
`opencode/big-pickle` model when the Product holds no runner credential.

## 4c. Keep the Linear token alive

A Linear access token lives for twenty-four hours. On the next day every Run fails at its first
Linear call with `Authentication required`, and the Run ends before it reaches the sandbox.

Run `just linear-auth` to do the whole flow in one command. It opens the Linear authorization
page, stores the installation with its refresh token and its expiry, and prints the workspace it
stored. Add the redirect URI `http://localhost:8080/callback` to the Linear application first.

Factoree refreshes the token itself when it holds three things:

1. `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` in `.env`, from the Linear OAuth application.
2. `SETUP_LINEAR_REFRESH_TOKEN`, the `refresh_token` of the same OAuth response.
3. `SETUP_LINEAR_EXPIRES_IN`, the `expires_in` of that response, in seconds. Linear returns
   86400.

`just bootstrap` stores all three. The worker then refreshes the access token five minutes
before it expires, writes the new pair back, and continues. It also refreshes once and retries
when Linear rejects a token that was revoked before its expiry.

Without the client credentials Factoree cannot refresh anything. It says so in the log, and an
operator must store a new token by hand each day.

## 5. Run the scenario

    just live-sprite

The command creates a fixture issue in Linear, delegates it to Factoree, and
waits for the Proof Pack comment. It prints one line per fact it proves, and
one line per fact it cannot prove.

Exit code 0 means every fact holds. Exit code 78 with `BLOCKED_EXTERNAL`
means a required value is absent or wrong.

`tests/live/scenario.ts` has never executed against a real service. Expect
defects on the first run. Read the printed report first, then the worker log,
then the stub log.

## 6. Stop

    just down        # stops PostgreSQL and keeps the data volume

## Troubleshooting

**The API rejects an admin call with 401.** The `Authorization` header must
carry `Bearer <ADMIN_API_TOKEN>`. `just bootstrap` reads the value from
`.env` itself.

**Publication fails with a configuration error naming the GitHub App
installation.** The target repository carries no installation, or the
installation was removed. Install the Factoree GitHub App on the repository
again.

**Factoree never comments in Linear.** The Linear installation record is
absent or carries a wrong token. Run `just bootstrap` again, or repeat the
`PUT /admin/linear-installations` call with a correct
`SETUP_LINEAR_ACCESS_TOKEN`.

**The worker starts no Run.** Linear cannot reach the API. Check the tunnel
still runs, and check the webhook URL in the Linear app settings.

**The disk fills.** Run `docker builder prune`. Do not run
`docker volume prune`. It can destroy data of other projects.
