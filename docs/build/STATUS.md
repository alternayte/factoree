# Factoree build status

## Specification

- Source of truth: `docs/sdd.md`
- Version: 2.0
- SHA-256: `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`

## Phases

- Completed: none
- Current: Phase 1 — Control plane
- Next: Phase 2 — Sandbox and first runner

## Git

- Branch: `main`
- Commit: none yet

## Phase 1 verification

| Check | Result |
| --- | --- |
| `npm run verify` | not run |
| AT-01 delegation | not run |
| AT-33 tenant isolation | not run |
| AT-35 worker restart | not run |
| AT-32 log redaction (partial) | not run |
| External audit (OpenCode, DeepSeek) | not run |

## Human decisions

- None recorded.

## Blockers

- None. Live Linear, GitHub, Fly, and Temporal Cloud credentials are needed for the Phase 12 live acceptance test, not for Phase 1.

## Environment notes

- Node 24 LTS is installed at `/opt/homebrew/opt/node@24/bin`. The Homebrew `node` 25 binary is broken on this machine, so prefix PATH with the Node 24 path.
- The shell alias `cat` points at `bat`, which is also broken. Use `/bin/cat`.
- Docker is available for Testcontainers.
