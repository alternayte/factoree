# Build handover

This file records where the build stopped. `decisions.md` is the authoritative record of decisions. `docs/factoree-sdd.md` is the design, and the specs in `docs/specs/` amend it. SDD §67 defines done. `BUILD.md` is the session prompt.

## Next step

Start W-6 on branch `hardening/review-fixes`: map each Action Policy action to its mechanism, and turn off repository MCP and settings for the agent CLIs.

## Work queue

| ID | Status | Item | Depends on | Evidence |
|---|---|---|---|---|
| W-1 | DONE | `just verify` on the docs branch, then merge it into `main`. | — | Unit 1264 passed and 7 skipped, integration 285, workflow 101. |
| W-2 | DONE | Safety fixes: R-5, R-6, R-7, R-8, R-12, and rule 3 of the refiner gate (stop an L3 Run before implementation when an assertion is manual). | W-1 | `f96aa0f`, `aca8700`, and the R-8/R-12 commit. DI-14.1 to DI-14.4. Unit 1270, integration 286, workflow 103. |
| W-3 | DONE | Build `docs/specs/check-isolation.md`. | W-1 | DI-14.5 to DI-14.7, B-2. `prepareCheckSandbox` tests in `tests/unit/prepare-sandbox-activity.test.ts`, AT-16 check sprite assertions. The draft PR for a marked patch lands with W-4. Unit, integration 286 and workflow pass. |
| W-4 | DONE | Build `docs/specs/autonomy-levels.md`, plus R-4 (the Product owns the network allow list). | W-1 | DI-14.8 to DI-14.11. `tests/workflow/autonomy-levels.test.ts`, the route, risk, delegation, Proof Pack and runtime-config tests. `just verify` exit 0: unit 1285, integration 286, workflow 109. |
| W-5 | DONE | Build `docs/specs/refiner-agent.md`. | W-3, W-4 | DI-14.12 to DI-14.15. `tests/unit/refiner-proposal.test.ts`, `tests/unit/propose-refinement-activity.test.ts`, `tests/workflow/refiner.workflow.test.ts`. The flaky target-selection wait is fixed. `just verify` exit 0: unit 1296, integration 286, workflow 112. |
| W-6 | IN_PROGRESS | Action Policy (R-3): a mechanism for each action, or remove the action. Turn off repository MCP and settings files for the agent CLIs. | W-1 | |
| W-7 | OPEN | Remove the Change Set leftovers (H-4). | W-1 | |
| W-8 | OPEN | Preview exposure on Fly (H-2), then the §66 live proof (B-1). | W-3, W-5 | |

## State at the last commit

- Status: SDD §69 phases 1 to 12 are complete, and the two specs in `docs/specs/` are built except Change Sets (AT-44, AT-45). Version 1 is not done: 88 of the 99 §67 items pass, and the 11 "Live proof" items are `BLOCKED_EXTERNAL` (B-1).
- Last verified run: `just verify` exit 0 on `hardening/review-fixes` after W-5 (2026-10-29). Unit 1296 passed and 7 skipped, integration 286, workflow 112.
- The repository has the remote `origin`. No phase has pushed to it. Ask the human before a push.

## Open work

Each item names the SDD section that it affects. The adversarial review of 2026-10-29 found R-1 to R-12 and H-1 to H-5, in order of severity. The Phase 12 review found H-6 to H-11. Each R item is confirmed in the code.

