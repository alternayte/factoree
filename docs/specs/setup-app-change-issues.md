# Setup app-change issues

Amends docs/specs/repository-setup-and-services.md: "A part that needs an app change fails, and the report names the change — a normal issue then implements it."

## What it does
When a setup pull request merges, Factoree creates a Linear issue for each app change in its setup report and delegates it to itself. Each issue runs as a normal run. When every app-change issue of a setup has ended, Factoree starts a new setup run of the repository, so that setup adds the fakes the changes made possible. The product page shows a registered repository as active. The repository list scrolls in a bounded area with a filter, and the save bar stays at the bottom of the page.

## Decisions
- Factoree detects a merge from each `push` event to the default branch. It reads the latest setup of the repository with an open pull request and asks the GitHub API whether that pull request merged — the GitHub App needs no new event, and squash, merge and rebase all work. The merge of an app-change pull request often touches no config, so every default-branch push counts.
- A merged setup gets the status `merged` — the setup row must stop saying "pull request open".
- A new product setting, "App change issues", takes `one_per_change` (default) or `one_for_all` — product policy, changeable without a release or a commit.
- `one_per_change` creates one issue per line of the app changes; `one_for_all` creates one issue that lists every line — each change gets its own run, repair budget and pull request by default.
- Each issue goes to the product's Linear team. The description names the repository full name, the change, and the setup pull request — the refiner then targets the repository without a question.
- Factoree delegates each issue to itself when it creates it — the operator stays hands-off; autonomy and risk caps still apply, and each run ends at a pull request a human merges.
- Factoree stores each app-change issue: setup id, repository, change text, Linear issue id and identifier, run id when one starts.
- Before it creates an issue, Factoree skips a change whose text equals a stored change of the repository whose issue has no ended run — an agent claim is never evidence, so Factoree dedupes, not the agent.
- The setup report lists a skipped change as "already requested: FAC-n".
- An app-change issue has ended when its run's pull request merged or closed, or its run ended with no pull request.
- On each push to the default branch, Factoree checks the repositories with app-change issues. When every app-change issue of one setup has ended and at least one pull request merged, Factoree starts one new setup run of the repository — one setup per round, not one per merge.
- The new setup gets the previous report's unproven parts (DI-21.18) — it adds the fakes for the URLs that are now configurable.
- A setup with no app changes creates no issues and starts no follow-up setup — the loop ends when a round has nothing new.
- The repository row shows "active" when the repository is registered, whatever the latest setup status — registered means a run can take an issue.
- An active repository with a newer open setup pull request also shows "setup pull request open" with its link.
- A repository that is not registered shows the setup status as now.
- Every setup button (set up, set up selected, run setup again, add host to allow list) shows the button spinner while its request runs — instant feedback on click.
- The repository list sits in a bounded scroll area (`max-h-96 overflow-auto`, sticky header) under a client-side filter input that matches the repository full name, as in assay's connection scope list.
- The product save bar moves to the end of the page and stays sticky at the bottom of the viewport; its submit button reaches the product form through the `form` attribute — the bar no longer stops between the form and the repositories.
- The setup prompt (`setup@5`) tells the agent that each app-change line becomes a Linear issue, so each line names one change on its own, and never a denied host — Factoree reports denied hosts itself.

## Out
- Subscribing the GitHub App to `pull_request` events.
- Linear `Issue` webhooks.
- Grouping changes by service.
- A setting to create issues without delegating them.
- Closing or editing an app-change issue when a later setup no longer reports the change.

## How I know it works
- Merge a setup pull request with app changes: within seconds, Linear shows one delegated FAC issue per change, each naming the repository, and each starts a run without a repository question.
- The setup row on the product page shows "active" after the merge.
- Run the setup again before the issues end: the new report lists each change as "already requested: FAC-n", and Linear shows no duplicate issue.
- Merge the last app-change pull request: a new setup run of the repository starts, and its prompt names the previous unproven parts.
- Set the product to "One for all changes", merge a setup pull request: Linear shows one issue that lists every change.
- Click "Run setup again": the button shows a spinner at once.
- Type part of a repository name in the filter: the list shows only matching repositories, and a long list scrolls inside its box.
- Scroll the product page: the save bar stays at the bottom of the viewport and rests at the end of the page.
