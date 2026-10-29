# Factoree v1 decisions

`docs/factoree-sdd.md` is the design. A spec in `docs/specs/` amends it and names the sections it amends. This file records each decision that the SDD leaves open. Code comments cite these IDs. `DI-<phase>.<n>` is decision n of build phase `<phase>` of SDD §69. The phase plans are in the git history before this file.

## Implementation decisions

| ID | Date | Area | Decision | Reason |
|---|---|---|---|---|
| DI-1.2 | 2026-08-21 | §30 | Product secrets use AES-256-GCM with one control-plane key. | The least complex option that makes a database dump useless. |
| DI-1.3 | 2026-08-21 | §59 | `PUT /admin/linear-installations` exists beside the §59 list. | A Linear call needs an installation record before it can be authorized. |
| DI-1.6 | 2026-08-21 | §14 | `DelegationService` lives in `src/domain/runs/`. It imports Zod and workflow input types only. | §14 forbids provider SDKs in the domain. ESLint enforces the rule. |
| DI-2.1 | 2026-08-22 | §31, §33 | The `Sandbox` and `AgentRunner` ports live in `src/domain/runs/`. | Both concepts are Run-scoped. §63 names no domain folder for ports. |
| DI-2.2 | 2026-08-22 | §31 | `FlySpriteSandbox` uses the `@fly/sprites` SDK 0.2.0. | It is the vendor client and covers each §31 method except port exposure (DI-2.9). |
| DI-2.3 | 2026-08-22 | §12, §31 | `LocalProcessSandbox` is a second adapter for tests and the local harness. It does not replace `FlySpriteSandbox`. | `npm run verify` needs a sandbox with no credentials. |
| DI-2.4 | 2026-08-22 | §29 | A sandbox declares `capabilities.enforcesNetworkPolicy`. `SandboxManager` refuses to run an agent in a sandbox that does not enforce it, unless the caller passes `allowUnenforcedNetwork: true`. | The local sandbox cannot enforce egress. The flag makes that visible. |
| DI-2.5 | 2026-08-22 | §29 | The network policy ends with `{ domain: "*", action: "deny" }`. It is never empty. | Deny by default. |
| DI-2.7 | 2026-08-22 | §31, §32 | The `Sandbox` port adds `applyNetworkPolicy` and `readProcess`. | §32 requires the policy step, and `startProcess` needs a way to read output. |
| DI-2.8 | 2026-08-22 | AT-14 | The runner contract tests use a stub `opencode` executable. | A live model call is not deterministic. §66 holds the live proof. |
| DI-2.9 | 2026-08-22 | §31, §37 | `FlySpriteSandbox.exposeService` throws, and `capabilities.supportsExposedServices` is `false`. The SDK has no documented API that maps a port to a reachable URL. | A URL built from the undocumented `ServiceRequest.httpPort` field is a guess. See handover H-2. |
| DI-2.10 | 2026-08-22 | §31 | `FlySpriteSandbox.startProcess` makes its own process ID and runs the command in a wrapper that writes `pid`, `out`, `err` and `exit` files. | `Sprite.createSession` returns no session ID, and a finished session has no readable output or exit code. |
| DI-3.1 | 2026-08-23 | §15 | `.factoree/config.yaml` is read from the primary checkout inside the sandbox through `Sandbox.exec`. | The control plane holds no copy of the repository. |
| DI-3.2 | 2026-08-23 | §32 | The network policy is applied three times, each tighter than the last: repository hosts only for the checkout; checkout hosts plus the configured allow list for the reference checkout and bootstrap; the configured allow list alone before the checkpoint. | The allow list comes from a file that only the checkout can produce. No step runs under an open policy. |
| DI-3.3 | 2026-08-23 | §15 | A missing or invalid `.factoree/config.yaml` is a `RunConfigurationError` and ends the Run in `FAILED_CONFIGURATION`. | §15 makes the file mandatory. |
| DI-3.4 | 2026-08-23 | §35 | Every verification command runs. A failure does not stop the commands after it. | §35 requires a record for each command. |
| DI-3.5 | 2026-08-23 | §35 | A verification command runs through `sh -c` with `PATH`, `HOME`, `LANG` and the Product test secrets marked for injection, and nothing else. | §35 says "from a clean shell". |
| DI-3.6 | 2026-08-23 | §35, §39 | A verification result is an `Evidence` row with a null `validationAssertionId`. | §53 has no verification entity. |
| DI-3.7 | 2026-08-23 | §35, §39 | `Evidence.sha256` hashes the canonical record. The stdout and stderr hashes live in `metadata`. | §35 and §39 each name hashes. Both are kept. |
| DI-3.8 | 2026-08-23 | §35, §60 | A hash covers the raw output. A retained log holds the redacted output. | A hash of redacted text does not identify the output. A log reaches a human. |
| DI-3.9 | 2026-08-23 | §42 | A repair starts a fresh Implementer run with the findings. It does not resume the earlier session. | The runner session lives in one worker process and does not survive a restart (AT-35). This contradicts the §67 item "Implementer can resume for repair". See handover H-5. |
| DI-3.12 | 2026-08-23 | §27, §57 | The autonomy level of a Run comes from the Product. The repository file cannot set it. | The level is chosen at delegation, and §57 ranks the file below human decisions. |
| DI-4.1 | 2026-08-23 | §8 | Refinement is deterministic Factoree logic, not an agent role. It parses, classifies and asks. It never generates prose. | No sandbox exists before `prepare sandbox` (§49). It is the only reading that meets "MUST NOT invent material product behavior" without a further control. See handover H-1. |
| DI-4.2 | 2026-08-23 | §17, §49 | Repository discovery runs on the control plane through a read-only git port (`ls-remote`, `ls-tree`, `cat-file`). | Context resolution happens before the sandbox exists, and §32 allows one Sprite per Run. These commands run no repository code. |
| DI-4.3 | 2026-08-23 | §15, §18 | Discovery reads `.factoree/config.yaml` at the pinned primary SHA with `git cat-file`. | The `context` block governs discovery. The SHA is the one the sandbox checks out later. |
| DI-4.4 | 2026-08-23 | §23 | A human answer is a Context Item of authority `work_item_decision`. | §53 lists no decision entity. §22 ranks an explicit Work Item decision highest. |
| DI-4.5 | 2026-08-23 | §23 | Factoree asks one question at a time and records the answer against that question. | No free-text answer needs to be matched to one of several questions. |
| DI-4.6 | 2026-08-23 | §8, §23 | At most five question rounds. Then the Run fails with `REFINEMENT_UNRESOLVED`, `CONTEXT_UNRESOLVED`, `VALIDATION_UNRESOLVED` or `TARGET_UNRESOLVED`. | An unbounded elicitation loop never ends. |
| DI-4.7 | 2026-08-23 | §23 | A conflict exists when two selected items in one authority domain carry the same Work Item topic. A different authority class resolves to the higher class. The same class is unresolvable. | §23 prescribes no detector. A model-based detector would resolve ambiguity silently. |
| DI-4.8 | 2026-08-23 | §22 | `current_implementation` and `system_topology` are combined evidence. Two items inside one of these domains do not conflict. A review overturned the first version, which made such a pair unresolvable. | §22 joins these domains with `+`, not `>`. |
| DI-4.10 | 2026-08-23 | §21 | The Context Contract is written once per Run in one transaction with a unique index on `runId`. The store offers no update. | §21 immutability, and an activity retry must not write a second contract. |
| DI-4.11 | 2026-08-23 | §21, §53 | `Run.contextContractVersion` holds the contract SHA-256. The document keeps `version: 1` as its schema version. | The operator needs the identity of the exact contract. |
| DI-4.12 | 2026-08-23 | §21, AT-09 | An item that does not fit the context budget becomes `discoverable`. It keeps its provenance. | Nothing is dropped silently. |
| DI-4.13 | 2026-08-23 | §55 | A Context Item records repository, SHA, path and content hash. No blob is copied into PostgreSQL. | §55. |
| DI-4.16 | 2026-08-23 | §9, §18 | A repository slug in the Work Item that the Product does not hold becomes a risk, not a reference. | Factoree cannot prove that an arbitrary slug is accessible. |
| DI-5.1 | 2026-08-23 | §53, §59 | Context sources are configured per Product, so the source list is built per Run. | A registry built at worker start cannot hold a per-Product credential. |
| DI-5.2 | 2026-08-23 | §15, §49 | The `context` block is read at the pinned primary SHA on the control plane. | Context resolution happens before the sandbox exists. |
| DI-5.3 | 2026-08-23 | §15 | A failed discovery-time read of `.factoree/config.yaml` yields the defaults (`backstage: false`, `automaticDiscovery: false`). It does not fail the Run. | `SandboxManager` enforces the file at `PREPARING`. A failure adds no source. |
| DI-5.4 | 2026-08-23 | §19 | Backstage runs only when an administrator configures the endpoint and the repository sets `context.backstage.enabled`. | §19 "when configured". |
| DI-5.5 | 2026-08-23 | §19, §22 | Every Backstage candidate has authority `declarative_catalog`. | That class never competes with code or an ADR. |
| DI-5.6 | 2026-08-23 | §18 | Backstage discovery walks one hop from the primary entity, with a hard entity cap. It never lists the catalog without a filter. | §18 forbids unbounded retrieval. |
| DI-5.7 | 2026-08-23 | §20 | A Backstage repository location becomes a pinned reference repository when `automaticDiscovery` is true. At most three are added. | §20 requires an explicit SHA. Each one costs a mirror clone. |
| DI-5.8 | 2026-08-23 | §20 | A discovered repository is accepted only on the host of the primary repository. Others stay `discoverable` items. | The workflow builds clone URLs from one base URL and a slug. |
| DI-5.9 | 2026-08-23 | §10 | The MCP client is a small JSON-RPC client over `fetch` (`initialize`, `tools/list`, `tools/call`). | No new dependency. A fixture server stays deterministic. |
| DI-5.10 | 2026-08-23 | §58 | The Action Policy answers `decideMcpTool(name)`. It denies each tool that the Product configuration does not allow by name. The default list is empty. | §58. |
| DI-5.11 | 2026-08-23 | §22 | The administrator sets the MCP authority class. The default is `prose_documentation`. | A generic source has no fixed authority. |
| DI-5.12 | 2026-08-23 | §28 | Work Item labels are read in an activity, not in the webhook handler. | The session webhook carries no labels, and the handler must stay fast. |
| DI-5.13 | 2026-08-23 | §17 | A Backstage or MCP transport fault yields no candidates and the Run continues. A configuration fault is refused at the administration API. | Neither source is required for a Run. |
| DI-6.1 | 2026-08-24 | §24, §49 | The Validation Contract is built after the Context Contract and before the sandbox. It is a pure function of the Goal, the acceptance criteria, the constraints and the human decisions. | §49 order. |
| DI-6.2 | 2026-08-24 | §7, §24 | The builder is deterministic. Each assertion restates one acceptance criterion and records its ID in `requirement`. | §7 forbids invented behaviour. See handover H-1. |
| DI-6.3 | 2026-08-24 | §9 | A contract with no assertion does not freeze. The Run asks one question, and the answer becomes a criterion with source `human:decision`. | §9 item 5. |
| DI-6.4 | 2026-08-24 | §24, §36 | The default method is `manual`. | Guessing `test` claims a proof Factoree cannot produce. |
| DI-6.5 | 2026-08-24 | §25 | The frozen hash is the contract version. | A content hash cannot drift from its content. |
| DI-6.6 | 2026-08-24 | §56 | No `prompts/validation-builder.md` exists. | The builder starts no agent. See handover H-1. |
| DI-6.7 | 2026-08-24 | §25 | The store offers `save` and `findByRun` only. `save` is idempotent per Run. | §25, and an activity retry must not write a second contract. |
| DI-6.8 | 2026-08-24 | §34 | The Implementer receives the rendered contract text, never the store. | §34. AT-11 tests the store, not a prompt sentence. |
| DI-7.1 | 2026-08-24 | §37 | Playwright runs on the worker against the exposed preview. | Exposure exists so that a client outside the sandbox can reach the preview. |
| DI-7.2 | 2026-08-24 | §36, P-01 | The fresh validator session writes a declarative Validation Plan. Factoree parses and executes it and decides the result from the artefacts. The plan is data, never code. | No deterministic function turns prose into browser steps, and P-01 forbids trusting an agent claim. |
| DI-7.3 | 2026-08-24 | §25 | The plan parser rejects unknown assertion IDs and ignores any restated statement, method or evidence list. | §25 against the User Validator. |
| DI-7.4 | 2026-08-24 | §36 | An assertion with no plan entry is `BLOCKED`, not `FAIL`. | `FAIL` sends a correct implementation into repair. |
| DI-7.5 | 2026-08-24 | §36 | A `manual` or `code_review` assertion is `MANUAL_REQUIRED`. An L3 Run with one ends `VALIDATION_MANUAL_REQUIRED`. | §36. See handover H-1. |
| DI-7.6 | 2026-08-24 | §36 | The validator writes only into `${workspacePath}/validation`. | A validator artefact in the worktree would reach the patch. |
| DI-7.7 | 2026-08-24 | §37 | Preview is optional. Browser or HTTP assertions without a preview are `BLOCKED` with an operator reason. | The fault is repository configuration. |
| DI-7.8 | 2026-08-24 | §39 | Evidence bytes go through an `EvidenceStorage` port with a Linear and a filesystem adapter. `sha256` always hashes the exact bytes. | §39 SHOULD, and tests stay free of a live Linear account. |
| DI-7.9 | 2026-08-24 | §39 | An assertion result is its own row (`ValidationAssertionResult`). | One assertion can carry several artefacts. |
| DI-7.10 | 2026-08-24 | §42 | A failed user validation uses the shared repair budget. A repair re-runs verification before validation. | §42 bounds repairs per Run. AT-20 full reverification. |
| DI-7.12 | 2026-08-24 | §37 | The driver always collects console, network and assertion logs. Screenshot, video and trace only when the assertion requires them. A required kind without an artefact is `FAIL`. | §37. |
| DI-7.13 | 2026-08-24 | §63 | `evidence.activities.ts` exports `createEvidencePersistence`, and `userValidate` calls it in process. | Artefact bytes must not cross a workflow payload. |
| DI-7.14 | 2026-08-24 | §29, §36 | `buildActionPolicy({ role })` allows `writePrimaryWorktree` for `implementer` only. | §36 forbids the validator to change source. A prompt is not a boundary. |
| DI-8.1 | 2026-08-25 | §41, P-01 | The Reviewer writes one report file. Factoree parses it and decides which findings block. | P-01. |
| DI-8.2 | 2026-08-25 | §41 | The agent `verdict` never decides the Run. Factoree derives the outcome from the findings. | A verdict without a valid finding names nothing to repair. |
| DI-8.3 | 2026-08-25 | §41 | A finding blocks only when the severity is `blocker` or `high`, the category is not style, the `requirement` resolves, and the `evidence` names a changed file. | §41 three conditions. |
| DI-8.4 | 2026-08-25 | §41 | A `VAL-` requirement must name an assertion of the frozen contract. Other non-empty text counts as a repository rule. | Factoree cannot list every repository rule. |
| DI-8.5 | 2026-08-25 | §41, §43 | `evidence` must name a file that the diff changed. | §43 forbids blocking on something outside the change. |
| DI-8.6 | 2026-08-25 | §41 | A `style` finding never blocks, at any severity. | §41. |
| DI-8.7 | 2026-08-25 | §40, §68 | An absent or invalid review report ends the Run `FAILED` with `REVIEW_UNAVAILABLE`, not a repair. | A repair cannot fix a broken review. |
| DI-8.8 | 2026-08-25 | §48 | Blocking findings with a spent budget end the Run in `FAILED_REVIEW`. | §48. |
| DI-8.9 | 2026-08-25 | §42 | One repair budget covers verification, validation and review. | §42 bounds repairs per Run. |
| DI-8.10 | 2026-08-25 | §42 | A review repair re-runs implement, verify, validate and review in one loop. | §42 order. |
| DI-8.11 | 2026-08-25 | §42 | Every Reviewer attempt is a new session. | §42 fresh context. |
| DI-8.12 | 2026-08-25 | §44 | The Reviewer diff comes from the §44 command pair, through one shared module. | The review and the publication read the same change. |
| DI-8.13 | 2026-08-25 | §60 | The prompt diff is redacted and truncated at a byte ceiling. The prompt says so and carries the full changed-file list. | A prompt is a captured output. |
| DI-8.14 | 2026-08-25 | §40 | A binary file appears in the changed-file list, not in the diff text. | Binary bytes help no Reviewer. |
| DI-8.15 | 2026-08-25 | §40 | The Reviewer writes only into `${workspacePath}/review`. | A Reviewer artefact would reach the patch. |
| DI-8.17 | 2026-08-25 | §43, §47 | Every finding is persisted with its blocking decision and reason. | Non-blocking findings reach the Proof Pack as follow-ups. |
| DI-8.18 | 2026-08-25 | §53 | The review record is the `ReviewFinding` rows plus the reviewer `AgentExecution` row. | §53 has no review entity. |
| DI-9.1 | 2026-08-25 | §44 | The published patch uses `--binary` and is not the Reviewer diff. `src/domain/publishing/patch.ts` owns the §44 command pair. | The Reviewer diff is redacted and truncated, so it cannot apply. |
| DI-9.2 | 2026-08-25 | §44 | Publication refuses when the changed-file list of the review differs from that of the verified patch. | The review and the publication must cover one change. |
| DI-9.3 | 2026-08-25 | §46 | One constant pins every diff option (renames, algorithm, colour, external driver, abbreviation, prefix). The sandbox and the trusted checkout use it. | Git configuration must not change the bytes. |
| DI-9.4 | 2026-08-25 | §44 | The patch travels as base64. The SHA-256 covers the decoded bytes. | `Sandbox.exec` decodes stdout as UTF-8. |
| DI-9.5 | 2026-08-25 | §44, §60 | The patch is never redacted. Error messages about it are. | A redacted patch does not apply. |
| DI-9.6 | 2026-08-25 | §46 | The trusted checkout runs on the worker in a fresh temporary directory, removed in `finally`. | §46 and §29. |
| DI-9.7 | 2026-08-25 | §30 | Superseded by AT-53: the publish credential is a token minted from the GitHub App installation. No Product `GITHUB_TOKEN` secret exists. | `docs/specs/github-app-discovery-wiring.md`. |
| DI-9.8 | 2026-08-25 | §46, AT-35 | The branch is `factoree/run-<runId>`. Publication reuses an open PR for that branch. | A retry or restart must not make a second PR. |
| DI-9.9 | 2026-08-25 | §44, §48 | `PATCH_HASH_MISMATCH`, `EMPTY_PATCH` and `PUBLICATION_FAILED` are failure reasons. `STALE_BASE` is a Run status. | Each failure has its own identity. |
| DI-9.11 | 2026-08-25 | §29, §40 | The review activity fingerprints the primary worktree before and after the Reviewer and refuses the review when it changed. | A Reviewer write would reach the patch through `git add -A`. |
| DI-9.12 | 2026-08-25 | §46 | A tree-hash comparison is recorded beside the patch-hash assertion. It never replaces it. | Extra evidence for a mismatch. |
| DI-11.1 | 2026-08-25 | §16, §57 | The organization skills repository is a Product field, not a repository file key. | A repository must not name its own organization skills. |
| DI-11.2 | 2026-08-25 | §16 | The organization skills repository is checked out read-only into `${workspacePath}/organization-skills`. | It cannot collide with a reference repository. |
| DI-11.3 | 2026-08-25 | §16, §55 | The organization skills repository is checked out at its default branch. The Run records the SHA it read. | No discovery step resolves a skills SHA. |
| DI-11.4 | 2026-08-25 | §16 | A name conflict keeps every skill and applies one. The applied and the shadowed skills reach the prompt by name, path and scope. | No silent overwrite. |
| DI-11.5 | 2026-08-25 | §16 | Precedence: repository before organization; then `.agents`, `.claude`, `.codex`; then directory name ascending. | A fixed, auditable order. |
| DI-11.6 | 2026-08-25 | §16 | The prompt carries the skill name, description and origin, not the body. | A body can push the goal out of the prompt. |
| DI-11.7 | 2026-08-25 | §34 | Skills reach the Implementer only. | §38 and §40 do not list skills. |
| DI-11.8 | 2026-08-25 | §14 | An unknown runner name fails the Run at preparation with `CONFIGURATION_INVALID`. | The operator sees the fault early. |
| DI-11.10 | 2026-08-25 | §30 | Prompts and session IDs reach the CLI through stdin and environment values, never argv. | A process listing must not show them. |
| DI-12.1 | 2026-08-25 | §67 | One pure function maps each `RunFailureReason` to a category. `CATEGORY_BY_REASON` is a total `Record`, so a new reason fails the typecheck until it is classified. | A caller cannot disagree with the map. |
| DI-12.2 | 2026-08-25 | §62, §67 | The category is on the `Run` row and on the metric label. | The Definition of Done names it a Run property. |
| DI-12.3 | 2026-08-25 | §33 | `CliAgentRunner.releaseRun(runId)` frees the sessions of a Run. `failRun` and `cancelRun` cancel the Implementer before `completeRun`, and `completeRun` calls `releaseRun`. | A size cap can evict a session a retry still needs. |
| DI-12.4 | 2026-08-25 | §40 | The reviewer git-state check is a second fingerprint. `worktreeFingerprint` still returns the tree SHA that `publishing.activities` compares to `patch.treeSha`. | Changing the first value breaks the §46 guard. |
| DI-12.6 | 2026-08-25 | §55 | `Run.organizationSkillsSha` records the skills SHA. | §55. |
| DI-12.9 | 2026-08-25 | §66 | `npm run acceptance:live` exits 78 and prints `BLOCKED_EXTERNAL` when a credential is absent. | A silent skip reads as a pass. |
| DI-12.10 | 2026-08-25 | §65 | `acceptance:live` is not part of `npm run verify`. | `verify` must not need credentials. |
| DI-12.11 | 2026-08-26 | §50 | `AgentRunner.cancel` returns `"cancelled"` or `"no-live-session"`. `cancelImplementer` throws on the second, so the activity retry can reach the worker that owns the session. | A silent cancel let the workflow record §50 obligation 1 as met while an agent ran. |
| DI-13.1 | 2026-09-05 | §52, §53 | `Project` is split into `Product` and `Repository`. A Linear team maps to one Product, and routing refuses rather than guesses. | `docs/specs/multi-repo-tenancy.md`. |
| DI-13.2 | 2026-09-05 | §30, §59 | Repositories register through GitHub App events. A Run mints its clone and publish tokens from the installation. | `docs/specs/github-app-discovery-wiring.md`. |
| DI-14.1 | 2026-10-29 | R-5 | `SANDBOX_ADAPTER=local` needs `FACTOREE_UNSAFE_LOCAL_SANDBOX=1`. A secret key or an admin token made of one repeated character, or holding "change-me", is refused. | The local sandbox lets the agent read the worker environment. A copied `.env.example` must not boot. |
| DI-14.2 | 2026-10-29 | R-6, R-7 | `RepositoryReader.withCredential` holds the credential in an `AsyncLocalStorage` context, not per origin. A mirror is keyed by installation and URL. Every minted token names the repositories it may reach. | All GitHub repositories share one origin, so a per-origin credential mixed tenants. |
| DI-14.3 | 2026-10-29 | R-8 | `prePublicationFailures` checks the §68 clauses that hold before publication. The workflow runs it before `checkBase`. | A broken clause must stop the Run before a pull request exists. |
| DI-14.4 | 2026-10-29 | `docs/specs/refiner-agent.md` | Before the refiner exists, a frozen contract with a `manual` or `code_review` assertion ends the Run `VALIDATION_MANUAL_REQUIRED` before preparation. The human rewrites the ticket and delegates again. | Rule 3 of the refiner gate. The question round arrives with the refiner. |
| DI-14.5 | 2026-10-29 | `docs/specs/check-isolation.md` | The check sprite applies the patch after the config read and before the bootstrap, then recaptures it. The recaptured hash must equal the work sprite hash. Publication captures from the check sprite and must reproduce that same hash. | The config comes from the base SHA. The bootstrap needs the patched dependencies. Only the hash crosses the workflow, so no patch bytes reach Temporal history. |
| DI-14.6 | 2026-10-29 | `docs/specs/check-isolation.md` | The check sprite of a superseded attempt is destroyed when the next attempt starts. The last one is destroyed at the terminal write. The check sprite ID is logged with the run ID. | The Run row holds one sprite for the reaper. A second table for check sprites adds no guarantee. |
| DI-14.7 | 2026-10-29 | `docs/specs/check-isolation.md` | The publish hash gate replaces the tree checks before user validation and review. | Any change after the patch entered the check sprite changes the captured hash, so one gate covers every stage. A forged tree check could only report "unchanged", which the hash gate still catches. |
| DI-14.8 | 2026-10-29 | `docs/specs/autonomy-levels.md`, §48 | An L0 or L1 Run ends in the new terminal state `REPORTED`, counted by `factoree_runs_reported_total`. | §68 reserves `READY_FOR_HUMAN` for a Run with a pull request and a Proof Pack. A report is a success that is neither. |
| DI-14.9 | 2026-10-29 | `docs/specs/autonomy-levels.md` | `decideAutonomy` is one pure function of the Product level, the labels, the Product caps and the label-read result. Every rule can only lower the level. `Product.riskCaps` is JSON, and null means the §28 labels at L2. | One function, so no caller can apply the rules in another order. |
| DI-14.10 | 2026-10-29 | `docs/specs/autonomy-levels.md` | L1 stops after the review passes and before publication. L0 stops after the identity check of the context step. | L1 "implements and returns evidence" needs every check. L0 needs no sandbox. |
| DI-14.11 | 2026-10-29 | R-4, §29 | `Product.allowedDomains` is the egress ceiling. The repository list keeps only the entries the ceiling covers, and an empty repository list gets the ceiling. An empty ceiling allows the repository hosts only. A wildcard must name two labels. | A merged agent PR could widen egress for every later Run. The safe default denies, and bootstrap sets `registry.npmjs.org` through `SETUP_ALLOWED_DOMAINS`. |

