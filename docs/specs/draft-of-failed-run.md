# Draft of a failed run

Amends `docs/factoree-sdd.md` §46, §47 and §48, and `docs/specs/run-recovery.md`. Issue #41.

## What it does
A human can ask Factoree to publish the last patch of a failed run as a draft pull request. The request is the "Publish as draft" choice that Linear shows under the failure post, the typed reply `publish as draft`, or the "Publish as draft" button on the run page. Factoree publishes exactly the patch the last check sprite received, on the pinned base SHA. The pull request body starts with the checks that did not pass and the review findings. The run ends as DRAFT_PUBLISHED.

## Decisions
- After the `error` post of a qualifying run, Factoree posts an `elicitation` with the `select` signal and one option, label "Publish as draft", value `publish as draft` — the human sees the action where the failure is posted, with one click.
- Linear sends a chosen option as a normal prompt. A prompt whose whole body is `publish as draft`, case-insensitive, with surrounding whitespace and a final period ignored, is the command. The typed reply and the chosen option take this one matcher — no second parser.
- Any other reply on a failed run still starts a follow-up run — the command must not catch a real follow-up reply.
- `POST /admin/runs/:id/draft` and a run-page button take the same path as the reply. The button opens the `Confirm` dialog. Only workspace admins can use it — the same rule as the UI stop.
- The run records who asked and from where: the Linear user, or the admin and "Factoree UI".
- A separate workflow `draft-<runId>` publishes the draft. A second request finds that workflow or its pull request, and answers with the pull request URL — the request is idempotent.
- The patch is `Run.lastPatchBase64`. Its SHA-256 is the hash the commit message and the proof pack name. Factoree passes the patch to the trusted checkout of `publishToBranch` on the control plane, which clones at the base SHA, applies it and pushes — publication already commits on the control plane and uses a sandbox only to capture the patch, so the draft needs no sandbox, and the reaper cannot block it.
- A run qualifies when its status is in FOLLOW_UP_STATUSES and a stored patch exists — any failure that got as far as a check sprite has a patch a human can finish.
- Factoree refuses, and says why on the session or in the 409 answer, when: no patch exists, the run is a change set, the failure is PATCH_HASH_MISMATCH, or a blocker finding stands from a review of that same patch — an unproven patch is acceptable, a known defect is not.
- A change set is refused — `lastPatchBase64` holds one patch per run.
- The pull request is always a draft, at every autonomy level. Factoree never marks it ready and never merges it — the human takes the unproven part, and only the human marks it ready.
- The pull request body starts with a warning block: "Factoree did not prove this change." It lists each assertion that did not pass, with its result and reason, and each finding of the review of that patch, or "This patch was not reviewed." — the evidence stays honest.
- Factoree posts a proof pack that marks each unmet assertion as not proven, and links the draft — the proof pack is the delivery record.
- DRAFT_PUBLISHED is a new terminal status. It keeps `failureReason` and `failureMessage`, and it is not a success — the checks still failed.
- A reply after DRAFT_PUBLISHED starts nothing. Factoree answers "Comment on the pull request (<url>) or put a further change in a new issue." — the pull request has its own review loop, as after READY_FOR_HUMAN.
- After publication the draft behaves as any Factoree pull request does today. When `docs/specs/pr-review-merge-and-deploy.md` is built, its PR workflow treats the draft as any run pull request and never merges it — that spec is not built yet.
- The Linear issue stays in its started state — the work is not done.

## Out
- A draft of a change set.
- A draft of a patch other than the last one a check sprite received.
- Moving the Linear issue state on a draft.

## How I know it works
- A run that failed with a passing review and one failed assertion opens a draft pull request after the human picks "Publish as draft" in Linear. The body lists that assertion and its reason. The run page shows DRAFT_PUBLISHED and the pull request link.
- A run whose last review has a blocker finding answers the reply with the finding and opens nothing.
- The same request after the sandbox reaper ran still opens the draft.
- A typed `publish as draft` works the same way. A second request answers with the same pull request URL.
- A reply "fix the button colour" on a failed run still starts a follow-up run.
