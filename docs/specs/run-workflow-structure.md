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
- `RunControl` holds only the state that a signal or the query reads: run id, status, stop request, human inputs, work sprite, both contract versions, open question. It exists before the run row, because the handlers do. `Run` holds the state that the end of a run reads (deadline and waited time, implementer session and its cancel flag, issue status flag, check sprites, live reviewer, skill sources, published pull requests) and the steps every story shares — each value has one owner.
- Each other value is a typed output of the stage that produces it and a parameter of the stage that reads it — the compiler shows each data dependency.
- A terminal step (`fail`, `cancel`, `report`, `routingMismatch`, `succeed`) writes the row, posts to Linear and throws `RunEnded`, and `agentRunWorkflow` returns its result. Its type is `Promise<never>`, so the compiler sees the end — about 100 `if (ended) return` checks go, and every `catch` rethrows `RunEnded` through `rethrowControl` or `failFrom`.
- The move keeps every failure message as it is — this spec changes no behaviour.
- Each gate `patched(X)` becomes `deprecatePatch(X)`, and its old branch goes — this is the Temporal TypeScript lifecycle (docs.temporal.io/develop/typescript/workflows/versioning, read 2026-11-19), and new runs already take the new branch.
- Each new agentRun workflow records `factoreeRelease` in its memo, in `src/temporal/connection.ts` and in the `startChild` call of `pr.workflow.ts`.
- `MIN_REPLAYABLE_RELEASE` in `src/workflows` names the oldest release whose open runs this code replays. This release sets it to itself.
- `factoree upgrade-check` lists the open agentRun workflows and fails when one has no memo or an older release. It names each run with its Linear issue and its Run page — the operator stops them or waits for them to end.
- The worker runs the same check before it polls and exits 78 when it fails. The Helm chart runs it in the pre-upgrade hook — on Helm the old pods keep the runs, and on compose the operator rolls back to the previous image.
- `docs/quickstart.md` and the release notes say that an upgrade to this release needs no open runs — runs from earlier releases have no memo.
- ESLint `max-lines` is 800 for each file in `src/workflows` — the hotspot cannot grow back without a visible rule change.
- The move removes the duplicates it finds: one session step (`runSession`) for the retries and the hang of the refiner and the triage, one `failFrom` for the configuration-or-timeout catch, one `ask` for a question that ends the run when nobody answers, one sprite helper for the triage and the bring-current check, one preflight for both set publications. The serial review path goes: the `run-speed-parallel-review` gate is deprecated, so every run takes the parallel path.
- The attempt loop keeps the awaits of the old code. The reviewer branch and the release of a dropped reviewer sprite run beside the main path, and one more microtask turn on one side changes which command reaches the history first. `enter` and `progress` return the activity promise itself for the same reason.
- The build stacks on the head of PR #62, and the replay fixtures come from that head — #62 adds a retry ladder and a gate to the attempt loop, and the move must carry them. A later fix to #62 rebases under the move.

## Out
- Changes to `pr.workflow.ts`, `repository-setup.workflow.ts` and the other workflows, except the memo on `startChild`.
- New workflow types per run kind, Temporal Worker Versioning, and child workflows per stage.
- New failure causes in messages. `docs/specs/run-diagnostics.md` covers the cause.
- The removal of the `deprecatePatch` calls. That needs one more release with no open run older than this one.
- Changes to the failure messages and the Linear texts.

## How I know it works
- `npm run test:workflow` passes with no test changed, and the replay test replays every fixture history.
- `src/workflows/agent-run.workflow.ts` has fewer than 150 lines, and each story has fewer than 300.
- `checks/run-kind.sh` passes, and fails when a stage names `prFollowUp`.
- `grep -rn "patched(" src/workflows/agent-run src/workflows/agent-run.workflow.ts` prints nothing.
- `npm run lint` fails when a file in `src/workflows` passes 800 lines.
- On a compose install with one open run from 0.14.0, the new worker exits 78 and its log names that run. With no open run, it starts, and a new run shows `factoreeRelease` in its Temporal memo.
- A live run and a PR follow-up run on factoree-test end as on 0.14.0, with the same Linear posts.
- `just verify` passes.
