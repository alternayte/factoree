# Factoree build status

## Specification

- Source of truth: `docs/sdd.md`
- Version: 2.0
- SHA-256: `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`

## Phases

- Completed: Phase 1 — Control plane; Phase 2 — Sandbox and first runner; Phase 3 — Deterministic verification; Phase 4 — Refinement and Context Contract; Phase 5 — Backstage and MCP; Phase 6 — Validation Contract; Phase 7 — User validation and evidence; Phase 8 — Review and repair
- Current: none
- Next: Phase 9 — Trusted publishing

## Git

- Branch: `main`
- Phase 8 range: `d75406a..7880746`, 23 commits. 22 on `phase-08-review-repair`, then the no-fast-forward merge.
- The repository has no remote. Each phase merges into local `main` with a no-fast-forward commit.

## Phase 8 verification

The controller ran every check below itself. Agent claims were not accepted as evidence.

| Check | Result |
| --- | --- |
| `npm run verify` on the branch head `ccdab22` | exit 0, run in stages so no part could be cut short: lint 0, typecheck 0, unit 862 passed and 7 skipped, integration and acceptance 166, workflow 69, build 0 |
| `npm run verify` on `main` after the merge | exit 0, the same counts |
| Skip count | 7, the same as the Phase 2 through Phase 7 baseline. Phase 8 skipped no test. |
| Phase 8 exit condition | pass: a known defect is found, repaired, revalidated, and re-reviewed |
| AT-20 validation repair | pass. The repair clause is proved by `tests/workflow/at-20-validation-repair.test.ts`, which drives the real workflow. The reverification is the workflow's own recorded activity order, not a test's sequencing. |
| AT-21 fresh review | pass, proved three ways: the session identifiers differ, the `AgentExecution` rows carry both roles with two distinct session references, and the real reviewer prompt holds neither the Implementer summary nor its success sentence. It also asserts the SDD section 40 input list really arrives. |
| AT-22 blocking finding | pass. The harness drives the real `parseReviewReport` and the real `decideReview`, so the rule under test is the real rule. |
| AT-23 scope control | pass at `medium` and at `blocker`, and the two cases assert different gates, so one alone would not prove the rule. |
| AT-24 repair limit | pass, including the mixed-stage case where one repair comes from verification and one from review. That is the SDD section 42 per-Run proof. |
| Every earlier acceptance test | still passes unchanged |
| Task reviews | 9 tasks, 9 task reviews, 6 fix rounds. Task 2 needed three rounds on one string helper. |
| Final whole-branch review | 1 Important, no Critical. The Important was fixed, and the re-review found a residual hole in the same finding, which was also fixed. |
| External audit (OpenCode, DeepSeek reasoner) | 6 of 10 categories clean, 4 defects. The controller reproduced all four itself and fixed all four. |

Evidence: `docs/build/evidence/phase-08-verify.txt`, last line `exit=0`.

**The four defects the external audit found, all reproduced by the controller.**

1. **A sentence-final path defeated the changed-file gate.** `"src/auth.ts:84."` kept its location through `stripLocation`, so the gate reported that the finding named no changed file, and a genuine `blocker` or `high` finding became non-blocking. Ordinary Reviewer prose triggers it. A trailing `!` or `?` failed the same way. The controller's own earlier fix round set the replace order that caused it.
2. **A decorated assertion identifier resolved to nothing.** `requirementIsResolvable` compared a `VAL-` requirement exactly, so `"VAL-API-001."` and `"VAL-API-001: an explanation"` named no mandatory requirement and did not block.
3. **A stale report could decide a later attempt.** The report path was fixed at `review/report.json` and nothing removed it, so a repair attempt whose fresh session wrote no report parsed the previous attempt's report and persisted it as this attempt's findings. The path is now `report-${attempt}.json`.
4. **A review that did not complete could still decide the Run.** The activity recorded `completed` and `cancelled` on the `AgentExecution` row and never read them, so a timed-out Reviewer that had written a report still decided the outcome, including a pass.

Items 1, 2, and 4 were paths from a real defect to a passing review. That is exactly what this phase exists to prevent.

**The defect the whole-branch review found.** The parsed review report reached the `ReviewFinding` table and the next Implementer prompt without passing the redactor, while `captureSourceDiff` beside it redacted everything. The Reviewer session holds the Project test secrets, so an echoed value would have been persisted in clear. The fix redacts the parsed finding fields, never the raw JSON text, because a replacement inside a JSON string could corrupt the parse and fail a Run for the wrong reason. **The blocking decision is taken on the unredacted fields first, and only the values that leave the activity are redacted.** Keep that order.

## Read this before Phase 9

**The Reviewer writes DATA, and Factoree decides.** A fresh session receives the SDD section 40 input list and writes one JSON report into `${workspacePath}/review/report-${attempt}.json`. Factoree parses it, decides which findings block, persists every finding, and decides the Run. The agent's `verdict` field is recorded on the row and never decides. `tests/acceptance/phase-08-exit.test.ts` proves the two can disagree: a report claiming `"verdict": "pass"` while carrying a valid `high` finding still blocks.

