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
- `npx prisma generate` needs a DATABASE_URL. Any value works.
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
