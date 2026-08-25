# Factoree build status

## Specification

- Source of truth: `docs/sdd.md`
- Version: 2.0
- SHA-256: `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`

## Phases

- Completed: Phase 1 — Control plane; Phase 2 — Sandbox and first runner; Phase 3 — Deterministic verification; Phase 4 — Refinement and Context Contract; Phase 5 — Backstage and MCP; Phase 6 — Validation Contract; Phase 7 — User validation and evidence; Phase 8 — Review and repair; Phase 9 — Trusted publishing
- Current: none
- Next: Phase 10 — Proof Pack

## Git

- Branch: `main`
- Phase 9 range: `d2cb59b..1e9746c`, 22 commits on `phase-09-trusted-publishing`, then the no-fast-forward merge.
- The repository has no remote. Each phase merges into local `main` with a no-fast-forward commit.

## Phase 9 verification

The controller ran every check below itself. Agent claims were not accepted as evidence.

| Check | Result |
| --- | --- |
| `npm run verify` at the branch head `1e9746c` | exit 0, run in stages with a real aggregate exit code: lint 0, typecheck 0, unit 909 passed and 7 skipped, integration and acceptance 188, workflow 74, build 0 |
| Skip count | 7, the same as the Phase 2 through Phase 8 baseline. Phase 9 skipped no test. |
| Phase 9 exit condition | pass: only the exact verified patch can reach GitHub |
| AT-27 exact patch | pass, proved four ways in `tests/acceptance/phase-09-exit.test.ts` against a real bare repository. Case 2 changes the patch and keeps the hash. Case 3 keeps the patch and changes the hash. The comparison is sensitive to BOTH sides, so neither case alone proves the rule. Every refusal asserts the remote gained no ref. |
| AT-28 stale base | pass. `tests/workflow/at-28-stale-base.test.ts` proves the Run ends `STALE_BASE` with no failure reason and never calls `publish`. Exit case 4 drives the real `checkBase` against a real moved remote. |
| AT-29 pull request | pass. `tests/acceptance/at-29-pull-request.test.ts` drives the real `publish` activity against a real bare repository and a local GitHub API fixture. Exactly one pull request, carrying the Work Item, the Run ID, the base SHA, the patch hash, and the verification summary. |
| AT-35 publication case | pass. A second attempt returns `created: false` and creates no second pull request. The workflow test asserts the ordered `created` flags hold exactly one `true`. |
| Every earlier acceptance test | still passes unchanged |
| Task reviews | 10 tasks, 10 task reviews, 6 fix rounds. Task 5 needed seven fixes in one round. |
| Whole-branch review | 4 Important, no Critical. All four fixed and re-reviewed clean. |
| External audit (OpenCode, DeepSeek v4 Pro) | 4 findings. The controller reproduced all four. One was already fixed. Three were repaired. |
| Controller verification | found one BLOCKING regression that every review missed. See below. |

Evidence: `docs/build/evidence/phase-09-verify.txt`, last line `exit=0`.

**The blocking regression the controller's own verification found.** A Linear stop that arrived while the Run was inside the new publication path ended the Run `FAILED` rather than `CANCELLED`. SDD section 50 says a stop must prevent publication, and reporting a failure for a Run a human stopped is wrong. `tests/acceptance/phase-08-exit.test.ts` caught it with `expected 'FAILED' to be 'CANCELLED'`. The defect is timing dependent, so three earlier whole-suite runs passed. **Never accept a green suite as proof that a stop path is safe. Run the suite more than once.** The `catch` around `publish` now checks the stop before it classifies any error, the `checkBase` call carries the same guard, and a stop after a SUCCESSFUL publication keeps the message that names the pull request.

**The four defects the whole-branch review found.**

