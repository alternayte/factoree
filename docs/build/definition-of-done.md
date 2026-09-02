# Definition of Done audit

SDD section 67 states every required item. This file records the evidence for each one.

- Specification: `docs/sdd.md` version 2.0, SHA-256 `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`.
- Audit date: 2026-08-26.
- Task 11 gate evidence: `npm run lint` exit 0, `npm run typecheck` exit 0, both over the whole repository. `tests/acceptance/phase-12-exit.test.ts` run under `vitest.integration.config.ts`, 5 tests, PASS.
- Whole-phase verification: the controller ran every verification stage separately at commit `f2c121f`, the commit that holds this audit and its exit test. The result is recorded at `docs/build/evidence/phase-12-verify.txt`, last line `exit=0`. This audit cites that file for the Build rows below.

## Build

| Item | State | Evidence |
| --- | --- | --- |
| Node.js 24 LTS is the production runtime. | PASS | `package.json` `engines.node` is `>=24 <25`. `.nvmrc` names `24`. This audit ran under Node `v24.19.0`. |
| `npm ci` succeeds. | PASS | `docs/build/evidence/phase-12-verify.txt`, the controller's `npm ci` verification at commit `df09a1f`: `npm ci` exit 0, `npx prisma generate` exit 0, `npm run build` exit 0, `npx vitest run --config vitest.config.ts` exit 0, 1051 passed and 7 skipped. The install was clean. The build and the unit suite both ran from that clean install. |
| `npm run verify` exits 0. | PASS | `docs/build/evidence/phase-12-verify.txt`, the controller's own verification at commit `f2c121f`: eslint 0, tsc 0, unit 1051 passed / 7 skipped, integration 249 passed, workflow 85 passed, build 0, aggregate `exit=0`. |
| `npm run build` exits 0. | PASS | `docs/build/evidence/phase-12-verify.txt`, the controller's own verification at commit `f2c121f`: `npm run build` exit 0. |
| No required test is skipped. | PASS | `tests/acceptance/phase-12-exit.test.ts`, test `skips no required test`, scans every `tests/acceptance/**/*.test.ts` file for `it.skip`, `describe.skip`, `test.skip`, `it.todo`, `describe.todo`, `test.todo` and asserts none exist. The Tasks 1-10 baseline unit run shows 7 skipped tests; those are outside `tests/acceptance/` and are the same 7 carried since Phase 2, named in `docs/build/STATUS.md`. |
| No required production path contains placeholder behavior. | PASS | `src/adapters/runners/cli-agent-runner.ts` holds one real HTTP/CLI poll loop shared by both runners. `src/adapters/publishing/` and `src/adapters/github/github-pull-requests.ts` make real git and GitHub calls. No `TODO`, `throw new Error("not implemented")`, or stub return exists on a path a required test exercises; `npm run lint` and `npm run typecheck` both exit 0 over the whole repository, and the unit, integration, and workflow suites of the Tasks 1-10 baseline exercise every adapter named above. |

## Linear

| Item | State | Evidence |
| --- | --- | --- |
| Delegation starts exactly one Run. | PASS | `tests/integration/at-01-delegation.test.ts`, test `creates exactly one Run for one delegation and ignores a duplicate delivery`. `tests/unit/delegation-service.test.ts`, test `does not start a second workflow for a duplicate delivery`. |
| Progress works. | PASS | `tests/unit/linear-agent-client.test.ts`, test `reports progress with a thought activity`. |
| Elicitation works. | PASS | `tests/unit/linear-agent-client.test.ts`, test `asks a question with an elicitation activity`. `tests/workflow/at-03-material-uncertainty.test.ts` and `tests/workflow/at-08-unresolvable-conflict.test.ts` drive the elicitation round trip through the workflow. |
| Stop works. | PASS | `tests/unit/delegation-service.test.ts`, test `signals stop for a stop event`. `tests/acceptance/phase-08-exit.test.ts` drives a stop signal against a running workflow to a `CANCELLED` terminal state. |
| Final Proof Pack works. | PASS | `tests/unit/linear-agent-client.test.ts`, test `sends the final result with a response activity`. `tests/acceptance/at-30-proof-pack.test.ts` proves the Proof Pack content that this activity sends. |

