# Validator prompt facts

Amends SDD section 36 (the fields of the User Validator prompt) and DI-14.41 (the preview build beside the validator session).

## What it does
The user validator prompt states three facts it does not state today. The repository's verify commands already ran in this sandbox and passed. Factoree runs the Validation Plan itself, so the validator writes the plan from the source and the frozen contract. The preview may still be building while the validator plans. The validator then stops starting servers, polling the preview and running the checks again.

## Decisions
- The prompt states that Factoree already ran the verify commands of the repository in this sandbox and that they passed — the workflow starts user validation only after verification passed, so the fact holds without a new input field.
- The prompt states that Factoree executes every check of the plan after the validator writes it — the validator's only output is the plan file.
- The prompt states that the validator writes the plan from the source and the frozen contract, and that a check it runs itself is not evidence — an agent claim is never evidence.
- The prompt states that the preview may still be building and may not answer during the session — the FAC-65 validator polled it during `next build`, and started its own `next start`.
- The Preview section keeps the base URL, because browser steps and HTTP requests resolve against it.
- The user validator prompt version goes up to `user-validator@5` — SDD section 56 requires it.
- No activity input and no workflow code change — a run in flight replays without a guard. Record this as a DI entry.

## Out
- A rule or a mechanism that stops the validator from running a command.
- A change to the order of the preview build and the validator session.
- The plan correction prompt.

## How I know it works
- `just verify` passes.
- The rendered validator prompt holds the three facts.
- A c-dash run shows no `next start`, no `curl` to the preview and no `npm run type-check` from the validator in the check sprite, and its validator `AgentSession` row shows a lower `duration_ms` than FAC-65's 354 s.
- The run still reaches a Proof Pack with visual evidence.
