# Factory floor

Amends `docs/specs/run-visibility.md` (the control plane UI) and `docs/specs/agent-session-usage-and-hangs.md` (the runners).

## What it does
A signed-in member opens Floor and sees the workspace as an isometric 3D factory. Each product is a production line. Each work item is a crate that moves from intake through the stage machines, the shipping dock, the PR yard and the deploy gate. Agent operators appear at a machine while their session runs and move as the agent reads, edits, runs commands or opens a browser. A click on any object opens a bubble, then a side panel with the same facts as the full page, then a link to that page. A member can replay any past time window of the floor at 1x to 120x.

## Decisions
- One floor per Linear workspace, one line per product, named after its Linear team — the workspace is the boundary that the UI and the auth already use.
- A line has intake (WAITING_FOR_BLOCKERS, WAITING_FOR_UPDATE, QUEUED), one machine per stage group (Refinery: REFINING, RESOLVING_CONTEXT, BUILDING_VALIDATION_CONTRACT; Prep: PREPARING; Workshop: IMPLEMENTING, REPAIRING; Test bench: VERIFYING; User lab: USER_VALIDATING; Inspection: REVIEWING; Shipping dock: PUBLISHING), a PR yard (open pull requests), merge, and one deploy gate per environment — the line tells the story from Linear issue to deployed change.
- A failed check puts a red alert on its machine and sends the crate back to the Workshop on a repair belt. A PR follow-up run sends the crate from the yard back to the Workshop — a repair stays visible as a repair.
- A terminal failure (FAILED, FAILED_REVIEW, FAILED_CONFIGURATION, STALE_BASE, BLOCKED_ROUTING, CANCELLED) moves the crate to a reject bin at the end of the line. REPORTED and DRAFT_PUBLISHED leave at the dock with their own mark — the outcome of every run is on the floor.
- A setup run shows as a construction crew at its repository's line entrance. A retro shows as one consultant who walks the lines of the products it reads — every workflow that does work is visible.
- A "needs a human" counter in the top bar counts WAITING_FOR_INPUT, BLOCKED_TARGET, READY_FOR_HUMAN and open pull requests that wait for a human review, and a click on it pans to the next one — the idle-villager pattern of Age of Empires.
- A throughput graph shows work items in against pull requests merged over the shown period, and each crate carries a repair-budget meter — the Factorio production graph and the Game Dev Story power meter, both from stored data.
- The claude-code and opencode runners write a session pulse at most once per 5 s while a session runs: session, role, tool kind (read, edit, shell, browser, think) and last output time, in a new `session_pulse` table — long stages show real activity, and a hung session shows as it happens.
- A pulse holds no tool input and no text — it carries no secret and no code.
- A cloud runner has no stream, so its operator shows a plain working state — the floor never shows activity it did not observe.
- `updateStatus` writes a `run_status_change` row (run, from, to, at) in the same transaction, and the setup status update writes a `setup_status_change` row the same way — replay needs queue and wait times, which the status column alone loses.
- The product run retention prunes `session_pulse` and the status change rows with the run — one retention rule.
- `GET /admin/floor?linearWorkspaceId` returns the live state: lines, crates, sessions with their newest pulse, pull requests, deploys, setups and retros. The page polls it every 5 s — the event rate is seconds, so no push transport is needed.
- `GET /admin/floor/replay?linearWorkspaceId&from&to` returns every status change, stage, pulse, pull request event, deploy, setup and retro event in the window, which is capped at 7 days and at the retention limit — one query serves the window replay and the single-run replay.
- "Replay this run" on a crate opens the same player, fitted to that run's span, with its crate in focus — single-run replay is a filtered window.
- The replay player has play, pause, speed from 1x to 120x and a scrub bar, and the URL holds `from`, `to` and `speed` — a bookmarked URL is a reusable demo.
- A run from before the status change table replays from `run_stage` and the row timestamps and carries an "approximate" mark — the floor never shows a guessed time as a fact.
- A click opens three levels: a bubble that follows the object with one-line facts and the Linear link, a side panel that mounts the existing page sections, and "Open page" — the floor is a map over the pages, and each fact has one renderer.
- Crates, machines, line signs, pull requests in the yard, deploy gates, setup crews and the retro consultant are clickable.
- The floor is read-only. The mounted sections take a `readOnly` prop that hides their buttons — a demo click never stops a real run, and every action stays one click away on the full page.
- The scene uses Three.js with an orthographic camera and the Kenney Factory Kit and Conveyor Kit (CC0) — true isometric depth with free, licensed factory models.
- The look is Night shift: the models get matte materials from the `ui/DESIGN.md` tokens, with a canvas floor, panel and raised bodies, and hairline edges. Light comes only from the state colours: accent on a machine with a running session, warning on a crate that waits for a human, danger on a failed check, success at shipping and deploy, with a bloom pass for the glow. The owner picked this direction from the concept page https://claude.ai/artifact/W9gubZ2pZy2Jrwi95NWvEu — the glow always means work, and the floor matches the operator UI.
- Labels, bubbles and panels are HTML over the canvas in Geist — text stays crisp and uses the house type.
- The page is a lazy route chunk, and all models and textures are bundled with the UI — the other pages stay the same size, and the CSP `default-src 'self'` holds.
- `prefers-reduced-motion` stops movement and keeps the state colours. Without WebGL, the page shows a message with a link to Runs — the floor has no broken state.
- Floor is a sidebar entry. The landing page does not change.

## Out
- Actions on the floor: stop, draft, start setup, drain.
- A public or unauthenticated share link.
- A synthetic demo mode or made-up data.
- Saved replay reels.
- An install-wide floor across tenants.
- Server push (SSE or websocket).
- Sound.
- Tool inputs, agent text or diffs in a pulse.

## How I know it works
- A run delegated in FAC moves as a crate from intake to the Workshop, and its operator changes between read, edit and shell while the session runs.
- A run with a failed check shows a red alert on the Test bench, and its crate goes back to the Workshop. Its repair meter drops by one.
- A merged pull request moves from the yard through merge, and a successful deploy sends its crate out of the deploy gate.
- The "needs a human" counter matches the Runs list filtered to WAITING_FOR_INPUT, BLOCKED_TARGET and READY_FOR_HUMAN, plus the open pull requests that wait for a review.
- A click on a crate opens a bubble with the issue title, the stage, the attempt, the elapsed time, the current tool and a Linear link that opens the issue. The side panel shows the run events and the sessions without stop or draft buttons.
- `/floor/replay?from=<yesterday>&to=<today>&speed=60` plays yesterday's runs on every line, and the scrub bar moves the crates to the matching state.
- `select count(*) from session_pulse where session_id = '<id>'` is no more than the session duration in seconds divided by 5, plus one.
- No `session_pulse` row has a field with tool input or text.
- The Runs and product pages load no Three.js chunk, as the browser network panel shows.
- With reduced motion on, nothing on the floor moves, and the state colours stay.
- `just verify` passes.