**A finding blocks only when four conditions hold together:** the severity is `blocker` or `high`; the category is not `style`; the requirement resolves; and the evidence names a file the change touched. All four live in `src/domain/review/blocking.ts`. The exit test isolates three of the four with `RV-1`, `RV-3`, and `RV-4`, so deleting any one rule fails it.

**`src/domain/review/blocking.ts` is a security-relevant gate, and it must fail closed.** Six of the phase's fix rounds landed on it. Every change to `stripLocation`, `namesChangedFile`, or `requirementIdentifierOf` must add a case that proves the change does not let a real blocking finding through. **The replace order inside `stripLocation` is load-bearing.** The full stop is removed twice, before and after the location strip, because `src/auth.ts.` needs the second removal and `src/auth.ts:84.` needs the first.

**`captureSourceDiff` runs the SDD section 44 command pair,** `git add -A` then `git diff --cached <base_sha>`. **Phase 9 must hash that same output**, so the change under review and the change under publication can never differ. `src/domain/review/source-diff.ts` is the one owner. It redacts before it truncates, and `--binary` is deliberately absent.

**`runReview` calls the shared `runAgentActivity` helper,** like `runImplementer` and `runUserValidate`. The helper holds the stop entry guard, the ordering `sleep(1)`, and the cancellation handling. **Do not add a fourth long-activity stage that bypasses it.**

**The repair budget is shared across all three stages.** SDD section 42 bounds repairs per Run and not per stage, so verification, user validation, and review increment one counter. `tests/workflow/at-24-repair-limit.test.ts` proves the mixed-stage case.

**There is still no success terminal state.** A Run whose review passes falls into the residual wait and ends `FAILED` with `RUN_TIMEOUT`. SDD section 68 forbids `READY_FOR_HUMAN` without a PR and a Proof Pack. Phase 9 and Phase 10 build those.

**A stock repository configuration still cannot review.** SDD section 15 sets `reviewer: claude`, and `ClaudeCodeRunner` arrives in Phase 11. An unknown reviewer runner is a configuration fault that names the configured and the registered runners, exactly as the validator runner already does.

## Human decisions

None required so far. Every decision was taken by the controller and is recorded in the phase plans, the commit history, or the lists below.

Phase 4 through Phase 7 decisions still stand. Decisions added in Phase 8 are the eighteen recorded in `docs/build/phase-08-plan.md`, plus these eleven taken during execution:

1. **AT-22 and AT-23 assert the workflow decision, not a persisted row.** The workflow suite runs activity doubles and holds no database. Persistence is proved by the Task 6 unit test and by the exit test.
2. **A workflow test drives the real `decideReview` and the real `parseReviewReport` through the harness double.** The agent session and the sandbox stay doubles, so the rule under test is the real rule.
3. **No Phase 8 test may need a live model.** Every test drives real components against a real fixture repository, with a scripted runner that writes a real report file.
4. **The evidence resolver must fail closed.** Three fix rounds closed trailing prose, a line range, an absolute path, leading prose, and wrapping punctuation. The audit later closed a sentence-final location and a trailing `!` or `?`.
5. **AT-20's repair clause moved to a workflow test.** The acceptance file had asserted `REPAIRING` from a status it had written itself, which proved only that the repository round-trips a status.
6. **The AT-22 comment had to match its code.** The test had passed attempt 2 by emptying the changed-file list, which exercises the scope gate, while its comment claimed the repair fixed the finding. Attempt 2 now emits no finding.
7. **The exit test must be sensitive to each blocking rule on its own.** A finding that two gates each stop proves neither.
8. **`decisionReason` is redacted with the finding fields,** because `decideFinding` interpolates the requirement and the evidence into it verbatim.
9. **`finding.id` is redacted too.** It is agent free text and it reaches both the persisted `findingKey` and the next Implementer prompt through `failureLine`.
10. **A report Factoree cannot use ends the Run and starts no repair.** A repair cannot fix a broken review.
11. **The report path carries the attempt.** A fixed path let a stale report decide a later attempt.

## Carried findings for later phases

Reviewed, judged not reachable or not in scope now, deliberately not fixed. Every Phase 4 through Phase 7 entry that Phase 8 did not close still stands.

**New in Phase 8, highest priority:**

