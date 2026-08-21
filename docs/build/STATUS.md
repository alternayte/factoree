# Factoree build status

## Specification

- Source of truth: `docs/sdd.md`
- Version: 2.0
- SHA-256: `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`

## Phases

- Completed: Phase 1 — Control plane
- Current: none
- Next: Phase 2 — Sandbox and first runner

## Git

- Branch: `main`
- Commit: `f8aee01`
- Phase 1 range: `d5a7716..f8aee01`, 13 commits

## Phase 1 verification

The controller ran every check below itself. Agent claims were not accepted as evidence.

| Check | Result |
| --- | --- |
| `npm run verify` in the working tree | exit 0 |
| `npm run verify` from a clean clone, as CI runs it | exit 0: 57 unit, 21 integration, 6 workflow |
| AT-01 delegation | pass: one delegation creates one Run; a duplicate delivery identifier and a new delivery identifier for the same session both create no second Run; a wrong signature returns 401 |
| AT-33 tenant isolation | pass: projects, secrets, and runs are unreachable across tenants; the tenant column is proved from `information_schema` |
| AT-35 worker restart | pass: the workflow resumes and reaches COMPLETED with no duplicate Run |
| AT-32 redaction (log part only) | pass: configured secrets, authorization headers, and a bearer token in free text never reach a log line |
| Task reviews | 9 of 9 clean |
| Final whole-branch review | clean after one fix wave of 15 items |
| External audit (OpenCode, DeepSeek reasoner) | complete; converged on the same findings, none unique |

Evidence: `docs/build/evidence/phase-01-verify.txt`.

Phase 1 exit condition met: one Linear delegation creates one durable Run.

## Human decisions

None required so far. Every decision was taken by the controller and is recorded in the phase plan or the commit history.

Decisions worth knowing before Phase 2:

1. The Phase 1 workflow performs the real receive step, acknowledges the Linear session, then holds the Run open for a stop signal, human input, or the maximum Run duration. Phase 4 replaces the wait with the refinement and delivery steps.
2. Prisma 7 with the `@prisma/adapter-pg` driver adapter and `prisma.config.ts`. Always obtain a client through `createPrismaClient`.
3. Project secrets and Linear tokens use AES-256-GCM with the envelope `v1.<iv>.<tag>.<ciphertext>`.
4. `PUT /admin/linear-installations` exists beyond the SDD section 59 list, because no Linear call can be authorized without an installation record. The OAuth flow arrives later.

## Carried findings for Phase 2

Reviewed, judged not reachable in Phase 1, deliberately not fixed:

- Nothing wires `SecretStore` values into `Redactor.addSecret`. Only the three environment secrets are registered. This is the load-bearing half of SDD section 60 and MUST be closed in Phase 2, before any agent output is captured.
- `Redactor.addSecret` ignores values under six characters, and the token patterns require a minimum length.
- The ESLint provider-SDK import ban covers `src/domain/**` and `src/workflows/**`, not `src/activities/**`.
- `metrics` has no refinement, context, implementation, verification, validation, or review duration counters yet. Their steps do not exist.
- `src/bin/worker.ts` and `src/bin/api.ts` have never run against a live Temporal server or a live Linear workspace. SDD section 66 places that proof in Phase 12.

## Blockers

None.

Live Linear, GitHub, Fly, and Temporal Cloud credentials are needed for the Phase 12 live acceptance test. They are not needed for Phase 2.

## Environment notes

- Node 24 LTS is at `/opt/homebrew/opt/node@24/bin`. The Homebrew `node` 25 binary on this machine is broken, so prefix PATH with the Node 24 path.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`.
- Docker is required for the integration and workflow suites.
- The Prisma CLI resolves `DATABASE_URL` eagerly, so every CLI call needs a value. CI sets a placeholder.
