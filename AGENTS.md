# Factoree

## What this is
Factoree is a self-hosted control plane that takes a Linear issue delegated to it, runs a coding agent in an isolated sandbox, verifies, validates and reviews the change, and publishes the exact verified patch as a GitHub pull request with a Proof Pack in Linear.
It is a Temporal worker and a Fastify API in TypeScript on Node, with PostgreSQL through Prisma.

## Run
- `just install` installs the packages and generates the Prisma client. `just up` starts PostgreSQL. `just migrate` applies the migrations.
- `just temporal` starts the Temporal dev server. `just worker` and `just api` build and start the worker and the API with `.env`.
- `just stubs` starts the local Backstage and MCP stubs. `just tunnel` exposes the API for Linear and GitHub webhooks.
- `docs/quickstart.md` runs one live Run end to end.

## Test
- `just verify` is the gate: lint, typecheck, unit, build, integration and workflow, each stage alone, with an aggregate exit code. CI runs `npm run verify`.
- `npm test` runs `tests/unit`. `npm run test:integration` runs `tests/integration` and `tests/acceptance` against PostgreSQL in testcontainers. `npm run test:workflow` runs `tests/workflow` in the Temporal test environment. Docker must run.
- Never run two suites at the same time.
- `just live`, `just live-sprite` and `just live-local` run `tests/live` against real services. Only `just live` is SDD §66 proof. A missing credential exits 78 with BLOCKED_EXTERNAL.
- A test file named `at-NN-*` covers acceptance test AT-NN of SDD §64.

## Stack rules
- Node 24 LTS and npm, not Bun. SDD §11 forbids Bun for Temporal workers.
- `docs/factoree-sdd.md` is the authoritative design. Do not edit it. A spec in `docs/specs/` amends it and names the sections it amends.
- `docs/build/decisions.md` records each decision the SDD leaves open as a DI or B entry. Code comments cite SDD sections and DI IDs. `docs/build/handover.md` records the build state and open work.
- The source is split by layer, as SDD §63 fixes: `src/domain`, `src/activities`, `src/workflows`, `src/adapters`, `src/persistence/prisma`, `src/http`.
- Provider SDKs live in `src/adapters` only. ESLint refuses them in `src/domain` and `src/workflows`.
- Code in `src/workflows` must stay deterministic for Temporal replay. Side effects go in `src/activities`.
- Imports use the `~/` alias for `src`. `npm run build` rewrites it with tsc-alias.
- `npx prisma generate` needs a FACTOREE_DATABASE_URL. Any value works.
- An agent claim is never evidence. Factoree runs the checks and decides from the artefacts.

