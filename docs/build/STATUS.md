# Factoree build status

## Specification

- Source of truth: `docs/sdd.md`
- Version: 2.0
- SHA-256: `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`

## Phases

- Completed: Phase 1 — Control plane; Phase 2 — Sandbox and first runner; Phase 3 — Deterministic verification; Phase 4 — Refinement and Context Contract; Phase 5 — Backstage and MCP; Phase 6 — Validation Contract; Phase 7 — User validation and evidence; Phase 8 — Review and repair; Phase 9 — Trusted publishing; Phase 10 — Proof Pack
- Current: none
- Next: Phase 11 — Second runner and skills

## Git

- Branch: `main`
- Phase 10 range: `d65b8a2..ac0fd7f`, 11 commits on `phase-10-proof-pack`, then the no-fast-forward merge `432eac3`.
- The repository has no remote. Each phase merges into local `main` with a no-fast-forward commit.

## Phase 10 verification

The controller ran every check below itself. Agent claims were not accepted as evidence.

| Check | Result |
| --- | --- |
| `npm run verify` at the branch head `4c4b965` | exit 0, run in stages with a real aggregate exit code: lint 0, typecheck 0, unit 965 passed and 7 skipped, integration and acceptance 221, workflow 81, build 0 |
| Skip count | 7, the same as the Phase 2 through Phase 9 baseline. Phase 10 skipped no test. |
| Second whole verification | exit 0 again. A single green run is not proof. |
| Phase 10 exit condition | pass: a human decides on the change from the Proof Pack alone |
| AT-30 | pass. `tests/acceptance/at-30-proof-pack.test.ts` drives the real activity over real Prisma stores against a real database. It asserts all eleven AT-30 items, one row per assertion, the recorded Proof Pack hash, and a bounded size for a 200-file change. |
| AT-32 for the Proof Pack | pass. `tests/unit/at-32-redaction.test.ts` loads the fixture secret into EVERY free text field the Proof Pack can carry, so a field the renderer forgets cannot pass. |
| Workflow completion | pass. `tests/workflow/at-30-proof-pack.test.ts` proves one Proof Pack, `READY_FOR_HUMAN` with no failure reason, the Proof Pack strictly after the publication, the failure path, and the stop path. |
| Every earlier acceptance test | still passes, with three deliberate expectation changes recorded below |
| Whole-suite reruns | the workflow suite ran green twice, as the Phase 9 rule requires |
| External audit (OpenCode, DeepSeek v4 Pro) | 3 findings. The controller reproduced all three and repaired all three. |
| Controller verification | found two BLOCKING defects that every task test missed. See below. |

Evidence: `docs/build/evidence/phase-10-verify.txt`, last line `exit=0`.

**READY_FOR_HUMAN is now reachable, and it is the only success terminal state.** SDD section 68 is closed. The Phase 9 residual wait is deleted, because it existed only as the placeholder for the missing success state.

**The two blocking defects the controller's own review found, that every task test missed.**

1. **The Proof Pack listed the deterministic checks of EVERY attempt.** `verify` writes one evidence row per check per attempt. A Run that repaired therefore held the failing attempt-1 row beside the passing attempt-2 row, and the Proof Pack printed both. A human read that a passing Run failed its own verification. The reader now keeps the last attempt only.
2. **The review pass count reported the Implementer attempt.** A repair that verification or validation asked for raises the attempt without reaching a Reviewer, so the count overstated the number of review sessions. A real counter now increments beside the `REVIEWING` status.

**The three defects the external audit found, all reproduced by the controller.**

1. **A passing review writes NO finding row, so the Proof Pack inferred the wrong review pass.** `decideReview` maps over `report.findings`, and a passing report carries none. The highest STORED attempt was therefore the earlier FAILING pass. A Run whose attempt-1 review found a blocker and whose attempt-2 review passed reported that blocker as open, under `Blocking findings that remain: 1`, on a Run that reached `READY_FOR_HUMAN`. **The last review attempt now travels from the workflow, because only the caller knows it.** Never infer the last review pass from the rows that exist.
2. **Validation evidence carried no attempt dimension at all.** A repaired assertion showed the artefact of the FAILED attempt beside its `PASS` result, so a human who opened the reference saw a failure. The evidence row now records its attempt, exactly as a deterministic check row does, and the Proof Pack keeps the last attempt of each assertion.
3. **The SDD section 68 freeze clause was nominal, not real.** The clause names an ORDER, and the check only proved that a contract existed. The workflow now records the first Implementer start, and the invariant compares the two moments.