## Refinement

| Item | State | Evidence |
| --- | --- | --- |
| Technical refinement works on the fixture. | PASS | `tests/acceptance/at-02-refinement.test.ts`, test `enriches a vague Work Item and changes no source code`. |
| Material uncertainty stops safely. | PASS | `tests/workflow/at-03-material-uncertainty.test.ts`, tests `waits for one human input and starts no Implementer` and `fails the Run with REFINEMENT_UNRESOLVED when the rounds are spent`. |
| Refinement does not change source code. | PASS | `tests/acceptance/at-02-refinement.test.ts`, test `enriches a vague Work Item and changes no source code`, asserts the fixture repository HEAD and worktree are unchanged after refinement. |

## Context

| Item | State | Evidence |
| --- | --- | --- |
| Linear source works. | PASS | `tests/unit/linear-context-source.test.ts`, tests `offers the Work Item as a required product intent item` and `offers every recorded human decision as a required item`. |
| Primary repository source works. | PASS | `tests/unit/repository-context-source.test.ts` and `tests/unit/checkout.test.ts`, test `clones the primary repository and captures its base SHA`. |
| Reference repository source works. | PASS | `tests/acceptance/at-05-reference-repository.test.ts`, test `checks the reference out at the discovered SHA and denies a write to it`. |
| Backstage source works. | PASS | `tests/acceptance/at-04-backstage-discovery.test.ts`, test `produces the API dependency as a Context Item with a topology reason and provenance`. |
| MCP source works. | PASS | `tests/acceptance/at-36-mcp-source.test.ts`, tests `supplies one candidate with full provenance and reaches the Context Contract` and `makes exactly the two allow-listed tool calls and no other`. |
| Context Contract exists before implementation. | PASS | `tests/acceptance/phase-04-exit.test.ts`, test `freezes, persists, and publishes the Context Contract before the Implementer starts`. |
| Every Context Item has provenance. | PASS | `tests/acceptance/at-06-context-provenance.test.ts`, tests `gives every selected item complete provenance` and `fails validation when any provenance field is absent`. |
| Authority policy is deterministic. | PASS | `tests/unit/context-authority.test.ts` proves the fixed authority table. `tests/acceptance/at-07-resolvable-conflict.test.ts`, test `marks the README the lower authority and records the decision`. |
| Resolvable conflicts are recorded. | PASS | `tests/acceptance/at-07-resolvable-conflict.test.ts`, test `marks the README the lower authority and records the decision`. `tests/unit/context-conflicts.test.ts`. |
| Unresolvable material conflicts stop implementation. | PASS | `tests/workflow/at-08-unresolvable-conflict.test.ts`, tests `holds the Run in WAITING_FOR_INPUT and prepares no sandbox` and `fails the Run with CONTEXT_UNRESOLVED when the rounds are spent`. |
| Large context is referenced instead of prompt-dumped. | PASS | `tests/acceptance/at-09-context-limit.test.ts`, tests `references the large repository and its large file without preloading either` and `keeps every file body out of the initial Implementer prompt`. |

## Validation

| Item | State | Evidence |
| --- | --- | --- |
| Validation Contract exists before implementation. | PASS | `tests/acceptance/at-10-validation-created-first.test.ts`, test `freezes a contract with a creation time and a hash, and the Run row carries that hash`. |
| Every assertion has ID, method, and evidence requirements. | PASS | `tests/integration/context-contract.test.ts` and `tests/integration/validation-contract-store.test.ts`, test `stores a contract with every assertion field and reads it back`, together with `tests/integration/validation-contract-store.test.ts`, test `rejects a row whose method column holds a value the SDD does not allow`. |
| Contract hash is persisted. | PASS | `tests/acceptance/at-10-validation-created-first.test.ts`, test `freezes a contract with a creation time and a hash, and the Run row carries that hash`. |
| Active contract is immutable. | PASS | `tests/acceptance/at-11-validation-immutability.test.ts`, tests `keeps the frozen contract when a second save arrives with weaker assertions`, `keeps Run.validationContractVersion at the frozen hash`, and `gives the Implementer no port that can change the contract`. |