## Domain words
- tenant: one Linear workspace.
- product: the business unit. It owns secrets, context sources, autonomy, risk caps and policy. One Linear team maps to one product.
- repository: one GitHub repository of a product. It registers itself through its .factoree/config.yaml, found by the GitHub App.
- work item: a Linear issue delegated to Factoree.
- run: one Factoree execution for one work item. It is one Temporal workflow.
- run target: a repository that a run changes, with its base SHA, patch hash and pull request.
- refiner: the fresh agent role that proposes criteria and checks as data before the contracts freeze. Avoid: refinement agent, planner.
- context contract: the frozen set of context items, each with source, version, authority and reason.
- context conflict: two context items that disagree. Authority resolves it, or a human answers.
- validation contract: the frozen, hashed assertions that define success, built before implementation.
- implementer, user validator, reviewer: the three agent roles. The validator and the reviewer always start fresh.
- action policy: the permissions of an agent session, by role and by product.
- autonomy level: L0 to L4, the workflow automation level of a run.
- risk cap: the highest autonomy level that a Linear label allows in a product. Avoid: risk ceiling, label limit.
- repair: an implementer attempt after a failed check. One budget covers the run.
- verified patch: the staged diff against the base SHA whose SHA-256 publication must reproduce.
- proof pack: the final delivery record posted to Linear.
- work sprite: the sprite where the implementer runs for the whole run. Avoid: run sprite.
- check sprite: a new sprite per attempt, built from the base SHA plus the captured patch, where verification, user validation and review run. Avoid: verification sandbox, second sprite.
- pull request preview: the live copy of the published commit that the repository CI hosts. It is a link for humans and never evidence. Avoid: Kiln preview, review app, preview environment.
- visual evidence: the screenshots, video and trace that Factoree captures from a browser assertion in the check sprite. Avoid: demo, visual proof.
- self-check: the implementer's own browser checks in the work sprite. Its output never reaches the proof pack. Avoid: implementer evidence, implementer demo.
- warm snapshot: the Kiln snapshot of one repository, taken after the clone and the bootstrap and before any agent runs. A run and its check sprites fork from it. Avoid: golden sprite, cache sprite.
- bootstrap key: the SHA-256 of the bootstrap command, the warm command and the effective bootstrap allow list. It keys a warm snapshot. Avoid: config SHA, snapshot key.
- build-ahead: the workflow that builds a new warm snapshot when the bootstrap key changes, before any run needs it. Avoid: prebuild, snapshot refresh, pre-warm.
- warm command: the optional repository command that runs only when Factoree takes a warm snapshot. Avoid: prebuild command, setup command.
- skill registry: an external service that holds reviewed, versioned skills and resolves a set to pinned versions. Skael is one. Avoid: skill store, skill catalog.
- skill resolution: the pinned list of skill names, versions and digests that one run uses, named by its resolution id. Avoid: skill snapshot, skill lock.
- skill proposal: a draft skill the implementer writes in a run, sent to a person for review and never applied by Factoree. Avoid: skill submission, learned skill.
- follow-up run: a new run that a human reply starts in the agent session of a failed run. It refines again with the reply as a decision, with a new work sprite and repair budget. Avoid: retry, rerun, restart.
- unstable assertion: an assertion whose re-run in the same check sprite gives a different result. It is neither passed nor failed and starts no repair. Avoid: flaky test, intermittent assertion.
- sandbox image: the OCI image that sandbox/Dockerfile builds, with the toolchain and the root-owned runner CLIs, pinned by digest. Avoid: base image, sprite image, golden image.
- Kiln template: the Kiln build of the sandbox image at one sandbox size, named by the image digest and the size. A warm snapshot belongs to one Kiln template. Avoid: template image, sandbox template.
- determined proposal: a proposal backed by a rule or a cited source that a reviewer can check. Factoree takes it without asking. Avoid: recommended default, auto-accept, best guess.
- implied criterion: a criterion no ticket sentence states, but one cited sentence directly implies. It freezes with an implied-by source. Avoid: inferred criterion, assumed criterion.
- new criterion: a criterion that adds behaviour no ticket sentence implies. Factoree drops it and lists it under Not built. Avoid: extra criterion, scope creep.
- hung session: an agent session that writes no output for the silence limit. Factoree stops it and tries once more. Avoid: stuck agent, frozen session, stalled run.
- silence limit: the time with no new process output after which a session is hung. Avoid: idle timeout, hang timeout.
- install: one Factoree deployment, with its database, API and worker. It holds one or more tenants. Avoid: instance, deployment.
- install settings: the settings for the whole install, stored in the database, such as the GitHub App, the sandbox provider and the git author. Avoid: global settings, system config.
- setup token: the one-time token the API logs on first start. Only it opens /setup. Avoid: bootstrap token, admin token.
- setup run: the background workflow that writes, proves and proposes the .factoree/config.yaml of one repository as a pull request. Avoid: onboarding, repository init, auto-config.
- setup agent: the fresh agent role in a setup run. It writes .factoree/** only. Avoid: onboarding agent, config agent.
- setup report: the result of a setup run per part, proven or failed with its reason, and each denied or observed host. Avoid: setup log, setup summary.
- fake: a compose service in .factoree/compose.yaml, labelled factoree.fake, that answers for an external API. Avoid: mock, stub.
- account: a named sign-in identity in the config that the seed creates and Factoree signs in once per check sprite. Avoid: test user, login.
- ecosystem host list: the fixed list of package and toolchain hosts in Factoree's code that a setup sandbox can reach. Avoid: install hosts, default allow list.
- app change: a change to the app code that a setup part needs and the setup agent may not make, named in the setup report. Avoid: required change, code change request.
- app-change issue: a Linear issue that Factoree creates and delegates from one app change of a merged setup, or from all of them. Avoid: follow-up issue, setup issue.
- setup input key: the SHA-256 of the default-branch head SHA and the rendered setup prompt. A setup whose key matches the newest unchanged setup skips its session. Avoid: setup hash, input fingerprint, cache key.
- skipped setup: a setup that ends unchanged with no agent session, because its setup input key matches. It copies the report of the setup it matched. Avoid: cached setup, no-op setup.
- setup history: the page per repository that lists every setup run with its time, cost and report. Avoid: setup log, setup runs page.
- host credential: a product credential for one private host, a registry login or a header, that the sandbox provider adds to requests outside the guest. Avoid: registry login, registry secret, private registry credential.
- sandbox provider: one entry in the install settings, a Kiln host, an E2B account or a Sprites account, with its own live sandbox limit, size and priority. Avoid: sandbox backend, sandbox host.
- spillover: a run that starts on a lower-priority sandbox provider because every better one is full. Avoid: overflow, failover, load balancing.
- held slot: a live sandbox slot that a run reserves on its sandbox provider at start, for its peak of three sandboxes. Avoid: reservation, slot hold.
- cloud runner: a runner whose agent runs outside Factoree's sandboxes, such as cursor-cloud, so Factoree takes its branch into the work sprite to capture the patch. Avoid: remote runner, hosted agent.
- unenforced egress: the product switch that lets a cloud runner serve the implementer, whose egress Factoree cannot limit. Avoid: open egress, egress bypass.
- change set: a run whose targets are two or more repositories of one product, published as linked pull requests. Avoid: multi-repo run, linked runs.
- provider and consumer: in a change set, the target whose interface changes, and the target that calls it, linked by a cited edge. Avoid: upstream, downstream.
- set snapshot: a warm snapshot that holds every target of one set, keyed by the sorted list of repository and bootstrap key. Avoid: combined snapshot, product snapshot.
- wired pair: a provider and a consumer whose consumer fake names the provider repository, so they run together in the check sprite. Avoid: linked services, integration pair.
- in-between check: the check of each consumer at its base against the provider patches, the state between the two merges. Avoid: compatibility check, partial-merge test.
- retro agent: the fresh agent role that reads the ended runs of a tenant's products on a schedule and proposes findings. Avoid: review agent, improvement agent, meta agent.
- retro: one pass of the retro agent, run as its own workflow outside any run. Avoid: retrospective run, improvement pass, analysis run.
- retro finding: one proposed improvement that targets one product and cites its runs, and that becomes a Linear issue only when a human creates it. Avoid: insight, recommendation, lesson.
- retro goal: the optional product text that tells the retro agent what to improve first. Only the retro agent reads it. Avoid: product goal, factory goal, mandate.
- kept transcript: the redacted, gzipped full output and tool inputs of one agent session, stored only when the product turns it on. Avoid: session log, trace, full log.
- PR reviewer: an external review app that a product names by app slug and check name. Its check on the PR head gates an L4 merge, and its failure starts a PR follow-up run. Avoid: PR bot, review bot, external reviewer.
- PR follow-up run: a follow-up run that targets an existing PR branch, started by a failed PR reviewer check, a human request-changes review or a base conflict, and that pushes a new verified commit. Avoid: PR repair, autofix, PR fix.
- PR workflow: the workflow that publication starts per published PR, which takes the review, check, conflict, merge and deploy events after the run ends. Avoid: PR watcher, PR monitor.
- finding triage: the fresh reviewer session that keeps only PR reviewer findings with a concrete defect, a rule and evidence, and answers each dropped finding on the PR. Avoid: finding filter, comment triage.
