# Factoree build status

## Specification

- Source of truth: `docs/sdd.md`
- Version: 2.0
- SHA-256: `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`

## Phases

- Completed: Phase 1 — Control plane; Phase 2 — Sandbox and first runner; Phase 3 — Deterministic verification; Phase 4 — Refinement and Context Contract
- Current: none
- Next: Phase 5 — Backstage and MCP

## Git

- Branch: `main`
- Phase 4 range: `a8e9c0a..433f66e`, 28 commits. 26 on `phase-04-context`, then the no-fast-forward merge and this record.
- The repository has no remote. Each phase merges into local `main` with a no-fast-forward commit.

## Phase 4 verification

The controller ran every check below itself. Agent claims were not accepted as evidence.

| Check | Result |
| --- | --- |
| `npm run verify` on the branch | exit 0, run three times: after Task 12, after the final-review fix wave, after the audit fix |
| `npm run verify` on `main` after the merge | exit 0: 533 unit passed and 7 skipped, 92 integration, 37 workflow, build succeeded |
| Skip count | 7, the same as the Phase 2 and Phase 3 baseline. Phase 4 skipped no test. |
| Phase 4 exit condition | pass: a Run freezes and persists a Context Contract with complete provenance and pinned SHAs, posts it to Linear, and puts it in the Implementer prompt, all before the Implementer changes anything |
| AT-02 refinement | pass, and no source file changed |
| AT-03 material uncertainty | pass: `WAITING_FOR_INPUT`, no Implementer ran |
| AT-05 reference repository | pass at an explicit SHA. The read-only control is a file mode only. See the carried findings. |
| AT-06 context provenance | pass: each of four provenance fields broken in turn fails validation, with a positive control on the unbroken clone |
| AT-07 resolvable conflict | pass: the accepted ADR beats the README, with the ladder reason recorded |
| AT-08 unresolvable conflict | pass: `WAITING_FOR_INPUT`, no sandbox, no Implementer |
| AT-09 context limit | pass: the large repository is `discoverable` at a pinned SHA, and no file body reaches the prompt |
| AT-33 tenant isolation | strengthened. It now also fails when a new table omits `tenantId`. |
| Task reviews | 12 of 12 clean, after 11 fix rounds in total |
| Final whole-branch review | 1 Critical and 5 Important, all fixed and re-reviewed clean |
| External audit (OpenCode, DeepSeek reasoner) | 3 real findings and 2 minor. 3 fixed, 1 carried. The auditor executed the real code to prove its main finding. |

Evidence: `docs/build/evidence/phase-04-verify.txt`, last line `exit=0`.

## Read this before Phase 5

**A Run now refines, resolves context, and freezes a contract before it prepares a sandbox.** The workflow order is `RECEIVED` → `REFINING` → `RESOLVING_CONTEXT` → `PREPARING` → `IMPLEMENTING` → `VERIFYING`, with `WAITING_FOR_INPUT` reachable from both `REFINING` and `RESOLVING_CONTEXT`.

**`AgentRunWorkflowInput` no longer carries a `sandbox` block.** It carries `workItem` and `project`. The workflow derives the sandbox from the SHAs discovery pinned. `DelegationService` builds neither the goal nor a clone URL any more.

**Discovery runs on the control plane, not in a sandbox.** `GitRepositoryReader` in `src/adapters/github/` runs `git ls-remote`, `git ls-tree -z`, and `git cat-file` against a temporary bare mirror. It executes no repository code. SDD section 49 puts context resolution before the sandbox exists, and SDD section 32 gives one Run one sandbox, so a second discovery sandbox is forbidden.

**There is still no success terminal state.** A Run whose verification passes falls into the residual wait and ends `FAILED` with `RUN_TIMEOUT`. The next state of SDD section 49 is `USER_VALIDATING`, and Phase 7 builds it.

**The Validation Contract does not exist yet.** SDD section 49 places it between context resolution and sandbox preparation, and Phase 6 builds it. The workflow goes straight from `RESOLVING_CONTEXT` to `PREPARING` today.

## Human decisions

None required so far. Every decision was taken by the controller and is recorded in the phase plan, the commit history, or the list below.

Decisions worth knowing before Phase 5:

