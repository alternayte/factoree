# Factoree build status

## Specification

- Source of truth: `docs/sdd.md`
- Version: 2.0
- SHA-256: `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`

## Phases

- Completed: Phase 1 — Control plane; Phase 2 — Sandbox and first runner; Phase 3 — Deterministic verification; Phase 4 — Refinement and Context Contract; Phase 5 — Backstage and MCP
- Current: none
- Next: Phase 6 — Validation Contract

## Git

- Branch: `main`
- Phase 5 range: `048b8eb..2c50160`, 22 commits. 20 on `phase-05-backstage-mcp`, then the no-fast-forward merge and this record.
- The repository has no remote. Each phase merges into local `main` with a no-fast-forward commit.

## Phase 5 verification

The controller ran every check below itself. Agent claims were not accepted as evidence.

| Check | Result |
| --- | --- |
| `npm run verify` on the branch head `4331671` | exit 0, run in stages so no part could be cut short: lint 0, typecheck 0, unit 621 passed and 7 skipped, integration and acceptance 110, workflow 38, build 0 |
| `npm run verify` on `main` after the merge | exit 0: 621 unit passed and 7 skipped, 110 integration and acceptance, 38 workflow, build succeeded |
| Skip count | 7, the same as the Phase 2, 3, and 4 baseline. Phase 5 skipped no test. |
| Phase 5 exit condition | pass: a fixture dependency is discovered from the Backstage catalog with complete provenance, and the repository the catalog names is pinned to an explicit SHA |
| AT-04 Backstage discovery | pass: the consumed API reaches the contract with the topology reason, the catalog etag as its source version, and the SDD section 18 API-relation priority |
| AT-36 MCP source | pass against a real HTTP JSON-RPC server, and a tool the Project did not allow-list is refused while the Run still resolves |
| Every Phase 4 acceptance test | still passes unchanged |
| Task reviews | 10 of 10 clean, after 5 fix rounds in total |
| Final whole-branch review | 4 Important and 1 raised deferred finding, all fixed and re-reviewed clean |
| External audit (OpenCode, DeepSeek reasoner) | 8 of 10 categories clean, 5 findings. Every one validated by the controller against the code, all 5 fixed, plus 1 pre-merge item the re-review raised. |

Evidence: `docs/build/evidence/phase-05-verify.txt`, last line `exit=0`.

## Read this before Phase 6

**The context sources of a Run are built per Run, not once per worker.** `ContextResolver` has no constructor argument. `resolve(input)` receives `sources: ContextSourceRegistry` and `contextConfiguration` in its input. `ConfiguredContextSourceProvider` builds the registry from the `ContextSourceConfiguration` rows of the Project, plus the fixed Linear and repository sources. The worker holds one factory per kind.

**Backstage needs two switches.** An administrator configures the endpoint through `POST /admin/projects/:id/context-sources`, and the primary repository sets `context.backstage.enabled: true`. Either alone leaves the source unregistered. An MCP source needs only the row, because SDD section 15 defines no repository switch for it.

**`.factoree/config.yaml` is now read twice.** Discovery reads it at the pinned primary SHA on the control plane, for the `context` block only, and a failed read yields the defaults rather than a fault. `SandboxManager` still reads it inside the sandbox and still fails the Run under SDD section 15. Do not add a second enforcement point at discovery.

**Discovery can now add a reference repository.** With `context.referenceRepositories.automaticDiscovery: true`, a repository the Backstage catalog names becomes a real reference repository of the Run, pinned to an explicit SHA by a second discovery pass, capped at three, and accepted only on the host of the Project.

**Every MCP tool call passes the Action Policy.** `ActionPolicy.decideMcpTool(name)` denies a tool unless the Project allow-lists it by exact name, and `assertMcpTool` throws `McpToolDeniedError`. `McpJsonRpcClient` trusts its caller and checks nothing, so any new caller must assert the policy itself.

**The SDD section 28 autonomy cap is live.** The workflow reads the Work Item labels from the Linear API before refinement. A failed read keeps the webhook labels, posts a plain progress message to Linear saying the cap could not be applied, and lets the Run continue at its Project level.

