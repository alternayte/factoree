# Claude Code runner

Amends `docs/factoree-sdd.md` §15 (the `agents` block), §33 and B-3. Supersedes DI-14.54, DI-14.32 for the claude runner, and DI-21.17.

## What it does
Any agent role can run on Claude Code with an Anthropic API key, on Kiln and on E2B. The product page selects the runner, the model and the effort for each role. A product sets a default runner and model, and each role can override them. A claude session runs the model and the effort the product names, not the CLI defaults. A repository no longer selects a runner.

## Decisions
- The product holds `defaultRunner` (`opencode` or `claude`) and the default `model`. Each of the five roles (refiner, implementer, validator, reviewer, setup) holds `runner`, `model` and `effort`, each nullable. A null runner or model takes the product default. A null effort takes the model default — a new product sets two fields, and providers can still mix per role.
- The migration sets `defaultRunner` to `opencode` and `defaultModel` to the current `model`, and keeps each role effort — every product runs as it ran before.
- A save validates the resolved runner and model of every role. An opencode model is `provider/model`. A claude model is a Claude Code alias (`opus`, `sonnet`, `haiku`, `fable`) or a full `claude-*` id, or null for the CLI default — a mismatched pair fails at save, not in a run.
- A claude effort is one of `low`, `medium`, `high`, `xhigh`, `max`, and the form shows a select. An opencode effort stays free text with suggestions — opencode takes its variant names from the model catalog, and Claude Code has a fixed set.
- The claude runner passes the model with `--model` and the effort with `CLAUDE_CODE_EFFORT_LEVEL` — the env var takes precedence over every settings file, and only it accepts `max`.
- `.factoree/config.yaml` accepts an `agents` block and ignores it. The run log and the setup report name the ignored block. The setup agent writes no `agents` block — a strict refusal would fail every repository that holds one, and the repository is untrusted input that must not choose a paid key.
- The sandbox image installs `@anthropic-ai/claude-code` with npm, pinned to an exact version, root-owned in `/opt/factoree`. The image sets `DISABLE_UPDATES=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` — B-2 forbids an agent-writable runner, and a pinned CLI must not update itself.
- On an image with `supportsCustomImage`, the claude runner calls `/opt/factoree/bin/claude`. Elsewhere it calls `claude` on the `PATH` — the same rule as opencode (B-2).
- The claude runner adds `--dangerously-skip-permissions`, and `--add-dir <repositoryPath>` when the session works from a scratch directory. It keeps `--strict-mcp-config --setting-sources user` — print mode denies every tool that needs approval, and the sandbox and the action policy mechanisms are the boundary (DI-14.16).
- Factoree uses E2B templates it builds from the sandbox image only. It never starts from the E2B `claude` template — that template runs as `user` with no root-owned CLIs, no agent-browser and no rootless Docker.
- The Anthropic credential is a `runner_credential` product secret: `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` with `ANTHROPIC_BASE_URL`. The runner_credential path already carries any name — no new secret kind.
- Preparation fails with `CONFIGURATION_INVALID` when a role resolves to `claude` and the product holds no `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`. The message names the role — the session would otherwise fail on its first model call.
- When a role resolves to `claude`, the agent phase of that session allows `api.anthropic.com`, or the host of `ANTHROPIC_BASE_URL` when the product holds one. Only `claude` sessions get the host — the operator must not need to know the CLI's hosts, and other roles get no extra egress.
- The refiner and the setup agent use the runner their role resolves to — the refiner was fixed to the implementer runner, and the setup agent to opencode.
- The product page shows, for each role, the runner, model and effort it resolves to — an empty override must not hide what runs.
- `AgentSession` keeps the runner, the reported model and the effort, for both runners — the session list and the proof pack show what ran.

## Out
- Claude Code subscription sign-in (`CLAUDE_CODE_OAUTH_TOKEN`) and Bedrock, Vertex or Foundry as named options. An operator can still store their variables as runner credentials, and must then add their hosts to the allowed domains.
- Automatic egress for opencode provider hosts.
- The opencode change from `--variant` to `provider/model#variant` in releases after 1.19.5.
- E2B Hobby's one-hour sandbox limit. On Hobby, the operator sets `maxRunMinutes` to 55 or less.
- Codex, Amp or any other runner.

## How I know it works
- `just verify` passes.
- `docker run --user agent <image> claude --version` prints the pinned version, and `ls -l /opt/factoree/bin/claude` shows the owner `root`.
- The product page refuses a claude role with the model `deepseek/deepseek-chat`, and refuses a claude effort `ultra`.
- A product with the default runner `claude`, the model `sonnet`, the effort `high` and an `ANTHROPIC_API_KEY` runs a FAC issue on E2B to a pull request. Every `AgentSession` row shows the runner `claude`, a `claude-sonnet-*` model and the effort `high`.
- The same product without the key ends `CONFIGURATION_INVALID`, and the message names the role.
- A product with a claude implementer and an opencode reviewer runs to a pull request, and the session list shows both runners.
- A repository whose config holds an `agents` block runs, and the run log names the ignored block.
- An implementer `curl https://api.anthropic.com` succeeds in a claude session, and the same call fails in an opencode session.
