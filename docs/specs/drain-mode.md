# Drain mode

Amends `docs/factoree-sdd.md` §48 (run states) and `docs/specs/run-workflow-structure.md` (upgrade check). Reference: `docs/specs/blocked-by-wait.md`.

## What it does
An install admin turns on drain mode before a release that open runs cannot replay. While drain mode is on, Factoree accepts each new run but does not start it: the run waits as WAITING_FOR_UPDATE, and Linear says that it starts after the update. Every run that is already open finishes as normal. The drain page lists the open runs, so the admin knows when the deploy is safe. A worker of a newer release ends drain mode when it starts, and the waiting runs then start on the new release. The admin can also end drain mode by hand.

## Decisions
- Drain mode is one install-wide setting: `InstallSettings.drainStartedAt`, `drainStartedBy` and `drainRelease` (the `FACTOREE_RELEASE` of the API that turned it on) — the deploy is install-wide, and the API and every worker replica read the database, so it works the same on compose and Kubernetes.
- Drain mode holds every new agentRun only: a delegation, a follow-up reply, and the PR follow-up and bring-current runs that a PR workflow starts — `factoree upgrade-check` blocks on open agentRun workflows only.
- Draft runs, setup runs, setup after push, build-ahead, installation sync and PR workflow events go on — they are short, or they must survive any deploy.
- A held run is a Run row with status WAITING_FOR_UPDATE and no workflow — the blocked-by wait already keeps a row before its workflow, and the Runs page, the run page and Stop need no second source.
- A delegation or a follow-up reply during drain creates the held row. The blocked-by check runs first: a run with an open blocker waits as WAITING_FOR_BLOCKERS, and the sweep moves it to WAITING_FOR_UPDATE when its blockers close while drain is on.
- The sweep that starts released blocked runs also starts WAITING_FOR_UPDATE runs once drain mode is off, oldest first, with the deterministic workflow id and REJECT_DUPLICATE — two workers cannot start one run twice. A started run passes the QUEUED gate as any run does.
- A PR workflow that would start a PR follow-up or bring-current child asks an activity whether drain mode is on, and while it is, waits 60 s and asks again before `startChild` — the PR workflow awaits the child's result, so the start cannot move to a row. The change is a new `patched` gate in `pr.workflow.ts`.
- The held message is an elicitation: "Factoree is updating to a new release. It starts this run when the update ends." It posts once per held run.
- A reply to a held run gets one fixed answer with the same text — no workflow exists to take it.
- A Linear stop or a UI stop of a held run ends it CANCELLED with STOPPED_BY_HUMAN, as for a waiting blocked run.
- Open runs, QUEUED ones included, run to their normal end — every accepted run finishes as promised, and the run workflow does not change.
- A worker ends drain mode at boot when its `FACTOREE_RELEASE` is newer than `drainRelease`, after its upgrade check passes, and logs it — the deploy resumes intake, and a plain restart of the same release does not.
- The admin ends drain mode by hand at any time — a drain for maintenance has no new release.
- The worker still exits 78 when the upgrade check fails — on compose no old worker remains to finish the runs.
- API: `GET /admin/install/drain` returns the setting, the open agentRun workflows (work item, status, Run page, time open) and the held count. `PUT /admin/install/drain` with `{ "on": true | false }` turns it on or off. Install admin only.
- UI: Settings > Install shows a Drain section: the switch, the release that turned it on, the open runs with Stop, and the held count. While drain is on, every page shows a banner with the held count.
- `pr.workflow.ts`, the setup workflows and every workflow other than agentRun stay replayable across every release — a PR workflow stays open until its pull request merges, so it can never drain. `MIN_REPLAYABLE_RELEASE` applies to agentRun only.
- `docs/quickstart.md` section 10 describes a breaking upgrade: turn on drain mode, wait until the drain page lists no open run, deploy, check that the waiting runs start.

## Out
- Temporal Worker Versioning with pinned workflows. A later spec can add it for installs that cannot accept a pause.
- A drain deadline that stops open runs on a timer.
- Handing QUEUED runs back to a held row.
- Holding setup runs, build-ahead, draft runs or PR workflow events.
- Drain mode per tenant or per product.

## How I know it works
- Turn on drain mode in Settings > Install. Delegate a FAC issue. No workflow starts, the Runs page shows WAITING_FOR_UPDATE, and the Linear session shows the held message.
- A run that was open before drain mode finishes normally, and the drain page lists it until it ends.
- Request changes on an open Factoree pull request during drain. No PR follow-up run starts until drain mode ends.
- Deploy a newer release. The worker log says it ended drain mode, and the held run starts within a minute.
- Restart the worker on the same release with drain mode on. Drain mode stays on.
- Stop a held run. It ends CANCELLED and never starts.
- `just verify` passes.