## Sandbox and policy

| Item | State | Evidence |
| --- | --- | --- |
| Every Run uses a unique Sprite. | PASS | `tests/unit/sandbox-manager.test.ts`, test `follows the SDD section 32 order: create, network policy, checkout, bootstrap, checkpoint`, together with `tests/acceptance/at-12-isolation.test.ts`. |
| Network policy applies before agent execution. | PASS | `tests/unit/sandbox-manager.test.ts`, test `applies the network policy before it runs any command`. `tests/acceptance/at-13-action-policy.test.ts`, test `denies every domain outside the Project allow list`. |
| Primary repository uses captured base SHA. | PASS | `tests/unit/checkout.test.ts`, test `clones the primary repository and captures its base SHA`. |
| Reference repositories use captured SHAs. | PASS | `tests/acceptance/at-05-reference-repository.test.ts`, test `checks the reference out at the discovered SHA and denies a write to it`. |
| Reference repositories are read-only. | PASS | `tests/unit/checkout.test.ts`, test `makes every reference repository read-only`. `tests/acceptance/at-05-reference-repository.test.ts`. |
| Git remote write is denied to agents. | PASS | `tests/unit/checkout.test.ts`, test `removes the push URL of the primary repository, because SDD section 29 denies git remote write`. `tests/acceptance/at-13-action-policy.test.ts`, test `stops the Implementer from pushing to a git remote`. |
| Production access is denied. | PASS | `src/domain/policy/action-policy.ts` sets `productionAccess: "deny"` in the SDD section 29 default table, with no repository-level override path. `tests/unit/action-policy.test.ts`, test `uses the SDD section 29 default table`. |
| Policy is enforced outside prompts. | PASS | `tests/unit/action-policy.test.ts`, tests `denies every tool by default` and `throws ActionDeniedError from assertAllowed for a denied action`; enforcement runs in `Sandbox.exec` and the network policy document, not in prompt text. `tests/unit/fly-sprite-network-policy.test.ts` proves the policy is a real network document applied to the Sprite, not a prompt instruction. |
| Cancellation works. | PASS | `tests/workflow/phase-12-timeout.test.ts`, test `cancels the live session, publishes nothing, and records RUN_TIMEOUT`. `tests/unit/implement-activity.test.ts`, tests `cancels the live Implementer session when Temporal cancels the activity` and `cancels the session that registers after the cancellation arrived`. `tests/acceptance/phase-08-exit.test.ts` drives an external stop to `CANCELLED`. |
| Retention cleanup works. | PASS | `tests/unit/sprite-reaper.test.ts`, tests `destroys every sandbox past its retention window` and `clears the sandbox reference on the Run, so the Proof Pack stays readable (AT-34)`. |

## Agent runners

| Item | State | Evidence |
| --- | --- | --- |
| OpenCodeRunner passes integration tests. | PASS | `tests/integration/opencode-runner-local.test.ts`; `tests/acceptance/at-14-opencode.test.ts` drives a full fixture to passing verification with the `opencode` runner. |
| ClaudeCodeRunner passes integration tests. | PASS | `tests/integration/claude-code-runner-local.test.ts`; `tests/acceptance/at-15-claude-code.test.ts` drives the byte-identical fixture to passing verification with the `claude` runner. |
| Runner selection is configuration-driven. | PASS | `tests/unit/agent-runner-registry.test.ts`, tests `accepts a configuration whose runners are all registered` and `reports every unknown runner as a configuration fault, not an internal fault`. `tests/acceptance/phase-11-exit.test.ts`, test `reaches passing verification with either required runner, through the same drive`. |
| Implementer can resume for repair. | PASS | `tests/unit/claude-code-runner.test.ts`, test `resumes the named session and keeps the identifier out of the command line`. `tests/unit/opencode-runner.test.ts`, tests `resumes a session with the opencode session flag` and `keeps the previous session entry so a retried resume can still find its sandbox`. |
| User Validator is fresh. | PASS | `tests/acceptance/at-17-fresh-user-validation.test.ts`, test `differs from the Implementer session, in the persisted rows and in the prompt text`. `tests/unit/user-validator-prompt.test.ts`, test `never states an Implementer claim or a Reviewer finding`. |
| Reviewer is fresh. | PASS | `tests/acceptance/at-21-fresh-review.test.ts`, test `differs from the Implementer session, in the persisted rows, in the prompt text, and carries the SDD section 40 input list`. `tests/unit/reviewer-input.test.ts`, test `states plainly that the session is fresh`. |

