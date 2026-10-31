# Own proposals and parallel runs

Amends `docs/factoree-sdd.md` §8, §44, §45, §47, §68 and AT-28, `docs/specs/multi-repo-tenancy.md` §10 and `docs/specs/refiner-agent.md`. Closes H-14 and H-16.

## What it does
A run asks a human only when Factoree has no determined proposal. Every other question becomes a decision: Factoree takes its own proposal, continues, and lists the decision with its reason under "Needs your attention" in the proof pack. Factoree finds the target repository from the issue text or the Linear project. A run whose base branch moved still opens its pull request, so parallel runs on one repository never block each other.

## Decisions
- Factoree takes its own proposal at every autonomy level — a human reviews every result anyway, as a draft pull request, a ready pull request or a report, and a question during the run only repeats that review.
- Each decision Factoree takes appears under "Needs your attention" with its reason, and as one progress thought when it is taken — a reviewer must see what Factoree chose and why.
- A run still asks a human in three cases only: several repositories and no target rule decides, a context conflict that authority does not resolve, and a ticket with no checkable outcome after refinement — P-05 and §9 forbid a guess, and a pick among equals has no reason a reviewer can check.
- Target rule one: the issue title or description names exactly one repository of the product, by its full name or by a short name that no other repository of the product shares — a named repository is a determined choice.
- Target rule two: the issue's Linear project matches exactly one repository, which declares its projects in `.factoree/config.yaml` under `identity.linear.projects` — the project is a determined choice the team already makes.
- The target rules run on the worker before any sandbox, and the run records the rule and its reason — routing needs no model call.
- The refiner marks each criterion that no ticket sentence states as `implied` or `new`. An implied criterion cites the ticket sentence it follows from — §8 allows directly implied edge cases.
- An implied criterion freezes with the source "implied by: <sentence>", and appears under "Needs your attention" — it adds no scope.
- A new criterion is dropped, never asked, and the proof pack lists it under "Not built" — §7 forbids invented product behaviour, and a human who wants it writes a ticket.
- The gate checks that the cited sentence exists in the ticket, as it does for every source today — a refiner claim is never evidence.
- The proposals to drop an unverifiable criterion and to proceed with no screenshot are taken, and appear under "Needs your attention" — both already have a determined proposal.
- Publication opens the pull request from a branch on the verified base SHA, also when the base branch moved. `STALE_BASE` no longer stops a run, and the §68 completion invariant drops "target base SHA has not changed" — the verified patch on the verified base is exactly what Factoree tested, and GitHub CI tests the merge with the current branch.
- The proof pack states "Verified on <base>. <branch> is now <head>, N commits ahead." when the branch moved — a reviewer sees the gap at once.
- At publication Factoree runs a three-way apply check of the patch against the current branch head on the worker. A conflict appears first under "Needs your attention" with the conflicting files — the check writes nothing, and GitHub shows the same conflict.

## Out
- An agent that reads every repository to choose the target.
- A product setting that keeps the questions.
- An automatic rebase of a pull request when the base branch moves, before or after publication.
- Change sets and more than one target per run.
- A limit on parallel runs per repository.

## How I know it works
- A c-dash issue in a product with two repositories whose description says "in c-dash" reaches IMPLEMENTING with no Linear question, and the proof pack says "Factoree chose alternayte/c-dash, because the issue names c-dash".
- An issue in a Linear project that the fixture repository declares targets the fixture repository with no question.
- An issue that names no repository and has no matching project posts the target question, and the run waits in `BLOCKED_TARGET`.
- A ticket "Export the table to CSV" freezes "the export includes the header row" with an "implied by" source, and lists any criterion that adds behaviour under "Not built".
- A run whose base branch receives a merge during the run reaches READY_FOR_HUMAN with a pull request, and the proof pack states how far the branch moved.
- A run whose patch conflicts with that merge opens its pull request, and "Needs your attention" names the conflicting files first.
- `GET /admin/runs/:id` lists every decision Factoree took with its reason.
