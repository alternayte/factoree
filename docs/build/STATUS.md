# Factoree build status

## Specification

- Source of truth: `docs/sdd.md`
- Version: 2.0
- SHA-256: `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`

## Phases

**The Phase 12 exit condition is NOT fully met, and Version 1 is NOT Done.** 88 of 99
Definition of Done items pass. The 11 "Live proof" items carry state `BLOCKED_EXTERNAL`,
because no live Linear, GitHub, Fly, or Temporal credential exists in this environment.
SDD section 66 names that state and says plainly it is not equivalent to Done.

- Completed: Phase 1 — Control plane; Phase 2 — Sandbox and first runner; Phase 3 —
  Deterministic verification; Phase 4 — Refinement and Context Contract; Phase 5 —
  Backstage and MCP; Phase 6 — Validation Contract; Phase 7 — User validation and
  evidence; Phase 8 — Review and repair; Phase 9 — Trusted publishing; Phase 10 — Proof
  Pack; Phase 11 — Second runner and skills; Phase 12 — Hardening
- Current: none
- Next: none. Every Version 1 implementation phase is complete.

## Git

- Branch: `main`. Phase 12 is merged.
- Post-phase fix: the worker-local silent-cancel finding, merged as `c11db35`. The merged
  result verified exit 0: lint 0, typecheck 0, unit 1054 passed and 7 skipped, integration
  249 passed, workflow 85 passed, build 0.
- Phase 12 range: `9fb9585..314d998`, 18 commits on `phase-12-hardening`, then the
  no-fast-forward merge `03aa4c5`.
- **The merged result on `main` verified exit 0.** The controller ran every stage on `main`
  after the merge: lint 0, typecheck 0, unit 1051 passed and 7 skipped, integration 249
  passed, workflow 85 passed, build 0. A merge can break what neither side broke alone.
- The repository HAS a remote. `origin` is `https://github.com/alternayte/factoree.git`.
  Phase 11 and earlier recorded "no remote", and that statement was wrong. The controller
  corrected it in Phase 12.
- **No phase has ever pushed to that remote, and `phase-12-hardening` tracks no upstream.**
  Every phase merges into local `main` with a no-fast-forward commit. A push is an outward
  action. Ask the human before you push.

## Phase 12 verification

The controller ran every check below itself, twice, with every stage serialized. Agent
claims were not accepted as evidence.

| Check | Result |
| --- | --- |
| `npm run verify`, run 1, at commit `f2c121f` | exit 0: lint 0, typecheck 0, unit 1051 passed and 7 skipped, integration 249 passed, workflow 85 passed, build 0, aggregate exit 0 |
| `npm run verify`, run 2, at commit `f2c121f` | exit 0 again, with identical counts |
| Skip count | 7, the unchanged Phase 2 through Phase 11 baseline. Phase 12 skipped no test. |
| The doc-only commits after `f2c121f` | changed no source file, so the recorded counts stand unchanged at the branch head |
| `npm ci` verification, at commit `df09a1f` | `npm ci` exit 0, `npx prisma generate` exit 0, `npm run build` exit 0, unit suite exit 0 from that clean install |

Evidence: `docs/build/evidence/phase-12-verify.txt`, last line `exit=0`.

**What Phase 12 built.** The normalized failure category of SDD section 67. The bounded
runner session map, so a completed Run releases its session. The git-state fingerprint,
so a Reviewer commit cannot hide. The recorded git versions on both sides of the hash
assertion. The organization skills SHA, so a Run records the exact skill source it
read. The three reliability proofs: three concurrent fixture Runs, an infrastructure
retry that spends no repair budget, and a timeout that cancels the live Implementer.
The live acceptance harness of SDD section 66. The Definition of Done audit of SDD
section 67.

**The real source defect Phase 12 found and fixed.** On a Run timeout the workflow
never cancelled the live Implementer, violating SDD section 50 obligation 1.
`cancelImplementer` was reachable only through the human stop signal. Fixed in
`ebafa91`. A Run that reached its deadline previously left a live coding agent running
inside its sandbox.

## Read this before the next session

1. `failRun` and `cancelRun` both cancel the Implementer BEFORE `completeRun`, and
   `completeRun` calls `releaseRun`. Cancel always precedes release. Do not reorder
   them.
2. `worktreeFingerprint` returns the tree SHA and `publishing.activities` compares it
   to `patch.treeSha`. **Never change its return value.** The git-state check is a
   SECOND value.
3. `CATEGORY_BY_REASON` is a total `Record`, so a new failure reason breaks the
   typecheck until somebody classifies it. That is deliberate.
4. The eslint ignore list is narrow on purpose. `tests/live/*.mjs` covers the two live
   loaders only. Do not widen it to `**/*.mjs`.
