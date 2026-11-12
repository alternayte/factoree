# Blocked-by wait

Amends `docs/factoree-sdd.md` §9 and §48. Issue #40.

## What it does
A delegated work item that Linear marks as blocked by an open issue starts no run. Factoree records the run as WAITING_FOR_BLOCKERS and posts which blockers it waits for. A sweep in the worker reads the blockers again every 60 s. When no blocker is open, Factoree starts the run from the head of the default branch. An issue with no open blocker behaves as today.

## Decisions
- "Blocked by" is each `inverseRelations` entry of the work item with type `blocks`. Its `issue` is the blocker — Linear has no other field for it (schema.graphql, 2026-11-11).
- A blocker is open while its state type is not `completed` and not `canceled` — Linear's own `hasBlockedByRelations` counts a pair only while both issues are open.
- At delegation, Factoree reads the blockers with one GraphQL query. When the query fails, the run waits and the next sweep reads again — a run on the wrong base is the defect this feature prevents.
- The waiting record is the Run row: status WAITING_FOR_BLOCKERS, and a new `blockers` JSON column with each blocker's identifier, state and Factoree pull request URL — `createIfAbsent` keys on `temporalWorkflowId`, so the workflow adopts the row, and the Runs page, the run page and the UI stop need no second source.
- The workflow starts only when the wait ends. The wait is not inside the run workflow — a wait of days would grow the workflow history towards the Temporal limit.
- The sweep runs in the worker every 60 s, as the reaper does. It sends one batched GraphQL query per tenant for all waiting runs of that tenant — the Linear cost stays at one call per tenant per minute (limit 5,000 per hour per app user).
- A Factoree pull request that merges starts a sweep at once — the blocked run starts without waiting for the next tick.
- The sweep starts the workflow with the run's deterministic workflow id. A second start of the same id fails, and the sweep ignores that failure — two workers or two sweeps cannot start a run twice.
- The sweep updates `blockers` on each read. A relation added during the wait holds the run. A relation removed releases it — removing the relation in Linear is the human override, so Factoree has no "start anyway" command.
- The waiting message is an `elicitation` activity: "Waiting for FAC-1 (https://github.com/org/repo/pull/2) to complete. Factoree starts this issue when it does." — an elicitation keeps the session in `awaitingInput`, not `stale`.
- Factoree posts a new line only when the set of open blockers changes — the session must not fill with repeated lines.
- A reply during the wait gets one fixed answer: the open blockers, and "Remove the relation in Linear to start now." — no workflow exists yet to take the reply.
- A Linear stop, or a stop from the Factoree UI, of a waiting run ends it as CANCELLED with reason STOPPED_BY_HUMAN, and posts the stop message — the stop reaches the row, because no workflow exists to signal.
- A Factoree pull request that closes without a merge posts one line on the session of each run it blocks. The run keeps waiting — the blocker issue is still open.
- A released run passes the QUEUED gate and pins its base SHA as any run does — the new default-branch head holds the blocker's merge.
- A WAITING_FOR_BLOCKERS run holds no run slot, no held slot and no sandbox — the wait costs nothing.
- The run budget starts when the workflow starts — the wait is not work.

## Out
- Stacked runs on the branch of the blocker's open pull request.
- Undelegation: Factoree handles no undelegation event today.
- A blocker in a team the Linear app cannot read. The query does not return it, so it does not hold the run.
- The Linear Issue webhook.
- A product setting to turn the hold off.

## How I know it works
- Delegate FAC-2, which FAC-1 blocks, while FAC-1's pull request is open. No sandbox starts. The session shows the waiting message. The Runs page shows FAC-2 as WAITING_FOR_BLOCKERS with FAC-1.
- Merge FAC-1's pull request. FAC-2's run starts within a minute, with no human action. Its base SHA is the merge commit or later.
- Remove the relation on a waiting issue in Linear. Its run starts within a minute.
- Press Stop on a waiting issue. The run is CANCELLED, and the next sweep does not start it.
- Delegate an issue with no blocker. It runs as before.
