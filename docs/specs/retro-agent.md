# Retro agent

Amends `docs/factoree-sdd.md` §53, §59 and §61, and `docs/specs/model-picker.md` (one more role row). Reference: Warp self-improving factories (2026-08-27), Cognition "Multi-Agents: What's Actually Working" (2026-04-22), Paperclip goals guide, read 2026-11-11.

## What it does
A retro agent runs on a schedule, outside any run, and reads the runs that ended since the last retro in the products it covers. It writes findings, and each finding cites the runs that show it. The Retro page lists the findings of each retro beside the measured numbers of each product. "Create issue" turns a finding into a Linear issue in the product's team and delegates it to Factoree, so a normal run makes the change with a validation contract, checks, review and a proof pack. A product can keep redacted agent transcripts, and the retro agent reads them where they exist.

## Decisions
- A retro is its own Temporal workflow on the existing worker task queue, started by a Temporal Schedule or by "Run now" — it never steers a live run, and the run workflow stays the only orchestrator.
- Retro settings are per tenant: schedule, the products in scope, the runner, model and effort, and a cost cap per retro — §52 keeps one tenant's data out of another's retro.
- The schedule is off by default — a retro costs an agent session, and the operator turns it on.
- The schedule form offers Off, Daily or Weekly, a weekday for Weekly, and an hour picker. The time zone fills in from the browser and the operator can change it. The form never shows a cron expression — the operator picks a time, not a syntax.
- Each save of the retro settings makes the API create, update or delete the one Temporal Schedule `retro-<tenantId>`, with the stored IANA time zone — a schedule survives a worker restart or deploy, a `setInterval` does not, and the zone keeps "09:00" at 09:00 across daylight saving changes.
- The schedule uses the overlap policy `SKIP` and a catch-up window of one hour — two retros never read the same runs, and a Temporal outage starts at most one missed retro.
- The settings page shows the next retro time from the schedule, the last retro with its status, cost and finding count, and "Run now" — the operator sees that it works without opening Temporal UI.
- "Run now" starts the workflow with the id `retro-<tenantId>-<time>`. While a retro runs, the button is disabled and says "A retro is running" — one retro at a time, with the reason shown.
- A save that cannot reach Temporal keeps the settings, shows "Schedule not saved: Temporal is unreachable" with a retry button, and the worker reconciles the schedule from the stored settings at start — the stored settings are the truth, and the schedule follows them.
- A retro reads the runs of its products that ended since the last successful retro, capped at 200 — each run is read once, and one retro stays inside the model's context.
- Factoree exports, per run, the stages, review findings, repairs, failed checks with their retained logs, hung sessions, human replies of follow-up runs, cost per session and the transcript when kept, as files in the sandbox — the agent reads data, and P-12 holds.
- The retro agent runs through the existing runner in a sandbox from the sandbox image, with no repository and no network beyond the model provider — P-08 forbids a direct model call, and the agent needs no code.
- The retro prompt is `src/prompts/retro.ts`, and each retro records its prompt version — §56.
- The output is a list of findings: product, title, description, cited run ids, cited repositories — data that Factoree checks.
- Factoree drops a finding that cites a run outside the retro's input, or that mixes products — an agent claim is never evidence, and a finding targets one product.
- Factoree drops a finding whose title equals an open finding of the same product, and the page shows it as "already proposed" — the app-change issue dedupe rule.
- "Create issue" creates the Linear issue in the product's team with the description, the cited run links and every cited repository, and delegates it to Factoree — the starting set of a change set is the repositories an issue names, so a multi-repo finding runs as one change set.
- A finding stays proposed until a human creates its issue or dismisses it — a human chooses what the factory changes.
- The product page has an optional "Retro goal" text — it tells the retro agent what to improve first, and only the retro agent reads it.
- With no retro goal, the agent ranks findings by failed runs, then repairs, then hung sessions, then cost — the fixed mandate covers an empty field.
- The Retro page shows per product, over the runs of the last retro: first-pass rate, repairs per run, hung sessions and cost per run — the goal and the result sit side by side.
- The product page has a "Keep transcripts" switch, off by default — §61.
- A kept transcript is the runner's whole process output plus every tool input, redacted by the same redactor as the retained log, then gzipped — the runner already holds both, and redaction runs before any byte leaves the worker.
- Transcripts go to Postgres by default — one dependency keeps self-hosting easy.
- The install settings take an optional S3-compatible bucket (endpoint, bucket, region, access key, secret key). When set, new transcripts go there and the row keeps the object key. `FACTOREE_TRANSCRIPT_S3_*` env vars win and lock the fields — the owner's env-over-UI rule.
- A kept transcript is deleted after the product's run retention period — §51.
- The model picker gets a retro row on the tenant's Retro settings, with the same runner, model and effort rules — no second model form.

## Out
- Shaping agent roles: free-text mandates, per-product prompt overrides, or review rules. No repeated review comment exists yet to justify them.
- Swapping a role definition into a running run.
- An orchestrator or manager agent inside a run.
- A retro that reads more than one tenant.
- Proposals against Factoree's own prompts.
- Automatic issue creation or delegation from a finding.
- Feature work toward a business goal (SDD §4, autonomous product ownership).
- Code access for the retro agent.

## How I know it works
- `just verify` passes.
- With the schedule off, "Run now" starts a retro, and the Retro page shows it with its cost and its findings.
- A save of "Weekly, Monday, 09:00, Europe/London" shows the next Monday 09:00 as the next retro, and `temporal schedule describe --schedule-id retro-<tenantId>` shows the same spec. A save of Off removes the schedule.
- While a retro runs, "Run now" is disabled and says "A retro is running".
- After a worker restart, the schedule exists and the next retro time is unchanged.
- Each finding links runs that exist in the same product. A finding seeded with a foreign run id does not appear.
- "Create issue" on a finding that cites c-dash and anthology creates one FAC issue delegated to Factoree, and its run has two targets.
- A second retro over the same failures shows the finding as "already proposed".
- With "Keep transcripts" on, a run's sessions store a gzipped transcript. A seeded secret value appears in it as redacted.
- With the S3 fields set, the transcript lands in the bucket and the row holds the object key. With `FACTOREE_TRANSCRIPT_S3_BUCKET` set, the field shows locked.
- With "Keep transcripts" off, no transcript row exists for a new run.
- The Retro page at 390 px shows the numbers and the findings without horizontal scroll.