## Read this before Phase 11

**The Proof Pack reads recorded facts, and the workflow supplies only what no row can carry.** `publishProofPack` in `src/activities/evidence.activities.ts` reads five stores. The workflow passes the publication facts, the changed files, the preview URL, the repair budget, and **the last review attempt**. That last value is not derivable from the database, for the reason in audit finding 1 above.

**Every recorded fact is scoped to its last attempt, and each one is scoped differently.** A validation result row carries `attempt`. A review finding row carries `attempt`, but a passing pass writes no row. A deterministic check row carries `attempt` in its metadata. A validation evidence row carries `attempt` in its metadata only since Phase 10. **A new fact the Proof Pack reports must state how it is scoped, and a test must prove it against a repaired Run.** Three separate defects in this phase were all this one mistake.

**The renderer cannot dump a log, by construction.** No type in `src/domain/evidence/proof-pack.ts` carries log text, so a caller cannot pass one. The activity reads named metadata fields and never spreads metadata. **Do not add a field that carries free agent output, and never spread an evidence row's metadata into the Proof Pack.**

**The completion invariant is the one gate to success.** `completionInvariantFailures` in `src/domain/runs/completion-invariant.ts` states every SDD section 68 clause and reports all of them. It runs immediately before the only `READY_FOR_HUMAN` write. **A new clause belongs there, and a clause that names an order must compare the order, not merely check that a value exists.**

**A Proof Pack that cannot be posted fails the Run.** The status is `FAILED` with `COMPLETION_INVARIANT_UNMET`, and the message names the pull request, because the change IS published. Factoree must never report a success it cannot prove.

**The hash is recorded BEFORE the Linear post.** A Linear outage must not lose the proof that the Proof Pack exists. A retry posts the identical body, because the body is a function of recorded state.

**Two workflow tests changed meaning, and one was passing for the wrong reason.** `at-27` signalled a stop and relied on the Run sitting in the residual wait; it now holds the Proof Pack activity so the stop lands deterministically. `at-35` built its own activity map by hand and lacked `publishProofPack`, so its Run failed the invariant while the test still asserted `COMPLETED`. **It now asserts the terminal state, and the controller proved the new assertion fails when the activity is missing.**

**A stock repository configuration still cannot review or publish.** SDD section 15 sets `reviewer: claude`, and `ClaudeCodeRunner` arrives in Phase 11. Publication needs a Project secret named `GITHUB_TOKEN` without the injection mark.

## Human decisions

None required so far. Every decision was taken by the controller and is recorded in the phase plans, the commit history, or the lists below.

Phase 4 through Phase 9 decisions still stand. Decisions added in Phase 10:

1. **The residual wait is deleted, not left unreachable.** Every path of the publication block returns, so the wait was dead code. Phase 10 exists to remove it.
2. **A stop that arrives after a successful publication still ends the Run `CANCELLED`.** This keeps the Phase 9 behaviour. The message names the pull request, so the human is never told that nothing was published.
3. **A Proof Pack failure is `COMPLETION_INVARIANT_UNMET`, a new failure reason.** SDD section 48 fixes the state names, not the failure reasons, so a new reason is allowed. The state is `FAILED`.
4. **The Proof Pack is built from persisted state, not from workflow-carried summaries.** A summary is an agent-shaped claim. A row is a fact. The exceptions are listed in the Phase 11 note above and each one is justified.
5. **The Proof Pack hash lives on the Run row.** A new migration adds `Run.proofPackSha256` and `Run.proofPackPostedAt`, so the clause "Proof Pack exists" is provable from durable state rather than from a workflow variable.
6. **The Proof Pack reports every NON-blocking finding as a known limitation, with the reason it did not block.** This closes the Phase 8 carried finding about a defect that failed only one gate.
7. **The Proof Pack states the success criterion of every assertion.** This closes the carried finding that the Validation Plan's criteria never reached a human.
8. **`previewUrl` was added to the user validation output.** A preview Factoree never exposed stays null, because a URL that never existed must not reach a human.
9. **The `at-35` test now asserts the terminal state.** A test that only asserts `COMPLETED` cannot tell a proved Run from a Run that failed its own invariant.
10. **Every free text field passes the same table-cell normalization.** A newline breaks a Markdown table AND a bullet list, so the criteria bullets use it too.

## Carried findings for later phases

Reviewed, judged not reachable or not in scope now, deliberately not fixed. Every Phase 4 through Phase 9 entry that Phase 10 did not close still stands.

**Closed by Phase 10:**

