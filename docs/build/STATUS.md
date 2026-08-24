# Factoree build status

## Specification

- Source of truth: `docs/sdd.md`
- Version: 2.0
- SHA-256: `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`

## Phases

- Completed: Phase 1 — Control plane; Phase 2 — Sandbox and first runner; Phase 3 — Deterministic verification; Phase 4 — Refinement and Context Contract; Phase 5 — Backstage and MCP; Phase 6 — Validation Contract
- Current: none
- Next: Phase 7 — User validation and evidence

## Git

- Branch: `main`
- Phase 6 range: `45bb82e..aed014f`, 20 commits. 19 on `phase-06-validation-contract`, then the no-fast-forward merge.
- The repository has no remote. Each phase merges into local `main` with a no-fast-forward commit.

## Phase 6 verification

The controller ran every check below itself. Agent claims were not accepted as evidence.

| Check | Result |
| --- | --- |
| `npm run verify` on the branch head `fe313ea` | exit 0, run in stages so no part could be cut short: lint 0, typecheck 0, unit 663 passed and 7 skipped, integration and acceptance 125, workflow 47, build 0 |
| `npm run verify` on `main` after the merge | exit 0: 663 unit passed and 7 skipped, 125 integration and acceptance, 47 workflow, build succeeded |
| Skip count | 7, the same as the Phase 2, 3, 4, and 5 baseline. Phase 6 skipped no test. |
| Phase 6 exit condition | pass: every implementation starts after a frozen validation contract exists |
| AT-10 validation created first | pass, in two halves. `tests/workflow/validation-contract.workflow.test.ts` proves the ordering from activity records the test does not sequence. `tests/acceptance/at-10-validation-created-first.test.ts` proves the creation time, the hash, and the Run row, with a negative case. |
| AT-11 validation immutability | pass: a second save that weakens an assertion is discarded, and the first contract stands |
| Every Phase 4 and Phase 5 acceptance test | still passes unchanged |
| Task reviews | 6 dispatches for 8 tasks. 3 clean at once, 3 needed fix rounds. 4 fix rounds in total. |
| Final whole-branch review | exit condition MET, no Critical, 1 Important and 5 Minor. It triaged all 11 deferred minors and judged that none blocks the merge. |
| Controller verification finding | 1 blocking defect the reviews missed, found by the controller's own suite run. See below. |
| External audit (OpenCode, DeepSeek reasoner) | 8 of 10 categories clean, 2 defects. The controller validated both against the code, fixed one, and ruled the other out of Phase 6 scope with a reason. |

Evidence: `docs/build/evidence/phase-06-verify.txt`, last line `exit=0`.

**The blocking defect the task reviews missed.** `tests/workflow/at-35-worker-restart.test.ts` hand-builds its own activity map instead of using the shared harness, and Task 6 never added the `buildValidationContract` double to it. The restarted worker then failed the activity and failed the Run. `npm run typecheck` cannot catch it, because the map is a plain object literal and is not typed as `Activities`. It appeared intermittently, because the outcome depends on where the restart lands, and one controller run passed before another failed. Commit `9f2b22e` fixes it. **A later phase that adds an activity must check that file by hand.** It is the only workflow test file that does not use the harness.

## Read this before Phase 7

**The Validation Contract exists and is frozen before any sandbox.** `BUILDING_VALIDATION_CONTRACT` sits between `RESOLVING_CONTEXT` and `PREPARING`. There is exactly one `prepareSandbox` call site, and no path reaches it without a frozen contract.

**The frozen hash is the contract version.** `Run.validationContractVersion` holds the SHA-256 of the canonical contract, as `contextContractVersion` holds the context hash. The contract is immutable: `ValidationContractStore` offers `save` and `findByRun` only, and no update and no delete.

**The freeze activity is idempotent, and it repairs.** `buildValidationContract` reads the store first. A frozen contract always wins over a freshly built one, even when the input has since changed. The early-return path writes the Run hash again, so a retry after an interrupted attempt repairs a Run row that holds no hash. A divergent freeze attempt warns with the two hashes and writes nothing.

**The builder is deterministic and starts no agent.** It restates one acceptance criterion per assertion and records that criterion identifier. It invents no behavior. Because it starts no agent and creates no `AgentExecution`, it records no prompt version, so `prompts/validation-builder.md` of SDD section 56 does not exist yet. See the carried findings.

**The method rule has two confidence levels.** An explicit method and path, for example `PATCH /projects/{id}`, beats everything. The weak HTTP word list does not beat a plainly stated page interaction. An unrecognized statement becomes `manual`, which SDD section 36 turns into MANUAL_REQUIRED.

