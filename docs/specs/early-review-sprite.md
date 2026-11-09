# Early review sprite

Amends docs/specs/run-speed.md: "The reviewer starts after verify passes, in a second check sprite, at the same time as user validation."

## What it does
Factoree builds the reviewer's check sprite while deterministic verification runs, not after it passes. The reviewer session still starts only after verify passes, so it starts at once in a ready sprite. When verify fails, Factoree destroys the reviewer's check sprite of that attempt, and the repair starts without a wait.

## Decisions
- The reviewer's check sprite starts to build when the first check sprite of the attempt is ready, at the start of verify — the reviewer branch was the critical path in every run on 2026-11-09, and its 3 to 5 minute build moved off that path.
- The two check sprites do not build at the same time — the first check sprite is on the critical path, and a parallel build takes CPU from it.
- The reviewer's check sprite proves that it holds the patch hash of the first check sprite of the attempt, as now — the reviewer reviews the patch that verify checks.
- The reviewer session starts after verify passes and gets the verification summary, as now — the run-speed reviewer input is unchanged.
- A failed or unavailable reviewer check sprite build has the same result as now, read when verify passes — the result matters only when the reviewer must start.
- When verify fails, Factoree destroys the reviewer's check sprite of that attempt at once — it holds a patch the repair replaces, and it keeps CPU, memory and a `sandboxMaxLive` slot through the repair.
- When verify fails while the reviewer's check sprite still builds, the repair starts at once. The build ends in the background, and Factoree then destroys the sprite — the build activity sends no heartbeat, so a cancel never reaches it, and a cancel would leave a sprite that belongs to no run.
- The workflow waits for that background build before the next reviewer check sprite of the run builds, and before the run ends — the run knows every sprite it built, and holds at most three live sandboxes (DI-15.14).
- A run stopped during verify waits for the reviewer check sprite build and destroys the sprite before the terminal write — the same rule as a failed verify.
- A new workflow patch gates the change. A workflow that started before it keeps the serial build — Temporal replay stays deterministic.

## Out
- A heartbeat or a mid-build cancel for check sprite builds.
- A cheaper reviewer check sprite with no services or seed.
- A reviewer session that starts before verify passes.
- A reused check sprite across attempts.

## How I know it works
- In a run that passes, the `run_stage` row `prepare_check_sprite` of the reviewer starts before the `verify` row ends, and the `reviewer` row starts within seconds of the `verify` row end.
- On anthology, the time from the end of `verify` to `publish` is 3 to 5 minutes shorter than in the four runs of 2026-11-09.
- The `verify` row of anthology runs stays in today's range (`test` 487 to 527 seconds) with 2 runs at a time. A longer verify means the overlap costs CPU.
- In a run whose verify fails, Kiln shows no reviewer check sprite of the failed attempt once the build ends, and the repair attempt starts before that build ends.
- After a run ends, Kiln holds no check sprite of the run whose `metadata.factoree_run_id` matches.
