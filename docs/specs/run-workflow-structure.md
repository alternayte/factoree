# Run workflow structure

Amends SDD section 63 (source structure) inside `src/workflows`. Changes no run behaviour.

## What it does
`agentRunWorkflow` stops being one function of about 4,000 lines with 31 shared mutable variables and 116 run-kind checks spread through every stage. Each run kind becomes one story that reads top to bottom: a new run, a PR follow-up run, a bring-current run. The stories call shared stages. A stage takes its differences as parameters and never asks which kind of run it serves. The 25 patch gates lose their dead branches. A worker refuses to start when an open run needs code that this release no longer has. Every run takes the same path and sends the same Linear posts as before.

## Decisions
- Replay fixtures come first. At the commit before the move, the workflow suite exports one history per path: ready, each failure reason, stop, human question, blocker wait, follow-up run, PR follow-up run per trigger (reviewer, human, base), bring-current, change set. They go in `tests/workflow/histories`. A replay test runs them through `Worker.runReplayHistories` — the existing tests start fresh runs and cannot catch a command order change in an open run.
- `agentRunWorkflow` stays the one registered type. It sets the signal handlers and the query, then dispatches once on its input to `newRun`, `prFollowUpRun` or `bringCurrentRun` — `pr.workflow.ts:360` starts its children by the name "agentRunWorkflow", and an open PR workflow must replay.
- A follow-up run is a new run with recorded decisions and follow-up targets — it differs only in its input, so it needs no story of its own.
- Each story lives in `src/workflows/agent-run/stories/` and lists its stage calls in order. A story stays under 300 lines — a reader names the order of one kind of run from one file.
- The shared stages live in `src/workflows/agent-run/stages/`: admission, refinement, targets and context, preparation, validation contract, attempt loop (implement, verify, user validation, review, repair), triage, bring-current merge check, publication, end — the boundaries follow the status changes that already exist.
- A stage takes a start point (base SHA, or pull request head with the merge flag), a target rule (refiner-chosen or fixed), a publication destination (new pull request or existing branch with its contract revision), Linear texts, and flags for issue status and draft offer. The story chooses each value — the 116 checks become one choice per story.
- `checks/run-kind.sh` fails when a file in `stages/` names `PrFollowUpInput`, `BringCurrentInput`, `prFollowUp` or `bringCurrent` — a kind check cannot creep back into a stage.
- `RunControl` holds only the state that a signal, the query or the end of a run reads: status, stop request, human inputs, deadline and waited time, work sprite, both contract versions, open question, implementer session and its cancel flag, issue status flag. One object is created per run — the signals and the query need it, and nothing else does.
- Each other value is a typed output of the stage that produces it and a parameter of the stage that reads it — the compiler shows each data dependency.
- A stage that fails returns `{ failed: RunFailure }`, where `RunFailure` is the reason, the sentence and a required `cause: unknown | null`. The story calls `failRun` with it right away — the command order stays the same, and a dropped cause is a visible `cause: null` (#61).
- The move keeps every failure message as it is. Sites with no cause today pass `cause: null` — this spec changes no behaviour.
- Each gate `patched(X)` becomes `deprecatePatch(X)`, and its old branch goes — this is the Temporal TypeScript lifecycle (docs.temporal.io/develop/typescript/workflows/versioning, read 2026-11-19), and new runs already take the new branch.
- Each new agentRun workflow records `factoreeRelease` in its memo, in `src/temporal/connection.ts` and in the `startChild` call of `pr.workflow.ts`.
- `MIN_REPLAYABLE_RELEASE` in `src/workflows` names the oldest release whose open runs this code replays. This release sets it to itself.
- `factoree upgrade-check` lists the open agentRun workflows and fails when one has no memo or an older release. It names each run with its Linear issue and its Run page — the operator stops them or waits for them to end.
- The worker runs the same check before it polls and exits 78 when it fails. The Helm chart runs it in the pre-upgrade hook — on Helm the old pods keep the runs, and on compose the operator rolls back to the previous image.
- `docs/quickstart.md` and the release notes say that an upgrade to this release needs no open runs — runs from earlier releases have no memo.
- ESLint `max-lines` is 800 for each file in `src/workflows` — the hotspot cannot grow back without a visible rule change.
- The build stacks on the head of PR #62, and the replay fixtures come from that head — #62 adds a retry ladder and a gate to the attempt loop, and the move must carry them. A later fix to #62 rebases under the move.

## Out
- Changes to `pr.workflow.ts`, `repository-setup.workflow.ts` and the other workflows, except the memo on `startChild`.
- New workflow types per run kind, Temporal Worker Versioning, and child workflows per stage.
- New failure causes in messages. `docs/specs/run-diagnostics.md` covers the cause.
- The removal of the `deprecatePatch` calls. That needs one more release with no open run older than this one.
- A shorter total line count. The code moves and gains types; it does not shrink.

## How I know it works
- `npm run test:workflow` passes with no test changed, and the replay test replays every fixture history.
- `src/workflows/agent-run.workflow.ts` has fewer than 150 lines, and each story has fewer than 300.
- `checks/run-kind.sh` passes, and fails when a stage names `prFollowUp`.
- `grep -rn "patched(" src/workflows/agent-run src/workflows/agent-run.workflow.ts` prints nothing.
- `npm run lint` fails when a file in `src/workflows` passes 800 lines.
- On a compose install with one open run from 0.14.0, the new worker exits 78 and its log names that run. With no open run, it starts, and a new run shows `factoreeRelease` in its Temporal memo.
- A live run and a PR follow-up run on factoree-test end as on 0.14.0, with the same Linear posts.
- `just verify` passes.
