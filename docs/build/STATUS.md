# Factoree build status

## Specification

- Source of truth: `docs/sdd.md`
- Version: 2.0
- SHA-256: `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`

## Phases

- Completed: Phase 1 — Control plane; Phase 2 — Sandbox and first runner; Phase 3 — Deterministic verification
- Current: none
- Next: Phase 4 — Refinement and Context Contract

## Git

- Branch: `main`
- Commit: the Phase 3 record commit on `main`, `docs: record Phase 3 completion, verification evidence, and carried findings`. Read `git log -1` for its identifier.
- Phase 3 range: `e97631e..c30a562`, 18 commits. 16 merged from `phase-03-verification`, then one audit fix and this record on `main`.
- The repository has no remote. Each phase merges into local `main` with a no-fast-forward commit.

## Phase 3 verification

The controller ran every check below itself. Agent claims were not accepted as evidence.

| Check | Result |
| --- | --- |
| `npm run verify` on the branch | exit 0 |
| `npm run verify` on `main` after the merge and the audit fix | exit 0: 328 unit passed and 7 skipped, 51 integration, 25 workflow, build succeeded |
| Skip count | 7, the same as the Phase 2 baseline. Phase 3 skipped no test. |
| Phase 3 exit condition | pass: an Implementer stub exits 0, claims every test passes, changes nothing, and the configured check still fails the Run |
| AT-14 OpenCode | pass: the fixture implementation reaches verification with `OpenCodeRunner` and the same check exits 0 |
| AT-16 deterministic failure | pass: a failing check blocks publication and triggers repair while budget remains |
| AT-24 repair limit | pass: with a maximum of two repairs the Implementer runs exactly three times, then the Run ends `FAILED` with `VERIFICATION_FAILED` |
| Test collection | confirmed by a verbose run: `tests/acceptance/phase-03-exit.test.ts` 3 of 3, `tests/workflow/at-16-deterministic-failure.test.ts` 2 of 2 |
| Task reviews | 10 of 10 clean, after 3 fix rounds in total |
| Final whole-branch review | ready to merge, no Critical, 1 Important, 6 Minor. The Important finding was fixed and re-reviewed clean. |
| External audit (OpenCode, DeepSeek reasoner) | 3 findings, all validated by the controller in the code. 2 fixed and re-reviewed clean, 1 carried as a Phase 2 tradeoff. |

Evidence: `docs/build/evidence/phase-03-verify.txt`, last line `exit=0`.

Phase 3 exit condition met: a false agent success claim cannot bypass a failing check.

## Read this before Phase 4

**A Linear delegation now reaches the sandbox.** The Phase 2 blocker is gone. `DelegationService` builds `AgentRunWorkflowInput.sandbox` from the Project record, so a real delegation reaches `PREPARING`, `IMPLEMENTING`, and `VERIFYING`.

**The repository owns its own configuration.** `SandboxManager` reads `.factoree/config.yaml` out of the primary checkout and builds `ProjectRuntimeConfig` itself. Nothing passes a ready-made runtime configuration in any more. The Project record still owns `stagingRead` and `spriteRetentionHours`, because SDD section 57 forbids a repository from widening a control the operator set.

**There is still no success terminal state.** A Run whose verification passes falls into the residual wait and ends `FAILED` with `RUN_TIMEOUT`. The next state of SDD section 49 is `USER_VALIDATING`, and Phase 7 builds it. SDD section 68 forbids `READY_FOR_HUMAN` without a Validation Contract, a PR, and a Proof Pack, so Phase 3 invented nothing.

**The goal and the reference refs are placeholders Phase 4 replaces.** The goal is the Linear issue title joined to its description. Every reference repository is checked out at `HEAD`. Phase 4 produces a refined Work Item and pins each reference to an explicit SHA.

## Human decisions

None required so far. Every decision was taken by the controller and is recorded in the phase plan, the commit history, or the list below.

Decisions worth knowing before Phase 4:

1. **The network policy is applied three times, and each application is tighter than the last.** SDD section 32 orders `APPLY NETWORK POLICY` before the primary checkout, but the allow list lives in a file only that checkout can produce. The order is: the repository hosts alone; then those hosts joined with the configured allow list, so the reference checkouts and the bootstrap command work; then the configured allow list alone, before the baseline checkpoint and the agent.
2. **A missing or invalid `.factoree/config.yaml` is a `RunConfigurationError`**, so the Run ends `FAILED_CONFIGURATION` with `CONFIGURATION_INVALID` and no retry repeats it.
3. **The verification command list is pinned at prepare time.** An Implementer that edits `.factoree/config.yaml` cannot weaken the checks that judge it, and a repair pass reuses the pinned list.
4. **A verification result is stored as an `Evidence` row**, because SDD section 53 lists `Evidence` and lists no verification entity. `validationAssertionId` is null for a deterministic check. **Phase 6 fills that column and must add the runtime guard on `Evidence.kind`.**
5. **A hash covers the raw output, and a retained log covers the redacted output.** A hash of redacted text would not identify the real output.
6. **Every configured command runs, and a failing command does not stop the ones after it**, because SDD section 35 requires a record for each command.
7. **A repair attempt starts a fresh Implementer run rather than resuming the session.** SDD section 42 makes the resume optional, and an `OpenCodeRunner` session lives in one worker process, so a resume could not survive the worker restart of AT-35.
8. **`RUN_FAILURE_REASONS` gained `VERIFICATION_FAILED`.** SDD section 48 fixes the state names, not the failure reasons.
9. **The egress allow list accepts `*.example.com`.** It rejects `*example.com`, which no adapter gives a meaning to, and rejects a bare `*`, because that would mean allow everything and SDD section 29 denies it.
10. **`Project` gained `defaultBranch`, default `main`,** because a checkout needs a ref and the record held none. `GITHUB_BASE_URL` turns an `owner/repo` slug into a clone URL until the Phase 9 GitHub adapter exists.

## Carried findings for later phases

Reviewed, judged not reachable or not in scope now, deliberately not fixed.

**For Phase 4:**

- `referenceBaseShas` reaches the activity output but nothing persists it. SDD section 55 wants the recorded SHA of every repository in PostgreSQL, not only in Temporal history.
- A reference repository is checked out at `HEAD`. Discovery must pin an explicit SHA.
- The goal is the raw issue title and description. Refinement replaces it.
- `checkoutHosts` derives a host with `new URL`, so an scp-style address such as `git@host:owner/repo.git` yields no host and would leave policy one empty. No caller produces one today, because `buildRepositoryUrl` always emits `https://`.
- `buildRepositoryUrl` accepts a single-dot segment such as `owner/.`. It is not a traversal, and the clone fails, but it deserves a comment or a tighter check.

**Security findings carried, from the external audit:**

- **`Redactor` ignores a secret shorter than four characters** (`src/telemetry/redaction.ts`). A Project secret of three characters or fewer, marked for injection and echoed by a command, reaches a log, an evidence row, and the repair findings unredacted. The floor is a deliberate Phase 2 choice, because a shorter value would redact ordinary words out of every line. The controller validated the finding in the code and did not change the floor. **The right fix is to refuse a too-short secret at the admin API, not to lower the floor.** SDD sections 30 and 60.
- The evidence tenant guard is defence in depth only. It throws on a mismatch, but the unique index is still `(runId, idempotencyKey)` with no tenant. The case is unreachable while `Run.id` is a globally unique identifier.

**Carried from Phase 2, still open:**

- The activities resolve a sandbox from one injected adapter while faithfully recording the adapter name. Carry a map through the activities before a second adapter is deployed.
- `baselineCheckpointId` is created, returned, and consumed by nothing.
- An admin write that omits `injectIntoImplementer` resets a marked secret to unmarked. It fails closed, but an operator rotating a value loses the mark with no signal.
- `AgentRunInput` carries `tenantId` but not `projectId`, so a runner cannot label by Project.
- The `reapExpiredSandboxes` activity duplicates the worker's own interval and has no caller.