1. **Refinement is deterministic Factoree logic, not an agent role.** SDD section 53 fixes `AgentExecution.role` to implementer, validator, and reviewer, and SDD section 49 places `refine` before any sandbox exists. Refinement parses, classifies, and asks. It never generates prose.
2. **A recorded human answer settles one subject in one authority domain.** Anything wider skips a question SDD section 23 requires. This cost three corrections: an answer first settled every subject, then one subject across every domain, and only then one subject in one domain. The reference `linear:decision:subject:<domain>:<subject>` carries the scope.
3. **A recorded answer never competes in a conflict pair.** It is an override, not a competitor.
4. **The current-implementation and system-topology domains never conflict with themselves.** SDD section 22 writes both with `+`, which is combined evidence, not a ladder. The opposite rule made every source file conflict with its own test.
5. **The three SDD section 21 classifications have distinct meanings.** `required` enters the prompt's required-context block. `reference` is summarized in the contract the prompt carries. `discoverable` is a container reachable only through a tool, which is what a repository is.
6. **An item's topics come from its path and, once fetched, from its content.** Path-only topics made the AT-07 conflict undetectable.
7. **The Context Contract freezes only when no unresolved conflict remains.** The store is immutable, so freezing a draft would lock out the human answer that follows.
8. **`Run.contextContractVersion` holds the contract SHA-256.** `ContextContract.version` holds the integer schema version of SDD section 21. The two share a name and hold different things.
9. **The question rounds are bounded at five, shared across refinement and conflict resolution.** SDD sections 8 and 23 impose no bound, and an unbounded elicitation loop never ends. A spent budget fails the Run with `REFINEMENT_UNRESOLVED` or `CONTEXT_UNRESOLVED` and publishes nothing.
10. **A deterministic discovery failure is a `RunConfigurationError`,** so it ends `FAILED_CONFIGURATION` with `CONFIGURATION_INVALID` and consumes no Temporal retry. A transport fault stays retryable.
11. **`ContextSourceConfiguration` of SDD section 53 is not built.** It configures the Backstage and MCP sources that SDD section 69 gives to Phase 5.
12. **The `context` block of `.factoree/config.yaml` is still parsed and unconsumed.** An earlier plan decision said Phase 4 would read it at the pinned SHA. Phase 4 does not, and the record is corrected rather than the code: the block governs Backstage and automatic reference discovery, and both are Phase 5.
13. **No Project-level authority override is built.** SDD section 22 makes it optional and no acceptance test needs it.

## Carried findings for later phases

Reviewed, judged not reachable or not in scope now, deliberately not fixed.

**For Phase 5, and blocking a real SDD section 28 guarantee:**

- **The autonomy cap is dead in production.** `DelegationService` sets `workItem.labels` to an empty list, because the Linear agent session webhook carries no label field. `capAutonomy` is correct and unit-tested, and the capped level now reaches the Run row, but no high-risk label ever arrives. Phase 5 must read the labels through the Linear API. Until then a `security` issue runs at the Project default level. SDD section 28.
- `context.backstage.enabled` and `context.referenceRepositories.automaticDiscovery` are parsed and consumed by nothing. Phase 5 owns both.
- `ContextSourceConfiguration` is unbuilt. See decision 11.

**For the phase that revisits the conflict model:**

- `conflictQuestion` names only the first pair of a `(domain, subject)` group. With three or more competing items on one subject in one domain, one answer settles every pair, while the question named only two of them. The scope is correct under decision 2; the wording understates it.
- A clean ladder resolution that a human decision overrides loses the original ladder reason. A `supersedes` field would keep it for the Proof Pack.
- A pairwise detector emits one record per pair, so three items sharing one settled subject yield three near-identical resolved records.

**For the phase that revisits discovery:**

- `isDeterministicRemoteFailure` matches `/Permission denied/i` and `/access rights/i`, which can catch a local EACCES on the mirror directory and report it as a permanent `FAILED_CONFIGURATION`.
- The streamed `listTree` error drops `{ cause }`. There is no `error` listener on the child stdout or stderr, and `pending` has no byte cap when every record is filtered out.
- `checkoutHosts` derives a host with `new URL`, so an scp-style address such as `git@host:owner/repo.git` yields no host. No caller produces one, because `buildRepositoryUrl` always emits `https://`. Carried from Phase 3.
- `context-resolver` treats an unknown `sizeBytes` as free budget. Only a repository candidate carries null today, and a repository never competes.