**There is still no success terminal state.** A Run whose verification passes falls into the residual wait and ends `FAILED` with `RUN_TIMEOUT`. The next state of SDD section 49 is `USER_VALIDATING`, and Phase 7 builds it.

**The Validation Contract still does not exist.** SDD section 49 places it between context resolution and sandbox preparation, and Phase 6 builds it. The workflow goes straight from `RESOLVING_CONTEXT` to `PREPARING` today.

## Human decisions

None required so far. Every decision was taken by the controller and is recorded in the phase plans, the commit history, or the lists below.

Phase 4 decisions still stand. Decisions added in Phase 5:

1. **A context source is configured per Project, so the source list is built per Run.** SDD section 53 requires the entity and SDD section 59 gives it three endpoints under one Project. A registry built once at worker start cannot hold a per-Project endpoint or credential.
2. **The `context` block is read at the pinned primary SHA, on the control plane.** SDD section 49 puts discovery before the sandbox exists. This carries out the Phase 4 plan decision that Phase 4 did not build.
3. **A failed discovery-time read of that file is not fatal.** SDD section 15 is enforced against the real checkout at `PREPARING`. A second enforcement point would fail a Run twice for one fault, and a transient read fault would stop a Run whose file is valid.
4. **Backstage needs an administrator endpoint and a repository opt in.** SDD section 19 says "When configured".
5. **Every Backstage candidate carries `declarative_catalog`.** That class sits in the `system_topology` domain, so the catalog can never win against an accepted ADR or against source code, which is what SDD section 19 requires. An API entity does not carry `machine_readable_contract`.
6. **Backstage discovery is one hop from the entity of the primary repository, with a hard entity cap.** SDD section 18 forbids organization-wide unbounded retrieval.
7. **A Backstage repository location becomes a real reference repository, not a note.** SDD section 20 requires an explicit SHA, so a discovered repository goes through the same repository source.
8. **A discovered repository is accepted only on the host of the Project,** because the workflow rebuilds every clone URL from `repositoryBaseUrl` and a slug. A repository elsewhere stays a recorded item.
9. **The MCP client is a small hand-written JSON-RPC client, not a new dependency.** SDD section 10 names "MCP client" and names no library.
10. **The Action Policy gained an MCP tool decision, and the SDD section 29 action table is unchanged.** SDD section 29 enumerates sandbox actions; SDD section 58 adds a separate rule. A tool name is matched exactly, so a wildcard grants nothing.
11. **The MCP authority class is configured and validated against the SDD section 22 list.** The default is `prose_documentation`.
12. **Work Item labels are read in an activity, not in the webhook handler.** The handler must stay fast, and an activity runs under the Temporal retry policy.
13. **A Backstage or MCP failure degrades the Run; it never fails it.** Neither source is required for a Run to proceed, and both are remote.
14. **`McpToolDeniedError` is a second error type on purpose.** `ActionDeniedError` is typed to the closed `AgentAction` enum and cannot carry a tool name without weakening it.
15. **A response body from either remote is capped at four mebibytes,** enforced by `Content-Length` and again while streaming. A timeout bounds duration, not size.

## Carried findings for later phases

Reviewed, judged not reachable or not in scope now, deliberately not fixed. Every Phase 4 entry that Phase 5 did not close still stands; the ones Phase 5 closed are removed.

**Closed by Phase 5:** the dead autonomy cap; `context.backstage.enabled`; `context.referenceRepositories.automaticDiscovery`; the unbuilt `ContextSourceConfiguration`.

**New in Phase 5, for the phase that revisits discovery:**