## Blocked

| ID | Date | Question | Default |
|---|---|---|---|
| B-2 | 2026-10-29 | `docs/specs/check-isolation.md` asks for runner CLIs in a root-owned directory. The Sprite user installs the CLIs in user directories, and the repository bootstrap can install them. The bootstrap runs project code in the check sprite before the validator and the reviewer. | Factoree calls git by absolute path with a clean environment, and the publish hash gate catches any change to the tested patch. A shim can still fake the validator or the reviewer verdict. Close it with a Sprite image that holds root-owned runner CLIs. |
| B-1 | 2026-08-26 | §66 live acceptance needs a Linear test workspace, a GitHub fixture repository with the App installed, a Fly Sprites token, Temporal, a runner credential, Backstage and MCP test endpoints. | 11 §67 "Live proof" items stay `BLOCKED_EXTERNAL`. |

## Human answers

| ID | Date | Question | Answer |
|---|---|---|---|
| H-A1 | 2026-10-29 | Autonomy levels are stored and never read (R-2). | Enforce L0 to L3. L2 keeps every check and opens a draft PR. Only an operator raises a Product; a Linear label only lowers one ticket. `docs/specs/autonomy-levels.md`. |
| H-A2 | 2026-10-29 | Change Sets: Version 1 (tenancy spec) or Version 2 (SDD §4, §71)? | Version 2. A Version 1 Run has one target repository. |
| H-A3 | 2026-10-29 | Refinement and the Validation Contract builder are keyword rules (H-1). | A fresh refiner agent proposes as data, a deterministic gate freezes, questions use the grill format. Supersedes DI-4.1, DI-6.2, DI-6.4. `docs/specs/refiner-agent.md`. |
| H-A4 | 2026-10-29 | Checks run in the Sprite the Implementer controlled (R-1). | A fresh check Sprite per attempt from base SHA plus the captured patch. `docs/specs/check-isolation.md`. |

DI-13.1 and DI-13.2 were approved by the human in the two tenancy specs. The build agent took every other DI decision.