- The Reviewer could not audit the Validation Plan's success criteria. The Proof Pack now states the frozen statement, the method, the requirement, and the outcome of every assertion.
- The Proof Pack should surface a `blocker` or `high` finding that failed only one gate. Every non-blocking finding now appears with its severity and the reason it did not block.

**New in Phase 10:**

- **The Proof Pack reports the LAST attempt of every fact, so an earlier failure is invisible to the human.** That is deliberate, because the earlier failure was repaired. **A human who wants the repair history must read the database.** A later phase can add a one-line repair history to the Proof Pack.
- **A validation evidence row written BEFORE Phase 10 carries no attempt.** The reader treats a missing attempt as -1, so every row of that assertion matches and nothing is dropped. No live Run exists yet, so no such row exists. **Delete this note once Phase 12 runs against a live account.**
- **The Proof Pack never names the Sprite retention deadline.** The preview URL it prints dies with the sandbox after the SDD section 51 window. A human who reads the Proof Pack late sees a dead link with no explanation.
- **`tests/workflow/at-16-deterministic-failure.test.ts` asserts an exact activity-name list.** A later phase that adds an activity to the implement, verify, validate, review, publish path must update that list. Phase 10 did not, because a failing Run posts no Proof Pack.
- **`tests/workflow/at-35-worker-restart.test.ts` still hand-builds its own activity map.** A later phase that adds an activity must update that file by hand. Phase 10 proved the file now fails loudly when it is stale.

**Still open from earlier phases, highest priority:**

- **The SDD section 46 hash assertion compares two diff texts that two different git binaries produce.** Phase 12 should log the git version on both sides, so a version skew is diagnosable rather than indistinguishable from tampering.
- **Three routes from a real defect to a passing review remain, all by design.** The Proof Pack now surfaces two of them to the human as known limitations.
- **The worktree fingerprint misses an ignored path and anything under `.git/`.** Phase 12 hardening owns it.
- **Everything else carried from Phase 9 and earlier still stands,** including the Phase 6 redaction gap for human-authored goal text at every persistence boundary, the Linear evidence storage that has never run against a live account, and every Phase 12 live-proof item.

## Blockers

None.

Live Linear, GitHub, Fly Sprites, and Temporal Cloud credentials are needed for the Phase 12 live acceptance test. Phase 11 does not need them.

## Environment notes

- Node 24 LTS is at `/opt/homebrew/opt/node@24/bin`. The Homebrew `node` 25 binary on this machine is broken, so prefix PATH with the Node 24 path.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`. **Never write a file through a `cat` heredoc, and never build a commit message with `git commit -m "$(cat <<EOF ...)"`.** Use `git commit -F` with a file.
- **`npx prisma generate` needs `DATABASE_URL`.** Any value works, because it generates only. Use `DATABASE_URL="postgresql://u:p@localhost:5432/db" npx prisma generate`.
- `timeout` and `gtimeout` are not installed.
- Docker is required for the integration and workflow suites.
- **`npm run verify` takes longer than a two-minute foreground tool call.** Run it in stages in the background and poll the output file. **Compute a real aggregate exit code across the stages.** `/tmp/verify.sh` in the Phase 10 session did this correctly.
- **A pipeline hides the exit code of the command before it.** `npm run typecheck 2>&1 | tail -5` reports the exit code of `tail`, which is always 0. Phase 10 nearly accepted a failing typecheck for this reason. **Redirect to a file and read `$?` on its own line.**
- **`pkill -f "<pattern>"` also kills the waiting shell whose command line contains that pattern.** Phase 10 killed six of its own monitors this way. Match on the script path alone.
- **Run the whole-repository `npm run lint` and `npm run typecheck` yourself at every task gate.**
- The acceptance tests run under `vitest.integration.config.ts`, not under a config of their own.
- **Run every suite more than once before you believe a green result.** Phase 9 hit two timing-dependent failures that a single run missed, and Phase 10 found a latent race in `at-27` that only the new terminal state exposed.
- Phase 10 added one migration, `20260828120000_add_proof_pack`.
- **`opencode` version 1.18.18 is installed and authenticated for DeepSeek. Use `deepseek/deepseek-v4-pro`.** Run `opencode models` first, because the provider prefix has changed before. **Pass the prompt as the message argument, not with `-f`.** The Phase 10 audit prompt named ten categories, listed six deliberate designs to exclude, and demanded a file and a line for every finding. It produced three real defects and no false positive.
- An OpenCode run can be killed by a session interrupt. Start it detached with `nohup` if it must survive.
