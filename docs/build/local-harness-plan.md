# Local harness and live acceptance enablement plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Historical note (env cleanup):** this plan created `.env.local.example` and `.env.sprite.example`. A later cleanup deleted both files. Every value below now lives in the single `.env.example`, in the Group B section. Read `docs/live-acceptance.md` for the current procedure.

**Goal:** Give an operator a one-command local path that runs the real `tests/live/scenario.ts` against local infrastructure, so the first Fly Sprite run is not also the first execution of that code.

**Architecture:** A `justfile` drives every step. `docker-compose.yml` runs PostgreSQL only, because the installed `temporal` CLI already ships a dev server. Two tiny Fastify stubs stand in for the Backstage catalog and the MCP source. `tests/live` gains a PROFILE: `local` uses local infrastructure and the local sandbox, `full` demands every SDD section 66 dependency. The two profiles never share a pass count.

**Tech Stack:** TypeScript with ESM, Node 24, Fastify, Temporal CLI dev server, Docker Compose, `just`.

**Spec:** `docs/sdd.md` version 2.0. Read sections 31, 65, 66, 67, and 72. The SDD is immutable and authoritative.

## The rule that governs this whole plan

**A local run does NOT satisfy SDD section 66 and must never be reported as if it does.**

SDD section 66 names a real Fly Sprite, a real Temporal service, and a real Linear workspace. The `local` profile substitutes the sandbox and two context sources. It therefore proves that the scenario CODE works. It proves nothing about SDD section 66.

Every local run must print that it is not SDD section 66 proof. The `full` profile must keep its current behaviour exactly: it demands all 14 `LIVE_` values and exits 78 with `BLOCKED_EXTERNAL` when one is absent. **Do not weaken the `full` profile to make the `local` profile convenient.**

## Global Constraints

- The SDD is immutable. Do not edit `docs/sdd.md`.
- All prose follows ASD-STE100: active voice; no contractions; no `-ing` outside a technical name; no `should`/`may`/`might`/`would`/`could`; 20 words maximum procedural and 25 descriptive; one instruction per sentence; no `e.g.`/`i.e.`/`etc.`; no parentheses that add information; no dash joining two clauses.
- Node 24 is at `/opt/homebrew/opt/node@24/bin`. Prefix `PATH` in every shell command.
- The shell alias `cat` is a broken `bat`. Use `/bin/cat`. Never write a file through a `cat` heredoc. Use the Write tool.
- Never run two test suites at the same time.
- The unit skip count is exactly 7 and must stay 7.
- The import alias is `~/` for `src/`.
- `npm run verify` must stay free of every live and local-live command. CI runs `verify` and holds no credential.

## Installed tooling, already verified on this machine

`just` 1.58.0, `temporal` 1.4.1 with Server 1.28.0, Docker 27.3.1 with Compose v2.30.3, `opencode` 1.18.18, `gh` 2.88.1 authenticated as `alternayte`.

**Do not add a dependency that duplicates one of these.**

## File structure

| File | Responsibility |
| --- | --- |
| `justfile` (create) | Every operator command. The single entry point. |
| `docker-compose.yml` (create) | PostgreSQL only. Temporal runs from the CLI dev server. |
| `.env.example` Group B (superseded plan; originally created as a separate file) | The local profile values. Distinct from `.env.example`. |
| `tools/local/backstage-stub.ts` (create) | A Fastify server answering the Backstage catalog shape the adapter reads. |
| `tools/local/mcp-stub.ts` (create) | A Fastify server answering the MCP shape the adapter reads. |
| `tests/live/profile.ts` (create) | The profile type, the per-profile credential list, and the banner text. |
| `tests/live/required-credentials.ts` (modify) | Splits its list by profile. The `full` list keeps all 14. |
| `tests/live/acceptance-live.ts` (modify) | Reads the profile. Prints the banner. Keeps exit 78 for `full`. |
| `package.json` (modify) | Adds `acceptance:live:local`. |
| `docs/live-acceptance.md` (modify) | Real per-provider setup steps, and the local path. |
| `tests/unit/live-profile.test.ts` (create) | Proves the `full` profile is not weakened. |