## Verification and evidence

| Item | State | Evidence |
| --- | --- | --- |
| Every deterministic command records exit code. | PASS | `tests/unit/proof-pack.test.ts`, test `reports every deterministic check with its exit code`. |
| Non-zero exit blocks publication. | PASS | `tests/acceptance/phase-03-exit.test.ts`, test `fails verification when the Implementer claims success and changes nothing`. |
| Every Validation assertion receives a result. | PASS | `tests/acceptance/at-25-evidence-completeness.test.ts`, test `an empty outcome list is not a pass; it proves nothing`, and `the persisted result rows match the reported results, against the real database`. |
| Browser assertions produce required evidence. | PASS | `tests/acceptance/at-18-ui-evidence.test.ts`, tests `produces exactly the evidence kinds the frozen assertion requires, from a real browser` and `does not pass when the required evidence is missing, even though the driver reports success`. `tests/integration/playwright-browser-driver.test.ts`. |
| HTTP assertions produce sanitized evidence. | PASS | `tests/acceptance/at-19-http-evidence.test.ts`, test `records the method, the path, the sanitized request, the status, and the result, and holds no secret`. `tests/unit/http-validation.test.ts`, test `redacts a sensitive header and a Project secret`. |
| Missing evidence blocks L3. | PASS | `tests/acceptance/at-18-ui-evidence.test.ts`, test `does not pass when the required evidence is missing, even though the driver reports success`. `tests/acceptance/at-25-evidence-completeness.test.ts`. |
| Validation repair works. | PASS | `tests/acceptance/at-20-validation-repair.test.ts`, test `passes verification twice, fails validation once, repairs, and reverifies fully`. |

## Review

| Item | State | Evidence |
| --- | --- | --- |
| Reviewer output matches schema. | PASS | `tests/unit/review-report.test.ts`, tests `parses a pass report with no finding` and `parses a fail report with one finding`. |
| Invalid Reviewer output fails safely. | PASS | `tests/unit/review-report.test.ts`, tests `refuses text that is not JSON`, `refuses a severity the SDD does not list`, and `refuses two findings that share one identifier`. `tests/acceptance/phase-08-exit.test.ts`, test `ends the Run with REVIEW_UNAVAILABLE when the Reviewer writes no report, and starts no repair`. |
| Concrete blocker/high findings block. | PASS | `tests/unit/review-blocking.test.ts`, tests `blocks a valid high finding` and `blocks a valid blocker finding`. |
| Style-only findings do not block. | PASS | `tests/unit/review-blocking.test.ts`, test `does not block a style finding at any severity`. |
| Repair works. | PASS | `tests/acceptance/phase-08-exit.test.ts`, test `blocks the defective revision, repairs it, revalidates it, and passes the second review`. |
| Repair limit is enforced. | PASS | `tests/workflow/at-24-repair-limit.test.ts`, tests `stops after two review repairs, with three implement calls and FAILED_REVIEW` and `shares the repair counter across stages: a verification repair plus two review blocks stop the third repair`. |

## Patch integrity and GitHub

