# Setup speed and history

Amends docs/specs/repository-setup-and-services.md (the setup session and its sandbox) and docs/specs/setup-app-change-issues.md (DI-21.20, the `unchanged` status).

## What it does
A setup run skips its agent session when nothing the agent sees has changed since the previous setup ended `unchanged`. A setup agent on a repository that already has a config runs only the parts it changes and their dependents. The setup session sandbox starts from the repository's warm snapshot. The setup prompt holds the repository instructions. Each repository has a setup history page that shows every setup with its time, cost, tokens, turns, report and Temporal link.

## Decisions
- The setup input key is the SHA-256 of the default-branch head SHA and the rendered setup prompt with the sandbox paths left out — the rendered prompt holds the prompt version, the existing config, the previous unproven parts, the test secret names, the ecosystem host list, the open app changes and the repository instructions, so any change that matters changes the key.
- Factoree computes the key before any sandbox starts. It reads the head SHA, `.factoree/config.yaml` and the instruction file at that SHA through the GitHub API — a skip costs no sandbox and no model call.
- Factoree stores the key on each setup row in a new `input_key` column.
- A setup skips its session when the newest ended setup of the repository has the status `unchanged` and the same input key — the agent would see the same inputs, and the last result was final.
- A setup never skips after `failed` — the failure can be transient. It never skips after `proposed` or `partial` — the config is not on the default branch.
- A skipped setup ends `unchanged`, copies the report of the setup it matched, records that setup's id in a new `skipped_from_setup_id` column, and creates no app-change issues — the matched setup created them, and the dedupe would skip them all.
- The product page shows a skipped setup as "no change (skipped)".
- The setup prompt (`setup@7`) lists the parts the previous setup proved. On a repository that has a config, the agent runs only the parts it adds or changes and every part that depends on them, in the order bootstrap, services, seed, verify and preview, accounts — Factoree's cold proof checks every part again.
- A change to the bootstrap makes the agent run every part again — every other part depends on it.
- The setup session sandbox starts from the repository's warm snapshot when one exists for the current Kiln template, and checks out the head SHA. Otherwise it starts cold — it saves the clone and the package installs.
- The proof sandbox always starts cold — it is the evidence that the bootstrap works from a clone.
- After a warm session, the bootstrap allow list is the union of the existing `bootstrap.allowedDomains` and the hosts the session reached, narrowed to the ecosystem host list — the warm cache hides hosts the bootstrap needs. A host still missing fails in the cold proof and shows in the report.
- The setup prompt holds the repository instructions under "Repository instructions": the first of `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` at the repository root, capped at 64 KB, as SDD section 34 gives the implementer — opencode runs with `OPENCODE_DISABLE_PROJECT_CONFIG=1` and loads no project instruction file.
- The prompt says that the setup rules win over the repository instructions — a repository file never lifts the `.factoree/`-only rule.
- Each setup row stores its Temporal run id, its session time and its proof time — every setup of a repository shares one workflow id, so a Temporal link needs the run id.
- Each setup row stores whether its session started from a warm snapshot.
- A new admin endpoint lists the setups of one repository of a product, newest first, with the same workspace admin guard as the product routes.
- A new page per repository lists every setup, newest first: status, start time, total, session and proof time, cost in USD, tokens, turns, model and tool time, runner and model, skipped or warm, the pull request link and the Temporal link.
- Opening one setup on that page shows its full report: each part with its reason and log tail, the observed and denied hosts, the fakes, the app changes with their FAC issue links, and the failure message.
- The repository row on the product page links to the page as "History", beside "Run setup again".

## Out
- Setups in the Runs list.
- A warm proof sandbox.
- Linking an unproven part to the app change that blocks it.
- Repository instructions for the user validator.
- Dropping `OPENCODE_DISABLE_PROJECT_CONFIG`.
- Kiln sandbox cost in the history.

## How I know it works
- Run the anthology setup twice with no commit between them, after the first ends `unchanged`: the second ends in seconds as "no change (skipped)", Kiln shows no new sandbox, and the history row names the setup it matched.
- Add a product test secret and run the setup again: it does not skip.
- Run the anthology setup on a repository with a warm snapshot: the history shows "warm", and its session time is shorter than the last cold session.
- Read the prompt file in a setup session sandbox: it holds anthology's CLAUDE.md under "Repository instructions" and the list of parts the previous setup proved.
- Open "History" on the anthology row: every setup since 0.6.0 is listed, and each setup from this release on has a Temporal link that opens its own workflow run.
- Open one setup: its report, app changes and FAC links show.