---

### Task 1: The profile split

**Files:**
- Create: `tests/live/profile.ts`
- Modify: `tests/live/required-credentials.ts`
- Test: `tests/unit/live-profile.test.ts`

**Interfaces:**
- Produces: `LiveProfile = "local" | "full"`, `resolveProfile(env): LiveProfile`, `credentialsFor(profile): LiveCredential[]`, `PROFILE_BANNER: Record<LiveProfile, string>`.

This task is spec-critical. It touches SDD section 66 compliance.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/live-profile.test.ts`. It must prove, at minimum:

1. `credentialsFor("full")` returns EXACTLY the current 14 entries of `REQUIRED_LIVE_CREDENTIALS`, with the same names. **This is the anti-weakening guard.** Assert the length and the sorted name list against a literal array written into the test, so a future edit that drops one fails here.
2. `credentialsFor("local")` omits every Fly credential and every Temporal Cloud credential, and still requires the real Linear and GitHub values.
3. `resolveProfile({})` returns `"full"`. **The default must be the strict profile.** A missing variable must never silently downgrade the proof.
4. `resolveProfile({ FACTOREE_LIVE_PROFILE: "local" })` returns `"local"`.
5. `resolveProfile({ FACTOREE_LIVE_PROFILE: "nonsense" })` throws. An unknown profile must fail loudly.
6. `PROFILE_BANNER.local` contains the exact string `NOT SDD SECTION 66 PROOF`.
7. `PROFILE_BANNER.full` does not contain that string.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/live-profile.test.ts`
Expected: FAIL, because `tests/live/profile.ts` does not resolve.

- [ ] **Step 3: Implement**

Create `tests/live/profile.ts`. Keep `REQUIRED_LIVE_CREDENTIALS` in `required-credentials.ts` as the `full` list, unchanged. Derive the `local` list from it by dependency, so a new `full` credential cannot be forgotten:

- The `local` profile drops every credential whose `dependency` is `fly-sprites`.
- The `local` profile replaces the `temporal` credentials with local endpoint values.
- The `local` profile replaces the `backstage` and `mcp` credentials with local endpoint values.
- The `local` profile KEEPS `linear`, `github`, and `runner` unchanged, because those are real in both profiles.

Write the banner text in ASD-STE100. The local banner must state plainly that the run uses local infrastructure, that it proves the scenario code, and that it is NOT SDD section 66 proof.

- [ ] **Step 4: Run the test and confirm it passes**

- [ ] **Step 5: Run lint, typecheck, and the whole unit suite**

The skip count must stay 7.

- [ ] **Step 6: Commit**

```bash
git add tests/live/profile.ts tests/live/required-credentials.ts tests/unit/live-profile.test.ts
git commit -m "feat(live): split the live acceptance credential list by profile"
```

---

### Task 2: The entry point reads the profile

**Files:**
- Modify: `tests/live/acceptance-live.ts`
- Modify: `package.json`
- Test: extend `tests/unit/required-credentials.test.ts`

- [ ] **Step 1: Extend the existing test**

Read `tests/unit/required-credentials.test.ts` first. Extend it so it proves:
- The `full` profile still reports every absent credential and still drives the exit-78 path.
- The documentation test still passes: every `full` credential name appears in `.env.example` AND `docs/live-acceptance.md`.
- Every `local` credential name appears in `.env.example`. This assertion is superseded; the env cleanup consolidated every example file into one.

- [ ] **Step 2: Implement the entry point change**

In `tests/live/acceptance-live.ts`:
- Resolve the profile FIRST.
- Print the banner for that profile BEFORE anything else.
- Check the credentials of THAT profile.
- Keep exit 78 and the `BLOCKED_EXTERNAL` print for a missing credential in EITHER profile.
- On a successful `local` run, print the local banner AGAIN at the end, so a reader who scrolled past the header still sees it.

**Do not change the `full` path's behaviour in any other way.**

- [ ] **Step 3: Add the script**

In `package.json`, beside `acceptance:live`:

```json
"acceptance:live:local": "FACTOREE_LIVE_PROFILE=local npm run acceptance:live",
```

