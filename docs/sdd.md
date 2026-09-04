# Factoree — Evidence-First Software Factory Control Plane

**Document type:** Software Design Document  
**Version:** 2.0  
**Status:** Implementation-ready  
**Style:** STE100-style controlled English  
**Primary interface:** Linear  
**Code review interface:** GitHub  
**Language:** TypeScript  
**Production runtime:** Node.js 24 LTS  

---

## 1. Purpose

Factoree is a self-hosted software factory control plane for AI-assisted software delivery.

The human remains the manager, architect, and accountable owner.

Factoree uses hosted services where they remove undifferentiated infrastructure work. The default deployment uses:

- Linear for work management;
- GitHub for source control and pull requests;
- Temporal Cloud for durable orchestration;
- Fly Sprites for isolated execution;
- hosted model providers for coding agents;
- Backstage, repositories, documentation systems, and MCP servers as context sources.

Factoree owns:

1. context selection;
2. delivery policy;
3. validation contracts;
4. agent orchestration;
5. independent verification;
6. evidence;
7. approval gates;
8. exact-patch publication.

Factoree does not build its own issue tracker, Git host, VM platform, or coding model.

The main workflow is:

```text
Linear work item
      ↓
technical refinement
      ↓
Context Resolver
      ↓
Context Contract
      ↓
Validation Contract
      ↓
isolated implementation
      ↓
deterministic verification
      ↓
user-level validation
      ↓
independent review
      ↓
bounded repair
      ↓
verified immutable patch
      ↓
GitHub pull request
      ↓
Proof Pack in Linear
      ↓
human decision
```

---

## 2. Product boundary

Factoree is in the same product category as software factory platforms.

Factoree is not a Factory.ai or Blocks clone.

Factoree must remain model-neutral and infrastructure-neutral at its domain boundaries.

Its main differentiators are:

- provenance-aware Context Contracts;
- explicit context authority and conflict handling;
- frozen Validation Contracts before implementation;
- evidence mapped to each validation assertion;
- separate change autonomy and tool/action permissions;
- fresh-context validation and review;
- bounded repair loops;
- exact verified-patch publication;
- stale-base protection;
- a self-hosted control plane over replaceable hosted primitives.

---

## 3. Goals

Factoree Version 1 MUST:

1. accept delegated Linear work;
2. refine technically incomplete work when product intent is clear;
3. request human input for unresolved material decisions;
4. resolve relevant context from repositories and organizational systems;
5. record why each context item was selected;
6. detect material context conflicts;
7. freeze a Validation Contract before implementation;
8. execute work in an isolated Fly Sprite;
9. support Claude Code and OpenCode through adapters;
10. run deterministic verification independent of the implementer;
11. validate browser and API behavior independently;
12. perform fresh-context code review;
13. repair verified defects within a fixed limit;
14. publish only the exact patch that passed verification;
15. create a Proof Pack in Linear;
16. isolate projects and clients;
17. record useful autonomy, cost, and quality metrics.

---

## 4. Non-goals

Version 1 MUST NOT implement:

- a custom project-management UI;
- a custom source-review UI;
- a custom coding agent;
- a custom VM platform;
- automatic production deployment;
- automatic pull request merge;
- production credential access;
- autonomous product ownership;
- autonomous architecture approval;
- fictional AI employee personalities;
- arbitrary multi-agent conversations;
- a full enterprise wiki;
- billing or SaaS account management;
- broad multi-day project decomposition;
- coordinated writes to several repositories.

A Version 1 Run MAY read several repositories but MAY modify only one primary repository.

---

## 5. Core principles

### P-01 — Evidence before confidence

An agent statement is not proof.

Factoree MUST verify material claims independently where practical.

### P-02 — Define correctness first

Factoree MUST freeze the Validation Contract before implementation begins.

The implementer MUST NOT change it.

### P-03 — Select context; do not dump it

Factoree MUST select relevant context.

It MUST NOT inject all available repositories or documents into an agent prompt.

### P-04 — Context has provenance

Each selected context item MUST record its source, version, authority class, and selection reason.

### P-05 — Conflicts are explicit

Factoree MUST resolve context conflicts with declared authority policy or request human input.

It MUST NOT guess.

### P-06 — Linear is the work interface

Factoree MUST NOT duplicate Linear.

### P-07 — GitHub is the code review interface

Factoree MUST NOT duplicate GitHub pull request review.

### P-08 — Agents are replaceable

Core workflows MUST NOT depend on one coding-agent vendor.

### P-09 — Action permissions are separate from task autonomy

A highly autonomous Run does not give the agent unrestricted network, credential, shell, or Git permissions.

### P-10 — Repair is finite

Default maximum repairs: 2.

### P-11 — Hosted infrastructure is replaceable

Factoree MAY use managed services, but the core domain MUST depend on provider abstractions.

### P-12 — Important state lives outside chat history

Requirements, context, validation, evidence, findings, and decisions MUST be durable artifacts.

---

## 6. Terminology

**Work Item** — Linear issue delegated to Factoree.  
**Run** — one Factoree execution for one Work Item.  
**Refinement** — pre-implementation technical enrichment.  
**Context Source** — source of engineering or product information.  
**Context Contract** — selected context with provenance and authority.  
**Validation Contract** — frozen observable assertions that define success.  
**Implementer** — agent that changes source code.  
**Verifier** — deterministic project verification.  
**User Validator** — fresh session or harness that tests behavior externally.  
**Reviewer** — fresh session that reviews the diff and evidence.  
**Repair** — implementer continuation after a verified failure.  
**Evidence** — immutable proof artifact.  
**Proof Pack** — final human-readable delivery record in Linear.  
**Primary Repository** — only repository Version 1 can modify.  
**Reference Repository** — read-only repository used as context.  
**Action Policy** — enforced permissions for tools and side effects.  
**Change Autonomy** — workflow automation level.

---

## 7. Work Item contract

Factoree SHOULD accept imperfect tickets.

Recommended structure:

```markdown
## Goal

<Required outcome>

## Acceptance criteria

- AC-1: <observable result>
- AC-2: <observable result>

## Constraints

<Optional decisions and restrictions>

## References

<Optional links to specs, ADRs, services, or repositories>
```

Acceptance criteria are recommended but are not required at delegation time.

Factoree MAY propose acceptance criteria during Refinement.

Factoree MUST NOT invent material product behavior.

---

## 8. Refinement

Refinement runs before readiness evaluation.

