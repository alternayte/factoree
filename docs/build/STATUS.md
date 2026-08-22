# Factoree build status

## Specification

- Source of truth: `docs/sdd.md`
- Version: 2.0
- SHA-256: `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`

## Phases

- Completed: Phase 1 — Control plane; Phase 2 — Sandbox and first runner
- Current: none
- Next: Phase 3 — Deterministic verification

## Git

- Branch: `main`
- Commit: `99f6ae6`
- Phase 2 range: `edf526a..99f6ae6`, 32 commits, merged from `phase-02-sandbox`

## Phase 2 verification

The controller ran every check below itself. Agent claims were not accepted as evidence.

| Check | Result |
| --- | --- |
| `npm run verify` on the branch | exit 0 |
| `npm run verify` on `main` after the merge | exit 0: 260 unit passed and 7 skipped, 43 integration, 15 workflow |
| Phase 2 exit condition | pass: a sandbox is prepared, the Implementer changes a fixture file, and nothing is published |
| AT-12 isolation | pass with a recorded limit: three concurrent Runs use three distinct sandbox identifiers and do not modify one another |
| AT-13 Action Policy | pass: the Implementer writes the primary worktree, cannot write a reference repository, and cannot push to a git remote |
| AT-26 credential isolation | pass with a recorded limit: the Implementer input rejects a GitHub credential by name and by value shape |
| Sandbox contract suite | `LocalProcessSandbox` passes all 12 cases; `FakeSandbox` passes the 5 lifecycle cases and declares that it does not execute commands |
| Task reviews | 12 of 12 clean, after 14 fix rounds in total |
| Final whole-branch review | 2 Critical and 6 Important found, all fixed, re-review clean |
| External audit (OpenCode, DeepSeek reasoner) | 4 findings, all validated by the controller, 3 unique and fixed |

Evidence: `docs/build/evidence/phase-02-verify.txt`, last line `exit=0`.

Phase 2 exit condition met: Factoree can make an isolated fixture change without publishing.

## Read this before Phase 3

**The exit condition is proved by a harness, not by a delegation.** The acceptance test assembles `SandboxManager`, `AgentRunnerRegistry`, and `buildImplementerInput` directly. `DelegationService` never sets `AgentRunWorkflowInput.sandbox`, so **no Run started by a Linear delegation reaches `PREPARING` today**. This is the plan's own design: Phase 3 builds the `.factoree/config.yaml` loader that produces `ProjectRuntimeConfig`, and wiring it is the first thing Phase 3 must do.

There is also no success terminal state after implementation. A completed implementation falls into the residual wait and the Run ends `FAILED` with `RUN_TIMEOUT`. Phase 3 adds verification and the states after it.

## Human decisions

None required so far. Every decision was taken by the controller and is recorded in the phase plan, the commit history, or the list below.

Decisions worth knowing before Phase 3:

1. **Fly Sprites has an official TypeScript SDK, `@fly/sprites`, version 0.2.0.** `FlySpriteSandbox` wraps it behind a `SpritesGateway` seam, and only `src/adapters/sandbox/fly-sprites/sprites-client.ts` imports it.
2. **The `Sandbox` port adds two methods beyond the SDD section 31 listing**, `applyNetworkPolicy` and `readProcess`. Section 32 requires a network policy step and process control is useless without reading output.
3. **`LocalProcessSandbox` is a second adapter for local development and tests.** It declares `enforcesNetworkPolicy: false`, and `SandboxManager` refuses it unless a caller passes `allowUnenforcedNetwork`.
4. **A Project secret reaches the Implementer only when it is marked `injectIntoImplementer`.** The column defaults to false, so every secret written before Phase 2 is denied. Every secret still reaches the redactor whether marked or not. **Phase 3 must not let `.factoree/config.yaml` become a second authority for this mark.**
5. **A credential is detected by value shape first and by name second.** `src/domain/security/credential-formats.ts` is the one list of provider credential formats, shared with the redactor.
6. **`Command.timeoutMs` applies to `exec` only.** `startProcess` ignores it and the caller owns the deadline.
7. **The workflow never destroys a sandbox.** It records a retention deadline and `SpriteReaper` deletes the sandbox after 24 hours, per SDD sections 32 and 51.
8. **`RUN_FAILURE_REASONS` gained `IMPLEMENTATION_FAILED`.** SDD section 48 fixes the state names, not the failure reasons.

