# Factoree build status

## Specification

- Source of truth: `docs/sdd.md`
- Version: 2.0
- SHA-256: `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`

## Phases

- Completed: Phase 1 — Control plane; Phase 2 — Sandbox and first runner; Phase 3 — Deterministic verification; Phase 4 — Refinement and Context Contract; Phase 5 — Backstage and MCP; Phase 6 — Validation Contract; Phase 7 — User validation and evidence; Phase 8 — Review and repair; Phase 9 — Trusted publishing; Phase 10 — Proof Pack; Phase 11 — Second runner and skills
- Current: none
- Next: Phase 12 — Hardening

## Git

- Branch: `main`
- Phase 11 range: `84a0e9b..8bc12f7`, 14 commits on `phase-11-runner-and-skills`, then the no-fast-forward merge.
- The repository has no remote. Each phase merges into local `main` with a no-fast-forward commit.

## Phase 11 verification

The controller ran every check below itself. Agent claims were not accepted as evidence.

| Check | Result |
| --- | --- |
| `npm run verify` at the branch head `8bc12f7` | exit 0, run in stages with a real aggregate exit code: lint 0, typecheck 0, unit 1028 passed and 7 skipped, integration and acceptance 241, workflow 81, build 0 |
| Skip count | 7, the same as the Phase 2 through Phase 10 baseline. Phase 11 skipped no test. |
| Second whole verification | exit 0 again, with identical counts. A single green run is not proof. |
| Phase 11 exit condition | pass: the same fixture workflow reaches passing verification with either required runner |
| AT-14 | pass. `tests/acceptance/at-14-opencode.test.ts` drives a real git fixture, a real `LocalProcessSandbox`, and a real stub process to passing deterministic verification. |
| AT-15 | pass. `tests/acceptance/at-15-claude-code.test.ts` is byte-identical to AT-14 apart from the runner name. No workflow change was needed. |
| AT-37 | pass. `tests/acceptance/at-37-skills.test.ts` builds two real git fixtures and proves discovery across all three formats, the recorded origin, the name conflict naming BOTH paths, and the skill lines reaching the real Implementer prompt. |
| Every earlier acceptance test | still passes |
| Whole-suite reruns | the whole verification ran green twice, as the Phase 9 rule requires |
| External audit (OpenCode, DeepSeek v4 Pro) | 3 findings, no finding in 7 of 10 categories. The controller validated all three. Two were repaired, one was validated as pre-existing and carried. |
| Whole-branch review | exit condition met. One blocker, this file. Three findings, all repaired. |
| Controller verification | found one REAL failure the agents missed. See below. |

Evidence: `docs/build/evidence/phase-11-verify.txt`, last line `exit=0`. Audit transcript: `docs/build/evidence/phase-11-audit.txt`.

**Both required runners of SDD section 33 now exist and are registered.** A stock repository configuration can finally review and validate. The Phase 10 limitation is closed.

**The failure the controller's own verification found, that every agent missed.**

`tests/acceptance/phase-08-exit.test.ts` was a latent race, and it failed once. The test waits for the second review, signals a stop, and then races the workflow terminal path. Under CPU contention the workflow wins, and the Run ends `FAILED` rather than `CANCELLED`. **The contention came from the controller running a fix agent and a verification at the same time. That was a controller process error, and the flake was already there.** The test now holds the `publish` activity, so the stop lands deterministically. The fix was proved by five clean runs and one run under deliberate load.

**The true control flow of that rig was not what the controller assumed.** That rig uses the real `review` activity, so the worktree SHA check of `publish` always fails against the fixed harness constant. The Run never reaches `publishProofPack`. The gate is therefore `heldPublishes`, not `heldProofPacks`. **Verify a control flow before you gate on it.**

## Read this before Phase 12

**Both runners share one base, and the base holds every behaviour that is not the command line.** `CliAgentRunner` in `src/adapters/runners/cli-agent-runner.ts` holds the poll loop, the timeout budget, the cancel path, `activeSession`, the summary redaction, and the session bookkeeping. A subclass supplies only `startCommand`, `resumeCommand`, and `parseOutput`. **A new runner belongs there, and it must not reimplement the loop.**