5. `harness.destroyed` is NEVER populated. The workflow makes no `destroySandbox`
   call. Do not assert on it.

## Human decisions

None required so far. Every decision was taken by the controller and is recorded in
the phase plans, the commit history, or the lists below.

Phase 4 through Phase 11 decisions still stand.

## Carried findings for later phases

Reviewed, judged not reachable or not in scope now, deliberately not fixed. Every
Phase 4 through Phase 11 entry that Phase 12 did not close still stands.

**New in Phase 12:**

1. **Worker-local state versus a shared task queue. HALF CLOSED.** `CliAgentRunner.sessions`
   lives in one process, and `src/bin/worker.ts` pins nothing to a worker.
   **The silent-cancel half is CLOSED by the post-phase fix `c11db35`.** A cancel that
   reached a worker holding no live session returned silently, so the workflow recorded
   that SDD section 50 obligation 1 was met while a live agent kept running.
   `AgentRunner.cancel` now returns `"cancelled"` or `"no-live-session"`.
   `cancelImplementer` logs at error and throws on the second, so the bounded retry of
   three attempts can reach the owning worker. Both call sites wrap the activity in
   `notify()`, so a Run still reaches its terminal state.
   **The unbounded-growth half is STILL OPEN.** `releaseRun` remains worker-local. On a
   two-worker deployment `completeRun` can land on worker B and free nothing on worker A.
   Fix by pinning a session to its worker, or by moving session state out of process.
2. **The timeout cancel is post-hoc, not pre-emptive.** `remainingMs() === 0` is
   checked between stages only. Every activity is bounded by the Run budget, and
   `IMPLEMENT_MARGIN_MS` is five minutes, so an agent can survive about five minutes
   past the deadline.
3. **A Reviewer that commits and then resets exactly back to the original `HEAD`,
   deleting any branch it created, defeats the git-state fingerprint.** Intrinsic to a
   point-in-time hash. A reflog read closes it.
4. **`releaseRun` runs after the durable write in `completeRun`.** An `updateStatus`
   throw retains the sessions until a retry succeeds.
5. **The widened review guard has no false-positive test.** Any ref the sandbox
   creates between the two samples fails the review with a git-state message.

## Blockers

Live Linear, GitHub, Fly Sprites, and Temporal Cloud credentials are needed for
`npm run acceptance:live`. `.env.example` names the required variables:
`LIVE_LINEAR_API_KEY`, `LIVE_LINEAR_TEAM_ID`, `LIVE_GITHUB_TOKEN`,
`LIVE_GITHUB_REPOSITORY`, `LIVE_FLY_API_TOKEN`, `LIVE_FLY_ORGANIZATION`,
`LIVE_TEMPORAL_ADDRESS`, `LIVE_TEMPORAL_NAMESPACE`, `LIVE_RUNNER_NAME`,
`LIVE_RUNNER_API_KEY`, `LIVE_BACKSTAGE_BASE_URL`, `LIVE_BACKSTAGE_TOKEN`,
`LIVE_MCP_ENDPOINT`, and `LIVE_MCP_TOKEN`. See `docs/live-acceptance.md` for the full
procedure.

## Environment notes

- Node 24 LTS is at `/opt/homebrew/opt/node@24/bin`. The Homebrew `node` 25 binary on
  this machine is broken, so prefix PATH with the Node 24 path.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`. **Never write a file
  through a `cat` heredoc, and never build a commit message with
  `git commit -m "$(cat <<EOF ...)"`.** Use `git commit -F` with a file.
- **`npx prisma generate` needs `DATABASE_URL`.** Any value works. Use
  `DATABASE_URL="postgresql://u:p@localhost:5432/db" npx prisma generate`.
- `timeout` and `gtimeout` are not installed.
- Docker is required for the integration and workflow suites.
- **`npm run verify` takes longer than a two-minute foreground tool call.** Run it in
  stages in the background and poll the output file. **Compute a real aggregate exit
  code across the stages.**
- **A pipeline hides the exit code of the command before it.** Redirect to a file and
  read `$?` on its own line.
- **NEVER run a test suite while another suite runs.** Phase 11 lost a whole
  verification cycle this way. **Serialize every suite run.**
- **`pkill -f "<pattern>"` also kills the waiting shell whose command line contains
  that pattern.** Match on the script path alone.
- **Run the whole-repository `npm run lint` and `npm run typecheck` yourself at every
  task gate.**
- The acceptance tests run under `vitest.integration.config.ts`, not under a config of
  their own.
- **Run every suite more than once before you believe a green result.**
- **`npm ci` was run in Phase 12 and exited 0,** together with `npx prisma generate`,
  `npm run build`, and the unit suite, all from that same clean install.
