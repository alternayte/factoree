# Retro agent

Amends `docs/factoree-sdd.md` §4, §53, §59 and §61, and `docs/specs/model-picker.md` (one more role row). Reference: Warp self-improving factories (2026-08-27), Cognition "Multi-Agents: What's Actually Working" (2026-04-22), Paperclip goals guide, read 2026-11-11. Sentry MCP and Seer Autofix, PostHog MCP and Inbox, Datadog MCP and Bits Code, Devin Sentry triage, read 2026-11-25.

## What it does
A retro agent runs on a schedule, outside any run, and reads the runs that ended since the last retro in the products it covers. It writes findings, and each finding cites the runs that show it. The Retro page lists the findings of each retro beside the measured numbers of each product. "Create issue" turns a finding into a Linear issue in the product's team and delegates it to Factoree, so a normal run makes the change with a validation contract, checks, review and a proof pack. A product can keep redacted agent transcripts, and the retro agent reads them where they exist. A product can also add signal sources: MCP servers for production errors or product analytics. Before the session, Factoree runs the queries that the operator set and gives the results to the agent as files. The agent then also proposes error findings and idea findings toward the product goal, which an operator writes in markdown. A human creates an idea issue and delegates it in Linear. Factoree never delegates an idea issue.

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
- A signal source belongs to one product and has a kind, errors or analytics, an MCP endpoint, an optional bearer token from a product secret, and up to 10 queries — §52: a product's signals stay in its retros.
- A query has a name, an MCP tool name, JSON arguments and a byte cap (default 256 KiB, at most 1 MiB). The text `{since}` in an argument becomes the end time of the last successful retro, in ISO 8601 — the operator picks what the agent sees, and each retro reads new data.
- The query tools join the source's allow list, and each call passes Action Policy — §58.
- The worker calls each query before the session and redacts the result with the retained-log redactor. It writes the result to `signals/<source>/<query>.md` in the sandbox. Each result is one signal result with its own id. The retro stores each result, its SHA-256 and its source and query names, and deletes them after the product's run retention period — the token never enters the sandbox, Factoree can check every citation, and production data may hold personal data.
- A failed or capped query records its reason as a retro event and skips that result. The retro goes on — a signal source never fails a retro, as DI-5.13 does for a context source.
- The admin connection test runs each query and shows its size and its first 500 characters — the operator sees what the agent reads.
- The output is a list of findings: product, kind (factory, error or idea), title, description, cited run ids, cited signal result ids, cited repositories — data that Factoree checks.
- Factoree drops a finding that cites a run or a signal result outside the retro's input, or that mixes products — an agent claim is never evidence, and a finding targets one product.
- Factoree drops a factory finding with no cited run, an error finding with no cited result from an errors source, and an idea finding with no cited result from an analytics source — each kind rests on its own evidence.
- An error finding states the error and never a cause in a run. The Retro page shows no link from an error to a run as a cause — error tools return no standard commit field, so Factoree cannot prove one.
- Factoree drops a finding whose title equals an open finding of the same product, and the page shows it as "already proposed" — the app-change issue dedupe rule.
- "Create issue" on a factory or error finding creates the Linear issue in the product's team with the description, the cited run links, the cited signal results and every cited repository, and delegates it to Factoree — the starting set of a change set is the repositories an issue names, so a multi-repo finding runs as one change set.
- "Create issue" on an idea finding creates the same issue and does not delegate it. A human edits it and delegates it — an idea is a product decision, and the refiner takes ticket sentences as the source of criteria.
- SDD §4 "autonomous product ownership" stays a non-goal. Factoree may propose a product change with evidence, and only a human decides it — the idea finding gate is that decision.
- A finding stays proposed until a human creates its issue or dismisses it — a human chooses what the factory changes.
- The product page has an optional "Product goal" field in markdown, at most 16 KiB, with a preview — it tells the retro agent what the product must achieve and what to improve first.
- Only the retro agent reads the product goal, for all three finding kinds. Runs do not read it — the refiner drops a new criterion, so the goal would cost tokens in every run with no effect.
- With no product goal, the agent ranks error findings first, then factory findings by failed runs, repairs, hung sessions and cost, then idea findings — a production error hurts users now.
- The Retro page shows per product, over the runs of the last retro: first-pass rate, repairs per run, hung sessions and cost per run — the goal and the result sit side by side.
- The product page has a "Keep transcripts" switch, off by default — §61.
- A kept transcript is the runner's whole process output plus every tool input, redacted by the same redactor as the retained log, then gzipped — the runner already holds both, and redaction runs before any byte leaves the worker.
- Transcripts go to Postgres by default — one dependency keeps self-hosting easy.
- The install settings take an optional S3-compatible bucket (endpoint, bucket, region, access key, secret key). When set, new transcripts go there and the row keeps the object key. `FACTOREE_TRANSCRIPT_S3_*` env vars win and lock the fields — the owner's env-over-UI rule.
- A kept transcript is deleted after the product's run retention period — §51.
- The model picker gets a retro row on the tenant's Retro settings, with the same runner, model and effort rules — no second model form.
- A running retro shows on the factory floor (`docs/specs/factory-floor.md`) as one consultant who walks the lines of the products it reads. The retro session writes session pulses with its retro id, and the floor read model returns the running retros — every workflow that does work is visible on the floor.