**A Run whose assertions are all `manual` cannot complete autonomously.** SDD section 36 says L3 cannot complete unless every assertion is PASS. This is deliberate and safe. Phase 7 must expect it, and a Phase 7 fixture Work Item must state a criterion the classifier recognizes, or the Run stalls on a human.

**The readiness gate is live but is not reached by a real Run today.** `RefinementEngine` derives a criterion from any non-empty goal, and it blocks an empty goal with its own question, so the `needs_input` branch and its question loop stay unentered in production. The gate stays, because SDD section 9 item 5 states the rule as an invariant of the Run and the activity is the last enforcement point before a freeze.

**There is still no success terminal state.** A Run whose verification passes falls into the residual wait and ends `FAILED` with `RUN_TIMEOUT`. The next state of SDD section 49 is `USER_VALIDATING`, and Phase 7 builds it.

**`Evidence.validationAssertionId` still has no relation.** The column exists in `prisma/schema.prisma` with a comment saying Phase 6 fills it. Phase 6 did not, because Phase 6 stores no evidence. Phase 7 owns evidence and must close it.

## Human decisions

None required so far. Every decision was taken by the controller and is recorded in the phase plans, the commit history, or the lists below.

Phase 4 and Phase 5 decisions still stand. Decisions added in Phase 6:

1. **The contract is built after the Context Contract freezes and before the sandbox exists,** which is the order SDD section 49 fixes. The builder therefore reads no repository and no sandbox.
2. **The builder is deterministic, and every assertion restates one acceptance criterion,** recording that criterion identifier in `requirement`. SDD section 7 forbids Factoree to invent material product behavior.
3. **A contract with no assertion is not valid and does not freeze.** The activity answers `needs_input`, the workflow asks one focused question, and the human answer becomes an assertion. An unanswered question ends the Run with `VALIDATION_UNRESOLVED`.
4. **The default method is `manual`.** SDD section 36 gives it MANUAL_REQUIRED. Guessing `test` for an unrecognized statement would claim an automated proof Factoree cannot produce.
5. **The frozen hash is the contract version,** because a content hash cannot drift from its content.
6. **Phase 6 writes no `prompts/validation-builder.md`.** SDD section 56 requires each `AgentExecution` to record its prompt version, and the deterministic builder creates none. The file belongs to the phase that makes the builder model-driven.
7. **The store offers `save` and `findByRun` only,** because SDD section 25 forbids a change to the active contract.
8. **The Implementer receives the rendered document, not the store.** AT-11 tests that against the store, not against a prompt sentence.
9. **Task 7 ran before Task 6,** so the tree kept compiling. Task 6 passes the frozen document into the implement call, and only Task 7 adds that field.
10. **AT-10 spans two files.** The ordering half lives in the workflow test, where the workflow decides the order. The persistence half lives in the acceptance test. A test that performs both writes itself can never express a regression in the order. Each file names the other.
11. **The SDD section 60 redaction gap is not fixed inside Phase 6.** See the carried findings.
12. **The weak HTTP word signal must not beat a plainly stated page interaction,** because a browser assertion needs the SDD section 37 evidence and `request-response` alone loses the user-visible half.

## Carried findings for later phases

Reviewed, judged not reachable or not in scope now, deliberately not fixed. Every Phase 4 and Phase 5 entry that Phase 6 did not close still stands.

**New in Phase 6, highest priority, for the phase that hardens persistence:**

- **Human-authored text reaches PostgreSQL and the Implementer prompt with no `Redactor`.** The rendered Validation Contract carries the Work Item goal, the derived criteria, and human answers. SDD section 60 requires Factoree to redact exact configured secret values, known GitHub token patterns, and known model-provider key patterns before external persistence. The external audit found this. The controller validated it and confirmed the Phase 4 Context Contract persists the same goal text by the same route, equally unredacted, so the gap is pre-existing and cross-cutting, not a Phase 6 regression. It is deliberately not fixed here, because redacting the Validation Contract alone would give false assurance while the Context Contract, the Linear progress posts, and the Implementer prompt leak the same text. Fix it in one pass over every persistence boundary that carries human-authored text.

**New in Phase 6, for the phase that revisits the builder:**

- `methodFor` matches `click` and `clicks` and not `clicked` or `clicking`, so a browser criterion in the past tense becomes `manual`. The external audit found this. The direction is safe, because `manual` needs a human and claims nothing, so it was deliberately not fixed. The word lists are hand-tuned and a review already flagged that as a smell; a principled classifier would close this and the entry below together.
- `COMMAND_WORDS` and `REVIEW_WORDS` hold generic entries such as `build` and `reviewed`. The rule order protects the observed cases only.
- `validateValidationContract` throws inside the activity, so an invalid contract would consume all five Temporal retries and fail as `INTERNAL_ERROR` rather than fail fast. It is unreachable today, because the builder cannot produce an invalid contract that also holds an assertion.
- The duplicate-identifier check runs last in the per-assertion loop, so a duplicate that also carries an unknown method reports the method fault first. The contract is rejected either way.

