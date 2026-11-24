# PR body for humans

Amends `docs/factoree-sdd.md` §46 step 9 and AT-29, `docs/specs/draft-of-failed-run.md` and `docs/specs/change-sets.md` (the pull request body), and `docs/specs/pr-review-merge-and-deploy.md`.

## What it does
A Factoree pull request tells a human reviewer what changed and why, where to look first, what Factoree proved, and what it did not prove. The fresh reviewer writes the summary and the reading guide. Factoree fills the rest from the frozen contracts and the evidence. Each verified push rewrites the body, so the body always describes the head.

## Decisions
- The body has this order: Summary, Where to look, What was asked, Needs your eye, What Factoree did not prove, Since the last commit, and Run metadata in a collapsed `<details>`. — Reviewers have lower odds of finding a defect in the file they read last (Fregnan et al., FSE 2022), so the core comes first.
- The reviewer session outputs, as data, a summary of two or three sentences (what changed and why) and the Where to look list: path, line range and one reason per entry. The core change comes first, and glue and tests come last. — The reviewer is independent of the author and already reads the whole change.
- Factoree drops a Where to look entry whose path is not a changed file. The section names the reviewer as its author and states that it is a guide, not evidence. — An agent claim is never evidence.
- What was asked lists each frozen criterion with its result and an evidence link. It marks each implied criterion with its implied-by source, and it lists each new criterion under Not built. — The validation contract is the record of the request.
- Needs your eye lists the by-eye criteria with their screenshots and the pull request preview link. — A human checks what Factoree cannot.
- What Factoree did not prove lists the changed check-defining files, the fakes that answer for real services, the visual evidence gap, unenforced egress and the known limitations, or "Nothing." — A reviewer must see the edge of the evidence.
- Since the last commit appears after a PR follow-up run. It names what started the run, links each thread or reply, and states the change per finding. — A reviewer reads only the new part.
- Run metadata keeps the AT-29 fields: Work Item link, Run ID, base SHA, patch SHA-256, changed files, repair count, and the contract version of the head. — AT-29 stays met, and machines still find the fields.
- The body names the Linear issue key with `Fixes <KEY>` and links the proof pack. — Linear links the pull request, and the proof pack stays one click away.
- Factoree owns the text between `<!-- factoree:body -->` and `<!-- /factoree:body -->`. Each verified push replaces only that block. Text outside the block stays. — The body describes the head, and a human's notes survive.
- The title is the work item title followed by the Linear key in parentheses, at most 120 characters. The `Factoree: ` prefix goes away. — The author shows the app, and the key links Linear.
- A draft of a failed run keeps its warning block first, inside the owned block. A change set keeps its sibling and merge order section last. — Those specs still hold.
- A body section with nothing to say is left out, except What Factoree did not prove. — Empty headings are noise.

## Out
- Diagrams in the body.
- A review effort or confidence score.
- Changes by Factoree to text outside the owned block.

## How I know it works
- A new Factoree PR on c-dash starts with a summary in plain sentences, then Where to look with the page component first and its test last.
- Each Where to look path is a file of the diff, and the section names the reviewer.
- What was asked shows each criterion with its result. The run metadata opens from a collapsed block and shows the patch SHA-256.
- The title reads `name what the configs page is loading (FAC-73)`, and the Linear issue shows the pull request.
- A human adds a line under the owned block. A PR follow-up run pushes a commit. The human's line stays, and Since the last commit names the review it answered.
- A draft of a failed run shows "Factoree did not prove this change." above the summary.