## Out
- Shaping agent roles: free-text mandates, per-product prompt overrides, or review rules. No repeated review comment exists yet to justify them.
- Swapping a role definition into a running run.
- An orchestrator or manager agent inside a run.
- A retro that reads more than one tenant.
- Proposals against Factoree's own prompts.
- Automatic issue creation or delegation from a finding.
- Factoree deciding or delegating a product change by itself (SDD §4, autonomous product ownership).
- Live MCP access for the retro agent, and queries that the agent writes.
- A causal link between a production error and a run.
- OAuth sign-in to a signal source.
- An error alert or a vendor webhook that starts a retro.
- Code access for the retro agent.

## How I know it works
- `just verify` passes.
- With the schedule off, "Run now" starts a retro, and the Retro page shows it with its cost and its findings.
- A save of "Weekly, Monday, 09:00, Europe/London" shows the next Monday 09:00 as the next retro, and `temporal schedule describe --schedule-id retro-<tenantId>` shows the same spec. A save of Off removes the schedule.
- While a retro runs, "Run now" is disabled and says "A retro is running".
- After a worker restart, the schedule exists and the next retro time is unchanged.
- Each finding links runs that exist in the same product. A finding seeded with a foreign run id does not appear.
- A product with an errors source and an analytics source shows both query results as files in the retro sandbox. The stored results hold a seeded secret value as redacted.
- A retro shows factory, error and idea findings. Each error and idea finding links its signal results.
- A finding seeded with a signal result id from another product does not appear. An idea finding seeded with only a run citation does not appear.
- "Create issue" on an idea finding creates a FAC issue that is not delegated, and no run starts.
- A query that fails shows its reason on the retro, and the retro still ends with findings.
- "Create issue" on a finding that cites c-dash and anthology creates one FAC issue delegated to Factoree, and its run has two targets.
- A second retro over the same failures shows the finding as "already proposed".
- With "Keep transcripts" on, a run's sessions store a gzipped transcript. A seeded secret value appears in it as redacted.
- With the S3 fields set, the transcript lands in the bucket and the row holds the object key. With `FACTOREE_TRANSCRIPT_S3_BUCKET` set, the field shows locked.
- With "Keep transcripts" off, no transcript row exists for a new run.
- The Retro page at 390 px shows the numbers and the findings without horizontal scroll.
- While a retro runs, the factory floor shows the consultant on the lines of its products, and a click on it opens the retro with its status.