**The Claude Code prompt travels on standard input, and the script is a fixed string.** `printf %s "$FACTOREE_PROMPT" | "$FACTOREE_CLAUDE_BIN" ...` never interpolates a runtime value, so no prompt content is ever re-parsed by the shell. **Never build that script by concatenation. A prompt with a backtick or `$( )` would then execute.**

**The runner name is `claude`, not `claude-code`.** SDD section 15 sets that name as the stock validator and reviewer.

**Runner registration lives in one factory.** `buildAgentRunnerRegistry` in `src/adapters/runners/registry.ts` is used by `src/bin/worker.ts` AND by the exit test, so the test proves real registration. **An earlier version of that test read `worker.ts` as text and would have passed with an empty registry.**

**Skill discovery is two modules, and the split matters.** `src/domain/runs/skill-discovery.ts` is pure and holds the parse, the precedence, the conflict report, and the rendering. `src/domain/runs/skill-source.ts` holds every read, and every read goes through `Sandbox.exec`. **`resolveSkills` does NOT re-order its input. `discoverSkills` owns precedence order, so a change there silently changes which skill wins.**

**The skill cap applies in precedence order, then sorts for display.** An earlier version sorted first and capped second, so an organization skill sorting early displaced a repository skill sorting late. **A cap that runs before the ordering it claims to honour is a silent contradiction.**

**A name conflict is reported even when the cap dropped it.** The line for a dropped name says the limit dropped every one of them and that Factoree applies none. **A conflict nobody is told about is the silent overwrite SDD section 16 forbids.**

**A skill file is read with `head -c 65536`, not `cat`.** Only the frontmatter is ever used, and up to 1,200 reads are possible. A test asserts on the command that reaches the sandbox, so an unbounded read cannot return silently.

**Skills reach the Implementer only.** SDD section 34 lists them. SDD sections 38 and 40 do not. **Do not widen the Reviewer or the User Validator input.**

## Human decisions

None required so far. Every decision was taken by the controller and is recorded in the phase plans, the commit history, or the lists below.

Phase 4 through Phase 10 decisions still stand. Decisions added in Phase 11:

1. **The organization skills repository is a Project column, not a `.factoree/config.yaml` key.** SDD section 57 ranks the repository file below the Project, so a repository must not name its own organization skills source.
2. **It is checked out read-only into `${workspacePath}/organization-skills`,** outside the `reference/` tree, so it can never collide with a reference repository name and never appears in the reference path list.
3. **It is checked out at the Project default branch, not a pinned SHA.** No discovery step resolves a SHA for it.
4. **A name conflict keeps every skill and applies exactly one.** The applied skill and every shadowed skill reach the prompt by name, path, and scope.
5. **Precedence is repository before organization, then `.agents`, `.claude`, `.codex`, then directory name ascending.**
6. **The prompt carries the skill name, the description, and the origin. It never carries the body.** A body can reach tens of kilobytes and would push the goal out of the prompt.
7. **Skills reach the Implementer only.**
8. **An unknown runner name fails the Run at preparation, as `CONFIGURATION_INVALID`.** The sandbox is released on that path, and a test asserts the destroy count.
9. **`CliAgentRunner` is an extraction, not a rewrite.** Every pre-existing runner test passed unchanged, which is the proof.
10. **A skill read failure is logged at debug level on every non-zero exit.** Classifying a failure by its stderr text is fragile across `ls` and `head` implementations, and a wrong guess warns on every ordinary miss.
11. **The Phase 8 exit test flake was fixed although it is outside Phase 11 scope.** A racing acceptance test makes every future phase verification unreliable.

## Carried findings for later phases

Reviewed, judged not reachable or not in scope now, deliberately not fixed. Every Phase 4 through Phase 10 entry that Phase 11 did not close still stands.

**Closed by Phase 11:**

- A stock repository configuration could not review or validate. Both required runners are now registered.

**New in Phase 11:**

