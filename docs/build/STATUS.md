# Factoree build status

## Specification

- Source of truth: `docs/sdd.md`
- Version: 2.0
- SHA-256: `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`

## Phases

- Completed: Phase 1 — Control plane; Phase 2 — Sandbox and first runner; Phase 3 — Deterministic verification; Phase 4 — Refinement and Context Contract; Phase 5 — Backstage and MCP; Phase 6 — Validation Contract; Phase 7 — User validation and evidence
- Current: none
- Next: Phase 8 — Review and repair

## Git

- Branch: `main`
- Phase 7 range: `bc649cb..c5494e5`, 23 commits. 22 on `phase-07-user-validation`, then the no-fast-forward merge.
- The repository has no remote. Each phase merges into local `main` with a no-fast-forward commit.

## Phase 7 verification

The controller ran every check below itself. Agent claims were not accepted as evidence.

| Check | Result |
| --- | --- |
| `npm run verify` on the branch head `5f820c5` | exit 0, run in stages so no part could be cut short: lint 0, typecheck 0, unit 793 passed and 7 skipped, integration and acceptance 158, workflow 56, build 0 |
| `npm run verify` on `main` after the merge | exit 0, the same counts |
| Skip count | 7, the same as the Phase 2 through Phase 6 baseline. Phase 7 skipped no test. |
| Phase 7 exit condition | pass: a UI fixture change produces independent acceptance evidence |
| AT-17 fresh user validation | pass, proved three ways: the session identifiers differ, the `AgentExecution` rows carry both roles with two distinct session references, and the real validator prompt holds neither the Implementer summary nor its success sentence |
| AT-18 UI evidence | pass: the screenshot bytes start with the PNG magic number, from real Chromium against a real preview. The negative half proves a driver that reports success with no artefact yields `FAIL`, never `PASS`. |
| AT-19 HTTP evidence | pass: the artefact records the method, the path, the status, and the result, and neither a real `Authorization` value nor a registered Project secret appears in the bytes |
| AT-25 evidence completeness | pass: `FAIL`, `MANUAL_REQUIRED`, `BLOCKED`, and all-`PASS`, plus a real database comparison so the gate and the record cannot disagree |
| Every earlier acceptance test | still passes unchanged |
| Task reviews | 10 tasks, 10 task reviews, 5 fix rounds. Task 8's review was split in two after the first reviewer stalled on a 68 kilobyte diff. |
| Final whole-branch review | exit condition MET, no Critical. 4 Important and 4 Minor, plus a triage of all 18 deferred minors. One fix wave of eight items closed them. |
| External audit (OpenCode, DeepSeek reasoner) | 6 of 10 categories clean, 4 defects. The controller validated all four against the code and fixed all four. |
| Controller verification findings | 2 defects the task reviews missed, both found by the controller's own checks. See below. |

Evidence: `docs/build/evidence/phase-07-verify.txt`, last line `exit=0`.

**The two defects the task reviews missed.**

1. **`npm run lint` was red from Task 2 until Task 5.** `tests/unit/preview.test.ts` carried 8 eslint errors. Three task agents ran lint scoped to their own files and reported clean, and one classified the failures as pre-existing and unrelated without checking `git log` for the file. SDD section 65 requires `npm run verify` to pass, and verify runs lint first. Commit `ca0dcbb` fixes it. **Run the whole-repository lint yourself at every task gate, and never accept an agent's scoped lint result.**
2. **A validation assertion could report `PASS` against a foreign host.** The external audit found it and the controller reproduced it directly: `"//example.com"` passes a `startsWith("/")` guard, and `new URL("//example.com", base)` replaces the origin. An agent-authored Validation Plan could therefore point an assertion at any host while the implementation under test never ran. Commit `cbd55d1` closes it with two independent controls, and `5f820c5` closes the residual parser gap.

## Read this before Phase 8

**A UI fixture change now produces independent acceptance evidence.** `tests/acceptance/phase-07-exit.test.ts` runs a real preview process, a real exposed URL, real Chromium, and a real HTTP client against a fixture repository, and writes real evidence rows. Its negative half runs the same contract against the unfixed page and reports `FAIL` with the screenshot retained.

**The User Validator is a fresh agent session that writes DATA, not code.** SDD section 24 states each assertion in prose, and no deterministic function can turn prose into browser steps. So a fresh validator session writes one declarative Validation Plan into `${workspacePath}/validation/plan.json`, and Factoree parses it, refuses any entry that weakens the frozen contract, executes it itself, and decides the result from the artefacts. No agent-authored program runs on the worker, and no agent claim decides a result.

**Every plan path is untrusted text.** `src/domain/validation/preview-url.ts` holds the one resolver. It rejects a path that is not a single-slash relative path, it rejects a tab, a line feed, and a carriage return anywhere in the path, because the WHATWG parser strips exactly those three, and it compares the resolved origin with the base origin. The plan parser and each point of use both call it. **Keep both controls.** The predicate alone was defeated by `"/\t/example.com"` during the audit.

