# Factoree architecture

## TL;DR
A human delegates a Linear issue to Factoree. Factoree refines it, runs a coding agent in an isolated sandbox, checks the change in a second clean sandbox, and opens a GitHub pull request with a Proof Pack in Linear. Factoree decides from evidence it captures itself, never from an agent's claim.

## Flow
```
Linear issue ──delegate──▶ API ──start──▶ Workflow engine ──▶ Worker
                                                   │
   route → refine → context → queue → work sandbox → refiner → contract → implementer
        → check sandbox: verify → user validation → review → publish → Proof Pack
```

## Components
| Component | Role | Today |
|---|---|---|
| Issue tracker | Intake, questions, progress, Proof Pack. One team is one product. | Linear agent app |
| Code host | Repositories, pull requests, webhooks. Each repository registers itself with `.factoree/config.yaml`. | GitHub App |
| API | Receives webhooks, starts runs, serves setup, the admin API and the operator UI. | Fastify |
| Operator UI | Setup of a new install, and the install, workspace, product and API key settings. Sign-in with Linear. Served by the API from the same origin. | Vite React SPA, better-auth |
| Workflow engine | Runs each run as one durable workflow, with retries and timers. | Temporal |
| Worker | Runs the workflow steps: sandbox control, publication, the browser for evidence. | Node worker |
| Database | Tenants, products, repositories, runs, contracts, evidence, decisions, and the install and product settings. Every stored credential is encrypted with `FACTOREE_MASTER_KEY`. | PostgreSQL |
| Sandbox provider | Isolated VMs with an egress allow list, detached processes, a published port, and snapshots. | Kiln, E2B or Fly Sprites |
| Sandbox image | The toolchain and the root-owned agent CLIs. Kiln and E2B only. Each release pins its digest, and the install settings can override it. | `sandbox/Dockerfile` on ghcr.io |
| Release | One image with `api`, `worker` and `migrate`, a Compose file, a Helm chart, and release notes from the CHANGELOG, all from one `v*.*.*` tag. `GET /version` names the build. | `ghcr.io/alternayte/factoree` |
| Agent CLI and model | The refiner, implementer, validator and reviewer sessions. | opencode with DeepSeek |
| Browser | Captures screenshots and video of the check sandbox's preview. | Playwright on the worker |
| Evidence storage | Holds screenshots, logs and `proof-pack.json`. | Linear uploads |
| Context sources | Extra context for the context contract. Optional. | Backstage, MCP |
| Pull request preview | A live copy of the pull request for humans. It is never evidence. Optional, in the repository's CI. | Kiln preview action |

## What you need to run it
- PostgreSQL, a Temporal service, the API and the worker.
- The environment holds infrastructure only: `FACTOREE_DATABASE_URL`, `FACTOREE_MASTER_KEY`, the `FACTOREE_TEMPORAL_*` values, `FACTOREE_PUBLIC_URL`, `FACTOREE_PORT` and `FACTOREE_LOG_LEVEL`.
- A public URL for the API, so browsers, Linear and GitHub reach it.
- A Linear workspace, a GitHub account or organization, a sandbox provider account (Kiln, E2B or Fly Sprites), and a model provider key.
- `deploy/compose/compose.yml` runs all four on one machine. The Helm chart in `deploy/helm/factoree` runs the API and the worker against your PostgreSQL and Temporal.
- Setup in the UI at `/setup`, with the one-time token from the API log, creates the GitHub App, installs the Linear app, installs the GitHub App on the repositories, stores the sandbox provider and creates the first product. The settings screens change these values later, with no restart.
- In each repository: `.factoree/config.yaml` with the product, the bootstrap command, the checks, the egress allow list, and an optional preview command.

## Throughput control
- A product runs at most `maxConcurrentRuns` runs past the gate before PREPARING. A run over the limit waits in `QUEUED`, starts in delegation order, and shows `Queued: N runs ahead.` in Linear. The slot is the run row itself: a terminal status frees it (DI-15.13).
- The install setting `sandboxMaxLive` caps the live sandboxes of the provider. A lease row counts each sandbox from before its create until its delete. At the limit Factoree deletes its oldest retained sandbox, or the run waits within its budget (DI-15.14).

`README.md` installs a release. `docs/quickstart.md` runs one run end to end from a checkout. `.env.example` lists every environment value.

## Is Factoree a software factory?
A software factory turns a stream of work items into verified, shippable changes, with humans at the edges instead of in the loop.

Factoree has the core of one:
- Intake from the issue tracker, with routing to a product and a repository.
- Refinement into a frozen, checkable contract before any code changes.
- Isolated, parallel execution. Runs do not block each other, within the product's concurrency limit and the sandbox limit.
- Recovery from a hung agent session: one more try, then `AGENT_HUNG`.
- Independent verification, user validation and review in a clean sandbox.
- Evidence, not claims: the Proof Pack and `proof-pack.json`.
- Policy: autonomy levels, risk caps, the action policy and egress control.
- Few touch points. Factoree takes its own determined proposals and asks only when it cannot decide.

What it does not have yet:
- **Delivery past the pull request.** No merge, no deploy, no rollback. L4 is reserved.
- **Feedback from production.** Factoree does not see merges, reverts or incidents, so it cannot learn or raise autonomy from a track record.
- **A spend budget.** The product caps concurrent runs, and the install caps live sandboxes. No run has a token or cost limit.
- **Quality metrics.** Each agent session records its tokens and cost, and the proof pack shows them. No success-rate dashboard exists (H-12).
- **Keeping pull requests current.** No automatic rebase when the base branch moves after publication.
- **Changes across repositories.** One run changes one repository. Change sets are Version 2.

Today Factoree is a verified pull request factory with throughput control. Delivery and production feedback would make it a full software factory.
