# Cursor cloud agent runner

Amends `docs/specs/claude-code-runner.md` (the runners a product selects per role), SDD §14 (runners), §29 (egress) and §33 (sessions).

## What it does
A product can select `cursor-cloud` as the runner of its implementer. The implementer then runs as a Cursor cloud agent in Cursor's VM, started at the base SHA of the work sprite. When the agent ends, Factoree takes the tree of the agent's branch into the work sprite, captures the patch, and verifies, validates and reviews it in its own check sprites as for any runner. Cursor's VM is outside Factoree's egress control, so `cursor-cloud` is a cloud runner, and a product must turn on its unenforced egress switch first.

## Decisions
- `cursor-cloud` serves the implementer role only — the refiner runs in the work sprite, and the user validator and the reviewer start fresh in check sprites.
- The product holds the unenforced egress switch, off by default. The product page refuses `cursor-cloud` while it is off, and every proof pack of such a run states it — the product owns its policy, and Cursor's VM reaches Cursor and GitHub in every network mode.
- The adapter calls the Cloud Agents API v1 in `src/adapters/runners/cursor-cloud` only — AGENTS.md keeps provider SDKs in the adapters.
- `CURSOR_API_KEY` is a product runner credential, and preparation fails with `CONFIGURATION_INVALID` when the product selects `cursor-cloud` without it — no credential reaches a workflow argument (SDD §30).
- The implementer model must be one that `GET /v1/models` lists. The product save checks it with the product key — a wrong model fails where the operator reads it.
- `run` launches the agent with `startingRef` at the base SHA, `autoCreatePR` off and the implementer prompt — the agent starts from the same commit as the work sprite.
- The repository's own Cursor environment sets up the VM. The prompt states the bootstrap command and the verify commands of `.factoree/config.yaml` as text — Factoree keeps no Cursor setup, and its verdict never depends on the implementer's environment.
- The prompt carries the frozen context items as text and at most 5 work-item images. Context files and registry skills do not reach Cursor's VM, and the proof pack says so — Cursor's VM holds no Factoree files.
- When a run ends FINISHED, the work sprite fetches the agent's branch with the read token and takes its tree into the primary checkout, with HEAD still at the base SHA. The patch capture and the check sprite then run unchanged — the verified patch stays Factoree's own capture.
- A run that ends without a branch, or ERROR, CANCELLED or EXPIRED, is an implementer session that did not finish — the existing repair and failure rules apply.
- `resume` sends a follow-up run to the same agent with the repair findings, and the work sprite takes the branch again when it ends — one Cursor agent serves the whole run.
- The adapter reads the run stream. Every event other than a heartbeat counts as output for the silence limit. A hung session is cancelled and tried once more — the hung-session rule of every runner.
- `cancel` cancels the active Cursor run. The end of the run deletes the Cursor agent and its branch — no unverified branch stays on GitHub.
- The session usage holds the tokens of `GET /v1/agents/{id}/usage`. The cost comes from the models.dev price of the model, or stays null — the API reports no cost.
- A launch refused for the plan or for missing GitHub App access fails the run with `CONFIGURATION_INVALID`, and the message names the cause — cloud agents need a Premium plan or higher and the Cursor GitHub App on the repository.
- The runner polls the run status and reads the stream. It uses no webhook — v1 has none yet.

## Out
- `cursor-cloud` for the refiner, the user validator, the reviewer and the setup agent.
- Factoree control of Cursor's network mode or environment through the Environments API.
- The Cursor CLI as a runner inside the work sprite.
- Cursor self-hosted workers and pools.
- The implementer self-check in Factoree's browser for `cursor-cloud`.

## How I know it works
- `just verify` passes, and `tests/unit/cursor-cloud-runner.test.ts` passes against a fake Cloud Agents API.
- The product page refuses `cursor-cloud` for the implementer until the unenforced egress switch is on, and refuses a model that `GET /v1/models` does not list.
- A run with the `cursor-cloud` implementer on c-dash opens a pull request whose diff equals the verified patch, and the Cursor branch is gone afterwards.
- The proof pack of that run names the runner, states that implementer egress is not enforced, and shows the token usage.
- A run whose verify fails sends a follow-up to the same Cursor agent, and the second attempt's patch reaches a new check sprite.
- A run without `CURSOR_API_KEY` ends `FAILED_CONFIGURATION` with a message that names the key.