**Playwright runs on the worker, not in the sandbox.** SDD section 37 orders `expose the service` before `execute Playwright`, so exposure exists for a client outside the sandbox. `src/adapters/browser/playwright/playwright-browser-driver.ts` is the only file that imports Playwright.

**`BrowserDriver.run` returns a result, never an exception.** A scenario that fails is a result. Only a fault that makes a result impossible may throw. Two Task 5 review findings were exactly this.

**The workflow has one shared helper for a long agent activity.** `runAgentActivity` in `src/workflows/agent-run.workflow.ts` holds the stop entry guard, the ordering `sleep(1)`, the cancellation watcher, and the cancellation handling. Both `runImplementer` and `runUserValidate` call it. The `sleep` is a durable timer that forces the schedule command onto its own workflow task, because a cancel issued in the same activation as the schedule can race it and, under `WAIT_CANCELLATION_COMPLETED`, wait forever for a report from an activity no worker started. **Do not remove it, and do not add a third long-activity stage that bypasses the helper.**

**There is still no success terminal state.** A Run whose user validation passes falls into the residual wait and ends `FAILED` with `RUN_TIMEOUT`. SDD section 68 forbids `READY_FOR_HUMAN` without a PR and a Proof Pack. Phase 9 and Phase 10 build those.

**A stock repository configuration still cannot user-validate.** SDD section 15's own example sets `validator: claude`, and `ClaudeCodeRunner` arrives in Phase 11. Phase 7 therefore makes an unknown validator runner a configuration fault that names the configured and the registered runners, and the workflow routes it to `FAILED_CONFIGURATION` rather than to `INTERNAL_ERROR`. The default value was deliberately not changed.

**`Evidence.validationAssertionId` now has its relation,** and `ValidationAssertionResult` holds one immutable row per assertion per attempt. The foreign key is the assertion ROW identifier, exposed as `rowId`, never the contract-level identifier such as `VAL-UI-001`. Both are strings, so a mistake here would fail at run time and not at compile time.

## Human decisions

None required so far. Every decision was taken by the controller and is recorded in the phase plans, the commit history, or the lists below.

Phase 4, Phase 5, and Phase 6 decisions still stand. Decisions added in Phase 7 are the fourteen recorded in `docs/build/phase-07-plan.md`, plus these taken during execution:

1. **The activity learns the preview address through `sandbox.exposeService` and never starts a preview.** An address needs no running server. `runUserValidation` is the single owner of the preview start and its `finally` stop. An earlier implementation started the preview twice.
2. **The cancel-versus-schedule race fix was hoisted into one shared helper,** so the two long-activity stages cannot drift apart. The same race was live in `runImplementer` and is now closed there too.
3. **The `settled` flag was deleted.** `node_modules/@temporalio/workflow/lib/workflow.js:168` guards the cancel with `if (!activator.completions.activity.has(seq)) return;`, so a cancel after an activity settles emits no command. The controller verified that source itself.
4. **The Validation Plan authoring its own success criteria for `command` and `http` entries is accepted as designed.** It follows from the plan's decisions 2 and 3, and no deterministic function can derive an expected status from prose. The criteria reach persisted evidence metadata, so a human can audit them. This is the widest remaining path from a real defect to a `PASS`. See the carried findings.
5. **The validator runner default stays `claude`,** because SDD section 15 states it. The unknown-runner case became a configuration fault instead.
6. **Evidence storage is selectable** through `EVIDENCE_STORAGE`, a closed enum defaulting to `filesystem`. The Linear adapter is wired but has never run against a live Linear account.

## Carried findings for later phases

Reviewed, judged not reachable or not in scope now, deliberately not fixed. Every Phase 4, Phase 5, and Phase 6 entry that Phase 7 did not close still stands.

**New in Phase 7, highest priority:**

- **The Validation Plan supplies both the check and its success criterion, and nothing ties either to the frozen assertion text.** A `command` entry of `{ run: "true", expectExitCode: 0 }` passes a `command` assertion. An `http` entry may state `expectStatus: 500` and pass a broken endpoint. Only a browser entry has a floor: at least one `goto` and at least one `expect` step. This is the branch's widest path from a real defect to a `PASS`. It follows from ratified design, and the criteria are persisted so a human can audit them, but the Phase 8 Reviewer and the Phase 10 Proof Pack should surface them prominently.
- **The Action Policy is never enforced.** No call to `assertAllowed` or `decide` exists anywhere in `src/`. The policy reaches an agent session only through `describe()` in the prompt, so controller decision 14's `writePrimaryWorktree: deny` for the validator is a prompt sentence today, not a boundary. The gap is inherited from the Implementer path and predates Phase 7. **Phase 9 owns it,** because Phase 9 is the first phase that captures a patch a rogue write could reach.

**New in Phase 7, for the phase that revisits storage:**

