# Refiner agent

Amends `docs/factoree-sdd.md` §8, §24, §49, §53 and §56. Supersedes DI-4.1, DI-6.2 and DI-6.4.

## What it does
Before the contracts freeze, a fresh refiner agent reads the code in the run's sprite and proposes what done means and how to prove it. Factoree validates each proposal with deterministic rules and freezes only what passes. When a proposal needs a human, Factoree asks one question in Linear with a proposed answer, so the human can reply "yes". An L3 run never starts the implementer while an assertion is manual.

## Decisions
- The §49 order becomes route, refine (deterministic parse), resolve context, prepare the work sprite, run the refiner, build and freeze the validation contract, implement — context resolution pins the SHAs the sprite checks out, and the refiner needs the sprite to read code. The contract still freezes before implementation.
- The refiner is a fourth agent role. It has its own versioned prompt in `src/prompts` and its own agent execution row — §56 names the refiner prompt.
- The refiner writes one proposal file. It writes nothing in the primary worktree, and the worktree fingerprint before and after proves it — the reviewer guard already works this way.
- A proposal holds criteria, a method and a runnable target for each assertion (a command, a test path, an HTTP request or a browser route), the files that show existing patterns, and open questions.
- Every criterion cites its source: a sentence of the ticket or a recorded human answer. A criterion the refiner inferred becomes a confirmation question — §7 forbids invented product behaviour.
- Every assertion that is not manual names a runnable target. Otherwise the gate makes it manual — the method must be executable, not a label.
- An L3 run with a manual assertion asks the human before implementation. If the rounds end with a manual assertion, the run fails with VALIDATION_MANUAL_REQUIRED before the implementer starts — agent time is not spent on a run that cannot pass.
- A question carries one proposal: "Proposal: <answer>, because <reason>". A reply "yes" accepts it — the cheapest answer in a Linear comment.
- Question rounds stay bounded at five (DI-4.6) — an elicitation loop must end.
- Authority rules and conflict resolution stay deterministic. The refiner can report a suspected conflict, and the gate records it as a question — P-05 forbids a guess.
- A refiner that writes no valid proposal ends the run with REFINEMENT_UNAVAILABLE — a repair cannot fix a broken proposal.
- The refiner reads the same skills as the implementer — the skills describe how the repository works.
- The refiner runs on the validator runner of `.factoree/config.yaml` — the validator already writes plans as data, and it is not the implementer model.

## Out
- Any question from the implementer, the user validator or the reviewer to a human.
- Target set proposals across repositories. Change sets are Version 2.
- A refiner model call outside the sprite.

## How I know it works
- The AT-02 ticket ("A failed notification delivery is never retried. Users lose messages.") produces the criterion "a failed delivery is retried", with the ticket sentence as its source, and a test or HTTP target in the repository.
- A ticket with no checkable outcome posts one Linear question that holds a proposal. A reply "yes" freezes the contract, and the implementer starts.
- A ticket whose questions stay unanswered ends with VALIDATION_MANUAL_REQUIRED, and the run has no implementer agent execution row.
- A refiner that edits a source file fails the run, and the worktree fingerprint names the change.
- `GET /admin/runs/:id/validation` shows each assertion with its source and its runnable target.