- **The Reviewer cannot audit the Validation Plan's success criteria.** The Phase 7 notes named the Phase 8 Reviewer as a place to surface the widest defect-to-`PASS` path in the system: a `command` entry of `{ run: "true", expectExitCode: 0 }` passes a `command` assertion, and an `http` entry may state `expectStatus: 500`. The workflow passes the Reviewer only `"<id>: <result>. <reason>"` lines, never the plan text. SDD section 40 does not list the plan among the Reviewer inputs, so Phase 8 did not expand scope. **Phase 10 owns it,** because the Proof Pack is the last place a human can see those criteria before deciding.
- **The Action Policy is still never enforced.** No call to `assertAllowed` or `decide` exists anywhere in `src/`. The reviewer role denies `writePrimaryWorktree` in the table, and nothing enforces it. `captureSourceDiff` runs `git add -A`, so a reviewer write would be staged and would reach the captured diff. **Phase 9 owns it,** and Phase 9 is the phase that turns that diff into a published patch.
- **Three routes from a real defect to a passing review remain, all by design.** The Reviewer can label a correctness defect `style`; it can cite a `VAL-` requirement that names no frozen assertion; and it can point its evidence outside the change. Each clears the finding. Every one is persisted with its decision reason, so a human can audit it. The Proof Pack should surface a `blocker` or `high` finding that failed only one gate.

**New in Phase 8, small:**

- A finding that fails ONLY the requirement gate is silently non-blocking. Making that one case block instead is worth considering.
- The progress post runs before the `reportUsable` check, so an unusable report still posts a summary, and that summary is empty on that path.
- The `REVIEW_UNAVAILABLE` message leaves a double space when `reportProblem` is null.
- `buildReviewActivities` duplicates `buildUserValidateActivities` byte for byte. A fourth copy earns the abstraction.
- `git add -A` inside `captureSourceDiff` stages any untracked artefact the preview or verification left behind, which inflates the changed-file list. It errs toward blocking.
- `PrismaReviewFindingStore.record` catches any create error and reads the winner, not only a unique-constraint violation. It mirrors `PrismaValidationResultStore`, so a change belongs to a sweep of both.
- `executions.record` persists the agent's own free-text session summary without redaction. It predates Phase 8 and applies to every role.
- An empty report file is untested. It reaches `parseReviewReport` and becomes unusable either way.
- The exit test's assertion that the two reviewer sessions differ cannot fail, because the scripted double mints a new identifier per call. AT-21 carries the real proof.
- AT-23 asserts no passing terminal state, only that no repair started.
- An inline Markdown link in the evidence field still fails the changed-file gate. A Windows backslash path fails on the separator.

**Everything else carried from Phase 7 and earlier still stands,** including the Phase 6 redaction gap for human-authored goal text at every persistence boundary, the Linear evidence storage that has never run against a live account, and every Phase 12 live-proof item.

## Blockers

None.

Live Linear, GitHub, Fly Sprites, and Temporal Cloud credentials are needed for the Phase 12 live acceptance test. They are not needed for Phase 9.

## Environment notes

- Node 24 LTS is at `/opt/homebrew/opt/node@24/bin`. The Homebrew `node` 25 binary on this machine is broken, so prefix PATH with the Node 24 path.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`. **Never write a file through a `cat` heredoc, and never build a commit message with `git commit -m "$(cat <<EOF ...)"`.** Use `git commit -F` with a file.
- `timeout` and `gtimeout` are not installed.
- Docker is required for the integration and workflow suites.
- **`npm run verify` takes longer than a two-minute foreground tool call.** Run it in stages in the background and poll the output file. A background run that a harness timeout kills reports nothing, so read the real output before you believe a result. **Two Phase 8 agents stalled repeatedly by waiting on a foreground suite.** Tell an agent this rule in its dispatch.
- **Run the whole-repository `npm run lint` yourself at every task gate.** Phase 8 shipped a red lint and a red typecheck at one task, and the controller's own gate caught it. This is the second phase in a row where that gate earned its place.
- The acceptance tests run under `vitest.integration.config.ts`, not under a config of their own.
- The Phase 8 migration `20260827120000_add_review_findings` creates one table and adds one foreign key. It was verified with `prisma migrate diff` against a real shadow database, output "No difference detected", and the integration suite applies it with `prisma migrate deploy` before every run. Its index names are 42 and 32 bytes, under the Postgres 63-byte limit.
- **Run the whole integration suite before calling a task complete, not one file.** Run the whole workflow suite as well when a task adds an activity, and run it twice.
- The Temporal and Testcontainers suites produce occasional timing flakes. **Do not accept "it is a known flake" from an agent.** Rerun the suite yourself.
- **`tests/workflow/at-35-worker-restart.test.ts` still hand-builds its own activity map** and is the only workflow test file that does not use the shared harness. Its map is a plain object literal and is not typed as `Activities`, so `npm run typecheck` cannot catch a missing entry. **A later phase that adds an activity must update that file by hand.** Phase 8 added `review` to it.
- **`tests/workflow/at-16-deterministic-failure.test.ts` asserts an exact activity-name list.** A later phase that adds an activity to the implement, verify, validate, review path must update that list.
- `opencode` version 1.18.18 is installed and authenticated for DeepSeek, and was used for the external audit of Phase 4 through Phase 8. **Pass the prompt as the message argument, not with `-f`.** The `-f` flag reads the message as a file name and the run fails. The Phase 8 audit prompt named ten categories, listed the ten deliberate designs to exclude, and demanded a file and a line for every finding. That shape produced four real defects and no noise.
