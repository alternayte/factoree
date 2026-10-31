# Factoree architecture

## TL;DR
A human delegates a Linear issue to Factoree. Factoree refines it, runs a coding agent in an isolated sandbox, checks the change in a second clean sandbox, and opens a GitHub pull request with a Proof Pack in Linear. Factoree decides from evidence it captures itself, never from an agent's claim.

## Flow
```
Linear issue ──delegate──▶ API ──start──▶ Workflow engine ──▶ Worker
                                                   │
   route → refine → context → work sandbox → refiner → contract → implementer
        → check sandbox: verify → user validation → review → publish → Proof Pack
```

## Components
| Component | Role | Today |
|---|---|---|
| Issue tracker | Intake, questions, progress, Proof Pack. One team is one product. | Linear agent app |
| Code host | Repositories, pull requests, webhooks. Each repository registers itself with `.factoree/config.yaml`. | GitHub App |
| API | Receives webhooks, starts runs, serves the admin API. | Fastify |
| Workflow engine | Runs each run as one durable workflow, with retries and timers. | Temporal |
| Worker | Runs the workflow steps: sandbox control, publication, the browser for evidence. | Node worker |
| Database | Tenants, products, repositories, runs, contracts, evidence, decisions. | PostgreSQL |
| Sandbox provider | Isolated VMs with an egress allow list, detached processes, a published port, and snapshots. | Kiln or Fly Sprites |
| Sandbox image | The toolchain and the root-owned agent CLIs. Kiln only. | `sandbox/Dockerfile` on ghcr.io |
| Agent CLI and model | The refiner, implementer, validator and reviewer sessions. | opencode with DeepSeek |
| Browser | Captures screenshots and video of the check sandbox's preview. | Playwright on the worker |
| Evidence storage | Holds screenshots, logs and `proof-pack.json`. | Linear uploads |
| Context sources | Extra context for the context contract. Optional. | Backstage, MCP |
| Pull request preview | A live copy of the pull request for humans. It is never evidence. Optional, in the repository's CI. | Kiln preview action |

## What you need to run it
- PostgreSQL, a Temporal service, the API and the worker.
- A Linear workspace with the Factoree agent app installed, and a GitHub App installed on the repositories.
- A public URL for the API, so Linear and GitHub can send webhooks.
- A sandbox provider account. For Kiln, a tenant key and the sandbox image digest.
- A model provider key, stored as a product secret of kind `runner_credential`.
- In each repository: `.factoree/config.yaml` with the product, the bootstrap command, the checks, the egress allow list, and an optional preview command.

`docs/quickstart.md` runs one run end to end. `.env.example` lists every setting.

## Is Factoree a software factory?
A software factory turns a stream of work items into verified, shippable changes, with humans at the edges instead of in the loop.

Factoree has the core of one:
- Intake from the issue tracker, with routing to a product and a repository.
- Refinement into a frozen, checkable contract before any code changes.
- Isolated, parallel execution. Runs do not block each other.
- Independent verification, user validation and review in a clean sandbox.
- Evidence, not claims: the Proof Pack and `proof-pack.json`.
- Policy: autonomy levels, risk caps, the action policy and egress control.
- Few touch points. Factoree takes its own determined proposals and asks only when it cannot decide.

What it does not have yet:
- **Delivery past the pull request.** No merge, no deploy, no rollback. L4 is reserved.
- **Feedback from production.** Factoree does not see merges, reverts or incidents, so it cannot learn or raise autonomy from a track record.
- **Throughput control.** No queue, no concurrency limit per product, and no sandbox or cost budget.
- **Cost and quality metrics.** No token or spend tracking, no model limits per run, no success-rate dashboards (H-12).
- **Recovery from a hung agent.** A silent agent CLI waits until the run budget ends (H-17).
- **Keeping pull requests current.** No automatic rebase when the base branch moves after publication.
- **Changes across repositories.** One run changes one repository. Change sets are Version 2.
- **Its own deployment.** No release image or deploy manifest for Factoree itself (H-13).

Today Factoree is a verified pull request factory. Delivery, production feedback and throughput control would make it a full software factory.
