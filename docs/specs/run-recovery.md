# Run recovery

Amends `docs/factoree-sdd.md` §23, §38, §42, §47 and §50.

## What it does
A run that fails posts what blocked it, built from the recorded facts, and gives example replies. A human reply in the same Linear agent session starts a follow-up run. The follow-up run refines again with the reply as a human decision, so it can change the frozen criteria, and it gets a new work sprite and a new repair budget. A browser assertion that fails runs once more in the same check sprite. When the two results differ, the assertion is unstable: it spends no repair, and the run can still publish a draft pull request that names it.

## Decisions
- The failure post lists, per attempt, each failed assertion, each unstable assertion, each blocking finding with its file, and each file the reviewer named outside the work item — the recorded facts already name the blocker, and no agent claim decides anything.
- The failure post ends with example replies built from those facts, for example "Drop VAL-UI-001 and check the text in the source instead." — the human sees what a useful reply looks like.
- No agent session writes the failure post — an extra session costs money and minutes after a failed run, and its advice is an agent claim.
- A reply starts a follow-up run only after FAILED, FAILED_REVIEW or STALE_BASE — those runs can recover with more information.
- A reply after READY_FOR_HUMAN, CANCELLED, FAILED_CONFIGURATION or BLOCKED_ROUTING starts nothing, and Factoree answers with one line that names where the change belongs — a pull request has its own review loop, a human stopped a cancelled run on purpose, and a configuration fault repeats until the configuration changes.
- A reply while a run is active stays a human input of that run, as today — only a terminal run takes a follow-up.
- The follow-up run is a new Run row and a new workflow in the same agent session. `Run.followUpOfRunId` names the failed run — the record of the failed run never changes, and the chain stays readable.
- The follow-up run refines again. The reply is a recorded human decision with the highest authority, so it can drop, replace or add a criterion — in FAC-73 the frozen contract itself was the blocker.
- The follow-up run receives the last findings of the failed run and its last patch, both as reference — the implementer learns from the failure and does not build on a patch that failed review.
- The follow-up run starts a new work sprite from the base and has the full repair budget and run time — a retry with the budget of a spent run cannot work.
- A failed browser assertion runs once more in the same check sprite before its result counts — a run costs about one second, and FAC-73 flipped between PASS and FAIL across attempts.
- Two results that differ make the assertion UNSTABLE. It is neither PASS nor FAIL, and it starts no repair — no code change can fix a check that flips by timing.
- A run whose only problem is unstable assertions publishes a draft pull request and lists each unstable assertion first under Needs your attention — the change is proven by every other check, and a human decides on the rest.
- The proof pack and the completion invariant treat UNSTABLE as not proven — Factoree never reports an assertion as passed that it could not prove.
- Two failed results are an ordinary failure, and repair works as today.

## Out
- A follow-up after a run that succeeded, and a push to an existing pull request.
- An automatic follow-up without a human reply.
- A re-run of a command or HTTP assertion.
- A stop or retry button in the control plane UI.

## How I know it works
- A run that fails on a blocking finding posts the finding, its file and example replies in Linear.
- A reply to that run in Linear starts a new run in the same agent session. Its row has `followUpOfRunId` set, and it starts with refinement.
- A reply that drops a criterion leaves that criterion out of the new frozen Validation Contract.
- A reply to a READY_FOR_HUMAN run starts no run and gets one line in Linear.
- A browser assertion that fails once and passes on the re-run is UNSTABLE in the proof pack, the run spends no repair, and the pull request is a draft.
- A workflow test pins each of these paths. `just verify` passes.