It MAY:

- identify the primary repository;
- identify reference repositories;
- find existing implementation patterns;
- locate relevant tests;
- discover APIs and events;
- locate ADRs;
- identify service dependencies;
- propose acceptance criteria;
- identify directly implied edge cases;
- derive risk labels;
- identify missing decisions.

It MUST NOT:

- modify source code;
- invent product scope;
- override explicit user decisions;
- override accepted architecture decisions;
- silently resolve ambiguous architecture choices.

Output:

```json
{
  "status": "ready",
  "primaryRepository": "owner/repo",
  "referenceRepositories": ["owner/repo-2"],
  "proposedAcceptanceCriteria": [
    {
      "id": "AC-1",
      "statement": "Observable behavior",
      "source": "linear:issue-id"
    }
  ],
  "risks": [],
  "unresolvedQuestions": []
}
```

or:

```json
{
  "status": "needs_input",
  "unresolvedQuestions": [
    {
      "id": "Q-1",
      "question": "Required decision",
      "whyMaterial": "Why implementation cannot continue safely"
    }
  ]
}
```

A material unresolved question sets the Run to `WAITING_FOR_INPUT`.

---

## 9. Readiness gate

Implementation can start only when:

1. the Project exists;
2. the primary repository is known;
3. required repositories are accessible;
4. a clear Goal exists;
5. at least one observable success assertion exists;
6. project configuration is valid;
7. no material question remains;
8. the Context Contract is valid;
9. the Validation Contract is valid and frozen;
10. required sandbox and agent credentials exist.

If readiness fails, Factoree MUST NOT start implementation.

---

## 10. Technology stack

### Application

- TypeScript with strict compiler settings;
- Node.js 24 LTS;
- npm with committed `package-lock.json`;
- Fastify;
- Zod.

Required TypeScript settings:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

### Durable workflows

- Temporal;
- Temporal TypeScript SDK;
- Temporal Cloud in the recommended production deployment.

Local development MUST support a local Temporal server.

### Persistence

- PostgreSQL;
- Prisma;
- Prisma Migrate.

### Integrations

- Linear SDK and Agent APIs;
- GitHub App and Octokit;
- Fly Sprites;
- Playwright;
- Backstage Catalog API;
- MCP client.

### Agent runners

Required:

- OpenCode;
- Claude Code.

### Testing

- Vitest;
- Testcontainers;
- Temporal test environment;
- Playwright.

### Observability

- OpenTelemetry;
- structured JSON logs;
- OTLP export.

---

## 11. Runtime decision

Bun MUST NOT be the production runtime for Temporal Workers in Version 1.

Temporal Worker execution uses Node-specific APIs and native components.

Factoree MUST run production and CI workflow workers on Node.js 24 LTS.

Bun MAY be used only for isolated developer utilities that do not run Temporal Worker code.

---

## 12. Deployment model

The Factoree control plane is self-hosted.

Recommended production topology:

```text
factoree-api
factoree-worker
managed PostgreSQL
Temporal Cloud
Fly Sprites
```

External hosted systems:

```text
Linear
GitHub
model providers
optional documentation/context systems
```

The system MUST permit later replacement of:

- Temporal Cloud with self-hosted Temporal;
- Fly Sprites with another Sandbox adapter;
- one coding agent with another runner;
- one context system with another source.

---

## 13. Core architecture

```text
                              Human
                                │
                              Linear
                                │
                                ▼
                         ┌─────────────┐
                         │  Factoree API  │
                         └──────┬──────┘
                                │
                             Temporal
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
               Refinement             Policy Engine
                    │
                    ▼
             Context Resolver
                    │
        ┌───────────┼─────────────┐
        ▼           ▼             ▼
     Backstage    Repos        MCP/docs
        │           │             │
        └───────────┼─────────────┘
                    ▼
             Context Contract
                    │
                    ▼
            Validation Contract
                    │
                    ▼
               Fly Sprite
                    │
               Implementer
                    │
                    ▼
        Deterministic Verification
                    │
                    ▼
             User Validation
                    │
                    ▼
         Independent Reviewer
                    │
             bounded repair
                    │
                    ▼
             Verified Patch
                    │
                    ▼
                  GitHub
                    │
                    ▼
               Proof Pack
                    │
                  Linear
```

---

## 14. Required modules

```text
LinearAdapter
GitHubAdapter
ProjectRegistry
RefinementEngine
ContextResolver
ContextSourceRegistry
ContextConflictResolver
ValidationContractBuilder
PolicyEngine
SandboxManager
AgentRunnerRegistry
DeterministicVerifier
UserValidator
IndependentReviewer
RepairCoordinator
PatchPublisher
EvidenceStore
ProofPackBuilder
MetricsRecorder
```

Provider SDKs MUST remain in adapters.

Core workflow policy MUST NOT import provider-specific SDKs.

---

## 15. Repository configuration

Each primary repository MUST contain:

```text
.factoree/config.yaml
```

Example:

```yaml
version: 1

bootstrap:
  command: npm ci

verify:
  commands:
    - name: typecheck
      run: npm run typecheck
    - name: lint
      run: npm run lint
    - name: test
      run: npm test

preview:
  enabled: true
  command: npm run dev -- --host 0.0.0.0 --port 8080
  readyUrl: http://127.0.0.1:8080/health
  timeoutSeconds: 60

agents:
  implementer: opencode
  validator: claude
  reviewer: claude

repair:
  maxAttempts: 2

sandbox:
  allowedDomains:
    - registry.npmjs.org

context:
  backstage:
    enabled: true
  referenceRepositories:
    automaticDiscovery: true

policy:
  defaultAutonomy: L3
```

Unknown configuration keys MUST fail validation.

---

## 16. Skills

Factoree MUST reuse common agent skill formats.

Discover:

```text
.agents/skills/*/SKILL.md
.claude/skills/*/SKILL.md
.codex/skills/*/SKILL.md
```

A Project MAY also define one organization-wide skills repository.

Skill precedence MUST NOT override:

1. Factoree security policy;
2. Action Policy;
3. Validation Contract;
4. explicit Work Item constraints.

Skill origin MUST be recorded.

Name conflicts MUST NOT silently overwrite another skill.

---

## 17. Context source interface

```ts
interface ContextSource {
  id(): string;

  discover(
    request: ContextDiscoveryRequest,
  ): Promise<ContextCandidate[]>;

  fetch(
    ref: ContextReference,
  ): Promise<ContextDocument>;
}
```