1. **The verified TREE identity never crossed the review-to-publish seam.** The review computed a tree SHA and discarded it, and `publish` compared FILE NAMES only. A watch-mode formatter or a codegen daemon that rewrote an already-changed file after the review would publish content no Reviewer saw. `reviewedWorktreeSha` now crosses the seam and `publish` compares it to `patch.treeSha`. An empty value is a mismatch, never a skip.
2. **A rename could never be published.** The Phase 8 changed-file query carried no rename pinning while the Phase 9 one used `--no-renames`, so a rename produced different file lists and killed the Run at publish, blaming the review. Both queries now share `PATCH_GIT_OPTIONS`.
3. **A push that succeeded followed by a failed pull request creation was unrecoverable.** A fresh committer date gave a new commit SHA, the retry push was rejected as non-fast-forward, and the Run died with an orphan branch. The trusted commit now carries a fixed timestamp, so a retry pushes the identical commit as a no-op.
4. **A stop or a timeout after a successful publication told the human that nothing was published.** The message now names the pull request. The Run STATUS is unchanged, because SDD section 68 still forbids a success terminal state.

**The four defects the external audit found, all reproduced by the controller.**

1. **`publish` never asserted the base.** The check lived only in the separate `checkBase` activity, which the workflow calls once, so a Temporal retry of `publish` minutes later republished with no base check at all. `publish` now re-asserts the base itself.
2. **The GitHub token was world readable.** The authenticated clone URL was an argv element of `git clone`, so the credential was visible through `ps` and `/proc/<pid>/cmdline`. The code already avoided that exposure for `git ls-remote` a few lines away. The credential now travels as `GIT_CONFIG_KEY_0=http.<origin>/.extraheader` on the clone and the push, and never in argv.
3. **The commit was non-deterministic.** Already closed by the whole-branch fix wave.
4. **A deterministic failure consumed the whole retry policy.** A rejected credential, a missing ref, an inapplicable patch, and a GitHub 401, 403, or 404 each burned three attempts. A deterministic git failure and a GitHub 4xx other than 408 and 429 are now non-retryable.

## Read this before Phase 10

**Factoree publishes, and the agent never does.** SDD section 46 runs entirely on the control plane, in a fresh temporary directory, outside the sandbox and outside every agent session. `src/domain/publishing/trusted-checkout.ts` is the one owner. The step 5 hash assertion sits before the first `checkout -b`, so a branch, a commit, and a push are structurally unreachable on a mismatch. Keep that order.

**The publication path runs in exactly this order, and the order is load bearing.** Inside `publish`: capture the patch, `assertSameChangedFiles`, the tree comparison against `reviewedWorktreeSha`, the empty-patch refusal, `findByHead` with the `created: false` early return, the base freshness re-check, then the checkout, the push, and the create. **The pull request lookup must stay BEFORE the base check.** An already-published Run whose base then moved must return its pull request, not fail.

**Three gates now prove that the published change is the reviewed change.** The file names must match, the tree SHA must match, and the patch hash must reproduce in the trusted checkout. The tree gate is the one that closes the window between the review and the publication. **An empty `reviewedWorktreeSha` is a mismatch.** Every gate fails closed.

**The GitHub credential never enters an argv.** It reaches the redactor first, then travels only as a `GIT_CONFIG_*` environment value and as an HTTP header. **Never pass an authenticated URL to a git command.** Two separate reviews caught two separate instances of that mistake in this phase.

**`assertHttpsRepositoryUrl` is the only defence against a remote-helper URL.** An `ext::` URL reaches command execution on the control plane, and the `--` separator does not stop a remote helper. `tests/acceptance/at-29-pull-request.test.ts` covers it. **Do not delete that check, and do not delete its test.**

**The diff options are pinned in one place.** `PATCH_GIT_OPTIONS` and `PATCH_DIFF_ARGS` in `src/domain/publishing/patch.ts` are read by the sandbox capture, by the control-plane recomputation, and by the Phase 8 changed-file query. **A change to one of them changes all three.** That is the point.

