# Run speed

Amends `docs/factoree-sdd.md` §40, `docs/specs/check-isolation.md`, `docs/specs/kiln-sandbox-provider.md` and `docs/specs/agent-session-usage-and-hangs.md`.

## What it does
Factoree records the start and the end of each stage of a run, so an operator finds the slow stage with plain SQL. The reviewer runs in its own check sprite at the same time as user validation, so the reviewer leaves the critical path. A repository can declare `warm.command`, which fills its build caches once, in the warm snapshot. Factoree builds a new warm snapshot when the inputs of the snapshot change, before a run needs it.

## Decisions
- A `run_stage` table holds one row per stage: run, stage, attempt, start, end. The activities write the rows — the workflow cannot see the time inside an activity.
- The stages are prepare sandbox, prepare check sprite, verify, preview build, browser assertions, each agent session, warm snapshot and publish — these splits show where a run spends its time.
- The columns are snake_case, as in `AgentSession` — an operator queries them in plain SQL (DI-14.42).
- `AgentSession` gets `model_ms` and `tool_ms`. The runner fills them from the CLI record that it already reads, for example the message and tool part times of the opencode export. A field stays null when the CLI left no record — the same rule as the other usage fields.
- The Temporal history and OTLP are not the store — the dev server keeps history for 24 hours, and OTLP needs a backend (H-12 stays open).
- The reviewer starts after verify passes, in a second check sprite, at the same time as user validation — the reviewer guard compares the tracked worktree, and a preview build in the same sandbox can rewrite tracked files.
- The second check sprite forks the warm snapshot plus the captured patch, as the first one does, and goes through `SettingsSandbox` — every sandbox counts against `sandboxMaxLive` (DI-15.14).
- The reviewer input keeps the verification summary and drops the user validation evidence. This amends the input list of SDD §40 — research shows that LLM judges anchor on results they can see.
- Factoree waits for both the reviewer and user validation before it decides. A failed validation and the reviewer blockers of the same attempt go to one repair, which counts once against the repair budget — a repair costs much more than the wait.
- When user validation is blocked or manual, or the run stops, Factoree cancels the reviewer — the attempt has no use for its report.
- `.factoree/config.yaml` gets an optional `warm.command`. It runs after the bootstrap, only when Factoree takes a warm snapshot — `bootstrap` runs in every sandbox, and a full build in every fork costs time on each run.
- When `warm.command` fails, Factoree logs the failure, records it on the warm snapshot and takes the snapshot — a base commit that does not build must not stop every run, and a partial build cache is valid input to an incremental build.
- The bootstrap key replaces the SHA of the whole configuration file in the key of a warm snapshot. The bootstrap key is the SHA-256 of `bootstrap.command`, `warm.command` and the effective bootstrap allow list — only these three change what the snapshot holds. A change to `verify`, `agents`, `preview` or `identity` keeps the snapshot.
- The Kiln template name keeps the image digest and the sandbox size — they already form part of the key.
- `Run.configSha` stays the SHA of the whole file — it records the configuration the run used, which is a different fact.
- A build-ahead workflow builds the new warm snapshot when the bootstrap key changes: a default-branch push that changes `.factoree/config.yaml`, a change to the Product allow list, or a new image digest or sandbox size. A new image or size starts a build for every repository of the install.
- One build-ahead workflow runs per repository, with a fixed workflow ID. A trigger during a build queues one more build, not one per trigger — the result is the same snapshot.
- A build-ahead takes its sandbox through `SettingsSandbox` and waits for a slot like a run. It never evicts the sandbox of a live run — a build-ahead must not slow down a run.
- A run that finds no snapshot for its bootstrap key still builds one itself. The last saved snapshot replaces the earlier one — the run path must not depend on the build-ahead.
- On an adapter without warm snapshots, `warm.command` and the build-ahead do nothing — Fly Sprites cannot fork a checkpoint.

## Out
- A preview build that starts during verify. The `run_stage` timings decide whether a later spec adds it.
- A build-ahead on every push. The prepare-sandbox timings decide whether a later spec adds it.
- OTLP export.
- Changes to models, reasoning effort or `maxConcurrentRuns`. These are settings.
- A stage timing view in the UI or in the proof pack.

## How I know it works
- After a run, `select stage, attempt, ended_at - started_at from run_stage where run_id = '<id>' order by started_at` lists every stage, and the preview build and the browser assertions are separate rows.
- `AgentSession` rows of an opencode run have `model_ms` and `tool_ms`. Their sum does not exceed `duration_ms`.
- In a run that passes, the reviewer `run_stage` row starts before the user validation row ends, and the two rows name different check sprites.
- A run whose user validation fails while the reviewer reports a blocker makes one repair, and the implementer prompt of that repair holds both sets of findings.
- The reviewer prompt holds a "Deterministic verification" section and no "User validation evidence" section.
- A repository with `warm.command: go build ./...` shows the command in the warm snapshot log. The command does not appear in the log of a run that forks that snapshot.
- A default-branch push that changes only `verify.commands` starts no build-ahead, and the next run forks the existing snapshot.
- A default-branch push that changes `bootstrap.command` starts one build-ahead. The next run forks the new snapshot, and its prepare-sandbox stage stays short.
- Two pushes during one build-ahead queue one more build only.
- `just live` on Kiln passes all 11 §67 checks.