Required Version 1 sources:

- Linear;
- primary GitHub repository;
- reference GitHub repositories;
- Backstage Catalog;
- generic MCP source.

---

## 18. Context discovery

The Context Resolver SHOULD use explicit topology before broad semantic search.

Priority:

1. Work Item links and references;
2. Project repository mapping;
3. Backstage ownership and dependency relations;
4. Backstage API provider/consumer relations;
5. repository names in the Work Item;
6. accepted ADR references;
7. code imports or declared clients;
8. scoped semantic search.

Organization-wide unbounded retrieval MUST be disabled by default.

---

## 19. Backstage

When configured, Backstage is a topology source.

Factoree SHOULD use:

- Components;
- Systems;
- APIs;
- Resources;
- ownership;
- `dependsOn`;
- `providesApis`;
- `consumesApis`;
- repository locations.

Backstage helps Factoree determine where to look.

Backstage does not automatically override executable code or accepted architecture decisions.

---

## 20. Reference repositories

Version 1 MUST support read-only reference repositories.

They can provide:

- API definitions;
- event schemas;
- shared types;
- implementation examples;
- integration tests;
- architecture documentation.

Each reference repository MUST be checked out at an explicit commit SHA.

The Implementer MUST NOT modify it.

---

## 21. Context Contract

Every implementation-ready Run MUST have an immutable Context Contract.

Example:

```yaml
version: 1
runId: run_123

scope:
  primaryComponent: manuscript-service
  primaryRepository:
    repo: company/manuscript-service
    sha: 824ac31

references:
  repositories:
    - repo: company/notification-service
      sha: 71fa012
      reason: provides notification API

  documents:
    - ref: github:company/architecture/ADR-031.md
      version: a84f12
      authority: architecture_intent
      reason: defines notification ownership

  contracts:
    - ref: github:company/notification-service/openapi.yaml
      version: 71fa012
      authority: interface_contract
      reason: required API boundary
```

Each selected item MUST record:

- source;
- stable reference;
- source version or timestamp;
- authority class;
- selection reason;
- classification;
- content hash when practical.

Classification:

```text
required
reference
discoverable
```

Required items can enter initial role context.

Reference items are summarized or indexed.

Discoverable items remain available through tools but are not preloaded.

---

## 22. Context authority

Authority is domain-specific.

### Product intent

```text
explicit Work Item decision
> approved linked product specification
> general product documentation
```

### Architecture intent

```text
accepted ADR
> approved architecture specification
> architecture documentation
> repository README
```

### Interface contract

```text
versioned machine-readable contract
> executable contract tests
> API documentation
> prose documentation
```

### Current implementation

Evidence consists of:

```text
source code
+ executable tests
+ build/runtime behavior
```

### System topology

Use:

```text
Backstage/declarative catalog
+ repository configuration
```

Project configuration MAY explicitly override these rules.

---

## 23. Context conflicts

A material conflict MUST be recorded.

Factoree MAY resolve it automatically only when authority policy provides a clear winner.

Example:

```json
{
  "id": "CTX-4",
  "winner": "ADR-031",
  "loser": "README.md",
  "reason": "accepted ADR has higher architecture authority"
}
```

If no safe resolution exists:

1. do not start implementation;
2. set `WAITING_FOR_INPUT`;
3. ask one focused question;
4. persist the human answer as a Run decision.

---

## 24. Validation Contract

Factoree MUST create and freeze the Validation Contract before implementation starts.

Example:

```yaml
version: 1
workItem: ENG-143

assertions:
  - id: VAL-UI-001
    requirement: AC-1
    statement: >
      A signed-in editor can change the project name and the new
      name remains visible after reload.
    method: browser
    evidence:
      - screenshot
      - network
      - assertion-log

  - id: VAL-API-001
    requirement: AC-2
    statement: >
      PATCH /projects/{id} returns 403 for a user without edit permission.
    method: http
    evidence:
      - request-response
```

Each assertion MUST define:

- unique ID;
- source requirement;
- observable behavior;
- validation method;
- required evidence;
- permitted preconditions.

Allowed methods:

```text
command
test
http
browser
code_review
manual
```

---

## 25. Validation Contract immutability

After implementation starts, the active Validation Contract MUST NOT change.

Any change creates a new version.

A change that modifies product intent requires human approval and a new implementation baseline.

The Implementer, User Validator, and Reviewer MUST NOT weaken the contract.

---

## 26. Linear integration

Factoree is a Linear Agent.

It MUST support:

- delegation;
- mention;
- progress;
- elicitation;
- stop;
- final response.

Webhook handling MUST be idempotent.

Workflow ID:

```text
linear:{workspaceId}:{agentSessionId}
```

Factoree MUST acknowledge the session before long-running context or sandbox work begins.

---

## 27. Change autonomy

### L0 — Investigate

Read and report only.

### L1 — Implement

Modify sandbox and return evidence. No PR.

### L2 — Verified PR

Implement, verify, create draft PR.

Independent review is optional.

### L3 — Reviewed PR

Implement, verify, user-validate, review, repair, publish PR, create Proof Pack.

Default: L3.

### L4 — Merge

Reserved for a future version.

Version 1 MUST NOT merge automatically.

---

## 28. Risk caps

Default high-risk labels:

```text
security
authentication
authorization
payments
billing
cryptography
database-migration
infrastructure
secrets
```

They cap autonomy at L2 unless Project policy explicitly overrides the cap.

Verification still applies.

---

## 29. Action Policy

Action permissions are enforced outside prompts.

Default:

| Action | Result |
|---|---|
| Read primary repository | allow |
| Write primary worktree | allow |
| Read reference repository | allow |
| Write reference repository | deny |
| Run project commands | allow |
| Install approved dependencies | allow |
| Arbitrary outbound network | deny |
| Approved registries | allow |
| Approved test services | allow |
| Staging read | deny unless configured |
| Staging write | deny |
| Git remote write from agent | deny |
| Production access | deny |
| Merge | deny |

Model instructions are not a security boundary.

---

## 30. Credentials

The Implementer MUST NOT receive:

- Linear tokens;
- GitHub write credentials;
- production secrets;
- Factoree admin credentials.

Non-production test secrets MAY be injected explicitly per Project.

Secrets MUST:

- be encrypted at rest;
- be Project-scoped;
- never be logged;
- never be committed;
- be redacted from evidence.