- R-1 §35, §40, §44, §68 (decided: `docs/specs/check-isolation.md`): verification, user validation, review and patch capture run in the Sprite after the Implementer, as the same user. `SPRITE_BASE_ENVIRONMENT.PATH` in `fly-sprite-sandbox.ts` starts with directories the agent can write. A shim for `git`, `npm` or the runner CLI fakes every later check and the captured patch. Capture the patch with an absolute git path and a minimal environment first, then run the checks in a fresh Sprite or a restored checkpoint with base SHA plus that patch.
- R-2 §27, §28, AT-41 (decided: `docs/specs/autonomy-levels.md`): the autonomy level is stored and never read. An L0 pending Product, and an L2 risk-capped issue, both get a full L3 Run and a non-draft PR. `Product.status` is never read at routing. Branch on the level after refinement (L0 stop after context, L1 after verify, L2 draft PR) and refuse a pending Product.
- R-3 §29, §58: `ActionPolicy.assertAllowed` has no caller. Staging, production and merge rules reach the prompt only, and `src/prompts/implementer.ts` tells the model that Factoree enforces them. Reference repositories are read-only through `chmod`, which the owner can undo. The agent CLIs read the repository `.mcp.json`, `.claude/` and `opencode.json`, so a repository can add MCP servers. Map each action to a mechanism or delete it, and remove the false prompt sentence.
- R-4 §29: `.factoree/config.yaml` sets `sandbox.allowedDomains`, and `HOST_NAME` in `src/domain/runs/sandbox.ts` accepts `*.com`. A merged agent PR can widen egress for every later Run. Keep the allow list on the Product and let the repository only narrow it.
- R-5 §52: `SANDBOX_ADAPTER=local` turns on `allowUnenforcedNetwork` in `src/bin/worker.ts`, and `.env.example` ships `local`. The agent then runs as the worker user and can read the worker environment (App private key, secret key, admin token). The `.env.example` placeholders for `ADMIN_API_TOKEN` and `FACTOREE_SECRET_KEY` pass validation.
- R-6 §52: `GitRepositoryReader.credentialSources` is one map per worker, keyed by origin. All GitHub repositories share one origin, so two tenants that resolve context at the same time mint tokens for each other's installation. The mirror cache is keyed by URL only. Pass the installation per call and key the mirror by tenant.
- R-7 §52, AT-52: `app-token-provider.ts` mints installation tokens without `repositories`. The clone token reads, and the publish token writes, every repository of the installation. `putGitHubInstallation` moves an installation to another tenant without a check.
- R-8 §68: the completion invariant reads workflow locals that the control flow already forces, and it runs after the PR and the Proof Pack exist. `refined.status === "needs_input"` with no question hits `break` and continues to implement. Check persisted rows before `publishProofPack`, and fail on the empty question list.
- R-9 §35, §68 (covered by `docs/specs/check-isolation.md`): the tree that verification tested is not bound to the tree that is published. The validator and the preview run in the primary worktree after verify. Return `worktreeFingerprint` from verify, and require the review before-tree to equal it.
- R-10 AT-35: implement, validate and review use `maximumAttempts: 1`. A worker crash gives a heartbeat timeout that fails the Run with INTERNAL_ERROR, and the CLI process in the Sprite keeps running.
- R-11 §46 (covered by `docs/specs/check-isolation.md`): `trusted-checkout.ts` passes `...process.env` to git on the worker, so the App key, the secret key and the admin token reach git and its helpers. Pass `PATH`, a temporary `HOME`, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`.
- R-12 §49: two `throw new Error` paths in the workflow re-throw a non-`ApplicationFailure`, so Temporal retries the workflow task for ever while the row says FAILED. Terminal writes do not run in `CancellationScope.nonCancellable`.

- H-1 §8, §24, §56 (decided: `docs/specs/refiner-agent.md`): refinement, conflict detection and the Validation Contract builder are deterministic (DI-4.1, DI-4.7, DI-6.2). A ticket without acceptance criteria produces questions, not criteria, and an assertion that no rule classifies becomes `manual`, which ends an L3 Run `VALIDATION_MANUAL_REQUIRED` (DI-6.4, DI-7.5). §56 names six prompt files. Three exist, as TypeScript in `src/prompts/`.
- H-2 §31, §37: `FlySpriteSandbox.exposeService` throws (DI-2.9). On the production sandbox every browser and HTTP assertion is `BLOCKED`, so an L3 Run with such an assertion cannot reach `READY_FOR_HUMAN`. Prove `ServiceRequest.httpPort` and `sprite.url` against a live Sprite, or run the preview client inside the Sprite.
- H-3 §48: SDD §48 lists 18 states. The code adds `BLOCKED_ROUTING`, `BLOCKED_TARGET` and `BLOCKED_STALE_SET` from `docs/specs/multi-repo-tenancy.md` §17, and AT-39 and AT-43 use them. §48 and §49 do not.
- H-4 §4, §71: Change Sets are Version 2 (H-A2). Remove `RunTarget.role` and `RunTarget.mergeOrder`, and the target-set branches of `src/domain/routing/select-targets.ts` that serve more than one target.
- H-5 §42, §67: DI-3.9 makes every repair a fresh Implementer run. The §67 item "Implementer can resume for repair" is marked PASS in the old audit. `AgentRunner.resume` exists in the interface, and the workflow does not use it.
- H-6 §33: `CliAgentRunner.sessions` is worker-local. On two workers, `completeRun` can run on worker B, and `releaseRun` frees nothing on worker A. Pin a session to its worker, or move session state out of the process.
- H-7 §50: the timeout is checked between stages only. With `IMPLEMENT_MARGIN_MS` of five minutes an agent can run about five minutes past the deadline.
- H-8 §40: a Reviewer that commits and then resets to the original `HEAD`, and deletes its branch, defeats the git-state fingerprint. A reflog read closes it. The guard has no false-positive test.
- H-9 §50: `releaseRun` runs after the durable write in `completeRun`. An `updateStatus` throw keeps the sessions until a retry succeeds.
- H-10 §57: a skill description is attacker-controlled text in the Implementer prompt. Newline collapse and a 300-character cap stop a forged prompt line. In-line instruction text still reaches the model.
- H-11 §60: human-authored goal text is not redacted at every persistence boundary. `LinearEvidenceStorage` has never run against a live account. `head -c N -- path` is not verified on the Fly Sprites base image.

- H-12 §10, §62: the SDD names OpenTelemetry and OTLP. The code uses `prom-client`. No token or cost metric exists, and no runner gets a model, turn or spend limit.
- H-13 §12: no LICENSE, README, Dockerfile or deploy manifest exists. `package.json` is private, and the justfile hardcodes a Homebrew Node path.
- H-14 §10 of `docs/specs/multi-repo-tenancy.md`: `DelegationService` passes `repositoryProposal: null`, so a Product with more than one repository always asks a human for the target.

## Do not change

- `failRun` and `cancelRun` cancel the Implementer before `completeRun`, and `completeRun` calls `releaseRun` (DI-12.3). Do not reorder them.
- `worktreeFingerprint` returns the tree SHA that `publishing.activities` compares to `patch.treeSha` (DI-12.4). Do not change its return value.
- `CATEGORY_BY_REASON` is a total `Record` (DI-12.1). Classify a new failure reason. Do not make the type partial.
- The ESLint ignore list is narrow. Do not widen `tests/live/*.mjs` to `**/*.mjs`.
- The workflow never calls `destroySandbox`. The Sprite reaper deletes Sprites after retention. `harness.destroyed` is never populated, so do not assert on it.

## Known test behaviour

- The integration suite drives a real Chromium. Run `npx playwright install chromium` once per machine, as CI does.
- Never run two suites at the same time. Another project's testcontainers on the same Docker daemon can reset the shared PostgreSQL connection (`read ECONNRESET`), so rerun the stage alone before you debug it. Docker and Temporal test servers compete, and a whole verification run was lost this way.
- `vitest.integration.config.ts` runs `tests/integration` and `tests/acceptance` with one PostgreSQL container per run. `global-setup.ts` migrates a template database, and each test gets a copy.
- `vitest.workflow.config.ts` bundles the two workflows once in `global-setup.ts`. The workflow suite takes about 140 s.
- `waitFor` in `tests/workflow/support/harness.ts` takes an optional `describe` callback. On a timeout it reports the poll count and the last observed value.
- `npx prisma generate` needs a `DATABASE_URL`. Any value works.
- A pipeline hides the exit code of the command before it. `just verify` runs each stage alone and returns a real aggregate exit code.

## Laptop flow

- Node 24 LTS. `.nvmrc` names 24. The justfile puts `/opt/homebrew/opt/node@24/bin` first on `PATH`.
- `just install`, `just up`, `just migrate`, `just temporal`, then `just worker` and `just api` in their own terminals.
- `docs/quickstart.md` runs one live local Run. `docs/live-acceptance.md` holds the three live profiles (`local`, `sprite`, `full`). Only `full` is §66 proof.

## Test layout

- Unit: `tests/unit`, no Docker.
- Integration and acceptance: `tests/integration` and `tests/acceptance`, PostgreSQL in testcontainers. `tests/acceptance/at-NN-*.test.ts` covers SDD §64 test AT-NN. `phase-NN-exit.test.ts` covers the exit condition of SDD §69 phase NN.
- Workflow: `tests/workflow`, the Temporal test environment.
- Live: `tests/live`, run by `npm run acceptance:live` only.
- Shared doubles: `tests/support`.

## How to run checks

- `just verify` is the gate: lint, typecheck, unit, build, integration and workflow, one stage at a time. `npm run verify` stops at the first failing stage.
- CI: `.github/workflows/ci.yml` runs `npm run verify` after `npx playwright install --with-deps chromium`.
