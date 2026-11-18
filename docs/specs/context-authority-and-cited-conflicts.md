# Context authority and cited conflicts

Amends `docs/factoree-sdd.md` §15, §22, §23, AT-07 and AT-08, and `docs/specs/refiner-agent.md`. Supersedes DI-4.7. Closes issue #60.

## What it does
A context conflict exists only when the refiner quotes two context items that disagree. Factoree checks both quotes against the pinned content. The §22 ladder then resolves the pair, or Factoree asks a human when both items are in one authority class. A shared word between two documents is never a conflict. A repository names the documents with architecture authority in `.factoree/config.yaml`. Every other document is context that the agents read but that never enters a conflict.

## Decisions
- The refiner reports a conflict as two item refs, a quoted passage from each item and a subject. — Only a read shows a disagreement, and the refiner already reads the context.
- Factoree keeps a report only when both quotes occur in the pinned content of their items after whitespace normalisation, both items are selected, and both sit in one §22 domain. Factoree drops and logs any other report. — An agent claim is never evidence.
- The word-overlap pairing of `detectConflicts` goes. Topics stay, for context ranking only. — A shared word is not a disagreement, and a proof pack must not list conflicts that do not exist.
- A kept report between two classes in one domain resolves to the higher class and is recorded (AT-07). A kept report between two items of one class sets `WAITING_FOR_INPUT` (AT-08). — §22 and §23 unchanged in effect, with a real disagreement as input.
- The question quotes both passages and asks which one governs. It carries no proposal. The answer "neither" settles the pair. — A pick among equals has no reason a reviewer can check.
- A human answer is keyed by the authority domain and both item refs. — The subject is free text from the refiner, and the pair is the stable key.
- Kept reports enter the existing context resolve loop after the refiner, as the change-set re-resolve does. The context contract and its hash hold them. A patch gate keeps old histories on the old path. — One loop asks, records and re-resolves, and Temporal replay stays deterministic.
- `.factoree/config.yaml` gets `context.authority`: a list of glob patterns of `.md` files with architecture authority, at any path. A matching file is `architecture_documentation`. — This is the project override that §22 allows.
- Every other `.md` under `doc/` or `docs/` gets the new class `documentation`. The agents read it. It never enters a conflict. With no `context.authority`, nothing under `docs/` carries authority. — Most of `docs/` is plans and reports. The safe default asks nobody.
- ADR detection runs before the glob list. An ADR reads its status from front matter `status:` or from a `Status` line or heading. `Accepted` is `accepted_adr`. `Proposed` and `Draft` are `documentation`. `Superseded`, `Deprecated` and `Rejected` are not selected. An ADR with no status is `documentation`. — A superseded ADR must never win the ladder, and authority needs recorded acceptance.
- The setup agent proposes `context.authority` in the setup pull request, and the human reviews it there. — Setup does what it can. No person configures what setup can.

## Out
- The implementer does not update a stale document in the run.
- Factoree does not rank documents by staleness.
- Factoree does not detect a conflict that the refiner does not report.

## How I know it works
- A run on a repository with 20 plans under `docs/` and no `context.authority` reaches the implementer without a context question.
- The context contract of that run lists the plans with class `documentation` and no conflict records.
- A run where the ticket touches two documents in `context.authority` that state different rules stops in `WAITING_FOR_INPUT` with one Linear question that quotes both passages.
- The answer "neither" to that question resumes the run, and the same pair asks nothing again in that run.
- A refiner report whose quote does not occur in the pinned file produces a log line and no question.
- An ADR folder with one `Accepted` and one `Superseded` ADR on the same subject gives one `accepted_adr` item, and the superseded file is absent from the contract.
- A README that the refiner quotes against an accepted ADR gives a resolved conflict with the ADR as the winner, and no question (AT-07).
- A new setup run writes `context.authority` in the proposed `.factoree/config.yaml`.