### Secret kinds

Every Project secret carries a kind. The kind states what the secret is for, and it decides
which carrier may hold the value.

| Kind | Purpose | Carrier |
| --- | --- | --- |
| `test` | A non-production test secret. | The agent process environment, and only with the explicit injection mark. |
| `runner_credential` | The model provider credential of a coding agent. | The sandbox environment. |
| `repository_read` | A read-only repository credential. | One git command of the checkout, and the repository reader of context discovery. |
| `publish` | The GitHub write credential of the publication. | The trusted checkout, on the worker. |

A secret of a kind other than `test` MUST NOT carry the injection mark.

A runner credential is none of the four forbidden things above. It MUST:

- reach the process environment of the agent, and never a prompt;
- never appear in the Implementer input, the User Validator input, or the Reviewer input;
- never cross a workflow boundary, so no workflow history holds its value;
- be refused when its value holds a GitHub or a Linear credential.

A repository read credential is not a GitHub write credential. It MUST:

- reach one git command at a time, through the environment of that command;
- never appear on a command line, and never persist in the checkout;
- never be able to push.

---

## 31. Sandbox abstraction

```ts
interface Sandbox {
  create(input: SandboxCreateInput): Promise<SandboxRef>;
  exec(ref: SandboxRef, command: Command): Promise<CommandResult>;
  startProcess(ref: SandboxRef, command: Command): Promise<ProcessRef>;
  cancelProcess(ref: SandboxRef, process: ProcessRef): Promise<void>;
  checkpoint(ref: SandboxRef, name: string): Promise<CheckpointRef>;
  exposeService(ref: SandboxRef, port: number): Promise<ServiceRef>;
  destroy(ref: SandboxRef): Promise<void>;
}
```

Required implementation:

```text
FlySpriteSandbox
```

---

## 32. Sandbox lifecycle

```text
CREATE
  ↓
APPLY NETWORK POLICY
  ↓
CHECKOUT PRIMARY REPOSITORY
  ↓
CHECKOUT REFERENCE REPOSITORIES
  ↓
BOOTSTRAP
  ↓
CHECKPOINT BASELINE
  ↓
IMPLEMENT
  ↓
VERIFY
  ↓
USER VALIDATE
  ↓
REVIEW
  ↓
REPAIR IF REQUIRED
  ↓
CAPTURE PATCH
  ↓
RETAIN
  ↓
DELETE
```

One Run MUST use one unique mutable Sprite.

---

## 33. Agent runner interface

```ts
interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;

  resume(
    session: AgentSessionRef,
    input: AgentResumeInput,
  ): Promise<AgentRunResult>;

  cancel(session: AgentSessionRef): Promise<void>;
}
```

Required adapters:

```text
OpenCodeRunner
ClaudeCodeRunner
```

Temporal workflows MUST depend only on this interface.

---

## 34. Implementer input

The Implementer receives:

- Goal;
- recorded human decisions;
- frozen Validation Contract;
- Context Contract;
- required context;
- primary repository;
- reference repository paths;
- repository instructions;
- applicable skills;
- Action Policy;
- repair findings when applicable.

It MUST NOT receive:

- Reviewer conversation history;
- GitHub write credentials;
- authority to change the Validation Contract.

---

## 35. Deterministic verification

After implementation, Factoree runs configured commands from a clean shell.

Record for each command:

- name;
- exact command;
- start time;
- end time;
- exit code;
- stdout hash;
- stderr hash;
- retained log reference when applicable.

Only exit code 0 passes.

Agent claims do not affect this result.

---

## 36. User-level validation

After deterministic verification passes, Factoree validates every Validation Contract assertion.

The User Validator MUST use a fresh context.

It MUST NOT receive:

- Implementer transcript;
- Implementer success claims;
- Reviewer findings.

It MUST NOT change production source files.

Assertion results:

```text
PASS
FAIL
BLOCKED
MANUAL_REQUIRED
```

L3 cannot complete unless all assertions are `PASS`.

---

## 37. Browser validation

For browser assertions:

1. start preview;
2. wait for readiness;
3. expose the service;
4. execute Playwright;
5. capture required evidence.

Evidence MAY include:

- screenshot;
- video;
- trace;
- network evidence;
- console output;
- assertion log.

The Validation Contract defines what is required.

---

## 38. HTTP validation

For HTTP assertions, record:

- method;
- path;
- sanitized request;
- status;
- sanitized response when relevant;
- assertion result.

Sensitive values MUST be redacted before persistence.

---

## 39. Evidence

Evidence is immutable.

Each artifact records:

```text
evidence_id
run_id
validation_assertion_id
kind
source
created_at
sha256
storage_ref
metadata
```

Version 1 SHOULD store user-facing evidence through Linear private file storage where practical.

---

## 40. Independent review

After user validation passes, Factoree starts a fresh Reviewer session.

Reviewer input:

- Goal;
- frozen Validation Contract;
- Context Contract;
- constraints;
- source diff;
- changed files;
- deterministic verification;
- user-validation evidence;
- repository rules.

Reviewer MUST NOT reuse Implementer context.

A different model family SHOULD be used when practical.

---

## 41. Reviewer output

```json
{
  "verdict": "pass",
  "findings": []
}
```

or:

```json
{
  "verdict": "fail",
  "findings": [
    {
      "id": "RV-1",
      "severity": "high",
      "category": "correctness",
      "requirement": "VAL-API-001",
      "evidence": "src/auth.ts:84",
      "description": "Concrete defect"
    }
  ]
}
```

Allowed severities:

```text
blocker
high
medium
low
```

A blocking finding MUST identify:

- a concrete defect;
- a mandatory requirement or rule;
- specific evidence.

Only valid `blocker` and `high` findings block by default.

Style preferences do not block.

---

## 42. Repair loop

```text
verification, validation, or review failure
                 ↓
               repair
                 ↓
       deterministic verification
                 ↓
          user-level validation
                 ↓
            fresh review
```

The same Implementer session MAY resume.

Every new User Validator and Reviewer run MUST use fresh context.

Default total repair limit:

```text
2
```

No third repair may occur when the limit is two.

---

## 43. Fixed review baseline

All validation and review use:

```text
Work Item intent
+ human decisions
+ Context Contract
+ Validation Contract
+ repository rules
+ Action Policy
```

Reviewers MUST NOT expand scope.

Useful out-of-scope work MAY be reported as follow-up recommendations.

---