Verify the environment variable really reaches the entry point through that indirection. If it does not on this shell, write the full node command out instead.

Neither script joins `npm run verify`.

- [ ] **Step 4: Run the tests, then lint and typecheck**

- [ ] **Step 5: Commit**

---

### Task 3: Local infrastructure

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example` (superseded; later consolidated)
- Create: `tools/local/backstage-stub.ts`
- Create: `tools/local/mcp-stub.ts`

- [ ] **Step 1: Read the adapters before you write a stub**

Read `src/adapters/backstage/` and `src/adapters/mcp/` in full. **The stub must answer the exact shape the real adapter parses.** Write down the endpoint paths and the response shapes in your report. Do not guess a shape.

- [ ] **Step 2: Write `docker-compose.yml`**

PostgreSQL only. Use the same major version the Prisma schema targets. Expose 5432. Name the volume so `docker volume prune` does not silently destroy it. Do NOT add Temporal, because the installed CLI ships a dev server.

- [ ] **Step 3: Write the two stubs**

Use Fastify, which is already a dependency. Each stub takes its port from an environment variable with a default. Each serves one fixture entity that the local scenario resolves. Keep each file under 80 lines.

- [x] **Step 4: Write the local values (superseded; consolidated into .env.example)**

Every `local` profile credential name from Task 1, with a working default for each local endpoint. The real Linear, GitHub, and runner values stay blank, because the operator supplies them.

- [ ] **Step 5: Start each piece by hand and confirm it answers**

Run the compose file. Run each stub. Curl each endpoint. Record the real output in your report. Do not claim a stub works without showing its response.

- [ ] **Step 6: Commit**

---

### Task 4: The justfile

**Files:**
- Create: `justfile`

- [ ] **Step 1: Write the recipes**

At minimum:

- `just` with no argument lists the recipes.
- `just install` runs `npm ci` then `prisma generate`.
- `just up` starts compose and waits for PostgreSQL to accept a connection.
- `just down` stops compose. It must NOT delete the volume without an explicit `just nuke`.
- `just temporal` starts the Temporal dev server in the foreground.
- `just stubs` starts both stubs.
- `just migrate` applies the Prisma migrations.
- `just worker` starts the worker with the local environment.
- `just api` starts the HTTP API.
- `just verify` runs the full non-live verification, in stages, with a real aggregate exit code. **Never two suites at once.**
- `just live-local` runs `acceptance:live:local`.
- `just live` runs `acceptance:live`.
- `just nuke` stops compose and deletes the volume. Print a warning first.

Every recipe that needs Node must prefix `PATH` with `/opt/homebrew/opt/node@24/bin`.

- [ ] **Step 2: Run every recipe that is safe to run, and record the real output**

Run `just`, `just install`, `just up`, `just migrate`, `just stubs`, `just down`. Record real output. Do NOT run `just nuke`.

- [ ] **Step 3: Commit**

---

### Task 5: The documentation rewrite

**Files:**
- Modify: `docs/live-acceptance.md`

- [ ] **Step 1: Rewrite it**

It must hold two clearly separated paths.

**Path A, the local run.** State what it proves and what it does not. State plainly that it is not SDD section 66 proof. Give the exact command sequence with `just`. State that only a Linear account and a GitHub account are needed, and that both have a free plan.

**Path B, the SDD section 66 run.** Per-provider setup, one numbered list each, for Linear, GitHub, Fly, Temporal, the runner, Backstage, and MCP. For each, state what to create, which value to copy, and which `LIVE_` variable receives it. State which providers charge money.

Keep the existing credential table. The unit test asserts every `full` credential name appears in this file.

Write every sentence in ASD-STE100. Start each instruction with the command verb.

- [ ] **Step 2: Run the credential documentation test**

- [ ] **Step 3: Commit**

---

## What this plan does NOT do

It does not run the local scenario to a pass. That is the next step, and it is iterative debugging, not a plannable task list. `tests/live/scenario.ts` has never executed, so expect real defects.

It does not satisfy SDD section 66. Only a real Fly Sprite run does that.
