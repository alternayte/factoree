# Run visibility

Amends `docs/specs/release-0-1-0.md` (the web UI).

## What it does
The control plane UI gets a Runs list and a Run detail page. They show why a run failed, where its time went and what it cost, from the data Factoree already stores. An admin opens the Temporal UI at `/temporal` with the same sign-in, read-only. On a desktop the pages use the width of the screen the way Sluice does.

## Decisions
- `GET /admin/runs` lists runs newest first, filterable by product and status, with cursor pagination. Each row has the issue, the product, the status and failure reason, the duration, the total cost, repairs used of the limit and the pull request URL — one row answers "what happened" for each run.
- `GET /admin/runs/:id` returns the run with its stages, agent sessions, assertion results per attempt, review findings, skills, skill proposals and follow-up chain. Both routes are in the OpenAPI document — the UI uses the generated client, and `checks/gen-check.sh` keeps it current.
- The Run detail page shows a stage timeline from `run_stage`, the agent sessions with model, tokens, cost, model time, tool time and outcome, the assertion results per attempt with UNSTABLE marked, the findings, the skills, and links to Linear, the pull request, the proof pack and the workflow in the Temporal UI — every question from the FAC-71 to FAC-73 live runs has an answer there.
- Both pages are read-only, and every member of the workspace can open them — Linear stays the place to stop or reply, so every action stays on the agent session.
- The compose stack runs `temporalio/ui` with no domain and no published port. The Factoree API proxies `/temporal/*` to it, with `TEMPORAL_UI_PUBLIC_PATH=/temporal` — the internet never reaches it directly.
- The proxy forwards only for a signed-in Linear workspace admin and answers 404 to everyone else — one sign-in, no shared password, and the path reveals nothing.
- `TEMPORAL_DISABLE_WRITE_ACTIONS=true` — nobody terminates or signals a workflow from the UI.
- The Helm chart gets the same Temporal UI container and proxy setting as the compose stack — both release paths behave the same.
- The app shell centers the content and lets it grow to 1440 px, with the padding of Sluice. Tables use the full width. A form groups its sections in two columns from the `lg` breakpoint — the 960 px and 640 px caps squash the pages on a desktop, and Sluice is the house reference.

## Out
- Stop, retry or edit actions in the control plane UI.
- A database admin tool such as pgAdmin or Adminer.
- Charts and cost dashboards across runs.
- The Temporal gRPC port outside the stack.

## How I know it works
- The Runs list shows FAC-71 to FAC-73 with status, duration, cost and repairs.
- The FAC-73 detail page shows three attempts, the browser assertion FAIL, PASS, FAIL, and the blocking finding of attempt 2.
- An admin opens `/temporal` and sees the run's workflow history. A member who is not an admin gets 404. A request with no session gets 404.
- The Temporal UI shows no terminate or signal action.
- On a 1920 px wide window the Runs table and the product page use the width, centered, and no page is capped at 640 px.
- `just verify` passes.
