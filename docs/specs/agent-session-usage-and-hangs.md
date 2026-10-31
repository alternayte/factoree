# Agent session usage and hangs

Amends SDD §33 (agent runner interface), §47 (Proof Pack), §50 (timeout and cancellation) and §62 (observability). Closes H-12 for cost and H-17.

## What it does
Factoree records the model cost of each agent session. When a session ends, the runner reads the session's usage from the agent CLI and returns it. Factoree stores one `AgentSession` row per session, with tokens, cost, turns, duration, the longest turn and the outcome. The admin API returns the rows of a run, `proof-pack.json` holds the totals per role, and the Proof Pack in Linear shows one line with the total cost, the tokens and the model time.
Factoree also detects a hung session. A session that writes no output for the silence limit is hung. Factoree stops it, records it, and tries once more. A second hang ends the run with the failure reason `AGENT_HUNG`.

## Decisions
- The agent loop, the CLI and the model key stay in the sandbox. — The sandbox isolates the commands. A gateway or a harness on the worker adds a component for needs that the CLI already meets.
- The runner reads usage from the CLI after the session: `opencode export <session>` for opencode, and the result message's `usage` and `total_cost_usd` for Claude Code. — Each CLI already records its own tokens and cost. No proxy is needed.
- The runner also reads usage after a hung or failed session. — A failed session costs money too.
- `AgentSession` is a table with one row per session: run, role, attempt, CLI session id, model, effort, input, output, reasoning, cache read and cache write tokens, cost in USD, turns, duration, longest turn, and outcome `finished`, `hung` or `failed`. — One SQL query gives cost per run, role and product. The longest turn shows whether one slow model call or many calls made a session slow.
- A missing usage record stores the row with null usage fields and logs a warning. It never fails the run. — Cost is a metric, not evidence.
- The silence limit is `AGENT_SILENCE_MINUTES`, default 10. Silence means no new bytes in the detached process output. — At `max` effort the model can think for minutes with no output, so the limit is generous.
- On the first hang, Factoree stops the process. It resumes the implementer once with "continue", and that attempt uses the repair budget. It starts a fresh refiner, validator or reviewer session once. — One retry covers a stall at the provider.
- On a second hang in the same step, the run fails with the reason `AGENT_HUNG` in the category `AGENT`. The Proof Pack names the role and the silence limit. — Two hangs are a pattern that a human must see.
- The worker logs "agent session finished" with role, outcome, tokens, cost, turns and longest turn. — The worker log is where the timings are read today.
- Key injection at the egress point is Kiln work: alternayte/kiln#21. Until Kiln ships it, each product uses its own provider key with a spend limit at the provider. — Kiln already enforces egress for each sandbox.

## Out
- A model gateway or proxy, and LiteLLM.
- An agent loop on the worker, pi or pi-durable.
- A token or cost budget that stops a run.
- Dashboards and Prometheus metrics for cost.
- Removal of the provider key from the sandbox. That waits for Kiln #21.

## How I know it works
- After a c-dash run, `select role, outcome, cost_usd, turns, longest_turn_ms from "AgentSession" where run_id = '<id>'` returns a row for the refiner, the implementer, the validator and the reviewer, with cost above zero.
- `GET /admin/runs/<id>` returns the same rows. `proof-pack.json` holds the totals per role.
- The Proof Pack in Linear shows one line with the total cost, the tokens and the model time.
- With `AGENT_SILENCE_MINUTES=1` and a validator command that sleeps without output, the worker logs a hang, starts one fresh session, and on the second hang the run ends `FAILED` with `AGENT_HUNG`.
- `just verify` passes.