- **The organization skills checkout discards its computed `baseSha`, and it is pinned to a branch rather than a SHA.** SDD section 55 asks for the repository, the SHA, and the path. Two Runs a day apart can therefore read different skills with no record of the difference. `checkoutOrganizationSkills` already RETURNS the SHA, so recording it is a one-field change once a provenance sink exists.
- **`head -c N -- path` is verified on this machine only.** The local sandbox uses the host binary. The Fly Sprites base image is unverified, and a BusyBox `head` handles `--` less certainly. **Phase 12 must confirm it on the real image.**
- **`OpenCodeRunner.resumeCommand` puts the session id in argv, while `ClaudeCodeRunner` keeps it in the environment.** A session id is not a credential, so this breaches no SDD section. The branch created a standard it applies to one runner only.
- **`CliAgentRunner.sessions` is never pruned.** It grows without bound in the number of Runs, for the life of the worker process. Only a restart clears it. This is PRE-EXISTING, inherited verbatim from the Phase 2 runner, and disposal needs a signal that a Run has ended. **Phase 12 hardening owns it.**
- **The fixture drive of AT-14 and AT-15 is a hand-assembled path, not the Temporal workflow.** The workflow is runner-agnostic structurally, because it only forwards a string, but no test drives a full `agentRunWorkflow` Run with `claude`. **Phase 12 can close that gap for real.**
- **A skill description is attacker-controlled text that reaches the Implementer prompt.** Newline collapse and a 300-character cap stop a forged extra prompt line. In-line instruction text still reaches the model, mitigated only by the SDD section 57 precedence notice. Known and accepted, not solved.

**Still open from earlier phases, highest priority:**

- **The SDD section 46 hash assertion compares two diff texts that two different git binaries produce.** Phase 12 should log the git version on both sides.
- **Three routes from a real defect to a passing review remain, all by design.**
- **The worktree fingerprint misses an ignored path and anything under `.git/`.** Phase 12 hardening owns it.
- **Everything else carried from Phase 10 and earlier still stands,** including the Phase 6 redaction gap for human-authored goal text at every persistence boundary, the Linear evidence storage that has never run against a live account, and every Phase 12 live-proof item.

## Blockers

None.

Live Linear, GitHub, Fly Sprites, and Temporal Cloud credentials are needed for the Phase 12 live acceptance test.

## Environment notes

- Node 24 LTS is at `/opt/homebrew/opt/node@24/bin`. The Homebrew `node` 25 binary on this machine is broken, so prefix PATH with the Node 24 path.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`. **Never write a file through a `cat` heredoc, and never build a commit message with `git commit -m "$(cat <<EOF ...)"`.** Use `git commit -F` with a file.
- **`npx prisma generate` needs `DATABASE_URL`.** Any value works. Use `DATABASE_URL="postgresql://u:p@localhost:5432/db" npx prisma generate`.
- `timeout` and `gtimeout` are not installed.
- Docker is required for the integration and workflow suites.
- **`npm run verify` takes longer than a two-minute foreground tool call.** Run it in stages in the background and poll the output file. **Compute a real aggregate exit code across the stages.**
- **A pipeline hides the exit code of the command before it.** Redirect to a file and read `$?` on its own line.
- **NEVER run a test suite while another suite runs.** Phase 11 lost a whole verification cycle this way. The contention exposed a latent race in `phase-08-exit`, and two separate agents hit CPU-starvation flakes. **Serialize every suite run.**
- **`pkill -f "<pattern>"` also kills the waiting shell whose command line contains that pattern.** Match on the script path alone.
- **Run the whole-repository `npm run lint` and `npm run typecheck` yourself at every task gate.**
- The acceptance tests run under `vitest.integration.config.ts`, not under a config of their own.
- **Run every suite more than once before you believe a green result.**
- Phase 11 added one migration, `20260901120000_add_organization_skills`.
- **`opencode` is installed. The OpenCode-brokered account hit an "Insufficient balance" error during the Phase 11 audit.** A direct `deepseek` provider is also authenticated. Use `deepseek/deepseek-v4-pro`. **Run `opencode models` first, because the provider prefix has changed twice.** Pass the prompt as the message argument, not with `-f`.
- An OpenCode run can be killed by a session interrupt. Start it detached with `nohup` if it must survive.
