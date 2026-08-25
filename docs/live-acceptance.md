# Live acceptance

SDD section 66 requires one live proof of Factoree Version 1. This document states the
accounts, the credentials, and the procedure.

## Command

    npm run acceptance:live

The command exits 0 only when every live fact of the SDD section 67 "Live proof" list
holds. It exits 78 and prints `BLOCKED_EXTERNAL` when a required credential is absent.
`BLOCKED_EXTERNAL` is not equivalent to `DONE`. See SDD section 66.

The repository has no `tsx` dependency and no `ts-node` dependency. The command runs the
entry point with the Node.js 24 built-in TypeScript support instead, through a small
module-resolution hook at `tests/live/path-alias-loader.mjs`. That hook exists only to let
the entry point resolve the repository's `~/` import alias. It adds no new dependency.

## Accounts you must create first

1. A Linear test workspace. Do not use a production workspace.
2. A GitHub fixture repository. Do not use a production repository.
3. A Fly.io organization that can create a Sprite.
4. A Temporal service. Temporal Cloud and a self-hosted service both work.
5. One coding-agent runner account. Use OpenCode or Claude Code.
6. A Backstage catalog with at least one component entity.
7. An MCP source that answers a search.

Install the Factoree Linear app on the test workspace before you run the command. The
scenario delegates its fixture issue to that app user, and it cannot find that user
otherwise.

## Credentials

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

## Procedure

1. Copy `.env.example` to `.env`. Fill every `LIVE_` value.
2. Start PostgreSQL and apply the migrations with `npm run db:migrate`.
3. Start the worker against the real Temporal service.
4. Configure the Backstage source and the MCP source through Factoree's normal
   configuration path, so the worker can reach the test catalog and the test MCP source.
5. Run `npm run acceptance:live`.
6. Read the printed report.

## What the command proves

The command exits 0 only when every fact of the SDD section 67 "Live proof" list holds.
It creates a real fixture issue in the Linear test workspace, delegates it to Factoree,
and waits for the Proof Pack comment. It reads the Proof Pack sections to confirm that
context resolution ran, the Validation Contract froze, deterministic verification ran,
review ran, and the Fly Sprite changed code. It then confirms the linked pull request
exists in the real GitHub fixture repository. The command names each fact it could not
prove, and it prints one line for each.

## What the command cannot prove alone

The scenario reads facts from the Proof Pack comment Factoree posts in Linear. It does
not itself drive the coding-agent runner, and it does not itself create the Fly Sprite.
An operator must confirm the worker process is running against every credential above
before the command starts, or the scenario times out and reports every fact absent.