**The Action Policy has its first enforcement point.** `worktreeFingerprint` in `src/domain/review/source-diff.ts` runs before and after the Reviewer session, and a changed tracked tree refuses the review. It covers TRACKED content only.

**Still no success terminal state.** A Run that publishes falls into the residual wait and ends `FAILED` with `RUN_TIMEOUT`, or `CANCELLED` on a stop, with a message that names the pull request. SDD section 68 forbids `READY_FOR_HUMAN` without a Proof Pack. **Phase 10 builds it, and Phase 10 is the phase that finally closes the invariant.**

**A stock repository configuration still cannot review or publish.** SDD section 15 sets `reviewer: claude`, and `ClaudeCodeRunner` arrives in Phase 11. Publication needs a Project secret named `GITHUB_TOKEN` without the injection mark.

## Human decisions

None required so far. Every decision was taken by the controller and is recorded in the phase plans, the commit history, or the lists below.

Phase 4 through Phase 8 decisions still stand. Decisions added in Phase 9 are the twelve recorded in `docs/build/phase-09-plan.md`, plus these sixteen taken during execution:

1. **The published patch carries `--binary` and is NOT the Reviewer diff.** The Phase 8 STATUS note said Phase 9 must hash the output of `captureSourceDiff`. That note conflicted with SDD section 44, and the SDD won. A redacted, truncated diff cannot be applied and must never be hashed. The intent is kept by the changed-file agreement check.
2. **Task 1 defines `EmptyPatchError`,** because a later task consumes it and no task created it.
3. **The workflow uses the flat fields of `PrepareSandboxActivityOutput`.** The plan had invented a nested shape.
4. **The publication path hoists two carriers before the repair loop,** because `review` and `verification` are loop-scoped and cannot be read after the `break`.
5. **A semantic publication failure becomes `ApplicationFailure.nonRetryable` with an explicit type,** rather than relying on Temporal to derive it from a class name.
6. **The unpinned-git-input finding entered a fix round rather than the deferred list.** An unpinned input makes a good change present as tampering and blocks a correct publication.
7. **An `ext::` URL survives the `--` separator,** so the scheme check exists and must stay.
8. **The worktree fingerprint finding became a comment accuracy fix.** The check covers tracked content only, and the published patch skips the same paths.
9. **`nonRetryableErrorTypes` belongs in the workflow proxy options,** not in the activity. That is the house pattern.
10. **The concurrent duplicate pull request race stays open.** GitHub answers 422 for a second pull request on one head branch.
11. **The base64 portability defect was repaired in the source, not worked around in the tests.** A shim in front of the code under test weakens the evidence, because the host decides whether the real capture runs.
12. **The controller owns `docs/build/evidence/phase-09-verify.txt`,** and the committed 1577-line integration transcript was deleted. It carried absolute paths from the build machine.
13. **The branch name is `factoree/run-<runId>`,** from the source. The plan text was stale.
14. **The orphan branch defect is fixed by a deterministic commit,** so a retry pushes the identical commit SHA as a no-op. That removes the failure rather than recovering from it.
15. **The base re-check sits AFTER the pull request lookup.** An earlier ordering broke idempotency for an already-published Run whose base then moved.
16. **The `at-35` polling budget was raised rather than the flake accepted.** A correct implementation must not fail because the machine is busy.

## Carried findings for later phases

Reviewed, judged not reachable or not in scope now, deliberately not fixed. Every Phase 4 through Phase 8 entry that Phase 9 did not close still stands.

**New in Phase 9, highest priority:**