**For Phase 6:**

- Evidence recording lives in `src/activities/verification.activities.ts`. SDD section 63 lists `evidence.activities.ts`. Split it when Validation Contract evidence arrives.
- `Evidence.kind` is read back with a cast and no runtime guard. One kind exists today. A second kind needs the guard.

**For Phase 7 and later:**

- A stop during verification does not cancel the verify activity. The workflow waits for it, then ends the Run `CANCELLED`. SDD section 50 names agent processes, and verification runs project commands, so this is inside the letter of the rule. The phase that adds a cancellation scope there must revisit it.
- `CLEAN_SHELL_ENV` in `src/domain/runs/verification.ts` fixes `PATH` and `HOME` for a Linux sandbox image, and sets `HOME` to `/root`. A repository needing another toolchain path must state it inside its verification command until the shell environment becomes configurable.

**For Phase 11 or the credential path:**

- Neither adapter passes a model-provider credential to the agent. A real agent Run needs a model key, and no phase has yet designed how it arrives.

**For Phase 12, the live proof under SDD section 66:**

- The residual cancellation interleaving: the wrapper checks the cancel marker, the marker lands, then the command launches and the pid write misses the retry budget.
- `cancelProcess` swallows a transport fault, so an unreachable sandbox is indistinguishable from a process that never existed.
- Whether a detached session survives `command.close()` without `maxRunAfterDisconnect`.
- Whether `set -m` under a non-interactive POSIX shell creates a process group, which the group kill depends on.
- `FlySpriteSandbox.create` ignores `memoryMb`, `cpus`, and `region`.
- `exposeService` throws and `supportsExposedServices` is false. Phase 7 needs it.
- AT-12 is partially satisfied. The local adapter is not a sprite and imposes no kernel boundary.
- AT-26 is proved for the prompt, the input path, and the local adapter allow list. The live sprite proof remains.
- The reference-repository read-only control is a file mode the owning user can reverse. The real control is to run the agent as a user that does not own those directories.
- `FakeSandbox` declares `enforcesNetworkPolicy: true` while enforcing nothing.
- The Phase 3 acceptance test proves the staged network policy by what `SandboxManager` applied, not by what a kernel denied, because the local adapter enforces nothing. `tests/unit/sandbox-manager.test.ts` proves that policy three is narrower than policy two, using two distinct remote hosts. The live proof stays here.

## Blockers

None.

Live Linear, GitHub, Fly Sprites, and Temporal Cloud credentials are needed for the Phase 12 live acceptance test. They are not needed for Phase 4.

## Environment notes

- Node 24 LTS is at `/opt/homebrew/opt/node@24/bin`. The Homebrew `node` 25 binary on this machine is broken, so prefix PATH with the Node 24 path.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`. **Never write a file through a `cat` heredoc, and never build a commit message with `git commit -m "$(cat <<EOF ...)"`.** Both fail with a dyld error. Use `git commit -F` with a file instead.
- `timeout` and `gtimeout` are not installed.
- Docker is required for the integration and workflow suites.
- The Prisma CLI resolves `DATABASE_URL` eagerly, so every CLI call needs a value. CI sets a placeholder. `prisma migrate dev --create-only` needs a reachable database on this machine, so both Phase 3 migrations were written by hand and applied through the Testcontainers database.
- **Deployment prerequisite:** the migration `20260822184549_add_agent_execution_idempotency_key` adds a NOT NULL column with no default and no backfill. It refuses to apply against a database that already holds `AgentExecution` rows. That table has never held a row outside a test database. Backfill first if that ever changes.
- The two Phase 3 migrations are safe against a populated database. `Evidence` is a new table, and `Project.defaultBranch` is NOT NULL with the default `main`.
- `opencode` version 1.18.18 is installed and authenticated for DeepSeek, and was used for the external audit.