## Carried findings for later phases

Reviewed, judged not reachable or not in scope now, deliberately not fixed.

**For Phase 3:**

- Wire `AgentRunWorkflowInput.sandbox` from Project configuration. Until then the sandbox path is unreachable from a delegation.
- `checkoutRepositories` records a base SHA for every reference repository, but only the primary SHA survives into the activity output. SDD section 55 wants all of them.
- The activities resolve a sandbox from one injected adapter while faithfully recording the adapter name. `SpriteReaper` already resolves by name from a map. Carry a map through the activities before a second adapter is ever deployed.
- `baselineCheckpointId` is created, returned, and consumed by nothing. Persist it or stop taking the checkpoint.
- An admin write that omits `injectIntoImplementer` resets a marked secret to unmarked. It fails closed, but an operator rotating a value loses the mark with no signal.
- `AgentRunInput` carries `tenantId` but not `projectId`, so a runner cannot label by Project.
- The `reapExpiredSandboxes` activity duplicates the worker's own interval and has no caller.

**For Phase 11 or the credential path:**

- Neither adapter passes a model-provider credential to the agent. `LocalProcessSandbox` now uses a closed allow list and `FlySpriteSandbox` passes only the command environment. A real agent Run needs a model key, and no phase has yet designed how it arrives.

**For Phase 12, the live proof under SDD section 66:**

- The residual cancellation interleaving: the wrapper checks the cancel marker, the marker lands, then the command launches and the pid write misses the retry budget.
- `cancelProcess` swallows a transport fault, so an unreachable sandbox is indistinguishable from a process that never existed.
- Whether a detached session survives `command.close()` without `maxRunAfterDisconnect`. If the server default kills it, every started agent process dies at once.
- Whether `set -m` under a non-interactive POSIX shell creates a process group, which the group kill depends on.
- `FlySpriteSandbox.create` ignores `memoryMb`, `cpus`, and `region`.
- Whether the Sprites base image provides the workspace directory. `SandboxManager` creates it, so this is defence in depth.
- `exposeService` throws and `supportsExposedServices` is false, because the SDK has no documented port publication API. Phase 7 needs it.
- AT-12 is partially satisfied. The test uses the local adapter, which is not a sprite and imposes no kernel boundary. An absolute-path write into a peer worktree would still succeed.
- AT-26 is proved for the prompt and the input path, and now also by the local adapter's allow list. The live sprite proof remains.
- The reference-repository read-only control is a file mode the owning user can reverse. The real control is to run the agent as a user that does not own those directories.
- `FakeSandbox` declares `enforcesNetworkPolicy: true` while enforcing nothing, so the contract's network-policy case certifies a claim the fake cannot back.

## Blockers

None.

Live Linear, GitHub, Fly Sprites, and Temporal Cloud credentials are needed for the Phase 12 live acceptance test. They are not needed for Phase 3.

## Environment notes

- Node 24 LTS is at `/opt/homebrew/opt/node@24/bin`. The Homebrew `node` 25 binary on this machine is broken, so prefix PATH with the Node 24 path.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`.
- `timeout` and `gtimeout` are not installed.
- Docker is required for the integration and workflow suites.
- The Prisma CLI resolves `DATABASE_URL` eagerly, so every CLI call needs a value. CI sets a placeholder.
- **Deployment prerequisite:** the migration `20260822184549_add_agent_execution_idempotency_key` adds a NOT NULL column with no default and no backfill. It refuses to apply against a database that already holds `AgentExecution` rows. That table has never held a row outside a test database. Backfill first if that ever changes.
- `opencode` version 1.18.18 is installed and authenticated for DeepSeek, and was used for the external audit.