- **The SDD section 46 hash assertion compares two diff texts that two different git binaries produce.** Twelve configuration values are pinned, and two git versions can still format a diff differently. The failure is closed, so such a Run publishes nothing and reports `PATCH_HASH_MISMATCH` for a correct change. **Phase 12 should log the git version on both sides, so a version skew is diagnosable rather than indistinguishable from tampering.**
- **The Reviewer still cannot audit the Validation Plan's success criteria.** Carried from Phase 8, unchanged. **Phase 10 owns it,** because the Proof Pack is the last place a human sees those criteria.
- **Three routes from a real defect to a passing review remain, all by design.** Carried from Phase 8. The Proof Pack should surface a `blocker` or `high` finding that failed only one gate.
- **The worktree fingerprint misses an ignored path and anything under `.git/`.** A Reviewer that writes `.git/info/exclude` can hide a later write from the check. The published patch skips the same paths, so patch integrity holds. **Phase 12 hardening owns it.**

**New in Phase 9, small:**

- A GitHub 403 secondary rate limit is a 4xx that GitHub asks a client to retry, and it is now non-retryable. A 429 and a 408 are correctly retryable.
- `Permission denied` is treated as deterministic, and it can also come from a transient local file lock.
- `findByHead` uses `state=all`, so a CLOSED pull request on the same head branch is adopted as the current one. Only reachable for a reused Run identifier.
- `credentialEnvironment` returns an empty environment for a missing token. The activity refuses an empty secret earlier, so it fails closed.
- The deterministic-commit integration test asserts the recorded author date and committer date, which is the robust form. The same-SHA assertion alone was not.
- `tests/workflow/at-35-worker-restart.test.ts` still hand-builds its own activity map and is the only workflow test file that does not use the shared harness. **A later phase that adds an activity must update that file by hand.**
- `tests/workflow/at-16-deterministic-failure.test.ts` asserts an exact activity-name list. A later phase that adds an activity to the implement, verify, validate, review, publish path must update that list.

**Everything else carried from Phase 8 and earlier still stands,** including the Phase 6 redaction gap for human-authored goal text at every persistence boundary, the Linear evidence storage that has never run against a live account, and every Phase 12 live-proof item.

## Blockers

None.

Live Linear, GitHub, Fly Sprites, and Temporal Cloud credentials are needed for the Phase 12 live acceptance test. Phase 10 does not need them.

## Environment notes

- Node 24 LTS is at `/opt/homebrew/opt/node@24/bin`. The Homebrew `node` 25 binary on this machine is broken, so prefix PATH with the Node 24 path.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`. **Never write a file through a `cat` heredoc, and never build a commit message with `git commit -m "$(cat <<EOF ...)"`.** Use `git commit -F` with a file.
- `timeout` and `gtimeout` are not installed.
- Docker is required for the integration and workflow suites.
- **`npm run verify` takes longer than a two-minute foreground tool call.** Run it in stages in the background and poll the output file. **Compute a real aggregate exit code across the stages.** A naive `echo "exit=$?"` after a loop reports only the LAST stage, and it reported `exit=0` over a failing workflow stage in this phase.
- **Run the whole-repository `npm run lint` and `npm run typecheck` yourself at every task gate.**
- The acceptance tests run under `vitest.integration.config.ts`, not under a config of their own.
- **Run every suite more than once before you believe a green result.** Phase 9 hit two timing-dependent failures that a single run missed: a real stop-path regression in `phase-08-exit`, and a load-sensitive budget in `at-35`. **Do not accept "it is a known flake" from an agent. Rerun the suite yourself, and run the failing file alone several times.**
- Phase 9 added no migration. `Run.patchSha256`, `Run.commitSha`, and `Run.pullRequestUrl` already existed.
- **`opencode` version 1.18.18 is installed and authenticated for DeepSeek. The model `deepseek/deepseek-reasoner` NO LONGER EXISTS.** Two audit attempts failed with an opaque `UnknownError` before the cause was found. Run `opencode models` and use `deepseek/deepseek-v4-pro`. **Pass the prompt as the message argument, not with `-f`.** The audit prompt that produced four real defects named ten categories, listed the deliberate designs to exclude, and demanded a file and a line for every finding.
- An OpenCode run can be killed by a session interrupt. Start it detached with `nohup` if it must survive.