| Item | State | Evidence |
| --- | --- | --- |
| Agent has no GitHub write credential. | PASS | `tests/acceptance/at-13-action-policy.test.ts`, test `AT-26: the Implementer cannot read a GitHub write credential`. `tests/acceptance/at-29-pull-request.test.ts`, test `keeps the GitHub write credential out of every log line (SDD section 60)`. |
| Verified patch hash is persisted. | PASS | `tests/unit/publishing-patch.test.ts`, test `runs the SDD section 44 command pair with --binary and hashes the decoded bytes`. `tests/unit/proof-pack.test.ts`, test `records the base SHA, the patch hash, and the repair count`. |
| Publishing uses a clean checkout. | PASS | `tests/integration/trusted-checkout.test.ts` clones a fresh checkout for publishing, separate from the sandbox worktree, and removes its temporary directory on both a successful and a refused publish. |
| Applied patch hash equals verified hash. | PASS | `tests/acceptance/phase-09-exit.test.ts`, test `case 2: a patch tampered after the hash was taken reaches no remote`. `tests/integration/trusted-checkout.test.ts`, test `applies the patch, proves the hash again, and pushes one branch (AT-27)`. |
| Stale-base protection works. | PASS | `tests/unit/publishing-stale-base.test.ts`, test `is stale when the target head moved`. `tests/acceptance/phase-09-exit.test.ts`, test `case 4: a base that moved after the Run started publishes nothing`. |
| Factoree creates branch, commit, and PR. | PASS | `tests/acceptance/at-29-pull-request.test.ts`, tests `creates exactly one pull request` and `opens the deterministic Factoree branch against the Project default branch`. |
| Factoree never merges the PR. | PASS | `src/adapters/github/github-pull-requests.ts` calls only `GET` against the pulls list endpoint and `POST` to create a pull request; no merge endpoint is called anywhere in the file. `tests/unit/github-pull-requests.test.ts` exercises only creation and lookup, never a merge call. |

## Proof Pack

| Item | State | Evidence |
| --- | --- | --- |
| Every successful L3 Run creates one Proof Pack. | PASS | `tests/acceptance/at-30-proof-pack.test.ts`, test `carries every one of the eleven AT-30 items`. |
| It maps each validation assertion to evidence. | PASS | `tests/unit/proof-pack.test.ts`, test `maps every assertion to its result and its evidence`. |
| It includes deterministic verification. | PASS | `tests/unit/proof-pack.test.ts`, test `reports every deterministic check with its exit code`. |
| It includes review outcome. | PASS | `tests/acceptance/at-30-proof-pack.test.ts`, test `reports no open blocker when the last review passed and wrote no row`. |
| It identifies important Context Items. | PASS | `tests/unit/proof-pack.test.ts`, test `writes every SDD section 47 heading exactly once and in order`, which includes the Context Items heading; `tests/acceptance/at-06-context-provenance.test.ts` proves the underlying provenance the Proof Pack renders. |
| It records resolved material Context Conflicts. | PASS | `tests/unit/proof-pack.test.ts`, test `names a resolved context conflict with its winner and its reason`. |
| It includes known limitations. | PASS | `tests/unit/proof-pack.test.ts`, tests `lists a non-blocking finding under known limitations with its decision reason` and `writes None under known limitations when no finding survived`. |
| It includes base SHA and patch hash. | PASS | `tests/unit/proof-pack.test.ts`, test `records the base SHA, the patch hash, and the repair count`. |
| It links the PR. | PASS | `tests/acceptance/at-29-pull-request.test.ts`, test `names the Work Item, the Run, the base SHA, the patch hash, and the verification summary`, and `tests/acceptance/at-30-proof-pack.test.ts` proves the Proof Pack carries that link. |

## Skills and security

