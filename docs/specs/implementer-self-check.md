# Implementer self-check

Amends docs/specs/proof-pack-and-visual-evidence.md (the implementer prompt decision) and SDD section 34 (the fields the implementer receives).

## What it does
The implementer prompt no longer scripts a self-check. It states facts: the checks that Factoree runs after the implementer finishes, that a failed check returns as repair findings, and that agent-browser is installed when the work sprite has it. The agent chooses its own commands from the repository and its AGENTS.md. The prompt never names the preview command, so the implementer does not start a production build in the work sprite.

## Decisions
- The prompt lists the name and the command of each `verify.commands` entry as the checks Factoree runs after the implementer finishes — the agent knows the gate without a scripted procedure, as Copilot coding agent and Codex read AGENTS.md.
- The prompt states that a failed check returns as repair findings and uses the repair budget — the agent can weigh a self-check against a repair.
- The prompt states that the agent may run any of these checks itself, and that its result is not evidence — an agent claim is never evidence.
- `selfCheck` becomes a boolean, true when the work sprite has agent-browser — the preview command and the ready URL leave the implementer input.
- When `selfCheck` is true, the prompt has one line: agent-browser is installed, a browser check is optional, and it is not evidence — no scripted start, open or stop steps.
- The `preview` block of `.factoree/config.yaml` serves the check sprite only — its command can be a production build without cost to the implementer.
- The implementer prompt version goes up by one — SDD section 56 requires it.
- The activity input changes shape and the workflow commands do not change — a run in flight replays without a guard. Record this as a DI entry.
- The c-dash config comment that says the implementer opens the preview is corrected in the c-dash repository.

## Out
- A dev-server command field in `.factoree/config.yaml`.
- A limit on which commands the implementer may run.
- The 187 s validator turn in FAC-64.
- A change to the check sprite, the preview or visual evidence.

## How I know it works
- `just verify` passes.
- The rendered implementer prompt for c-dash names `npm run type-check` and `npm test`, and holds neither `npm run build` nor `localhost:3000`.
- A c-dash run shows no `npm run build` in the implementer's `opencode export` tool calls, and its `AgentSession` row shows a lower `duration_ms` than FAC-64's 791 s.
- The run still reaches a Proof Pack with visual evidence from the check sprite.