## 44. Patch integrity

After all checks pass:

```text
git add -A
git diff --cached --binary <base_sha>
```

Factoree calculates:

```text
patch_sha256
```

This patch becomes the immutable verified implementation artifact.

---

## 45. Stale base protection

Before publication:

```text
current_target_sha == run_base_sha
```

MUST be true.

If false:

```text
STALE_BASE
```

Version 1 MUST NOT automatically rebase.

---

## 46. Trusted publishing

The coding agent MUST NOT publish.

Factoree:

1. creates a clean trusted checkout;
2. checks out the original base SHA;
3. applies the verified patch;
4. recalculates patch hash;
5. asserts it equals the verified hash;
6. creates a branch;
7. creates a commit;
8. pushes;
9. creates a GitHub PR;
10. removes temporary files.

Hash mismatch MUST block publication.

---

## 47. Proof Pack

A successful L3 Run MUST create one Proof Pack in Linear.

Required sections:

```markdown
## Factoree delivery

Status: READY FOR HUMAN REVIEW

### Pull request

<PR>

### Validation contract

| Assertion | Result | Evidence |
|---|---|---|

### Deterministic verification

<results>

### Independent review

<results>

### Context used

<important context with provenance>

### Context conflicts

<resolved conflicts or none>

### Change summary

<files and diff size>

### Preview

<if available>

### Known limitations

<limitations or none>

### Run metadata

<base SHA, patch hash, repair count>
```

The Proof Pack MUST optimize for a human acceptance decision.

It MUST NOT dump full raw logs into Linear.

---

## 48. Run states

```text
RECEIVED
REFINING
WAITING_FOR_INPUT
RESOLVING_CONTEXT
BUILDING_VALIDATION_CONTRACT
PREPARING
IMPLEMENTING
VERIFYING
USER_VALIDATING
REVIEWING
REPAIRING
PUBLISHING
READY_FOR_HUMAN
STALE_BASE
FAILED_CONFIGURATION
FAILED
FAILED_REVIEW
CANCELLED
```

Terminal states:

```text
READY_FOR_HUMAN
STALE_BASE
FAILED_CONFIGURATION
FAILED
FAILED_REVIEW
CANCELLED
```

---

## 49. Temporal workflow

```text
receive
  ↓
refine
  ├─ needs decision → WAITING_FOR_INPUT
  ↓
resolve context
  ├─ unresolved conflict → WAITING_FOR_INPUT
  ↓
build and freeze validation contract
  ↓
prepare sandbox
  ↓
implement
  ↓
verify
  ├─ fail → repair
  ↓
user validate
  ├─ fail → repair
  ↓
review
  ├─ blocking finding → repair
  ↓
capture patch
  ↓
check base
  ├─ changed → STALE_BASE
  ↓
publish
  ↓
proof pack
  ↓
READY_FOR_HUMAN
```

Transient infrastructure failures MAY use Temporal retries.

Semantic failures MUST use workflow decisions and MUST NOT consume infrastructure retry policy.

---

## 50. Timeout and cancellation

Default maximum Run duration:

```text
90 minutes
```

A Project MAY override it.

On timeout:

1. cancel active processes;
2. stop new side effects;
3. preserve evidence;
4. set failure reason `RUN_TIMEOUT`.

A Linear stop signal MUST cancel active agent processes and prevent publication.

---

## 51. Retention

Default Sprite retention:

```text
24 hours
```

After retention, Factoree deletes the Sprite.

Proof Pack and evidence metadata remain available.

---

## 52. Multi-tenant isolation

Tenant boundary:

```text
Linear workspace
```

A Run MUST reference one tenant and one Product.

Factoree MUST NOT:

- reuse mutable sandboxes across Products;
- use another Product's secrets;
- search another tenant's context sources;
- expose another tenant's evidence.

Tenant ID MUST be present on tenant-owned persisted records.

---

## 53. Persistent model

Required entities:

```text
Tenant
LinearInstallation
GitHubInstallation
Product
Repository
ProductSecret
ContextSourceConfiguration
Run
RunTarget
ContextContract
ContextItem
ContextConflict
ValidationContract
ValidationAssertion
Evidence
ReviewFinding
AgentExecution
ProcessedWebhook
```

Critical Run fields:

```text
id
product_id
linear_issue_id
linear_agent_session_id
temporal_workflow_id
status
autonomy_level
implementer_runner
validator_runner
reviewer_runner
sprite_id
base_sha
patch_sha256
commit_sha
pull_request_url
context_contract_version
validation_contract_version
repair_count
created_at
started_at
completed_at
```

---

## 54. Data ownership

Temporal owns active durable workflow state.

PostgreSQL owns:

- project configuration;
- context contracts;
- validation contracts;
- evidence metadata;
- findings;
- run metadata;
- idempotency.

Linear owns work-management state and the human-facing Proof Pack.

GitHub owns source history, PR review, and merge state.

External context systems remain authoritative for their own content.

---

## 55. Reproducible context

A completed Run MUST remain explainable after external sources change.

For repository content, record:

- repository;
- commit SHA;
- path;
- content hash.

For external records, record:

- stable source reference;
- source version or timestamp;
- content hash when practical.

Factoree SHOULD NOT copy complete repositories into PostgreSQL.

---

## 56. Prompt versioning

Required prompt files:

```text
prompts/refiner.md
prompts/context-selector.md
prompts/validation-builder.md
prompts/implementer.md
prompts/user-validator.md
prompts/reviewer.md
```

Each AgentExecution MUST record the prompt version.

Prompt changes are source changes and MUST pass normal review.

---

## 57. Instruction precedence

Highest to lowest:

1. Factoree security policy;
2. Action Policy;
3. recorded human decisions;
4. frozen Validation Contract;
5. Work Item constraints;
6. `.factoree/config.yaml`;
7. accepted Context authority rules;
8. repository instructions;
9. applicable skills;
10. runner defaults.

A lower rule cannot override a higher rule.

---

## 58. MCP policy

MCP is an extension mechanism, not an unrestricted trust boundary.

Use it for:

- internal tools;
- self-hosted systems;
- custom documentation sources;
- organization-specific data.

Every MCP tool call MUST pass through Action Policy.

Implementers MUST NOT receive unrestricted organization-wide MCP access by default.

---

## 59. Administration API

Required endpoints:

```text
GET  /healthz
GET  /readyz

PUT /admin/linear-installations
PUT /admin/github-installations

POST /admin/products
GET  /admin/products
GET  /admin/products/:id
PUT  /admin/products/:id
POST /admin/products/:id/activate
GET  /admin/products/:id/repositories

PUT    /admin/products/:id/secrets/:name
DELETE /admin/products/:id/secrets/:name

POST   /admin/products/:id/context-sources
GET    /admin/products/:id/context-sources
DELETE /admin/products/:id/context-sources/:sourceId

GET /admin/runs/:id
GET /admin/runs/:id/context
GET /admin/runs/:id/validation
```

A repository row is not created through the administration API. Discovery
creates it from the `.factoree/config.yaml` file of the repository itself,
when the GitHub App reports the repository to Factoree.

Version 1 MAY use a strong administration bearer token plus network restriction.

No user-facing Factoree dashboard is required.

---

## 60. Logging and redaction

Structured logs SHOULD include:

```text
tenant_id
project_id
run_id
linear_issue
workflow_id
step
sprite_id
```

Factoree MUST NOT log raw:

- OAuth tokens;
- GitHub tokens;
- model API keys;
- Project secrets;
- authorization headers.

Before external persistence, Factoree MUST redact:

- exact configured secret values;
- known GitHub token patterns;
- known model-provider key patterns;
- authorization headers;
- configured sensitive cookies and environment values.

---

## 61. Transcript policy

Full agent transcripts MUST NOT be persisted by default.

Persist:

- role;
- runner;
- model;
- session reference;
- duration;
- final structured result;
- prompt version;
- cost metadata when available.

A Project MAY explicitly enable transcript retention.

---

## 62. Observability

Required metrics:

```text
factoree_runs_started_total
factoree_runs_ready_total
factoree_runs_failed_total
factoree_runs_cancelled_total
factoree_run_duration_seconds

factoree_refinement_duration_seconds
factoree_context_resolution_duration_seconds
factoree_implementation_duration_seconds
factoree_verification_duration_seconds
factoree_validation_duration_seconds
factoree_review_duration_seconds

factoree_repairs_total
factoree_context_conflicts_total
factoree_human_interventions_total
factoree_active_runs
```

Recommended outcome metrics:

```text
first_attempt_success_rate
repair_rate
review_rejection_rate
human_interventions_per_run
automated_validation_ratio
time_issue_to_pr
time_issue_to_ready
cost_per_ready_run
cost_per_merged_pr
post_merge_revert_rate
post_merge_followup_defect_rate
```

---

## 63. Source structure

```text
src/
  bin/
    api.ts
    worker.ts

  domain/
    projects/
    runs/
    refinement/
    context/
    validation/
    policy/
    evidence/
    review/
    publishing/

  workflows/
    agent-run.workflow.ts

  activities/
    refinement.activities.ts
    context.activities.ts
    validation.activities.ts
    linear.activities.ts
    github.activities.ts
    sandbox.activities.ts
    agent.activities.ts
    verification.activities.ts
    evidence.activities.ts

  adapters/
    linear/
    github/
    backstage/
    mcp/
    sandbox/
      fly-sprites/
    runners/
      claude-code/
      opencode/

  persistence/
    prisma/

  http/
    oauth/
    webhooks/
    admin/

  prompts/
  security/
  telemetry/
  config/

tests/
  unit/
  integration/
  workflow/
  acceptance/
  fixtures/
```

---

## 64. Required system acceptance tests

### AT-01 — Delegation

A valid Linear delegation creates exactly one Run.

Duplicate webhook delivery does not create another Run.

### AT-02 — Refinement

A technically vague fixture issue with clear intent is enriched with:

- correct primary repository;
- at least one relevant implementation pattern;
- candidate acceptance assertions.

No source code is changed.

### AT-03 — Material uncertainty

An unresolved product decision causes `WAITING_FOR_INPUT`.

Implementation does not start.

### AT-04 — Backstage discovery

A Backstage API dependency produces the expected Context Candidate with a topology-based selection reason.

### AT-05 — Reference repository

A discovered reference repository is checked out at an explicit SHA and is read-only to the Implementer.

### AT-06 — Context provenance

Every selected Context Item contains source, version, authority, and reason.

Missing provenance causes Context Contract validation failure.

### AT-07 — Resolvable conflict

A README that conflicts with a higher-authority accepted ADR is marked lower authority and the decision is recorded.

### AT-08 — Unresolvable conflict

Two equally authoritative incompatible architecture decisions cause `WAITING_FOR_INPUT`.

### AT-09 — Context limit

A large repository is referenced and tool-accessible but is not copied in full into the initial agent prompt.

### AT-10 — Validation created first

Validation Contract creation time and hash exist before Implementer start time.

### AT-11 — Validation immutability

An Implementer cannot alter the active Validation Contract.

### AT-12 — Isolation

Three concurrent Runs use three different Sprite IDs and cannot modify one another.

### AT-13 — Action Policy

The Implementer can write the primary worktree but cannot:

- write a reference repository;
- push to GitHub;
- reach an unapproved network domain.

### AT-14 — OpenCode

The fixture implementation reaches verification with OpenCodeRunner.

### AT-15 — Claude Code

The same fixture reaches verification with ClaudeCodeRunner without workflow changes.

### AT-16 — Deterministic failure

A failing configured verification command blocks publication and triggers repair when budget remains.

### AT-17 — Fresh user validation

User Validator session differs from Implementer session and does not receive the Implementer transcript.

### AT-18 — UI evidence

A browser assertion produces the evidence required by its Validation Contract entry.

### AT-19 — HTTP evidence

An HTTP assertion records sanitized request/response evidence.

### AT-20 — Validation repair

A build-successful but behaviorally incorrect implementation fails user validation, enters repair, and is fully reverified.

### AT-21 — Fresh review

Reviewer session differs from Implementer sessions and does not receive Implementer transcript.

### AT-22 — Blocking finding

A concrete high-severity finding tied to a mandatory rule blocks the Run and triggers repair.

### AT-23 — Scope control

A style-only medium finding does not block.

### AT-24 — Repair limit

No third repair starts when maximum repairs is two.

### AT-25 — Evidence completeness

Every Validation assertion is PASS before L3 can reach `READY_FOR_HUMAN`.

### AT-26 — Credential isolation

The Implementer cannot read a GitHub write credential.

### AT-27 — Exact patch

Verified patch SHA-256 equals published patch SHA-256.

A mismatch blocks publication.

### AT-28 — Stale base