| Item | State | Evidence |
| --- | --- | --- |
| `.agents/skills` discovery works. | PASS | `tests/unit/skill-source.test.ts`, test `finds a skill under .agents/skills`. |
| `.claude/skills` discovery works. | PASS | `tests/unit/skill-source.test.ts`, test `finds a skill under .claude/skills`. |
| `.codex/skills` discovery works. | PASS | `tests/unit/skill-source.test.ts`, test `finds a skill under .codex/skills`. |
| Organization skills can be configured. | PASS | `tests/integration/admin-api.test.ts`, tests `accepts and returns the organization skills repository` and `refuses an organization skills repository that is not an owner and repository slug`. |
| Skill conflicts do not silently overwrite. | PASS | `tests/unit/skill-discovery.test.ts`, tests `applies the first candidate of a name and records the rest as shadowed` and `states a name conflict, the applied path, and every ignored path`. `tests/acceptance/at-37-skills.test.ts`, test `discovers every skill of both scopes, records the origin, and names both conflicting paths`. |
| Secrets are encrypted at rest. | PASS | `tests/unit/crypto.test.ts`, tests `never stores the plaintext in the cipher text` and `produces a different cipher text for the same input`. `tests/integration/admin-api.test.ts`, test `stores a project secret as ciphertext and reads it back through the secret store`. |
| Known secrets are redacted. | PASS | `tests/unit/at-32-redaction.test.ts`, test `AT-32: a Project secret loaded from the SecretStore never reaches a log line`. `tests/unit/redaction.test.ts`. |
| Cross-tenant isolation tests pass. | PASS | `tests/integration/at-33-tenant-isolation.test.ts`, tests `keeps projects, secrets, and runs inside their own tenant`, `records the tenant on every tenant-owned row`, and `gives every other table a tenant column`. |

## Reliability and observability

| Item | State | Evidence |
| --- | --- | --- |
| Worker restart does not duplicate work. | PASS | `tests/workflow/at-35-worker-restart.test.ts`, test `does not duplicate a Run when the worker restarts during it`. |
| Infrastructure retries do not consume semantic repair budget. | PASS | `tests/workflow/phase-12-fault-injection.test.ts`, tests `retries a failing verification activity and leaves the repair count at zero` and `spends the repair budget on a failing check and not on a transport fault`. |
| Timeout works. | PASS | `tests/workflow/phase-12-timeout.test.ts`, test `cancels the live session, publishes nothing, and records RUN_TIMEOUT`. Fixed in `ebafa91`, closing a Phase 12 defect where a Run timeout never cancelled the live Implementer (SDD section 50 obligation 1). |
| Three concurrent fixture Runs complete independently. | PASS | `tests/workflow/phase-12-concurrency.test.ts`, test `completes three Runs with three separate sandboxes, patches, and pull requests`. |
| Required OpenTelemetry metrics are emitted. | PASS | `tests/acceptance/phase-12-exit.test.ts`, test `registers every metric SDD section 62 requires`, proves every required metric is registered in `src/telemetry/metrics.ts`. `tests/unit/run-activity.test.ts:65` reads `metrics.repairs.get()` and asserts a recorded value. `tests/unit/prepare-sandbox-activity.test.ts:60` reads `metrics.sandboxesDestroyed.get()` and asserts a recorded value. `tests/unit/resolve-context-activity.test.ts:86` reads `metrics.registry.getMetricsAsJSON()` and asserts on the recorded value of `factoree_context_conflicts_total`. Together these prove registration and real emission. |
| Failed Runs have normalized failure categories. | PASS | `tests/unit/failure-category.test.ts`, tests `maps every failure reason to a declared category` and `uses every declared category, so no category is dead`. `tests/acceptance/phase-12-exit.test.ts`, test `gives every failure reason a normalized category`. `tests/integration/run-repository.test.ts`, test `stores the normalized failure category beside the failure reason (SDD section 67)`. |

## Live proof

SDD section 66 defines the live acceptance test and names `BLOCKED_EXTERNAL` as a legitimate recorded state, distinct from `DONE`.

An operator supplied live credentials on 2026-09-02 and ran Factoree against a real Linear
workspace, a real Fly Sprite, and the GitHub repository `alternayte/c-dash`. One Run completed and
opened a pull request:

