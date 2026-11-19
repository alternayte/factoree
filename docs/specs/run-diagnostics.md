# Run diagnostics

Amends SDD section 59 (the administration API) and section 62 (observability). Amends `docs/specs/run-failure-detail.md`: its Out item "A run event log table or page" is now in.

## What it does
Factoree records each fault and each Factoree decision of a run or a setup run as a run event, in order. A run event holds the stage, the attempt, the role, a message, and typed detail such as the exit code, the redacted log tail and the hosts the sandbox did not reach. The run detail and the setup detail get a diagnosis: the end reason and the fault event that caused it. A user on the Run page, or an agent with a `fct_` API key, finds the cause of a failure without Temporal, the worker log or cluster access.

## Decisions
- One table, `run_event`: tenant, run or repository setup (exactly one), stage, attempt, role, kind, message, detail JSON, idempotency key, created at. Rows cascade with their run or setup — one write path covers runs and setups, and a new fault is a new kind, not a migration.
- The detail of each kind is a zod schema in `src/domain/diagnostics`, in one discriminated union. The API returns the parsed shape — an untyped detail becomes a log dump.
- Kinds: `session_failed`, `session_hung`, `provider_unreachable` (after #62), `command_failed` (bootstrap, warm, verify, seed, preview, setup proof), `plan_rejected`, `proposal_rejected`, `selector_recheck`, `check_unstable`, `retry_started`, `repair_started`, `egress_denied`, `run_ended` — each fault that reached an issue in #37 to #65 maps to one kind.
- Factoree records faults and its own decisions only. Normal progress stays in `run_stage` — the event list stays short enough to read.
- Activities write the events through a `RunEventLog` port with a Prisma adapter. The workflow schedules no new activity, and no patch gate is needed — the command sequence does not change.
- `completeRun` writes `run_ended`. It reads the open `run_stage` row for the stage and links the newest fault event of the run as the cause — the 113 `failRun` sites stay unchanged and still give the cause.
- An event write that fails is logged and never fails its activity — diagnostics must not end a run.
- The idempotency key is the activity key plus the kind and an ordinal — a Temporal retry of an activity writes no duplicate.
- A log tail is `buildRetainedLog` output: redacted first, then cut to 32 KB — this keeps the SDD section 60 and 61 rules, and stores no full transcript.
- Every agent role and the setup agent store the log tail of a session that did not finish. Today only the implementer stores it — the refiner, validator, reviewer and setup failures were invisible.
- Factoree stores the raw redacted output and the facts it knows itself: command, exit code, duration, allow list. It never parses the error format of one language or tool — Factoree stays stack-agnostic.
- On Kiln, `command_failed` and `session_failed` list the denied hosts from the egress log of that sandbox.
- On every provider, these events also list each host name in the log tail that is not on the effective allow list, as `hostHints`. The API labels them as hints — an agent claim is never evidence, and neither is a guess.
- When the provider has no egress log, the event says "this sandbox provider records no egress" — E2B and Sprites have none (E2B and Sprites docs, read 2026-11-19).
- `GET /admin/runs/:id/events` and `GET /admin/repository-setups/:id/events` return the events in order, with cursor pagination, in OpenAPI — any agent with an HTTP tool and the API key reads them.
- `GET /admin/runs/:id` and the setup detail get `diagnosis`: end reason, stage, attempt, message, cause event with its log tail, denied hosts and host hints. It is null for a run that did not fail — one call answers "why did it fail".
- Every member of the workspace reads events and diagnoses, as for the run detail now — the Linear failure post already shows the same redacted tails to the same people.
- The Run page and the setup history page show the event list under the stage timeline, with the diagnosis at the top of a failed run.
- The Linear failure post of a run links to its Run page — the person in Linear reaches the full diagnosis in one click.
- The build bases on `main`. `provider_unreachable` joins the union when PR #62 merges, and reads its `failureKind` — diagnostics needs nothing from #62, and the overlap in the runner result is a small rebase.

## Out
- An MCP server or a CLI for Factoree.
- A Factoree egress proxy in front of the sandboxes.
- Full transcripts. Kept transcripts stay a separate product switch.
- Build-ahead failures. `BuildAheadFailure` keeps them.
- The restructure of `agent-run.workflow.ts`, which goes in its own spec.
- New retries or new failure handling. This spec records what happens and does not change it.

## How I know it works
- Delegate an issue on a repository whose bootstrap exits 1 on Kiln. `GET /admin/runs/:id` with a `fct_` key returns `diagnosis.cause.kind` `command_failed`, the exit code, the output tail and the denied hosts.
- The same issue on E2B with a bootstrap that downloads from a host not on the allow list: `hostHints` names that host, and the event says that the provider records no egress.
- A validator plan rejection appears on the Run page as `plan_rejected`, with the rejection reason.
- A setup run whose agent fails to start shows `session_failed` with the runner error on the setup history page.
- Kill the worker during a session. After the Temporal retry, the run has one event per fault, not two.
- The SQL `select kind, count(*) from run_event group by kind` on the live install shows no kind outside the union.
- `just verify` passes.