- `LinearEvidenceStorage` is wired and unit tested but has never run against a live Linear account. SDD section 39 says Version 1 SHOULD use Linear private file storage where practical. Phase 12's live acceptance test is the first real exercise.
- `storageNameOf` now includes the artefact source, so two same-kind artefacts differ. Whether Linear keys an upload by filename is still unverified from this repository.

**New in Phase 7, small:**

- `http-validation.ts` records `bodyLength` after redaction, not the raw original length.
- `BrowserNetworkEntry.status` is typed `number | null`, but only the response event is wired, so `null` never occurs. A `requestfailed` listener would make it meaningful.
- The video read failure path has no test. The trace read failure path does.
- The filesystem storage tenant test proves separate paths, not a refused cross-tenant read. `EvidenceStorage` exposes no read, so there is no cross-tenant read to refuse.
- `PrismaValidationResultStore.record` catches any create error and reads the winner, not only a unique-constraint violation. It mirrors `PrismaEvidenceStore`, so a change belongs to a sweep of both.
- The reason for a wholly absent plan is a fixed sentence, not a parse message.
- `at-25` persists only the all-`PASS` shape. A store that mapped every result to `PASS` would still pass that one case. `tests/integration/validation-results.test.ts` covers non-`PASS` persistence.
- `at-25` writes a `FilesystemEvidenceStorage` root under `/tmp` and never removes it.
- `runUserValidate` hands the whole remaining Run budget to one validation pass, so a hung browser step can consume the rest of the Run. The browser stage has no ceiling of its own.
- `preview.timeoutSeconds` comes from repository configuration with no upper bound.
- The `hash()` helper in `user-validator.ts` is a 32-bit digest and is not collision resistant. Do not read it later as an integrity check.
- The trace-read console line now also covers a tracing-stop failure, so it slightly overstates the cause.

**Everything else carried from Phase 6 and earlier still stands,** including the Phase 6 redaction gap for human-authored goal text at every persistence boundary, which is the cross-cutting item that Phase 12 hardening owns; the Phase 6 builder word-list findings; the Phase 5 discovery, administration-API, and MCP findings; and every Phase 12 live-proof item.

## Blockers

None.

Live Linear, GitHub, Fly Sprites, and Temporal Cloud credentials are needed for the Phase 12 live acceptance test. They are not needed for Phase 8.

## Environment notes

- Node 24 LTS is at `/opt/homebrew/opt/node@24/bin`. The Homebrew `node` 25 binary on this machine is broken, so prefix PATH with the Node 24 path.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`. **Never write a file through a `cat` heredoc, and never build a commit message with `git commit -m "$(cat <<EOF ...)"`.** Use `git commit -F` with a file.
- `timeout` and `gtimeout` are not installed.
- Docker is required for the integration and workflow suites.
- **`npm run verify` takes longer than a two-minute foreground tool call.** Run it in stages in the background and poll the output file. A background run that a harness timeout kills reports nothing, so read the real output before you believe a result.
- **Run the whole-repository `npm run lint` yourself at every task gate.** Phase 7 shipped a red lint across three tasks, because agents ran lint scoped to their own files. See the verification note above.
- The acceptance tests run under `vitest.integration.config.ts`, not under a config of their own.
- **Playwright 1.62.1 is a dependency now,** and the matching Chromium build is in the machine cache at `~/Library/Caches/ms-playwright`. If `chromium.executablePath()` names a path that does not exist, run `npx playwright install chromium`.
- **Other applications on this machine hold some common ports.** Every fixture server must bind an ephemeral port and read back its assigned port. Port 8099 was already taken during Phase 7.
- The Prisma CLI resolves `DATABASE_URL` eagerly, so every CLI call needs a value. Every migration so far was written by hand and applied through the Testcontainers database.
- **The Phase 7 migration is safe against a populated database.** `20260826120000_add_validation_results` creates one table and adds one foreign key to a column that already exists and holds `NULL` everywhere. It was verified against a real shadow database with `prisma migrate diff`, output "No difference detected". That check caught a Postgres 63-byte index-name truncation the hand-written SQL had wrong. The brief's `migrate diff` flags do not exist in Prisma 7.9.1; read the Phase 7 task 6 report for the command that works.
- **Run the whole integration suite before calling a task complete, not one file.** Run the whole workflow suite as well when a task adds an activity, and run it twice.
- The Temporal and Testcontainers suites produce occasional timing flakes. **Do not accept "it is a known flake" from an agent.** Rerun the suite yourself.
- **`tests/workflow/at-35-worker-restart.test.ts` still hand-builds its own activity map** and is the only workflow test file that does not use the shared harness. Its map is a plain object literal and is not typed as `Activities`, so `npm run typecheck` cannot catch a missing entry. **A later phase that adds an activity must update that file by hand.** Phase 7 added `userValidate` and `preview: null` to it.
- `opencode` version 1.18.18 is installed and authenticated for DeepSeek, and was used for the external audit of Phase 4, Phase 5, Phase 6, and Phase 7. The Phase 7 audit prompt named ten categories and excluded the known deliberate designs; that shape produced four real defects and no noise.