| Fact | Value |
| --- | --- |
| Run | `a22a5e0a-e57c-4d96-9e95-6e3c8d6287e3` |
| Temporal workflow | `linear:3645c3ea-e357-4ee6-81a7-72bec7dde863:493ef8f3-fc9e-4491-82cc-b6ef95e14773` |
| Status | `READY_FOR_HUMAN` |
| Pull request | https://github.com/alternayte/c-dash/pull/2 |
| Head branch | `factoree/run-a22a5e0a-e57c-4d96-9e95-6e3c8d6287e3` |
| Context Contract | `4fb1023f3a196b2f9c899b7b974438ae045934832dd08c5e31afe65aefd67959` |
| Agent sessions | implementer, validator, reviewer, each on `opencode` |
| Evidence rows | 4 |
| Validation results | 2, both `PASS` |
| Review findings | 1 |
| Proof Pack | posted to Linear, `proofPackPostedAt` is set |

The rows below record what that Run proves. Each one names the stored fact a reader can query.
The state of each row comes from the database of that Run and from the GitHub API, not from the
report of the scenario command.

One row stays `BLOCKED_EXTERNAL`: `npm run acceptance:live` has not exited 0. It failed on a defect
of the scenario itself, which looked for a head branch in the Proof Pack section that SDD section
47 fixes as the URL alone. The scenario now confirms the pull request by its number. Nobody has
run the command since that fix, so no row claims it passed.

| Item | State | Evidence |
| --- | --- | --- |
| `npm run acceptance:live` has passed. | BLOCKED_EXTERNAL | The command has not exited 0. It failed on a defect of `tests/live/scenario.ts`, which required a head branch in the Proof Pack `### Pull request` section, and SDD section 47 fixes that section as the URL alone. The scenario now confirms by number, and `.env` also named a placeholder repository in `LIVE_GITHUB_REPOSITORY`. Nobody has run the command since. |
| Real Linear delegation reaches Factoree. | PASS | Run `a22a5e0a` carries `linearAgentSessionId`, and its workflow id names the Linear workspace `3645c3ea-e357-4ee6-81a7-72bec7dde863`. A delegation in Linear started it. |
| Real context resolution runs. | PASS | Run `a22a5e0a` stores `contextContractVersion` `4fb1023f3a196b2f9c899b7b974438ae045934832dd08c5e31afe65aefd67959`, against the real repository `alternayte/c-dash`. |
| Real Validation Contract is frozen. | PASS | The Validation Contract of Run `a22a5e0a` holds `VAL-CMD-001` and `VAL-TEST-001`, and both carry a stored result. |
| Real Fly Sprite performs implementation. | PASS | The `AgentExecution` row of role `implementer` on runner `opencode` records the session, and the sandbox of the Run was a real Fly Sprite. The patch became the pull request below. |
| Deterministic verification runs. | PASS | Two `Evidence` rows of kind `deterministic_check`, sources `verify:type-check` and `verify:test`, both from the repository configuration of `alternayte/c-dash`. |
| User-level validation runs. | PASS | Two `ValidationAssertionResult` rows, both `PASS`, with `command-output` evidence. The `AgentExecution` row of role `validator` records the fresh session SDD section 36 requires. |
| Independent review runs. | PASS | The `AgentExecution` row of role `reviewer` records a fresh session, and one `ReviewFinding` row stores its outcome. |
| Evidence is accessible from Linear. | PASS | The Proof Pack of Run `a22a5e0a` is posted, `proofPackPostedAt` is set, and it carries the pull request URL and the verification evidence. |
| A real GitHub PR is created. | PASS | https://github.com/alternayte/c-dash/pull/2, head branch `factoree/run-a22a5e0a-e57c-4d96-9e95-6e3c8d6287e3`, head SHA `cf3e98cc538d16c50d789b620a577ba14ce7c1e9`. Confirmed through the GitHub API with `GitHubPullRequests.findByNumber`. |
| The Proof Pack is visible in Linear. | PASS | `proofPackPostedAt` of Run `a22a5e0a` is set, so Factoree posted the comment to the Linear issue of the Run. |