A changed target branch causes `STALE_BASE` and no PR.

### AT-29 — PR

Successful L3 creates exactly one PR with Work Item, Run ID, base SHA, patch hash, and verification summary.

### AT-30 — Proof Pack

Successful L3 creates one Proof Pack with:

- PR;
- Validation results;
- evidence;
- deterministic checks;
- review result;
- context used;
- context conflicts;
- known limitations;
- repair count;
- base SHA;
- patch hash.

### AT-31 — Stop

Linear stop terminates the active process and prevents publication.

### AT-32 — Redaction

A deliberately printed fixture secret does not appear in Factoree logs, Linear evidence, or the Proof Pack.

### AT-33 — Tenant isolation

Tenant A cannot retrieve Tenant B secrets, context, projects, or evidence.

### AT-34 — Cleanup

Sprite deletion after retention does not remove Proof Pack access.

### AT-35 — Worker restart

Restarting the Temporal worker during a Run does not duplicate a Run, repair, or PR.

### AT-36 — MCP source

A configured test MCP source can supply a Context Candidate with provenance.

### AT-37 — Skills

Repository and organization skills are discovered without silent name overwrite.

### AT-38 — Team key resolution

A caller supplies a Linear team key. A caller MUST NOT supply a Linear team id. Factoree resolves the key to an id once. It stores both. Routing then resolves by the stored id.

### AT-39 — Ambiguous team

Two Products that claim the same Linear team cause a `BLOCKED_ROUTING` refusal. Factoree never guesses.

### AT-40 — Repository privilege key

A `.factoree/config.yaml` file that sets a privilege key, for example `policy.autonomy`, fails validation. The error names the key.

### AT-41 — Unknown product slug

A repository whose configuration names an unknown product slug creates a pending Product at autonomy level L0.

### AT-42 — Confident target

A Run with one confident repository proposal among several Product members proceeds. Factoree posts a Linear notice that names the chosen repository.

### AT-43 — Ambiguous target

A Run with no confident repository proposal among several Product members blocks with `BLOCKED_TARGET`. A human reply that names a repository resumes the Run.

(Change Sets, a later plan, adds AT-44 and AT-45.)

### AT-46 — Sibling clone

The Implementer clones a sibling repository of the same Product read-only, outside the primary working tree. Factoree writes an evidence record naming the repository, the commit, and the role.

### AT-47 — Sibling clone denied

A clone request for a repository outside the Product is denied. Factoree clones nothing. It writes no evidence record.

### AT-48 — Team key rename

A Linear team key rename keeps the existing Product, because the team id is stable. Factoree stores the new key. It reports the drift.

---

## 65. Required development commands

```text
npm ci
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:workflow
npm run build
npm run verify
```

`npm run verify` MUST run all required non-live checks.

CI MUST run `npm run verify`.

Required checks MUST NOT use `continue-on-error`.

---

## 66. Live acceptance test

Required command:

```text
npm run acceptance:live
```

It MUST use:

- a real Linear test workspace;
- a real GitHub fixture repository;
- a real Fly Sprite;
- a real Temporal service;
- at least one real coding-agent runner;
- a test Backstage catalog or endpoint;
- a test MCP source.

Required credentials MUST be documented in:

```text
.env.example
docs/live-acceptance.md
```

If required external credentials are unavailable:

```text
BLOCKED_EXTERNAL
```

is the correct state.

It is not equivalent to Done.

---

## 67. Definition of Done

Factoree Version 1 is Done only when all required items are true.

### Build

- [ ] Node.js 24 LTS is the production runtime.
- [ ] `npm ci` succeeds.
- [ ] `npm run verify` exits 0.
- [ ] `npm run build` exits 0.
- [ ] No required test is skipped.
- [ ] No required production path contains placeholder behavior.

### Linear

- [ ] Delegation starts exactly one Run.
- [ ] Progress works.
- [ ] Elicitation works.
- [ ] Stop works.
- [ ] Final Proof Pack works.

### Refinement

- [ ] Technical refinement works on the fixture.
- [ ] Material uncertainty stops safely.
- [ ] Refinement does not change source code.

### Context

- [ ] Linear source works.
- [ ] Primary repository source works.
- [ ] Reference repository source works.
- [ ] Backstage source works.
- [ ] MCP source works.
- [ ] Context Contract exists before implementation.
- [ ] Every Context Item has provenance.
- [ ] Authority policy is deterministic.
- [ ] Resolvable conflicts are recorded.
- [ ] Unresolvable material conflicts stop implementation.
- [ ] Large context is referenced instead of prompt-dumped.

### Validation

- [ ] Validation Contract exists before implementation.
- [ ] Every assertion has ID, method, and evidence requirements.
- [ ] Contract hash is persisted.
- [ ] Active contract is immutable.

### Sandbox and policy

- [ ] Every Run uses a unique Sprite.
- [ ] Network policy applies before agent execution.
- [ ] Primary repository uses captured base SHA.
- [ ] Reference repositories use captured SHAs.
- [ ] Reference repositories are read-only.
- [ ] Git remote write is denied to agents.
- [ ] Production access is denied.
- [ ] Policy is enforced outside prompts.
- [ ] Cancellation works.
- [ ] Retention cleanup works.

### Agent runners

- [ ] OpenCodeRunner passes integration tests.
- [ ] ClaudeCodeRunner passes integration tests.
- [ ] Runner selection is configuration-driven.
- [ ] Implementer can resume for repair.
- [ ] User Validator is fresh.
- [ ] Reviewer is fresh.

### Verification and evidence

- [ ] Every deterministic command records exit code.
- [ ] Non-zero exit blocks publication.
- [ ] Every Validation assertion receives a result.
- [ ] Browser assertions produce required evidence.
- [ ] HTTP assertions produce sanitized evidence.
- [ ] Missing evidence blocks L3.
- [ ] Validation repair works.

### Review

- [ ] Reviewer output matches schema.
- [ ] Invalid Reviewer output fails safely.
- [ ] Concrete blocker/high findings block.
- [ ] Style-only findings do not block.
- [ ] Repair works.
- [ ] Repair limit is enforced.

### Patch integrity and GitHub

- [ ] Agent has no GitHub write credential.
- [ ] Verified patch hash is persisted.
- [ ] Publishing uses a clean checkout.
- [ ] Applied patch hash equals verified hash.
- [ ] Stale-base protection works.
- [ ] Factoree creates branch, commit, and PR.
- [ ] Factoree never merges the PR.