**For the phase that owns the Implementer prompt:**

- `WorkItem.constraints` is parsed and reaches no consumer. SDD section 57 places Work Item constraints in the instruction precedence order, so they must reach the prompt. Changing the prompt needs a version bump under SDD section 56.

**Security findings carried, from Phase 3:**

- **`Redactor` ignores a secret shorter than four characters** (`src/telemetry/redaction.ts`). The floor is a deliberate Phase 2 choice. **The right fix is to refuse a too-short secret at the admin API, not to lower the floor.** SDD sections 30 and 60.
- The evidence tenant guard is defence in depth only. The unique index is still `(runId, idempotencyKey)` with no tenant.

**Carried from Phase 2, still open:**

- The activities resolve a sandbox from one injected adapter while faithfully recording the adapter name. Carry a map through the activities before a second adapter is deployed.
- `baselineCheckpointId` is created, returned, and consumed by nothing.
- An admin write that omits `injectIntoImplementer` resets a marked secret to unmarked.
- `AgentRunInput` carries `tenantId` but not `projectId`.
- The `reapExpiredSandboxes` activity duplicates the worker's own interval and has no caller.

**For Phase 6:**

- Evidence recording lives in `src/activities/verification.activities.ts`. SDD section 63 lists `evidence.activities.ts`. Split it when Validation Contract evidence arrives.
- `Evidence.kind` is read back with a cast and no runtime guard. The Phase 4 context store guards every string column instead; follow that pattern.

**For Phase 7 and later:**

- A stop during verification does not cancel the verify activity.
- `CLEAN_SHELL_ENV` fixes `PATH` and `HOME` for a Linux sandbox image.

**For Phase 11 or the credential path:**

- Neither adapter passes a model-provider credential to the agent.

**For Phase 12, the live proof under SDD section 66:**

- AT-05 proves a file mode only. The real read-only control is to run the agent as a user that does not own the reference directories.
- The residual cancellation interleaving, `cancelProcess` swallowing a transport fault, whether a detached session survives `command.close()`, and whether `set -m` creates a process group.
- `FlySpriteSandbox.create` ignores `memoryMb`, `cpus`, and `region`. `exposeService` throws.
- AT-12 is partially satisfied. AT-26 is proved for the prompt, the input path, and the local adapter allow list.
- `FakeSandbox` declares `enforcesNetworkPolicy: true` while enforcing nothing.
- The staged network policy is proved by what `SandboxManager` applied, not by what a kernel denied.

## Blockers

None.

Live Linear, GitHub, Fly Sprites, and Temporal Cloud credentials are needed for the Phase 12 live acceptance test. They are not needed for Phase 5.

## Environment notes

- Node 24 LTS is at `/opt/homebrew/opt/node@24/bin`. The Homebrew `node` 25 binary on this machine is broken, so prefix PATH with the Node 24 path.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`. **Never write a file through a `cat` heredoc, and never build a commit message with `git commit -m "$(cat <<EOF ...)"`.** Use `git commit -F` with a file instead.
- `node` and `npx` print a `dyld: Library not loaded: libllhttp.9.3.dylib` warning from `libgit2`. It is noise, but it can kill a command silently.
- `timeout` and `gtimeout` are not installed.
- Docker is required for the integration and workflow suites.
- The Prisma CLI resolves `DATABASE_URL` eagerly, so every CLI call needs a value. Both Phase 4 migrations were written by hand and applied through the Testcontainers database.
- **Both Phase 4 migrations are safe against a populated database.** `20260823120000_add_context_contract` creates three new tables. `20260823140000_add_context_conflict_domain` adds a NOT NULL column to `ContextConflict`, which the migration immediately before it created, so no row can exist to backfill.
- **Run the whole integration suite before calling a task complete, not one file.** A Phase 4 task broke AT-33 and the regression survived four tasks, because each ran only its own file.
- `opencode` version 1.18.18 is installed and authenticated for DeepSeek, and was used for the external audit.