- The guarded second discovery pass uses a bare `catch { continue; }`. It treats a transient reader fault like a deterministic one, would swallow a cancellation on that path, and gives a human no signal that a Backstage-named repository was dropped. Controller decision 13 permits the degrade.
- `readRepositoryContextConfiguration` swallows every failure with no log line, so an operator cannot tell a genuine `enabled: false` from a transient git fault.
- `BackstageContextSource.discover` wraps the whole walk in a blanket catch, so a programming error in candidate construction reads as an empty catalog.
- `onHost` treats an entity with no repository URL as a host match, so a null-URL entity earlier in a catalog answer can beat a real host match. Catalog answer order is undefined.
- The first-pass duplicate survivor is the source-registry-order occurrence, not the higher-priority one. Both states previously failed the Run, so this is strictly better.
- `findByRepositorySlug` keeps a default for its host parameter, so a direct client call can omit it. The port requires both.
- Only a Component carries a repository location. An API or a Resource that names one is not found by the slug lookup.
- `getByRef` answers null for a malformed reference, which reads the same as not found.
- Under a `file://` fixture URL, `hostOf` answers `""` on both sides, so the exit test's host check passes trivially. The negative side keeps real coverage in the unit tests.

**New in Phase 5, for the phase that owns the administration API:**

- `PrismaContextSourceConfigurationStore.put` does not check that the tenant owns the project. It mirrors the existing `ProjectSecret` store, and every read is still tenant-scoped.
- The tenant-resolution block repeats three times in the new routes, as it does in `projects.routes.ts`.
- The route dependencies are an inline object literal, not a named interface.
- `BackstageCatalogClient` composes `endpoint + path`, so an endpoint with a query string would produce a malformed URL. `put` now forbids storing one, but a directly constructed client is still exposed.

**New in Phase 5, for the phase that owns MCP:**

- A fetch-time policy denial and an unknown reference are distinguishable only by message text.
- `parseContextSourceSettings` always adds `discoverTool` and `fetchTool` to `allowedTools`, so the production denial path is reachable only through hand-built settings. This is controller decision 10 working as intended.
- The `notifications/initialized` response body is now cancelled, but the client still reads no answer from it.

**Everything else carried from Phase 4 and earlier still stands,** including: the conflict-model wording and `supersedes`; the discovery findings on `isDeterministicRemoteFailure`, the streamed `listTree` error, `checkoutHosts`, and an unknown `sizeBytes`; `WorkItem.constraints` reaching no consumer; the `Redactor` four-character floor and the evidence tenant guard; the Phase 2 adapter map, `baselineCheckpointId`, the `injectIntoImplementer` reset, `AgentRunInput` lacking `projectId`, and the unused `reapExpiredSandboxes`; the Phase 6 evidence-activity split and the `Evidence.kind` cast; the Phase 7 stop-during-verification and `CLEAN_SHELL_ENV` items; the Phase 11 model-provider credential; and every Phase 12 live-proof item.

## Blockers

None.

Live Linear, GitHub, Fly Sprites, and Temporal Cloud credentials are needed for the Phase 12 live acceptance test. They are not needed for Phase 6.

## Environment notes

- Node 24 LTS is at `/opt/homebrew/opt/node@24/bin`. The Homebrew `node` 25 binary on this machine is broken, so prefix PATH with the Node 24 path.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`. **Never write a file through a `cat` heredoc, and never build a commit message with `git commit -m "$(cat <<EOF ...)"`.** Use `git commit -F` with a file.
- `node` and `npx` print a `dyld: Library not loaded: libllhttp.9.3.dylib` warning from `libgit2`. It is noise, but it can kill a command silently.
- `timeout` and `gtimeout` are not installed.
- Docker is required for the integration and workflow suites.
- **`npm run verify` takes longer than a two-minute foreground tool call.** Run it in stages, or in the background and poll it. A background run that a harness timeout kills reports nothing, so read the real output before you believe a result.
- The acceptance tests run under `vitest.integration.config.ts`, not under a config of their own.
- The Prisma CLI resolves `DATABASE_URL` eagerly, so every CLI call needs a value. Every migration so far was written by hand and applied through the Testcontainers database.
- **The Phase 5 migration is safe against a populated database.** `20260824120000_add_context_source_configuration` creates one new table.
- **Run the whole integration suite before calling a task complete, not one file.**
- `opencode` version 1.18.18 is installed and authenticated for DeepSeek, and was used for the external audit of Phase 4 and Phase 5.