**New in Phase 6, for the phase that owns the workflow:**

- The `question === null` branch of the build loop is unreachable, because the activity always returns a question with `needs_input`. It is a defensive guard, and removing it would trade a dead branch for a silent fall-through.
- `tests/workflow/support/harness.ts` records no `implement` marker in `activityOrder`, so the AT-10 ordering test states its claim by read time rather than directly. Add the marker when Phase 7 next touches that file.
- The `indexOf` pair in the AT-10 workflow test duplicates the neighbouring ordering test.
- `validation-contract.workflow.test.ts` deletes its outcome entry after `runWorker`, so a failed assertion leaks the entry into a later test, and its `activityOrder` slice is correct only while the tests run one at a time.
- `validation-contract.workflow.test.ts` imports one module twice.

**New in Phase 6, for the phase that owns evidence:**

- `Evidence.validationAssertionId` has no relation to the new `ValidationAssertion` model, despite the comment in `prisma/schema.prisma` saying Phase 6 fills it.

**New in Phase 6, small:**

- `PrismaValidationContractStore.findByRun` filters the SQL on `runId` only and applies the tenant check in application code afterwards. It never returns a foreign-tenant row. It matches `PrismaContextContractStore` exactly, so a change belongs to a sweep of both stores.
- The `["browser","http"]` expectation in `phase-06-exit.test.ts` couples the acceptance test to the classifier word lists.
- One test in `implementer-input.test.ts` asserts a static prompt sentence a pre-existing test already covers.

**Everything else carried from Phase 5 and earlier still stands,** including: the Phase 5 discovery findings on the guarded second pass, `readRepositoryContextConfiguration`, `BackstageContextSource.discover`, `onHost`, the duplicate survivor, `findByRepositorySlug`, `getByRef`, and `hostOf`; the Phase 5 administration-API findings; the Phase 5 MCP findings; the conflict-model wording and `supersedes`; `isDeterministicRemoteFailure`, the streamed `listTree` error, `checkoutHosts`, and an unknown `sizeBytes`; `WorkItem.constraints` reaching no consumer; the `Redactor` four-character floor and the evidence tenant guard; the Phase 2 adapter map, `baselineCheckpointId`, the `injectIntoImplementer` reset, `AgentRunInput` lacking `projectId`, and the unused `reapExpiredSandboxes`; the evidence-activity split and the `Evidence.kind` cast; the stop-during-verification and `CLEAN_SHELL_ENV` items; the Phase 11 model-provider credential; and every Phase 12 live-proof item.

## Blockers

None.

Live Linear, GitHub, Fly Sprites, and Temporal Cloud credentials are needed for the Phase 12 live acceptance test. They are not needed for Phase 7.

## Environment notes

- Node 24 LTS is at `/opt/homebrew/opt/node@24/bin`. The Homebrew `node` 25 binary on this machine is broken, so prefix PATH with the Node 24 path.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`. **Never write a file through a `cat` heredoc, and never build a commit message with `git commit -m "$(cat <<EOF ...)"`.** Use `git commit -F` with a file.
- `node` and `npx` print a `dyld: Library not loaded: libllhttp.9.3.dylib` warning from `libgit2`. It is noise, but it can kill a command silently.
- `timeout` and `gtimeout` are not installed.
- Docker is required for the integration and workflow suites.
- **`npm run verify` takes longer than a two-minute foreground tool call.** Run it in stages, or in the background and poll it. A background run that a harness timeout kills reports nothing, so read the real output before you believe a result.
- The acceptance tests run under `vitest.integration.config.ts`, not under a config of their own.
- The Prisma CLI resolves `DATABASE_URL` eagerly, so every CLI call needs a value. Every migration so far was written by hand and applied through the Testcontainers database.
- **The Phase 6 migration is safe against a populated database.** `20260825120000_add_validation_contract` creates two new tables. The external audit verified it against `prisma migrate diff --from-empty --to-schema` and found no drift.
- **Run the whole integration suite before calling a task complete, not one file.** Run the whole workflow suite as well when a task adds an activity.
- The Temporal and Testcontainers suites produce occasional timing flakes. **Do not accept "it is a known flake" from an agent.** Rerun the suite yourself. One reported flake in Phase 6 was a real defect.
- `opencode` version 1.18.18 is installed and authenticated for DeepSeek, and was used for the external audit of Phase 4, Phase 5, and Phase 6.