### Proof Pack

- [ ] Every successful L3 Run creates one Proof Pack.
- [ ] It maps each validation assertion to evidence.
- [ ] It includes deterministic verification.
- [ ] It includes review outcome.
- [ ] It identifies important Context Items.
- [ ] It records resolved material Context Conflicts.
- [ ] It includes known limitations.
- [ ] It includes base SHA and patch hash.
- [ ] It links the PR.

### Skills and security

- [ ] `.agents/skills` discovery works.
- [ ] `.claude/skills` discovery works.
- [ ] `.codex/skills` discovery works.
- [ ] Organization skills can be configured.
- [ ] Skill conflicts do not silently overwrite.
- [ ] Secrets are encrypted at rest.
- [ ] Known secrets are redacted.
- [ ] Cross-tenant isolation tests pass.

### Reliability and observability

- [ ] Worker restart does not duplicate work.
- [ ] Infrastructure retries do not consume semantic repair budget.
- [ ] Timeout works.
- [ ] Three concurrent fixture Runs complete independently.
- [ ] Required OpenTelemetry metrics are emitted.
- [ ] Failed Runs have normalized failure categories.

### Live proof

- [ ] `npm run acceptance:live` has passed.
- [ ] Real Linear delegation reaches Factoree.
- [ ] Real context resolution runs.
- [ ] Real Validation Contract is frozen.
- [ ] Real Fly Sprite performs implementation.
- [ ] Deterministic verification runs.
- [ ] User-level validation runs.
- [ ] Independent review runs.
- [ ] Evidence is accessible from Linear.
- [ ] A real GitHub PR is created.
- [ ] The Proof Pack is visible in Linear.

**If any required item is false, Version 1 is not Done.**

---

## 68. Completion invariant

```text
READY_FOR_HUMAN
    only if

Work Item is ready
AND Context Contract exists
AND no unresolved material Context Conflict exists
AND Validation Contract was frozen before implementation
AND all Validation assertions PASS
AND deterministic verification PASS
AND no blocking review finding remains
AND repair count <= configured maximum
AND verified patch hash == published patch hash
AND target base SHA has not changed
AND PR exists
AND Proof Pack exists
```

No prompt or agent response can override this invariant.

---

## 69. Implementation order

### Phase 1 — Control plane

Build Linear integration, PostgreSQL, Temporal workflow skeleton, Project model, Run model, and idempotency.

**Exit:** one Linear delegation creates one durable Run.

### Phase 2 — Sandbox and first runner

Build Fly Sprite adapter, process control, checkout, network policy, checkpoint, OpenCodeRunner, and cancellation.

**Exit:** Factoree can make an isolated fixture change without publishing.

### Phase 3 — Deterministic verification

Build `.factoree/config.yaml`, verification commands, result recording, and repair handoff.

**Exit:** a false agent success claim cannot bypass a failing check.

### Phase 4 — Refinement and Context Contract

Build Refinement, repository discovery, read-only reference repos, authority rules, Context Contract, and conflict model.

**Exit:** Factoree can explain what context it will use before code changes begin.

### Phase 5 — Backstage and MCP

Build Backstage topology integration and generic MCP source.

**Exit:** a fixture dependency can be discovered from Backstage with provenance.

### Phase 6 — Validation Contract

Build contract generation, immutable hash, and command/test/http/browser assertion types.

**Exit:** every implementation starts after a frozen validation contract exists.

### Phase 7 — User validation and evidence

Build preview startup, Playwright, HTTP validation, evidence storage, and Linear uploads.

**Exit:** a UI fixture change produces independent acceptance evidence.

### Phase 8 — Review and repair

Build fresh Reviewer, finding schema, blocking rules, and bounded repair.

**Exit:** a known defect is found, repaired, revalidated, and re-reviewed.

### Phase 9 — Trusted publishing

Build patch capture, patch hash, stale-base guard, clean trusted checkout, GitHub branch, commit, and PR.

**Exit:** only the exact verified patch can reach GitHub.

### Phase 10 — Proof Pack

Build human-facing validation, context, conflict, evidence, and review summaries.

**Exit:** a human can decide whether to accept the change without reading the Implementer transcript.

### Phase 11 — Second runner and skills

Build ClaudeCodeRunner and skill discovery.

**Exit:** the same fixture workflow works with either required runner.

### Phase 12 — Hardening

Build tenant isolation, redaction, concurrency, timeout, failure injection, metrics, and live acceptance.

**Exit:** every Definition of Done item passes.

---

## 70. Version 1 user workflow

```text
1. Human creates or approves a Linear issue.
2. Human delegates it to Factoree.
3. Factoree refines technical details.
4. Factoree resolves relevant organizational and code context.
5. Factoree asks only for material unresolved decisions.
6. Factoree freezes the Validation Contract.
7. Factoree implements in an isolated Sprite.
8. Factoree verifies deterministic checks.
9. Factoree validates behavior independently.
10. Factoree performs fresh adversarial review.
11. Factoree repairs verified defects within the limit.
12. Factoree publishes the exact verified patch.
13. Factoree returns a PR and Proof Pack.
14. Human decides whether to merge.
```

The human MUST NOT need to:

- supervise agent terminals;
- tell agents repeatedly to continue;
- manually gather related repositories;
- manually paste architecture context into prompts;
- create separate review sessions;
- collect screenshots manually;
- compare raw test logs manually;
- decide when review loops stop;
- trust an agent claim that verification passed;
- guess which context version the agent used.

---

## 71. Version 2 candidates

Not required for Version 1:

- coordinated multi-repository writes;
- linked multi-PR Change Sets;
- project-level decomposition into milestones;
- scheduled maintenance agents;
- CI-triggered repair;
- automatic merge for approved low-risk work;
- post-merge production validation;
- generated living architecture documentation;
- richer managed connectors;
- per-action human approval gates;
- organization policy packs;
- hosted multi-tenant Factoree.

---

## 72. Final implementation rule

An implementation agent MUST treat this SDD as a fixed baseline.

It MAY choose internal details not constrained here.

It MUST NOT:

- weaken required validation;
- remove a difficult acceptance test;
- replace a required live integration with a mock and declare success;
- mark a requirement complete without evidence;
- expand Version 1 scope to Version 2 work.

If an external dependency prevents required live proof, the state is:

```text
BLOCKED_EXTERNAL
```

not `DONE`.
