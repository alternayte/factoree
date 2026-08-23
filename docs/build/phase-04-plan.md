# Factoree Phase 4 — Refinement and Context Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Factoree a deterministic Refinement step, a repository discovery step that pins every repository to an explicit commit SHA, an immutable Context Contract with full provenance, and an authority-driven conflict model, so that Factoree can explain what context it will use before any code change begins.

**Architecture:** `RefinementEngine` in `src/domain/refinement/` parses the Linear Work Item against the SDD §7 structure and produces the SDD §8 output. It invents no product behavior; it restates, classifies, and asks. A material unresolved question drives `WAITING_FOR_INPUT`, and one focused question is asked at a time. `ContextResolver` in `src/domain/context/` asks each registered `ContextSource` for candidates, ranks them by the SDD §18 priority, classifies them `required`, `reference`, or `discoverable` under a hard context budget, fetches only the required items to hash them, detects conflicts inside one authority domain, and resolves them by the SDD §22 ladder. The result is an immutable, hashed Context Contract persisted in PostgreSQL with one row per item and one row per conflict. Repository discovery runs on the control plane through a read-only git command port, so it needs no sandbox and executes no repository code.

**Tech Stack:** TypeScript (strict), Node.js 24 LTS, npm, Temporal TypeScript SDK, Prisma, PostgreSQL, `yaml`, `zod`, Vitest, Testcontainers, prom-client, the git command line.

**Spec:** `docs/sdd.md` (version 2.0, SHA-256 `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`)

## Global Constraints

- Production runtime is Node.js 24 LTS. Bun MUST NOT run Temporal Worker code (SDD §11).
- TypeScript compiler options MUST include `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true` (SDD §10).
- npm with a committed `package-lock.json` (SDD §10).
- Provider SDKs MUST stay in `src/adapters/**`. Core workflow policy MUST NOT import provider-specific SDKs (SDD §14).
- Temporal workflows MUST depend only on the `AgentRunner` interface (SDD §33). In practice the workflow depends on activities, and the activities depend on the port.
- Tenant boundary is the Linear workspace. Tenant ID MUST be present on tenant-owned persisted records (SDD §52).
- Factoree MUST NOT log raw OAuth tokens, GitHub tokens, model API keys, Project secrets, or authorization headers (SDD §60).
- Full agent transcripts MUST NOT be persisted by default (SDD §61).
- Required checks MUST NOT use `continue-on-error`. CI MUST run `npm run verify` (SDD §65).
- Source layout MUST follow SDD §63.
- Run states MUST use the exact names in SDD §48.
- Unknown configuration keys MUST fail validation (SDD §15).
- Refinement MUST NOT modify source code, invent product scope, override an explicit user decision, override an accepted architecture decision, or silently resolve an ambiguous architecture choice (SDD §8).
- Factoree MUST NOT invent material product behavior (SDD §7).
- Every reference repository MUST be checked out at an explicit commit SHA and MUST be read-only to the Implementer (SDD §20).
- Every selected Context Item MUST record source, stable reference, source version or timestamp, authority class, selection reason, classification, and a content hash when practical (SDD §21).
- Organization-wide unbounded retrieval MUST be disabled by default (SDD §18).
- A material context conflict MUST be recorded. Automatic resolution is permitted only when authority policy gives a clear winner (SDD §23).
- Instruction precedence places `.factoree/config.yaml` below Factoree security policy, Action Policy, recorded human decisions, the frozen Validation Contract, and Work Item constraints (SDD §57).
- Model instructions are not a security boundary. The Action Policy MUST be enforced outside prompts (SDD §29).
- Factoree MUST acknowledge the Linear session before long-running context or sandbox work begins (SDD §26).
- Factoree SHOULD NOT copy complete repositories into PostgreSQL (SDD §55).

---

## Phase 4 scope (SDD §69)

> Build Refinement, repository discovery, read-only reference repos, authority rules, Context Contract, and conflict model.
> **Exit:** Factoree can explain what context it will use before code changes begin.

**In scope:** Work Item parsing against SDD §7; the `RefinementEngine` and the SDD §8 output; the material-question path to `WAITING_FOR_INPUT` and the human answer round trip; the SDD §28 risk labels and the autonomy cap; the SDD §17 `ContextSource` interface and the `ContextSourceRegistry`; the Linear context source; the git repository context source and the read-only git command port; explicit SHA pinning of the primary repository and every reference repository; the SDD §22 authority ladders; the SDD §23 conflict model, its automatic resolution, and its unresolvable path; the Context Contract, its provenance validation, its content hash, its context budget, and its Prisma persistence; the `ContextContract`, `ContextItem`, and `ContextConflict` entities of SDD §53; `refinement.activities.ts` and `context.activities.ts`; the `REFINING`, `WAITING_FOR_INPUT`, and `RESOLVING_CONTEXT` workflow states; the `factoree_refinement_duration_seconds`, `factoree_context_resolution_duration_seconds`, and `factoree_context_conflicts_total` metrics; AT-02, AT-03, AT-05, AT-06, AT-07, AT-08, and AT-09.

**Out of scope (later phases, do not build):** Backstage and the generic MCP source, and the `ContextSourceConfiguration` entity that configures them (Phase 5); the Validation Contract and its assertions (Phase 6); preview startup, Playwright, HTTP validation, and Linear evidence upload (Phase 7); the Reviewer, the finding schema, and the review half of the repair loop (Phase 8); patch capture, stale base, and publishing (Phase 9); the Proof Pack (Phase 10); `ClaudeCodeRunner` and skills (Phase 11); the live Fly Sprite proof (Phase 12).

---

## Decisions taken by the controller

These are recorded so a later reviewer does not treat them as drift.

1. **Refinement is deterministic Factoree logic, not an agent role.** SDD §53 fixes `AgentExecution.role`, and the code already fixes `AgentRole` to `implementer`, `validator`, and `reviewer`. The SDD names no refinement runner and no refinement prompt. SDD §49 also places `refine` before `prepare sandbox`, so no sandbox and therefore no agent runner exists at that point. Refinement therefore parses, classifies, and asks. It never generates prose. This is also the only reading that satisfies "MUST NOT invent material product behavior" without a further control.

2. **Repository discovery runs on the control plane through a read-only git command port, not inside a sandbox.** SDD §49 places context resolution before `prepare sandbox`, and SDD §32 gives the Run exactly one mutable Sprite, so a second discovery Sprite is forbidden. Discovery runs `git ls-remote`, `git ls-tree`, and `git cat-file`, which read data and execute no repository code, so the isolation requirement of AT-12 is not engaged. The port lives in `src/adapters/github/`, because SDD §17 names the primary and reference GitHub repositories as the sources it serves and SDD §63 defines no `adapters/git` directory.

3. **`.factoree/config.yaml` is read a second time during discovery, at the pinned primary SHA, without a checkout.** The `context` block of SDD §15 governs discovery, and discovery happens before the sandbox exists. `git cat-file blob <sha>:.factoree/config.yaml` reads the exact file the sandbox will later check out, because both use the same pinned SHA. The existing `parseFactoreeConfig` parses it. `SandboxManager` still reads the file inside the sandbox, unchanged, because the verification commands must come from the real checkout.

4. **A human answer is persisted as a Context Item of authority `work_item_decision`, not as a new entity.** SDD §23 requires the answer to be persisted as a Run decision. SDD §53 lists the required entities and lists no decision entity. SDD §22 makes an explicit Work Item decision the highest product-intent authority, so a recorded answer belongs in the Context Contract, where it also reaches the Implementer prompt and the later Proof Pack.

5. **Factoree asks exactly one question at a time.** SDD §23 says "ask one focused question". The workflow elicits the first unanswered question, waits for one human input, records it against that question, and refines or resolves again. This removes any need to match a free-text answer to one of several open questions.

6. **The question round is bounded at five.** SDD §8 and §23 impose no bound, and an unbounded elicitation loop is a non-terminating workflow. Five rounds, and then the Run fails with `REFINEMENT_UNRESOLVED`. The Run budget of SDD §50 bounds it as well.

7. **A conflict is detected inside one authority domain, over a shared Work Item topic.** SDD §23 requires a material conflict to be recorded and resolved by authority; it prescribes no detector. A semantic detector needs a model, and SDD §8 forbids Refinement from resolving an ambiguous architecture choice silently, so a model-based detector would be the wrong control. The deterministic rule is: two selected items in the same authority domain that both carry the same Work Item topic conflict. A different authority class resolves automatically to the higher class. The same authority class is unresolvable and drives `WAITING_FOR_INPUT`. This is exactly the shape AT-07 and AT-08 describe.

8. **`current_implementation` and `system_topology` have one authority rung each.** SDD §22 writes those two domains as evidence joined with `+`, not as a ladder with `>`. Source code, executable tests, and runtime behavior are equally authoritative, so any conflict inside that domain is unresolvable by policy.

9. **Phase 4 builds no Project-level authority override.** SDD §22 says Project configuration MAY override the rules. No acceptance test requires it, `.factoree/config.yaml` has no such key, and an unknown key must fail validation. The phase that needs it adds it.

10. **The Context Contract is immutable and is written exactly once per Run.** SDD §21 requires immutability. The store offers no update, writes the contract with its items and conflicts in one transaction, and uses a unique index on `runId`, so a Temporal activity retry cannot write a second contract.

11. **`Run.contextContractVersion` holds the contract SHA-256, not an integer.** The column is a string, SDD §21 fixes `version: 1` as the document schema version, and the value an operator needs on the Run is the identity of the exact contract. The document keeps `version: 1` as its schema version.

12. **The context budget demotes rather than drops.** AT-09 requires a large repository to stay tool-accessible while it is not copied into the initial prompt. An item that does not fit the required budget becomes `discoverable`. It keeps its full provenance row, so the contract still explains it. Nothing is silently discarded.

13. **A repository blob is never copied into PostgreSQL.** SDD §55 asks for repository, commit SHA, path, and content hash. A Context Item records exactly those four values. The `required` items reach the Implementer prompt from the checkout inside the sandbox, by path, not from the database.

14. **`AgentRunWorkflowInput.sandbox` is replaced by `workItem` and `project` blocks.** Refinement and context resolution now decide the goal and every pinned ref, so the delegation service can no longer build the sandbox input. One path is safer than two, so the optional Phase 1 shape is removed rather than kept beside the new one.

15. **`ContextSourceConfiguration` stays unbuilt.** SDD §53 lists it, and it configures the Backstage and MCP sources that SDD §69 assigns to Phase 5. The Phase 4 registry is built from the two sources Phase 4 owns.

16. **A repository slug named in the Work Item but absent from the Project record becomes a risk, not a reference.** SDD §18 ranks Work Item references first, but Factoree holds no credential that could prove an arbitrary slug is accessible, and SDD §9 requires every required repository to be accessible before implementation starts. The slug is recorded as a risk so a human sees it, and the Run is not blocked by it.

---

## Requirement mapping

| SDD requirement | Task |
| --- | --- |
| §7 Work Item structure, no invented product behavior | Task 1, Task 2 |
| §8 Refinement permissions, prohibitions, and output | Task 2 |
| §8 material question sets `WAITING_FOR_INPUT` | Task 2, Task 10 |
| §9 readiness gate items 2, 3, 4, 5, 7, 8 | Task 2, Task 7, Task 10 |
| §14 `RefinementEngine`, `ContextResolver`, `ContextSourceRegistry`, `ContextConflictResolver` | Task 2, Task 3, Task 6, Task 7 |
| §15 `context` block consumed at the pinned SHA | Task 4 |
| §17 `ContextSource` interface, Linear and repository sources | Task 3, Task 4, Task 5 |
| §18 discovery priority, no unbounded retrieval | Task 5, Task 7 |
| §20 reference repositories at an explicit SHA, read-only | Task 4, Task 10, Task 12 |
| §21 Context Contract, required provenance, classification | Task 7, Task 8 |
| §22 authority ladders | Task 3 |
| §23 conflict record, automatic resolution, unresolvable path | Task 6, Task 10 |
| §26 elicitation before long-running work | Task 10 |
| §28 risk labels cap autonomy at L2 | Task 2 |
| §48 `REFINING`, `WAITING_FOR_INPUT`, `RESOLVING_CONTEXT` | Task 10 |
| §49 workflow order and semantic decisions | Task 10 |
| §52 tenant on every persisted record | Task 8 |
| §53 `ContextContract`, `ContextItem`, `ContextConflict` | Task 8 |
| §55 repository, SHA, path, content hash | Task 7, Task 8 |
| §62 refinement, context resolution, and conflict metrics | Task 9 |
| §63 `refinement.activities.ts`, `context.activities.ts`, `domain/refinement`, `domain/context` | Task 9 |
| AT-02 refinement enriches a vague issue and changes no code | Task 12 |
| AT-03 material uncertainty blocks implementation | Task 12 |
| AT-05 reference repository at an explicit SHA and read-only | Task 12 |
| AT-06 provenance is complete or validation fails | Task 7, Task 12 |
| AT-07 resolvable conflict is recorded with the winner | Task 12 |
| AT-08 unresolvable conflict sets `WAITING_FOR_INPUT` | Task 12 |
| AT-09 a large repository is tool-accessible and not preloaded | Task 12 |

---

## Phase 4 exit evidence

- `npm run verify` exits 0 from a clean clone.
- An acceptance test drives a Run to the moment before implementation and proves the persisted Context Contract names every repository with an explicit SHA, every selected item with its source, version, authority, reason, and classification, and every recorded conflict with its winner (exit condition).
- The same test proves the contract text reaches the Implementer prompt and that no repository file body is preloaded into it.
- An acceptance test proves a technically vague fixture issue is enriched with the correct primary repository, at least one relevant implementation pattern, and at least one candidate acceptance assertion, and that no source file changed (AT-02).
- An acceptance test proves an unresolved product decision leaves the Run in `WAITING_FOR_INPUT` and that no Implementer ran (AT-03).
- An acceptance test proves a discovered reference repository is checked out at a forty-character SHA and is not writable by the Implementer (AT-05).
- A unit test proves a Context Item missing any provenance field fails Context Contract validation (AT-06).
- A unit test and an acceptance test prove a README that conflicts with an accepted ADR loses, and that the decision is recorded (AT-07).
- An acceptance test proves two accepted ADRs that conflict leave the Run in `WAITING_FOR_INPUT` (AT-08).
- An acceptance test proves a large reference repository is recorded with a pinned SHA and a `discoverable` classification, and that its file bodies do not appear in the Implementer prompt (AT-09).
- An integration test proves a `ContextContract` row is tenant-scoped, holds its items and conflicts, and is never written twice for one Run.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/domain/refinement/work-item.ts` | `WorkItem`, `parseWorkItem`: the SDD §7 markdown structure, tolerant of an unstructured body. |
| `src/domain/refinement/risk.ts` | `HIGH_RISK_LABELS`, `capAutonomy`: the SDD §28 labels and the L2 cap. |
| `src/domain/refinement/refinement-engine.ts` | `RefinementEngine`, `RefinementOutput`: the SDD §8 output, the questions, and the risks. |
| `src/domain/context/authority.ts` | The SDD §22 domains, ladders, `authorityDomainOf`, and `compareAuthority`. |
| `src/domain/context/context-source.ts` | The SDD §17 `ContextSource` interface and its request, candidate, reference, and document types. |
| `src/domain/context/context-source-registry.ts` | `ContextSourceRegistry`: identifier to source, no duplicate identifier. |
| `src/domain/context/linear-source.ts` | `LinearContextSource`: the Work Item itself, its recorded decisions, and its declared references. |
| `src/domain/context/repository-source.ts` | `RepositoryContextSource`: pins a SHA, lists a bounded tree, classifies each path, and reads a blob. |
| `src/domain/context/topics.ts` | `topicsOf`: the deterministic Work Item keyword set used for ranking and conflict detection. |
| `src/domain/context/conflicts.ts` | `detectConflicts`, `resolveConflicts`: the SDD §23 model over the SDD §22 ladders. |
| `src/domain/context/context-contract.ts` | `buildContextContract`, `validateContextContract`, `renderContextContract`, `hashContextContract`, and the context budget. |
| `src/domain/context/context-resolver.ts` | `ContextResolver`: discover, rank, classify, fetch, hash, detect, resolve, build. |
| `src/domain/context/context-contract-store.ts` | The `ContextContractStore` port and its records. |
| `src/adapters/github/git-repository-reader.ts` | `GitRepositoryReader`: `resolveRef`, `listTree`, `readBlob` over the git command line. Read-only. |
| `src/persistence/prisma/context-contract.prisma.ts` | `PrismaContextContractStore`: one transaction, write once. |
| `src/activities/refinement.activities.ts` | The `refine` Temporal activity of SDD §63. |
| `src/activities/context.activities.ts` | The `resolveContext` Temporal activity of SDD §63. |
| `src/telemetry/metrics.ts` | Modified: the three SDD §62 metrics this phase owns. |
| `src/domain/runs/run-status.ts` | Modified: the `REFINEMENT_UNRESOLVED` and `CONTEXT_UNRESOLVED` failure reasons. |
| `src/workflows/agent-run.workflow.ts` | Modified: `REFINING`, `WAITING_FOR_INPUT`, `RESOLVING_CONTEXT`, the question rounds, and the pinned refs. |
| `src/domain/runs/delegation-service.ts` | Modified: passes the Work Item and the Project blocks instead of a built sandbox input. |
| `src/activities/index.ts` | Modified: registers the two new activity groups. |
| `src/bin/worker.ts` | Modified: constructs the refinement engine, the source registry, the resolver, and the store. |
| `prisma/schema.prisma` | Modified: `ContextContract`, `ContextItem`, `ContextConflict`. |
| `prisma/migrations/20260823120000_add_context_contract/migration.sql` | The hand-written migration. |
| `tests/support/fake-context-contract-store.ts` | An in-memory `ContextContractStore` for unit and workflow tests. |
| `tests/support/fake-repository-reader.ts` | An in-memory `GitRepositoryReader` for unit tests. |
| `tests/acceptance/support/context-fixture-repository.ts` | Builds a real local git repository holding an ADR, a README, tests, and a config file. |

---

## Environment notes for every task

The shell alias `cat` on this machine points at a broken `bat`. Use `/bin/cat` in any command. Never write a file through a `cat` heredoc, and never build a commit message with `git commit -m "$(cat <<EOF ...)"`. Use `git commit -F` with a file instead.

Node 24 is at `/opt/homebrew/opt/node@24/bin`. Every command below prefixes `PATH` with it.

`timeout` and `gtimeout` are not installed. Docker is required for the integration and workflow suites.

The Prisma CLI resolves `DATABASE_URL` eagerly, so every CLI call needs a value. Write the migration SQL by hand and apply it through the Testcontainers database.

---
### Task 1: Parse the Work Item

**Files:**
- Create: `src/domain/refinement/work-item.ts`
- Test: `tests/unit/work-item.test.ts`

**Interfaces:**
- Consumes: nothing outside the standard library.
- Produces:
  - `interface WorkItemSource { issueId: string | null; title: string; description: string; url: string | null; labels: string[] }`
  - `interface WorkItemReference { kind: "url" | "repository" | "text"; value: string }`
  - `interface AcceptanceCriterion { id: string; statement: string; source: string }`
  - `interface WorkItem { goal: string; acceptanceCriteria: AcceptanceCriterion[]; constraints: string[]; references: WorkItemReference[]; openQuestions: string[]; labels: string[]; issueId: string | null; url: string | null }`
  - `parseWorkItem(source: WorkItemSource): WorkItem`
  - `REPOSITORY_SLUG: RegExp`

**Behaviour the parser must have:**

- The body is split on ATX headings of any level. A heading whose text, lowercased and stripped of punctuation, is `goal`, `acceptance criteria`, `constraints`, `references`, or `open questions` opens the matching section. Any other heading opens no section, and its text stays inside the section it follows.
- A body with no recognised heading is entirely the goal.
- The goal is the title joined to the goal section text by a blank line. A title alone is a valid goal.
- An acceptance criterion is a list item of the acceptance criteria section. A leading `AC-<n>:` marker sets the identifier. A list item without one gets `AC-<n>` from its position, counting from one over the whole section.
- `source` is `linear:<issueId>` when an issue identifier exists, and `linear:unknown` otherwise.
- A constraint is one list item, or one non-empty line when the section has no list.
- A reference is a bare URL, a markdown link target, or an `owner/repo` slug. The slug pattern is anchored and permits `A-Za-z0-9._-` in each half, and rejects a half that is `.` or `..`.
- An open question is a list item or a line of the open questions section, and any line of the goal, constraints, or acceptance criteria sections that ends in `?`.
- Every returned string is trimmed, and no returned list holds an empty string.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/work-item.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseWorkItem } from "~/domain/refinement/work-item.js";

const source = (description: string, title = "Add a webhook retry") => ({
  issueId: "issue-1",
  title,
  description,
  url: "https://linear.app/acme/issue/ACME-1",
  labels: [] as string[],
});

const structured = `
## Goal

Deliveries must survive a transient receiver outage.

## Acceptance criteria

- AC-1: A failed delivery is retried three times.
- A delivery that never succeeds is recorded as failed.

## Constraints

- Do not change the public webhook payload.

## References

- https://example.com/adr/031
- acme/notification-service
`;

describe("parseWorkItem", () => {
  it("reads every documented section of SDD section 7", () => {
    const item = parseWorkItem(source(structured));
    expect(item.goal).toBe(
      "Add a webhook retry\n\nDeliveries must survive a transient receiver outage.",
    );
    expect(item.acceptanceCriteria).toEqual([
      { id: "AC-1", statement: "A failed delivery is retried three times.", source: "linear:issue-1" },
      {
        id: "AC-2",
        statement: "A delivery that never succeeds is recorded as failed.",
        source: "linear:issue-1",
      },
    ]);
    expect(item.constraints).toEqual(["Do not change the public webhook payload."]);
    expect(item.references).toEqual([
      { kind: "url", value: "https://example.com/adr/031" },
      { kind: "repository", value: "acme/notification-service" },
    ]);
    expect(item.openQuestions).toEqual([]);
  });

  it("treats a body with no heading as the goal", () => {
    const item = parseWorkItem(source("Retries are missing and deliveries are lost."));
    expect(item.goal).toBe("Add a webhook retry\n\nRetries are missing and deliveries are lost.");
    expect(item.acceptanceCriteria).toEqual([]);
  });

  it("uses the title alone when the body is empty", () => {
    expect(parseWorkItem(source("")).goal).toBe("Add a webhook retry");
  });

  it("keeps an unrecognised heading inside the section it follows", () => {
    const item = parseWorkItem(source("## Goal\n\nFix it.\n\n### Background\n\nIt broke.\n"));
    expect(item.goal).toBe("Add a webhook retry\n\nFix it.\n\n### Background\n\nIt broke.");
  });

  it("reads a heading of any level and ignores its punctuation and case", () => {
    const item = parseWorkItem(source("#### ACCEPTANCE CRITERIA:\n\n- It works.\n"));
    expect(item.acceptanceCriteria).toEqual([
      { id: "AC-1", statement: "It works.", source: "linear:issue-1" },
    ]);
  });

  it("numbers an unmarked criterion by its position over the whole section", () => {
    const item = parseWorkItem(source("## Acceptance criteria\n\n- One.\n- AC-7: Seven.\n- Three.\n"));
    expect(item.acceptanceCriteria.map((criterion) => criterion.id)).toEqual(["AC-1", "AC-7", "AC-3"]);
  });

  it("marks the source as unknown when the issue has no identifier", () => {
    const item = parseWorkItem({
      issueId: null,
      title: "T",
      description: "## Acceptance criteria\n\n- One.\n",
      url: null,
      labels: [],
    });
    expect(item.acceptanceCriteria[0]?.source).toBe("linear:unknown");
  });

  it("reads a constraints section that uses plain lines", () => {
    const item = parseWorkItem(source("## Constraints\n\nKeep the API stable.\nDo not add a dependency.\n"));
    expect(item.constraints).toEqual(["Keep the API stable.", "Do not add a dependency."]);
  });

  it("reads a markdown link target as a reference", () => {
    const item = parseWorkItem(source("## References\n\n- [ADR 31](https://example.com/adr/031)\n"));
    expect(item.references).toEqual([{ kind: "url", value: "https://example.com/adr/031" }]);
  });

  it("rejects a slug half that is a dot segment", () => {
    const item = parseWorkItem(source("## References\n\n- owner/.\n- ../repo\n"));
    expect(item.references).toEqual([{ kind: "text", value: "owner/." }, { kind: "text", value: "../repo" }]);
  });

  it("collects an open questions section", () => {
    const item = parseWorkItem(source("## Open questions\n\n- Which queue do we use?\n"));
    expect(item.openQuestions).toEqual(["Which queue do we use?"]);
  });

  it("collects a question mark line from the goal", () => {
    const item = parseWorkItem(source("## Goal\n\nRetry deliveries.\nDo we retry a 4xx response?\n"));
    expect(item.openQuestions).toEqual(["Do we retry a 4xx response?"]);
  });

  it("collects a question mark line from the acceptance criteria", () => {
    const item = parseWorkItem(source("## Acceptance criteria\n\n- How many retries?\n"));
    expect(item.openQuestions).toEqual(["How many retries?"]);
  });

  it("keeps the labels of the source", () => {
    const item = parseWorkItem({ ...source(""), labels: ["security", "backend"] });
    expect(item.labels).toEqual(["security", "backend"]);
  });

  it("returns no empty string in any list", () => {
    const item = parseWorkItem(source("## Constraints\n\n-\n-   \n- Real.\n"));
    expect(item.constraints).toEqual(["Real."]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/work-item.test.ts
```

Expected: FAIL. The module `~/domain/refinement/work-item.js` does not exist.

- [ ] **Step 3: Write the parser**

Create `src/domain/refinement/work-item.ts`:

```ts
/**
 * SDD section 7 recommends a Work Item structure and states that Factoree should accept an
 * imperfect ticket. This parser therefore reads the recommended structure when it is present
 * and degrades to "the whole body is the goal" when it is not. It never rewrites text, because
 * SDD section 7 forbids Factoree from inventing material product behavior.
 */

export interface WorkItemSource {
  issueId: string | null;
  title: string;
  description: string;
  url: string | null;
  labels: string[];
}

export interface WorkItemReference {
  kind: "url" | "repository" | "text";
  value: string;
}

export interface AcceptanceCriterion {
  id: string;
  statement: string;
  /** SDD section 8 requires the origin of a proposed criterion. */
  source: string;
}

export interface WorkItem {
  goal: string;
  acceptanceCriteria: AcceptanceCriterion[];
  constraints: string[];
  references: WorkItemReference[];
  openQuestions: string[];
  labels: string[];
  issueId: string | null;
  url: string | null;
}

/**
 * An `owner/repo` slug. Each half permits a letter, a digit, a dot, an underscore, and a
 * hyphen, and no half may be a bare dot segment. `buildRepositoryUrl` applies the same rule, so
 * a slug this parser accepts is a slug a checkout can use.
 */
export const REPOSITORY_SLUG = /^(?!\.{1,2}\/)[A-Za-z0-9._-]+\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

type SectionName = "goal" | "acceptance" | "constraints" | "references" | "questions";

const HEADING = /^#{1,6}\s+(.*)$/;

const SECTION_BY_TITLE = new Map<string, SectionName>([
  ["goal", "goal"],
  ["acceptance criteria", "acceptance"],
  ["acceptance criterion", "acceptance"],
  ["constraints", "constraints"],
  ["references", "references"],
  ["open questions", "questions"],
]);

/** Lowercases a heading and removes the trailing punctuation an author often adds. */
const headingKey = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[:.*_`]+/g, "")
    .trim();

/** Splits the body into the recognised sections. Unrecognised headings stay inside their section. */
const splitSections = (body: string): Map<SectionName, string[]> => {
  const sections = new Map<SectionName, string[]>();
  let current: SectionName | null = null;
  for (const line of body.split("\n")) {
    const heading = HEADING.exec(line);
    const named = heading === null ? undefined : SECTION_BY_TITLE.get(headingKey(heading[1] ?? ""));
    if (named !== undefined) {
      current = named;
      if (!sections.has(named)) sections.set(named, []);
      continue;
    }
    if (current === null) continue;
    sections.get(current)?.push(line);
  }
  return sections;
};

const textOf = (sections: Map<SectionName, string[]>, name: SectionName): string =>
  (sections.get(name) ?? []).join("\n").trim();

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/** The list items of a section. Empty when the section holds no list. */
const listItemsOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => LIST_ITEM.exec(line)?.[1]?.trim() ?? null)
    .filter((item): item is string => item !== null && item !== "");

/** The non-empty lines of a section, with any list marker removed. */
const linesOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => (LIST_ITEM.exec(line)?.[1] ?? line).trim())
    .filter((line) => line !== "");

/** The list items when the section holds a list, and its plain lines otherwise. */
const itemsOf = (text: string): string[] => {
  const items = listItemsOf(text);
  return items.length > 0 ? items : linesOf(text);
};

const AC_MARKER = /^(AC-\d+)\s*[:.\-–]\s*(.*)$/i;

const acceptanceCriteriaOf = (text: string, source: string): AcceptanceCriterion[] =>
  itemsOf(text).map((item, index) => {
    const marked = AC_MARKER.exec(item);
    const statement = marked?.[2]?.trim();
    // A marked item keeps its own identifier. An unmarked item is numbered by its position, so
    // two unmarked items can never collide.
    if (marked !== null && statement !== undefined && statement !== "") {
      return { id: (marked[1] ?? "").toUpperCase(), statement, source };
    }
    return { id: `AC-${index + 1}`, statement: item, source };
  });

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const BARE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+$/;

const referenceOf = (value: string): WorkItemReference => {
  if (BARE_URL.test(value)) return { kind: "url", value };
  if (REPOSITORY_SLUG.test(value)) return { kind: "repository", value };
  return { kind: "text", value };
};

const referencesOf = (text: string): WorkItemReference[] => {
  const values: string[] = [];
  for (const item of itemsOf(text)) {
    const links = [...item.matchAll(MARKDOWN_LINK)].map((match) => match[1] ?? "");
    // A markdown link hides its target inside the line, so the target replaces the line. A line
    // with no link is itself the reference.
    if (links.length > 0) values.push(...links);
    else values.push(item);
  }
  const seen = new Set<string>();
  const references: WorkItemReference[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    references.push(referenceOf(trimmed));
  }
  return references;
};

/**
 * SDD section 8 requires Factoree to identify a missing decision rather than choose one. A line
 * that ends in a question mark is the one marker an author writes without being asked to.
 */
const questionLinesOf = (text: string): string[] =>
  linesOf(text).filter((line) => line.endsWith("?"));

export const parseWorkItem = (source: WorkItemSource): WorkItem => {
  const title = source.title.trim();
  const body = source.description.trim();
  const sections = splitSections(body);
  const hasSection = sections.size > 0;

  const goalSection = hasSection ? textOf(sections, "goal") : body;
  const goal = [title, goalSection].filter((part) => part !== "").join("\n\n");

  const acceptanceText = textOf(sections, "acceptance");
  const constraintsText = textOf(sections, "constraints");
  const referencesText = textOf(sections, "references");
  const questionsText = textOf(sections, "questions");

  const criterionSource = `linear:${source.issueId ?? "unknown"}`;

  const openQuestions = [
    ...itemsOf(questionsText),
    ...questionLinesOf(goalSection),
    ...questionLinesOf(constraintsText),
    ...questionLinesOf(acceptanceText),
  ].filter((question, index, all) => question !== "" && all.indexOf(question) === index);

  return {
    goal,
    acceptanceCriteria: acceptanceCriteriaOf(acceptanceText, criterionSource),
    constraints: itemsOf(constraintsText),
    references: referencesOf(referencesText),
    openQuestions,
    labels: [...source.labels],
    issueId: source.issueId,
    url: source.url,
  };
};
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/work-item.test.ts
```

Expected: PASS, 14 tests.

- [ ] **Step 5: Run lint and typecheck**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain/refinement/work-item.ts tests/unit/work-item.test.ts
git commit -m "feat: parse the Work Item structure of SDD section 7"
```

---

### Task 2: The Refinement engine

**Files:**
- Create: `src/domain/refinement/risk.ts`
- Create: `src/domain/refinement/refinement-engine.ts`
- Test: `tests/unit/risk.test.ts`
- Test: `tests/unit/refinement-engine.test.ts`

**Interfaces:**
- Consumes: `parseWorkItem`, `WorkItem`, `WorkItemSource`, `AcceptanceCriterion`, `REPOSITORY_SLUG` from Task 1.
- Produces:
  - `HIGH_RISK_LABELS: readonly string[]`
  - `AUTONOMY_LEVELS: readonly ["L0","L1","L2","L3","L4"]`, `type AutonomyLevel`
  - `highRiskLabelsOf(labels: string[]): string[]`
  - `capAutonomy(level: string, highRisk: boolean): AutonomyLevel`
  - `interface RefinementQuestion { id: string; question: string; whyMaterial: string }`
  - `interface RecordedDecision { questionId: string; question: string; answer: string }`
  - `interface RefinementInput { source: WorkItemSource; project: { primaryRepository: string; referenceRepositories: string[]; defaultAutonomy: string }; decisions: RecordedDecision[] }`
  - `interface RefinementOutput { status: "ready" | "needs_input"; workItem: WorkItem; goal: string; primaryRepository: string; referenceRepositories: string[]; proposedAcceptanceCriteria: AcceptanceCriterion[]; risks: string[]; unresolvedQuestions: RefinementQuestion[]; autonomyLevel: AutonomyLevel; decisions: RecordedDecision[] }`
  - `class RefinementEngine { refine(input: RefinementInput): RefinementOutput }`

**Behaviour the engine must have:**

- The primary repository always comes from the Project record. SDD §18 ranks Work Item references first, but SDD §8 forbids overriding an explicit user decision, and the Project mapping is that decision.
- A reference repository slug is selected only when the Project record already lists it. A slug named in the Work Item and absent from the record becomes the risk `unconfigured-repository:<slug>` (controller decision 16).
- A proposed acceptance criterion comes from the acceptance criteria section when one exists. When none exists, one criterion is derived per non-empty sentence of the goal, with `source` set to `derived:goal`. A derived criterion restates the sentence and adds nothing.
- A question is material when it is an open question of the Work Item, or when the goal is empty. Each question that a recorded decision answers is removed, and the decision text joins the output.
- The output status is `needs_input` when any unresolved question remains, and `ready` otherwise.
- A risk is a Work Item label in the SDD §28 list, plus `no-acceptance-criteria` when the Work Item stated none, plus each `unconfigured-repository:<slug>`.
- The autonomy level is the Project default, capped at `L2` when any SDD §28 label is present. A level the Project record does not recognise falls back to `L2`, because SDD §27 makes L4 forbidden in Version 1 and a lower cap is always the safe direction.
- `L4` is capped to `L3` always, because SDD §27 states Version 1 MUST NOT merge automatically.

- [ ] **Step 1: Write the failing risk test**

Create `tests/unit/risk.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HIGH_RISK_LABELS, capAutonomy, highRiskLabelsOf } from "~/domain/refinement/risk.js";

describe("highRiskLabelsOf", () => {
  it("lists the SDD section 28 labels", () => {
    expect([...HIGH_RISK_LABELS]).toEqual([
      "security",
      "authentication",
      "authorization",
      "payments",
      "billing",
      "cryptography",
      "database-migration",
      "infrastructure",
      "secrets",
    ]);
  });

  it("matches a label whatever its case and surrounding space", () => {
    expect(highRiskLabelsOf([" Security ", "Backend"])).toEqual(["security"]);
  });

  it("returns each matched label once and in the SDD order", () => {
    expect(highRiskLabelsOf(["secrets", "security", "secrets"])).toEqual(["security", "secrets"]);
  });

  it("returns nothing for an ordinary label", () => {
    expect(highRiskLabelsOf(["frontend"])).toEqual([]);
  });
});

describe("capAutonomy", () => {
  it("keeps the level when no high risk label is present", () => {
    expect(capAutonomy("L3", false)).toBe("L3");
  });

  it("caps a high risk Run at L2", () => {
    expect(capAutonomy("L3", true)).toBe("L2");
  });

  it("does not raise a level below the cap", () => {
    expect(capAutonomy("L0", true)).toBe("L0");
  });

  it("caps L4 to L3, because Version 1 must not merge automatically", () => {
    expect(capAutonomy("L4", false)).toBe("L3");
  });

  it("falls back to L2 for an unknown level", () => {
    expect(capAutonomy("L9", false)).toBe("L2");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/risk.test.ts
```

Expected: FAIL. The module does not exist.

- [ ] **Step 3: Write the risk module**

Create `src/domain/refinement/risk.ts`:

```ts
/** SDD section 28. The default high-risk labels, in the order the specification lists them. */
export const HIGH_RISK_LABELS = [
  "security",
  "authentication",
  "authorization",
  "payments",
  "billing",
  "cryptography",
  "database-migration",
  "infrastructure",
  "secrets",
] as const;

export const AUTONOMY_LEVELS = ["L0", "L1", "L2", "L3", "L4"] as const;

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

const HIGH_RISK = new Set<string>(HIGH_RISK_LABELS);

/** The SDD section 28 labels a Work Item carries, in the SDD order and without a duplicate. */
export const highRiskLabelsOf = (labels: string[]): string[] => {
  const present = new Set(labels.map((label) => label.trim().toLowerCase()));
  return HIGH_RISK_LABELS.filter((label) => present.has(label));
};

const rankOf = (level: string): number => AUTONOMY_LEVELS.indexOf(level as AutonomyLevel);

/**
 * SDD section 28. A high-risk label caps autonomy at L2 unless Project policy overrides the cap,
 * and no Project policy override exists in Version 1. SDD section 27 reserves L4 for a future
 * version, so L4 can never survive. An unrecognised level falls back to L2, because a lower
 * level is always the safe direction.
 */
export const capAutonomy = (level: string, highRisk: boolean): AutonomyLevel => {
  const rank = rankOf(level);
  if (rank < 0) return "L2";
  const ceiling = highRisk ? rankOf("L2") : rankOf("L3");
  return AUTONOMY_LEVELS[Math.min(rank, ceiling)] ?? "L2";
};
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/risk.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Write the failing engine test**

Create `tests/unit/refinement-engine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RefinementEngine } from "~/domain/refinement/refinement-engine.js";
import type { RefinementInput } from "~/domain/refinement/refinement-engine.js";

const engine = new RefinementEngine();

const input = (over: Partial<RefinementInput> = {}): RefinementInput => ({
  source: {
    issueId: "issue-1",
    title: "Add a webhook retry",
    description: "## Goal\n\nDeliveries must survive a transient outage.\n",
    url: "https://linear.app/acme/issue/ACME-1",
    labels: [],
  },
  project: {
    primaryRepository: "acme/webhook-service",
    referenceRepositories: ["acme/notification-service"],
    defaultAutonomy: "L3",
  },
  decisions: [],
  ...over,
});

describe("RefinementEngine", () => {
  it("takes the primary repository from the Project record", () => {
    const output = engine.refine(input());
    expect(output.primaryRepository).toBe("acme/webhook-service");
  });

  it("does not let the Work Item override the configured primary repository", () => {
    const output = engine.refine(
      input({
        source: {
          ...input().source,
          description: "## References\n\n- other/repo\n",
        },
      }),
    );
    expect(output.primaryRepository).toBe("acme/webhook-service");
  });

  it("selects a reference repository the Work Item names and the Project record lists", () => {
    const output = engine.refine(
      input({
        source: {
          ...input().source,
          description: "## Goal\n\nRetry.\n\n## References\n\n- acme/notification-service\n",
        },
      }),
    );
    expect(output.referenceRepositories).toEqual(["acme/notification-service"]);
  });

  it("keeps every configured reference repository even when the Work Item names none", () => {
    expect(engine.refine(input()).referenceRepositories).toEqual(["acme/notification-service"]);
  });

  it("records an unconfigured slug as a risk and does not select it", () => {
    const output = engine.refine(
      input({
        source: { ...input().source, description: "## References\n\n- other/repo\n" },
      }),
    );
    expect(output.referenceRepositories).toEqual(["acme/notification-service"]);
    expect(output.risks).toContain("unconfigured-repository:other/repo");
  });

  it("proposes the stated acceptance criteria unchanged", () => {
    const output = engine.refine(
      input({
        source: {
          ...input().source,
          description: "## Acceptance criteria\n\n- AC-1: A failed delivery is retried.\n",
        },
      }),
    );
    expect(output.proposedAcceptanceCriteria).toEqual([
      { id: "AC-1", statement: "A failed delivery is retried.", source: "linear:issue-1" },
    ]);
    expect(output.risks).not.toContain("no-acceptance-criteria");
  });

  it("derives one candidate criterion per goal sentence when the Work Item states none", () => {
    const output = engine.refine(
      input({
        source: {
          ...input().source,
          title: "Retry deliveries",
          description: "## Goal\n\nA delivery is retried. A failed delivery is recorded.\n",
        },
      }),
    );
    expect(output.proposedAcceptanceCriteria).toEqual([
      { id: "AC-1", statement: "Retry deliveries", source: "derived:goal" },
      { id: "AC-2", statement: "A delivery is retried.", source: "derived:goal" },
      { id: "AC-3", statement: "A failed delivery is recorded.", source: "derived:goal" },
    ]);
    expect(output.risks).toContain("no-acceptance-criteria");
  });

  it("is ready when nothing is unresolved", () => {
    const output = engine.refine(input());
    expect(output.status).toBe("ready");
    expect(output.unresolvedQuestions).toEqual([]);
  });

  it("needs input when the Work Item states an open question", () => {
    const output = engine.refine(
      input({
        source: {
          ...input().source,
          description: "## Goal\n\nRetry.\n\n## Open questions\n\n- Do we retry a 4xx response?\n",
        },
      }),
    );
    expect(output.status).toBe("needs_input");
    expect(output.unresolvedQuestions).toEqual([
      {
        id: "Q-1",
        question: "Do we retry a 4xx response?",
        whyMaterial:
          "The Work Item leaves this decision open. Factoree must not invent product behavior, " +
          "so implementation cannot start safely without an answer.",
      },
    ]);
  });

  it("needs input when the Work Item states no goal at all", () => {
    const output = engine.refine(
      input({ source: { ...input().source, title: "", description: "" } }),
    );
    expect(output.status).toBe("needs_input");
    expect(output.unresolvedQuestions[0]?.id).toBe("Q-1");
    expect(output.unresolvedQuestions[0]?.question).toMatch(/required outcome/i);
  });

  it("treats an answered question as resolved and keeps the decision", () => {
    const withQuestion = input({
      source: {
        ...input().source,
        description: "## Goal\n\nRetry.\n\n## Open questions\n\n- Do we retry a 4xx response?\n",
      },
    });
    const output = engine.refine({
      ...withQuestion,
      decisions: [
        { questionId: "Q-1", question: "Do we retry a 4xx response?", answer: "No. Retry 5xx only." },
      ],
    });
    expect(output.status).toBe("ready");
    expect(output.unresolvedQuestions).toEqual([]);
    expect(output.decisions).toEqual([
      { questionId: "Q-1", question: "Do we retry a 4xx response?", answer: "No. Retry 5xx only." },
    ]);
  });

  it("gives each question a stable identifier across two refinements", () => {
    const twoQuestions = input({
      source: {
        ...input().source,
        description: "## Goal\n\nRetry.\n\n## Open questions\n\n- First?\n- Second?\n",
      },
    });
    const first = engine.refine(twoQuestions);
    expect(first.unresolvedQuestions.map((question) => question.id)).toEqual(["Q-1", "Q-2"]);
    const second = engine.refine({
      ...twoQuestions,
      decisions: [{ questionId: "Q-1", question: "First?", answer: "Yes." }],
    });
    expect(second.unresolvedQuestions.map((question) => question.id)).toEqual(["Q-2"]);
  });

  it("caps autonomy at L2 for a high risk label and records the label as a risk", () => {
    const output = engine.refine({
      ...input(),
      source: { ...input().source, labels: ["security"] },
    });
    expect(output.autonomyLevel).toBe("L2");
    expect(output.risks).toContain("security");
  });

  it("keeps the Project autonomy level when no high risk label is present", () => {
    expect(engine.refine(input()).autonomyLevel).toBe("L3");
  });

  it("returns the goal of the parsed Work Item", () => {
    expect(engine.refine(input()).goal).toBe(
      "Add a webhook retry\n\nDeliveries must survive a transient outage.",
    );
  });

  it("changes no source code, because it holds no file system port", () => {
    // The engine constructor takes no argument, so it cannot reach a file, a repository, or a
    // network. SDD section 8 forbids Refinement from modifying source code, and this test states
    // the structural reason that prohibition holds.
    expect(RefinementEngine.length).toBe(0);
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/refinement-engine.test.ts
```

Expected: FAIL. The module does not exist.

- [ ] **Step 7: Write the engine**

Create `src/domain/refinement/refinement-engine.ts`:

```ts
import type { AcceptanceCriterion, WorkItem, WorkItemSource } from "./work-item.js";
import { parseWorkItem } from "./work-item.js";
import type { AutonomyLevel } from "./risk.js";
import { capAutonomy, highRiskLabelsOf } from "./risk.js";

/** SDD section 8. One decision a human must take before implementation can start safely. */
export interface RefinementQuestion {
  id: string;
  question: string;
  whyMaterial: string;
}

/** SDD section 23. A persisted human answer to one focused question. */
export interface RecordedDecision {
  questionId: string;
  question: string;
  answer: string;
}

export interface RefinementProject {
  primaryRepository: string;
  referenceRepositories: string[];
  defaultAutonomy: string;
}

export interface RefinementInput {
  source: WorkItemSource;
  project: RefinementProject;
  decisions: RecordedDecision[];
}

/** SDD section 8 fixes this output shape. */
export interface RefinementOutput {
  status: "ready" | "needs_input";
  workItem: WorkItem;
  goal: string;
  primaryRepository: string;
  referenceRepositories: string[];
  proposedAcceptanceCriteria: AcceptanceCriterion[];
  risks: string[];
  unresolvedQuestions: RefinementQuestion[];
  autonomyLevel: AutonomyLevel;
  decisions: RecordedDecision[];
}

const WHY_OPEN_QUESTION =
  "The Work Item leaves this decision open. Factoree must not invent product behavior, " +
  "so implementation cannot start safely without an answer.";

const WHY_NO_GOAL =
  "The Work Item states no required outcome. Factoree cannot define correctness without one.";

const NO_GOAL_QUESTION = "What is the required outcome of this work?";

/**
 * Splits a goal into sentences. A sentence ends at a full stop, a question mark, or an
 * exclamation mark followed by a space or the end of the text, or at a line break.
 */
const sentencesOf = (goal: string): string[] =>
  goal
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");

/**
 * SDD section 7 permits Factoree to propose acceptance criteria and forbids it from inventing
 * material product behavior. A derived criterion is therefore a restatement of one sentence the
 * author already wrote, and it is marked `derived:goal` so a human can see it is a proposal.
 */
const deriveAcceptanceCriteria = (goal: string): AcceptanceCriterion[] =>
  sentencesOf(goal).map((statement, index) => ({
    id: `AC-${index + 1}`,
    statement,
    source: "derived:goal",
  }));

/**
 * SDD section 14 names this module `RefinementEngine`. It holds no port, so it can reach no
 * file, no repository, and no network. SDD section 8 forbids Refinement from modifying source
 * code, and that prohibition holds here by construction rather than by discipline.
 */
export class RefinementEngine {
  refine(input: RefinementInput): RefinementOutput {
    const workItem = parseWorkItem(input.source);

    // Every question the Work Item raises, numbered in a stable order. The identifier depends on
    // the position in this list only, so a second refinement of the same Work Item numbers the
    // same question the same way and a recorded answer keeps matching it.
    const allQuestions: RefinementQuestion[] =
      workItem.goal === ""
        ? [{ id: "Q-1", question: NO_GOAL_QUESTION, whyMaterial: WHY_NO_GOAL }]
        : workItem.openQuestions.map((question, index) => ({
            id: `Q-${index + 1}`,
            question,
            whyMaterial: WHY_OPEN_QUESTION,
          }));

    const answered = new Set(input.decisions.map((decision) => decision.questionId));
    const unresolvedQuestions = allQuestions.filter((question) => !answered.has(question.id));

    const configured = new Set(input.project.referenceRepositories);
    const namedSlugs = workItem.references
      .filter((reference) => reference.kind === "repository")
      .map((reference) => reference.value);

    // SDD section 8 forbids overriding an explicit user decision. The Project record is that
    // decision, so a slug the record does not list is reported and not used. See controller
    // decision 16.
    const unconfigured = namedSlugs.filter(
      (slug) => !configured.has(slug) && slug !== input.project.primaryRepository,
    );

    const statedCriteria = workItem.acceptanceCriteria;
    const proposedAcceptanceCriteria =
      statedCriteria.length > 0 ? statedCriteria : deriveAcceptanceCriteria(workItem.goal);

    const highRisk = highRiskLabelsOf(workItem.labels);
    const risks = [
      ...highRisk,
      ...(statedCriteria.length === 0 ? ["no-acceptance-criteria"] : []),
      ...unconfigured.map((slug) => `unconfigured-repository:${slug}`),
    ];

    return {
      status: unresolvedQuestions.length > 0 ? "needs_input" : "ready",
      workItem,
      goal: workItem.goal,
      primaryRepository: input.project.primaryRepository,
      referenceRepositories: [...input.project.referenceRepositories],
      proposedAcceptanceCriteria,
      risks,
      unresolvedQuestions,
      autonomyLevel: capAutonomy(input.project.defaultAutonomy, highRisk.length > 0),
      decisions: [...input.decisions],
    };
  }
}
```

- [ ] **Step 8: Run the engine test and confirm it passes**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/refinement-engine.test.ts
```

Expected: PASS, 16 tests.

- [ ] **Step 9: Run lint and typecheck**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck
```

Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/domain/refinement tests/unit/risk.test.ts tests/unit/refinement-engine.test.ts
git commit -m "feat: add the deterministic Refinement engine of SDD section 8"
```

---
### Task 3: Authority rules, the context source interface, and the registry

**Files:**
- Create: `src/domain/context/authority.ts`
- Create: `src/domain/context/context-source.ts`
- Create: `src/domain/context/context-source-registry.ts`
- Create: `src/domain/context/topics.ts`
- Test: `tests/unit/context-authority.test.ts`
- Test: `tests/unit/context-source-registry.test.ts`
- Test: `tests/unit/context-topics.test.ts`

**Interfaces:**
- Consumes: nothing outside the standard library.
- Produces:
  - `AUTHORITY_CLASSES: readonly AuthorityClass[]`, `type AuthorityClass`
  - `type AuthorityDomain = "product_intent" | "architecture_intent" | "interface_contract" | "current_implementation" | "system_topology"`
  - `authorityDomainOf(authority: AuthorityClass): AuthorityDomain`
  - `authorityRankOf(authority: AuthorityClass): number` — 0 is the highest rung of its domain.
  - `compareAuthority(a: AuthorityClass, b: AuthorityClass): "a" | "b" | "equal" | "unrelated"`
  - `CONTEXT_CLASSIFICATIONS: readonly ["required","reference","discoverable"]`, `type ContextClassification`
  - `interface ContextDiscoveryRequest { runId: string; goal: string; topics: string[]; primaryRepository: RepositoryRef; referenceRepositories: RepositoryRef[]; workItemReferences: string[]; decisions: RecordedDecision[] }`
  - `interface RepositoryRef { slug: string; url: string; ref: string }`
  - `interface ContextReference { sourceId: string; ref: string; repository: string | null; sha: string | null; path: string | null }`
  - `interface ContextCandidate { reference: ContextReference; sourceVersion: string; authority: AuthorityClass; reason: string; priority: number; topics: string[]; sizeBytes: number | null; suggestedClassification: ContextClassification }`
  - `interface ContextDocument { reference: ContextReference; sourceVersion: string; content: string }`
  - `interface ContextSource { id(): string; discover(request: ContextDiscoveryRequest): Promise<ContextCandidate[]>; fetch(ref: ContextReference): Promise<ContextDocument> }`
  - `DISCOVERY_PRIORITY: Record<DiscoveryRule, number>`, `type DiscoveryRule`
  - `class ContextSourceRegistry`, `class UnknownContextSourceError`
  - `topicsOf(input: { goal: string; acceptanceCriteria: string[] }): string[]`

**Behaviour:**

- `compareAuthority` returns `"unrelated"` when the two classes belong to different domains, because SDD §22 makes authority domain-specific. It returns `"equal"` when both classes share one domain and one rank, which is the unresolvable case of AT-08 and controller decision 8.
- `DISCOVERY_PRIORITY` mirrors the eight rules of SDD §18 in order, starting at 1. A lower number ranks higher.
- `topicsOf` lowercases the goal and every acceptance criterion, keeps words of four characters or more, removes a stop word, and returns each remaining word once, sorted. This is the only topic definition Phase 4 uses, so ranking and conflict detection can never disagree.

- [ ] **Step 1: Write the failing authority test**

Create `tests/unit/context-authority.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_CLASSES,
  authorityDomainOf,
  authorityRankOf,
  compareAuthority,
} from "~/domain/context/authority.js";

describe("authority", () => {
  it("lists every class of SDD section 22", () => {
    expect([...AUTHORITY_CLASSES]).toEqual([
      "work_item_decision",
      "approved_product_specification",
      "product_documentation",
      "accepted_adr",
      "approved_architecture_specification",
      "architecture_documentation",
      "repository_readme",
      "machine_readable_contract",
      "contract_tests",
      "api_documentation",
      "prose_documentation",
      "source_code",
      "executable_tests",
      "runtime_behavior",
      "declarative_catalog",
      "repository_configuration",
    ]);
  });

  it("places each class in its SDD section 22 domain", () => {
    expect(authorityDomainOf("work_item_decision")).toBe("product_intent");
    expect(authorityDomainOf("accepted_adr")).toBe("architecture_intent");
    expect(authorityDomainOf("repository_readme")).toBe("architecture_intent");
    expect(authorityDomainOf("machine_readable_contract")).toBe("interface_contract");
    expect(authorityDomainOf("source_code")).toBe("current_implementation");
    expect(authorityDomainOf("declarative_catalog")).toBe("system_topology");
  });

  it("ranks the product intent ladder", () => {
    expect(authorityRankOf("work_item_decision")).toBe(0);
    expect(authorityRankOf("approved_product_specification")).toBe(1);
    expect(authorityRankOf("product_documentation")).toBe(2);
  });

  it("ranks the architecture intent ladder", () => {
    expect(authorityRankOf("accepted_adr")).toBe(0);
    expect(authorityRankOf("approved_architecture_specification")).toBe(1);
    expect(authorityRankOf("architecture_documentation")).toBe(2);
    expect(authorityRankOf("repository_readme")).toBe(3);
  });

  it("ranks the interface contract ladder", () => {
    expect(authorityRankOf("machine_readable_contract")).toBe(0);
    expect(authorityRankOf("contract_tests")).toBe(1);
    expect(authorityRankOf("api_documentation")).toBe(2);
    expect(authorityRankOf("prose_documentation")).toBe(3);
  });

  it("gives current implementation one rung, because SDD section 22 joins its evidence", () => {
    expect(authorityRankOf("source_code")).toBe(0);
    expect(authorityRankOf("executable_tests")).toBe(0);
    expect(authorityRankOf("runtime_behavior")).toBe(0);
  });

  it("gives system topology one rung", () => {
    expect(authorityRankOf("declarative_catalog")).toBe(0);
    expect(authorityRankOf("repository_configuration")).toBe(0);
  });

  it("lets an accepted ADR win over a repository README", () => {
    expect(compareAuthority("accepted_adr", "repository_readme")).toBe("a");
    expect(compareAuthority("repository_readme", "accepted_adr")).toBe("b");
  });

  it("reports two accepted ADRs as equal, so no automatic resolution exists", () => {
    expect(compareAuthority("accepted_adr", "accepted_adr")).toBe("equal");
  });

  it("reports two classes of different domains as unrelated", () => {
    expect(compareAuthority("accepted_adr", "work_item_decision")).toBe("unrelated");
  });

  it("reports source code and executable tests as equal", () => {
    expect(compareAuthority("source_code", "executable_tests")).toBe("equal");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/context-authority.test.ts
```

Expected: FAIL. The module does not exist.

- [ ] **Step 3: Write the authority module**

Create `src/domain/context/authority.ts`:

```ts
/**
 * SDD section 22. Authority is domain-specific, so a class can be compared only with another
 * class of the same domain. Inside a domain the specification writes a ladder with `>`, except
 * for current implementation and system topology, which it writes as evidence joined with `+`.
 * Those two domains therefore have one rung, and any conflict inside them is unresolvable by
 * policy. See controller decision 8.
 */

export type AuthorityDomain =
  | "product_intent"
  | "architecture_intent"
  | "interface_contract"
  | "current_implementation"
  | "system_topology";

/**
 * The union is written out rather than derived, so the compiler keeps every class name a literal
 * type. A derived union over a nested array widens to `string`, and a widened authority class
 * would let a typing mistake reach the Context Contract.
 */
export type AuthorityClass =
  | "work_item_decision"
  | "approved_product_specification"
  | "product_documentation"
  | "accepted_adr"
  | "approved_architecture_specification"
  | "architecture_documentation"
  | "repository_readme"
  | "machine_readable_contract"
  | "contract_tests"
  | "api_documentation"
  | "prose_documentation"
  | "source_code"
  | "executable_tests"
  | "runtime_behavior"
  | "declarative_catalog"
  | "repository_configuration";

/** Each domain, highest authority first. A rung holding two classes makes them equal. */
const LADDERS: Record<AuthorityDomain, readonly (readonly AuthorityClass[])[]> = {
  product_intent: [
    ["work_item_decision"],
    ["approved_product_specification"],
    ["product_documentation"],
  ],
  architecture_intent: [
    ["accepted_adr"],
    ["approved_architecture_specification"],
    ["architecture_documentation"],
    ["repository_readme"],
  ],
  interface_contract: [
    ["machine_readable_contract"],
    ["contract_tests"],
    ["api_documentation"],
    ["prose_documentation"],
  ],
  current_implementation: [["source_code", "executable_tests", "runtime_behavior"]],
  system_topology: [["declarative_catalog", "repository_configuration"]],
};

const DOMAIN_ORDER: readonly AuthorityDomain[] = [
  "product_intent",
  "architecture_intent",
  "interface_contract",
  "current_implementation",
  "system_topology",
];

export const AUTHORITY_CLASSES: readonly AuthorityClass[] = DOMAIN_ORDER.flatMap((domain) =>
  LADDERS[domain].flat(),
);

interface Placement {
  domain: AuthorityDomain;
  rank: number;
}

const PLACEMENTS = new Map<string, Placement>(
  DOMAIN_ORDER.flatMap((domain) =>
    LADDERS[domain].flatMap((rung, rank) =>
      rung.map((authority) => [authority, { domain, rank }] as const),
    ),
  ),
);

export const isAuthorityClass = (value: string): value is AuthorityClass => PLACEMENTS.has(value);

const placementOf = (authority: AuthorityClass): Placement => {
  const placement = PLACEMENTS.get(authority);
  if (placement === undefined) {
    throw new Error(`"${authority}" is not an authority class of SDD section 22.`);
  }
  return placement;
};

export const authorityDomainOf = (authority: AuthorityClass): AuthorityDomain =>
  placementOf(authority).domain;

/** The rung inside the domain. Zero is the highest authority. */
export const authorityRankOf = (authority: AuthorityClass): number => placementOf(authority).rank;

/**
 * SDD section 23 permits automatic resolution only when authority policy gives a clear winner.
 * `equal` and `unrelated` both mean no clear winner exists.
 */
export const compareAuthority = (
  a: AuthorityClass,
  b: AuthorityClass,
): "a" | "b" | "equal" | "unrelated" => {
  const left = placementOf(a);
  const right = placementOf(b);
  if (left.domain !== right.domain) return "unrelated";
  if (left.rank < right.rank) return "a";
  if (left.rank > right.rank) return "b";
  return "equal";
};
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/context-authority.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Write the context source interface**

This file holds types only, so it needs no test of its own. The tasks that implement a source
test the shape.

Create `src/domain/context/context-source.ts`:

```ts
import type { RecordedDecision } from "~/domain/refinement/refinement-engine.js";
import type { AuthorityClass } from "./authority.js";

/** SDD section 21. Required items can enter initial role context. */
export const CONTEXT_CLASSIFICATIONS = ["required", "reference", "discoverable"] as const;

export type ContextClassification = (typeof CONTEXT_CLASSIFICATIONS)[number];

/** SDD section 18. The discovery priority, highest first. A lower number ranks higher. */
export const DISCOVERY_PRIORITY = {
  work_item_reference: 1,
  project_repository_mapping: 2,
  backstage_relation: 3,
  backstage_api_relation: 4,
  work_item_repository_name: 5,
  accepted_adr_reference: 6,
  declared_client_or_import: 7,
  scoped_semantic_search: 8,
} as const;

export type DiscoveryRule = keyof typeof DISCOVERY_PRIORITY;

export interface RepositoryRef {
  /** The `owner/repo` slug. */
  slug: string;
  /** The clone URL. */
  url: string;
  /** The requested ref. Discovery replaces it with an explicit SHA. */
  ref: string;
}

export interface ContextDiscoveryRequest {
  runId: string;
  goal: string;
  /** The deterministic keyword set of the Work Item. See `topicsOf`. */
  topics: string[];
  primaryRepository: RepositoryRef;
  referenceRepositories: RepositoryRef[];
  /** Every reference the Work Item declared, as written. */
  workItemReferences: string[];
  /** SDD section 23. Every human answer recorded on this Run so far. */
  decisions: RecordedDecision[];
}

/**
 * SDD section 21 requires a stable reference. `ref` is that reference and is unique inside one
 * contract. `repository`, `sha`, and `path` carry the SDD section 55 fields for a repository
 * item, and are null for an item that is not repository content.
 */
export interface ContextReference {
  sourceId: string;
  ref: string;
  repository: string | null;
  sha: string | null;
  path: string | null;
}

export interface ContextCandidate {
  reference: ContextReference;
  /** SDD section 21 and section 55. A commit SHA, a timestamp, or another stable version. */
  sourceVersion: string;
  authority: AuthorityClass;
  /** SDD section 21 requires a selection reason a human can read. */
  reason: string;
  /** The SDD section 18 priority of the rule that found this candidate. */
  priority: number;
  /** The Work Item topics this candidate carries. Ranking and conflict detection both use it. */
  topics: string[];
  /** The size of the content, when the source knows it without fetching. */
  sizeBytes: number | null;
  suggestedClassification: ContextClassification;
}

export interface ContextDocument {
  reference: ContextReference;
  sourceVersion: string;
  content: string;
}

/** SDD section 17. Every context source implements exactly this interface. */
export interface ContextSource {
  id(): string;
  discover(request: ContextDiscoveryRequest): Promise<ContextCandidate[]>;
  fetch(ref: ContextReference): Promise<ContextDocument>;
}
```

- [ ] **Step 6: Write the failing registry test**

Create `tests/unit/context-source-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ContextSourceRegistry,
  UnknownContextSourceError,
} from "~/domain/context/context-source-registry.js";
import type { ContextSource } from "~/domain/context/context-source.js";

const stub = (id: string): ContextSource => ({
  id: () => id,
  discover: () => Promise.resolve([]),
  fetch: () => Promise.reject(new Error("not used")),
});

describe("ContextSourceRegistry", () => {
  it("returns a registered source by its identifier", () => {
    const source = stub("linear");
    expect(new ContextSourceRegistry([source]).get("linear")).toBe(source);
  });

  it("lists every identifier in sorted order", () => {
    const registry = new ContextSourceRegistry([stub("repository"), stub("linear")]);
    expect(registry.ids()).toEqual(["linear", "repository"]);
  });

  it("returns every source in identifier order", () => {
    const registry = new ContextSourceRegistry([stub("repository"), stub("linear")]);
    expect(registry.all().map((source) => source.id())).toEqual(["linear", "repository"]);
  });

  it("refuses a duplicate identifier", () => {
    expect(() => new ContextSourceRegistry([stub("linear"), stub("linear")])).toThrow(/already registered/);
  });

  it("throws a named error for an unknown identifier", () => {
    expect(() => new ContextSourceRegistry([stub("linear")]).get("backstage")).toThrow(
      UnknownContextSourceError,
    );
  });

  it("names the registered identifiers in the error message", () => {
    expect(() => new ContextSourceRegistry([stub("linear")]).get("backstage")).toThrow(/linear/);
  });
});
```

- [ ] **Step 7: Run it and confirm it fails, then write the registry**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/context-source-registry.test.ts
```

Expected: FAIL. The module does not exist.

Create `src/domain/context/context-source-registry.ts`:

```ts
import type { ContextSource } from "./context-source.js";

export class UnknownContextSourceError extends Error {
  constructor(id: string, known: string[]) {
    super(`No context source is registered under "${id}". Registered sources: ${known.join(", ")}.`);
    this.name = "UnknownContextSourceError";
  }
}

/**
 * SDD section 14 names this module `ContextSourceRegistry`. SDD section 17 fixes the source
 * interface. Source selection is configuration driven, so no call site names a concrete source.
 */
export class ContextSourceRegistry {
  private readonly sources = new Map<string, ContextSource>();

  constructor(sources: ContextSource[] = []) {
    for (const source of sources) this.register(source);
  }

  register(source: ContextSource): void {
    const id = source.id();
    if (this.sources.has(id)) {
      throw new Error(`A context source named "${id}" is already registered.`);
    }
    this.sources.set(id, source);
  }

  get(id: string): ContextSource {
    const source = this.sources.get(id);
    if (source === undefined) throw new UnknownContextSourceError(id, this.ids());
    return source;
  }

  ids(): string[] {
    return [...this.sources.keys()].sort();
  }

  all(): ContextSource[] {
    return this.ids().map((id) => this.get(id));
  }
}
```

- [ ] **Step 8: Write the failing topics test**

Create `tests/unit/context-topics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { topicsOf } from "~/domain/context/topics.js";

describe("topicsOf", () => {
  it("keeps a significant word of the goal", () => {
    expect(topicsOf({ goal: "Retry webhook deliveries", acceptanceCriteria: [] })).toEqual([
      "deliveries",
      "retry",
      "webhook",
    ]);
  });

  it("removes a stop word", () => {
    expect(topicsOf({ goal: "Retry the delivery when it fails", acceptanceCriteria: [] })).toEqual([
      "delivery",
      "fails",
      "retry",
    ]);
  });

  it("removes a word shorter than four characters", () => {
    expect(topicsOf({ goal: "Fix the api now", acceptanceCriteria: [] })).toEqual([]);
  });

  it("reads the acceptance criteria as well", () => {
    expect(topicsOf({ goal: "Retry", acceptanceCriteria: ["Notification is queued"] })).toEqual([
      "notification",
      "queued",
      "retry",
    ]);
  });

  it("returns each topic once, sorted", () => {
    expect(topicsOf({ goal: "Retry retry RETRY", acceptanceCriteria: ["retry"] })).toEqual(["retry"]);
  });

  it("splits on punctuation and on a hyphen", () => {
    expect(topicsOf({ goal: "notification-service, please", acceptanceCriteria: [] })).toEqual([
      "notification",
      "please",
      "service",
    ]);
  });

  it("returns nothing for an empty Work Item", () => {
    expect(topicsOf({ goal: "", acceptanceCriteria: [] })).toEqual([]);
  });
});
```

- [ ] **Step 9: Write the topics module**

Create `src/domain/context/topics.ts`:

```ts
/**
 * The one topic definition of Phase 4. Ranking and conflict detection both call it, so they can
 * never disagree about what a Work Item is about. It is deliberately simple and deterministic:
 * SDD section 8 forbids Refinement from silently resolving an ambiguity, so a clever similarity
 * measure would be the wrong control here.
 */

const MINIMUM_LENGTH = 4;

/** Common English words that carry no topic. */
const STOP_WORDS = new Set([
  "about", "after", "again", "also", "always", "another", "because", "been", "before", "being",
  "below", "between", "both", "cannot", "could", "does", "doing", "done", "down", "during",
  "each", "either", "else", "enough", "even", "ever", "every", "from", "further", "have",
  "having", "here", "however", "into", "just", "like", "make", "makes", "many", "more", "most",
  "much", "must", "need", "needs", "next", "none", "only", "other", "over", "same", "shall",
  "should", "since", "some", "such", "than", "that", "their", "them", "then", "there", "these",
  "they", "this", "those", "through", "under", "until", "very", "when", "where", "which",
  "while", "will", "with", "within", "without", "would", "your",
]);

export const topicsOf = (input: { goal: string; acceptanceCriteria: string[] }): string[] => {
  const words = [input.goal, ...input.acceptanceCriteria]
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MINIMUM_LENGTH && !STOP_WORDS.has(word));
  return [...new Set(words)].sort();
};
```

- [ ] **Step 10: Run every new test, then lint and typecheck**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/context-authority.test.ts tests/unit/context-source-registry.test.ts tests/unit/context-topics.test.ts
npm run lint && npm run typecheck
```

Expected: PASS, 24 tests. Lint and typecheck exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/domain/context tests/unit/context-authority.test.ts tests/unit/context-source-registry.test.ts tests/unit/context-topics.test.ts
git commit -m "feat: add the SDD section 22 authority rules and the context source registry"
```

---

### Task 4: The read-only git repository reader

**Files:**
- Create: `src/adapters/github/git-repository-reader.ts`
- Test: `tests/integration/git-repository-reader.test.ts`

**Interfaces:**
- Consumes: `node:child_process`, `node:crypto`.
- Produces:
  - `interface RepositoryReader { resolveRef(url: string, ref: string): Promise<string>; listTree(url: string, sha: string): Promise<TreeListing>; readBlob(url: string, sha: string, path: string): Promise<string | null> }`
  - `interface TreeEntry { path: string; sizeBytes: number }`
  - `interface TreeListing { entries: TreeEntry[]; truncated: boolean }`
  - `MAX_TREE_ENTRIES: number`, `MAX_BLOB_BYTES: number`
  - `GitRepositoryReader.close(): void`
  - `class GitRepositoryReader implements RepositoryReader`
  - `class RepositoryReadError extends Error`
  - `GIT_READ_TIMEOUT_MS: number`

**Behaviour:**

- `resolveRef` runs `git ls-remote <url> <ref>` and returns the forty-character SHA. A ref that already is a forty-character SHA is returned unchanged, because `ls-remote` cannot resolve a bare SHA. A ref that resolves to nothing is a `RepositoryReadError`.
- `listTree` keeps one bare mirror per URL in a temporary directory for the lifetime of the reader, then runs `git ls-tree -r -l <sha>`. A tree larger than `MAX_TREE_ENTRIES` is truncated, and the truncation is reported through `truncated` on the result so no caller can mistake a partial tree for a complete one.
- `readBlob` runs `git cat-file blob <sha>:<path>` and returns null when the path does not exist at that SHA. A blob larger than `MAX_BLOB_BYTES` returns null as well, because a large blob must never enter the prompt (SDD §18, AT-09).
- Every command carries `GIT_TERMINAL_PROMPT=0`, so a private repository fails fast instead of waiting for a password.
- Every error message passes through `withoutUrlCredentials`, because a clone URL can carry a token (SDD §60).
- The reader never writes to the source repository and never runs repository code. It runs `git` only.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/git-repository-reader.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRepositoryReader, RepositoryReadError } from "~/adapters/github/git-repository-reader.js";

let root = "";
let origin = "";
let headSha = "";
const reader = new GitRepositoryReader();

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e" },
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "factoree-reader-"));
  origin = join(root, "origin");
  mkdirSync(join(origin, "docs"), { recursive: true });
  writeFileSync(join(origin, "README.md"), "# Service\n\nNotifications are owned here.\n");
  writeFileSync(join(origin, "docs", "ADR-031.md"), "# ADR 31\n\nStatus: accepted\n");
  writeFileSync(join(origin, "big.bin"), "x".repeat(300_000));
  git(origin, "init", "--initial-branch", "main");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "initial");
  headSha = git(origin, "rev-parse", "HEAD").trim();
});

afterAll(() => {
  reader.close();
  rmSync(root, { recursive: true, force: true });
});

describe("GitRepositoryReader", () => {
  it("resolves a branch to an explicit forty character SHA", async () => {
    await expect(reader.resolveRef(origin, "main")).resolves.toBe(headSha);
  });

  it("returns a SHA unchanged", async () => {
    await expect(reader.resolveRef(origin, headSha)).resolves.toBe(headSha);
  });

  it("fails with a named error for a ref that does not exist", async () => {
    await expect(reader.resolveRef(origin, "no-such-branch")).rejects.toBeInstanceOf(RepositoryReadError);
  });

  it("fails with a named error for a repository that does not exist", async () => {
    await expect(reader.resolveRef(join(root, "absent"), "main")).rejects.toBeInstanceOf(
      RepositoryReadError,
    );
  });

  it("lists every path of the tree with its size", async () => {
    const tree = await reader.listTree(origin, headSha);
    expect(tree.truncated).toBe(false);
    const paths = tree.entries.map((entry) => entry.path).sort();
    expect(paths).toEqual(["README.md", "big.bin", "docs/ADR-031.md"]);
    const readme = tree.entries.find((entry) => entry.path === "README.md");
    expect(readme?.sizeBytes).toBeGreaterThan(0);
  });

  it("reads a blob at the pinned SHA", async () => {
    await expect(reader.readBlob(origin, headSha, "docs/ADR-031.md")).resolves.toContain("Status: accepted");
  });

  it("returns null for a path that does not exist at that SHA", async () => {
    await expect(reader.readBlob(origin, headSha, "docs/absent.md")).resolves.toBeNull();
  });

  it("returns null for a blob larger than the maximum", async () => {
    await expect(reader.readBlob(origin, headSha, "big.bin")).resolves.toBeNull();
  });

  it("does not modify the source repository", async () => {
    await reader.listTree(origin, headSha);
    await reader.readBlob(origin, headSha, "README.md");
    expect(git(origin, "status", "--porcelain")).toBe("");
    expect(git(origin, "rev-parse", "HEAD").trim()).toBe(headSha);
  });

  it("keeps a repository access token out of an error message", async () => {
    await expect(
      reader.resolveRef("https://user:supersecrettoken@127.0.0.1:1/owner/repo.git", "main"),
    ).rejects.toThrow(/^(?!.*supersecrettoken).*$/s);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.integration.config.ts tests/integration/git-repository-reader.test.ts
```

Expected: FAIL. The module does not exist.

- [ ] **Step 3: Write the reader**

Create `src/adapters/github/git-repository-reader.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { withoutUrlCredentials } from "~/domain/runs/checkout.js";

const run = promisify(execFile);

/** One git read must not hang a Run. A slow mirror fails and the caller decides what follows. */
export const GIT_READ_TIMEOUT_MS = 120_000;

/** SDD section 18 disables unbounded retrieval. A tree beyond this size is truncated. */
export const MAX_TREE_ENTRIES = 5_000;

/** A blob beyond this size never enters a prompt. SDD section 18 and AT-09. */
export const MAX_BLOB_BYTES = 128 * 1024;

/** The largest output one git command may produce. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const SHA = /^[0-9a-f]{40}$/;

export interface TreeEntry {
  path: string;
  sizeBytes: number;
}

export interface TreeListing {
  entries: TreeEntry[];
  /** True when the tree held more entries than `MAX_TREE_ENTRIES`. Never silently false. */
  truncated: boolean;
}

/**
 * The read-only repository port of the context resolver. It runs on the control plane, before
 * any sandbox exists, so it must never execute repository code. Every method runs `git` only.
 * See controller decision 2.
 */
export interface RepositoryReader {
  resolveRef(url: string, ref: string): Promise<string>;
  listTree(url: string, sha: string): Promise<TreeListing>;
  readBlob(url: string, sha: string, path: string): Promise<string | null>;
}

export class RepositoryReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RepositoryReadError";
  }
}

/** A stable directory name for one URL. The URL itself can hold a credential, so it is hashed. */
const mirrorName = (url: string): string => createHash("sha256").update(url).digest("hex").slice(0, 32);

export class GitRepositoryReader implements RepositoryReader {
  private root: string | null = null;
  private readonly mirrors = new Map<string, Promise<string>>();

  private workspace(): string {
    this.root ??= mkdtempSync(join(tmpdir(), "factoree-context-"));
    return this.root;
  }

  private async git(cwd: string | null, args: string[], subject: string): Promise<string> {
    try {
      const { stdout } = await run("git", args, {
        ...(cwd === null ? {} : { cwd }),
        timeout: GIT_READ_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
        // A private repository must fail immediately rather than wait for a password, and no
        // interactive helper may run.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", GCM_INTERACTIVE: "never" },
      });
      return stdout;
    } catch (error) {
      // SDD section 60. A clone URL can carry an access token, and that token is not a Project
      // secret, so only this removal keeps it out of the message.
      throw new RepositoryReadError(withoutUrlCredentials(`${subject}: ${String(error)}`), {
        cause: error,
      });
    }
  }

  /**
   * A bare mirror of one repository, created once per reader. `--filter=blob:none` fetches the
   * commits and the trees and leaves the blobs on the server until one is read, so a large
   * repository costs a small download. SDD section 55 forbids copying a complete repository into
   * PostgreSQL, and this mirror is a temporary directory that `close` removes.
   */
  private mirror(url: string): Promise<string> {
    const existing = this.mirrors.get(url);
    if (existing !== undefined) return existing;
    const path = join(this.workspace(), mirrorName(url));
    const creating = this.git(
      null,
      ["clone", "--bare", "--filter=blob:none", "--no-tags", url, path],
      `the mirror of ${withoutUrlCredentials(url)} could not be created`,
    ).then(() => path);
    // A failed clone must not be cached, so a later attempt can try again.
    creating.catch(() => this.mirrors.delete(url));
    this.mirrors.set(url, creating);
    return creating;
  }

  async resolveRef(url: string, ref: string): Promise<string> {
    // `git ls-remote` cannot resolve a bare SHA, and a SHA is already explicit.
    if (SHA.test(ref)) return ref;
    const stdout = await this.git(
      null,
      ["ls-remote", url, ref],
      `the ref "${ref}" of ${withoutUrlCredentials(url)} could not be resolved`,
    );
    const first = stdout.split("\n").find((line) => line.trim() !== "");
    const sha = first?.split(/\s+/)[0]?.trim() ?? "";
    if (!SHA.test(sha)) {
      throw new RepositoryReadError(
        `the ref "${ref}" of ${withoutUrlCredentials(url)} does not resolve to a commit SHA.`,
      );
    }
    return sha;
  }

  async listTree(url: string, sha: string): Promise<TreeListing> {
    const path = await this.mirror(url);
    const stdout = await this.git(
      path,
      ["ls-tree", "-r", "-l", "--full-tree", sha],
      `the tree of ${withoutUrlCredentials(url)} at ${sha} could not be listed`,
    );
    const entries: TreeEntry[] = [];
    let truncated = false;
    for (const line of stdout.split("\n")) {
      if (line.trim() === "") continue;
      if (entries.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
      // `<mode> <type> <object> <size>\t<path>`. The size is `-` for a submodule.
      const [meta, entryPath] = line.split("\t");
      const size = meta?.trim().split(/\s+/)[3] ?? "-";
      if (entryPath === undefined || entryPath === "" || size === "-") continue;
      entries.push({ path: entryPath, sizeBytes: Number.parseInt(size, 10) });
    }
    return { entries, truncated };
  }

  async readBlob(url: string, sha: string, path: string): Promise<string | null> {
    const mirror = await this.mirror(url);
    let size: number;
    try {
      const stdout = await this.git(mirror, ["cat-file", "-s", `${sha}:${path}`], "size");
      size = Number.parseInt(stdout.trim(), 10);
    } catch {
      // The path does not exist at that SHA. That is an ordinary discovery outcome, not a fault.
      return null;
    }
    // AT-09. A large file stays tool-accessible in the sandbox and never enters a prompt.
    if (!Number.isFinite(size) || size > MAX_BLOB_BYTES) return null;
    const stdout = await this.git(
      mirror,
      ["cat-file", "blob", `${sha}:${path}`],
      `the blob "${path}" of ${withoutUrlCredentials(url)} at ${sha} could not be read`,
    );
    return stdout;
  }

  /** Removes every mirror. The caller owns the lifetime of the reader. */
  close(): void {
    const root = this.root;
    this.mirrors.clear();
    this.root = null;
    if (root !== null) rmSync(root, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.integration.config.ts tests/integration/git-repository-reader.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Run lint and typecheck, then commit**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck
git add src/adapters/github tests/integration/git-repository-reader.test.ts
git commit -m "feat: add a read-only git repository reader for context discovery"
```

---
### Task 5: The Linear and repository context sources

**Files:**
- Create: `src/domain/context/linear-source.ts`
- Create: `src/domain/context/repository-source.ts`
- Create: `tests/support/fake-repository-reader.ts`
- Test: `tests/unit/linear-context-source.test.ts`
- Test: `tests/unit/repository-context-source.test.ts`

**Interfaces:**
- Consumes: `ContextSource`, `ContextCandidate`, `ContextDocument`, `ContextReference`, `ContextDiscoveryRequest`, `DISCOVERY_PRIORITY` from Task 3; `RepositoryReader`, `TreeListing` from Task 4; `parseFactoreeConfig` and `FACTOREE_CONFIG_PATH` from `~/domain/projects/factoree-config.js`.
- Produces:
  - `class LinearContextSource implements ContextSource` — `id()` returns `"linear"`.
  - `class RepositoryContextSource implements ContextSource` — `id()` returns `"repository"`; constructor takes `{ reader: RepositoryReader }`.
  - `classifyPath(path: string): { authority: AuthorityClass; reason: string; rule: DiscoveryRule } | null`
  - `class FakeRepositoryReader implements RepositoryReader` in tests.

**Behaviour of `LinearContextSource`:**

- One candidate for the Work Item itself: reference `linear:issue:<runId>`, authority `work_item_decision`, classification `required`, reason `the Work Item is the product intent of this Run`, priority `work_item_reference`.
- One candidate per recorded decision: reference `linear:decision:<questionId>`, authority `work_item_decision`, classification `required`, reason `a human answered "<question>"`, priority `work_item_reference`. SDD §23 and controller decision 4.
- One candidate per non-repository Work Item reference: reference `linear:reference:<n>`, authority `product_documentation`, classification `discoverable`, reason `the Work Item links this reference`, priority `work_item_reference`.
- `sourceVersion` is the run identifier for the Work Item and the question identifier for a decision, because Linear supplies no version and the values are stable inside one Run.
- `fetch` returns the content the source was constructed with. The source holds the goal and the decisions, so it needs no network.

**Behaviour of `RepositoryContextSource`:**

- For the primary repository and for each reference repository:
  1. `resolveRef` pins an explicit SHA.
  2. `listTree` lists the tree at that SHA.
  3. Each path is classified by `classifyPath`. An unclassified path is skipped.
  4. Each kept path becomes a candidate whose `reference.repository` is the slug, `reference.sha` is the pinned SHA, `reference.path` is the path, `sourceVersion` is the pinned SHA, `topics` are the request topics whose word appears in the path, and `sizeBytes` is the tree size.
  5. The primary repository itself becomes one candidate with a null path, authority `source_code`, classification `required`, reason `the primary repository of the Project`, priority `project_repository_mapping`. Each reference repository becomes one candidate with a null path, authority `source_code`, classification `reference`, reason `a configured reference repository`.
  6. A truncated tree adds no further candidate and is reported through the repository candidate's reason, so no caller can read a partial tree as complete.
- `classifyPath` rules, tested one by one:
  - `.factoree/config.yaml` → `repository_configuration`, rule `project_repository_mapping`, reason `the repository configuration of SDD section 15`.
  - a path under a directory named `adr`, `adrs`, `decisions`, or `architecture`, or a file name matching `ADR-<digits>`, ending in `.md` → `accepted_adr`, rule `accepted_adr_reference`, reason `an accepted architecture decision record`.
  - `openapi.yaml`, `openapi.yml`, `openapi.json`, `asyncapi.yaml`, `asyncapi.yml`, a `.proto` file, or a `.graphql` file → `machine_readable_contract`, rule `declared_client_or_import`, reason `a versioned machine-readable contract`.
  - a path under a directory named `test`, `tests`, `spec`, or `__tests__`, or a file name holding `.test.` or `.spec.` → `executable_tests`, rule `declared_client_or_import`, reason `an executable test that shows the current behavior`.
  - `README.md` at the repository root → `repository_readme`, rule `project_repository_mapping`, reason `the repository README`.
  - a `.md` file under a directory named `doc` or `docs` → `architecture_documentation`, rule `accepted_adr_reference`, reason `repository architecture documentation`.
  - any other file with a source extension in `.ts .tsx .js .jsx .py .go .rb .java .kt .rs .cs .php .scala .swift` → `source_code`, rule `scoped_semantic_search`, reason `an existing implementation pattern in the primary repository`. Only the primary repository produces this rule, and only for a path carrying at least one request topic. AT-02 needs it, and SDD §18 forbids unbounded retrieval, so a topic match is mandatory.
  - everything else → `null`.
- `fetch` calls `readBlob` at the pinned SHA. A null blob is a `RepositoryReadError`, because the resolver only fetches an item it already selected.

- [ ] **Step 1: Write the fake reader**

Create `tests/support/fake-repository-reader.ts`:

```ts
import type {
  RepositoryReader,
  TreeListing,
} from "~/adapters/github/git-repository-reader.js";
import { RepositoryReadError } from "~/adapters/github/git-repository-reader.js";

export interface FakeRepository {
  sha: string;
  files: Record<string, string>;
  truncated?: boolean;
}

/** An in-memory `RepositoryReader`. Unit tests use it so no git process runs. */
export class FakeRepositoryReader implements RepositoryReader {
  readonly calls: string[] = [];

  constructor(private readonly repositories: Record<string, FakeRepository>) {}

  private repository(url: string): FakeRepository {
    const repository = this.repositories[url];
    if (repository === undefined) throw new RepositoryReadError(`no fake repository at ${url}`);
    return repository;
  }

  resolveRef(url: string, ref: string): Promise<string> {
    this.calls.push(`resolveRef ${url} ${ref}`);
    return Promise.resolve(this.repository(url).sha);
  }

  listTree(url: string, sha: string): Promise<TreeListing> {
    this.calls.push(`listTree ${url} ${sha}`);
    const repository = this.repository(url);
    return Promise.resolve({
      entries: Object.entries(repository.files).map(([path, content]) => ({
        path,
        sizeBytes: Buffer.byteLength(content, "utf8"),
      })),
      truncated: repository.truncated === true,
    });
  }

  readBlob(url: string, sha: string, path: string): Promise<string | null> {
    this.calls.push(`readBlob ${url} ${sha} ${path}`);
    return Promise.resolve(this.repository(url).files[path] ?? null);
  }
}
```

- [ ] **Step 2: Write the failing Linear source test**

Create `tests/unit/linear-context-source.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import type { ContextDiscoveryRequest } from "~/domain/context/context-source.js";

const request = (over: Partial<ContextDiscoveryRequest> = {}): ContextDiscoveryRequest => ({
  runId: "run-1",
  goal: "Retry webhook deliveries.",
  topics: ["deliveries", "retry", "webhook"],
  primaryRepository: { slug: "acme/webhook-service", url: "https://git/acme/webhook-service", ref: "main" },
  referenceRepositories: [],
  workItemReferences: [],
  decisions: [],
  ...over,
});

describe("LinearContextSource", () => {
  it("identifies itself as linear", () => {
    expect(new LinearContextSource().id()).toBe("linear");
  });

  it("offers the Work Item as a required product intent item", async () => {
    const [candidate] = await new LinearContextSource().discover(request());
    expect(candidate?.reference).toEqual({
      sourceId: "linear",
      ref: "linear:issue:run-1",
      repository: null,
      sha: null,
      path: null,
    });
    expect(candidate?.authority).toBe("work_item_decision");
    expect(candidate?.suggestedClassification).toBe("required");
    expect(candidate?.priority).toBe(1);
    expect(candidate?.reason).toBe("the Work Item is the product intent of this Run");
  });

  it("offers every recorded human decision as a required item", async () => {
    const candidates = await new LinearContextSource().discover(
      request({
        decisions: [{ questionId: "Q-1", question: "Do we retry a 4xx response?", answer: "No." }],
      }),
    );
    const decision = candidates.find((candidate) => candidate.reference.ref === "linear:decision:Q-1");
    expect(decision?.authority).toBe("work_item_decision");
    expect(decision?.suggestedClassification).toBe("required");
    expect(decision?.reason).toBe('a human answered "Do we retry a 4xx response?"');
  });

  it("offers a declared link as a discoverable item", async () => {
    const candidates = await new LinearContextSource().discover(
      request({ workItemReferences: ["https://example.com/adr/031"] }),
    );
    const link = candidates.find((candidate) => candidate.reference.ref === "linear:reference:1");
    expect(link?.suggestedClassification).toBe("discoverable");
    expect(link?.authority).toBe("product_documentation");
  });

  it("returns the Work Item text from fetch", async () => {
    const source = new LinearContextSource();
    await source.discover(request());
    const document = await source.fetch({
      sourceId: "linear",
      ref: "linear:issue:run-1",
      repository: null,
      sha: null,
      path: null,
    });
    expect(document.content).toBe("Retry webhook deliveries.");
  });

  it("returns the answer text of a decision from fetch", async () => {
    const source = new LinearContextSource();
    await source.discover(
      request({ decisions: [{ questionId: "Q-1", question: "How many retries?", answer: "Three." }] }),
    );
    const document = await source.fetch({
      sourceId: "linear",
      ref: "linear:decision:Q-1",
      repository: null,
      sha: null,
      path: null,
    });
    expect(document.content).toBe("How many retries?\n\nThree.");
  });

  it("rejects a reference it never offered", async () => {
    const source = new LinearContextSource();
    await source.discover(request());
    await expect(
      source.fetch({ sourceId: "linear", ref: "linear:absent", repository: null, sha: null, path: null }),
    ).rejects.toThrow(/linear:absent/);
  });
});
```

- [ ] **Step 3: Write the Linear source**

Create `src/domain/context/linear-source.ts`:

```ts
import type {
  ContextCandidate,
  ContextDiscoveryRequest,
  ContextDocument,
  ContextReference,
  ContextSource,
} from "./context-source.js";
import { DISCOVERY_PRIORITY } from "./context-source.js";

/**
 * SDD section 17 requires a Linear context source. The Work Item is the product intent of the
 * Run, and SDD section 22 makes an explicit Work Item decision the highest product-intent
 * authority. SDD section 23 requires a human answer to be persisted as a Run decision, and
 * controller decision 4 persists it here, as a Context Item of the same authority.
 *
 * The source holds every document it offers, so it needs no network and cannot fail.
 */
export class LinearContextSource implements ContextSource {
  private readonly documents = new Map<string, string>();

  id(): string {
    return "linear";
  }

  private reference(ref: string): ContextReference {
    return { sourceId: this.id(), ref, repository: null, sha: null, path: null };
  }

  discover(request: ContextDiscoveryRequest): Promise<ContextCandidate[]> {
    this.documents.clear();
    const candidates: ContextCandidate[] = [];

    const issueRef = `linear:issue:${request.runId}`;
    this.documents.set(issueRef, request.goal);
    candidates.push({
      reference: this.reference(issueRef),
      sourceVersion: request.runId,
      authority: "work_item_decision",
      reason: "the Work Item is the product intent of this Run",
      priority: DISCOVERY_PRIORITY.work_item_reference,
      topics: request.topics,
      sizeBytes: Buffer.byteLength(request.goal, "utf8"),
      suggestedClassification: "required",
    });

    for (const decision of request.decisions) {
      const ref = `linear:decision:${decision.questionId}`;
      const content = `${decision.question}\n\n${decision.answer}`;
      this.documents.set(ref, content);
      candidates.push({
        reference: this.reference(ref),
        sourceVersion: decision.questionId,
        authority: "work_item_decision",
        reason: `a human answered "${decision.question}"`,
        priority: DISCOVERY_PRIORITY.work_item_reference,
        topics: request.topics,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        suggestedClassification: "required",
      });
    }

    request.workItemReferences.forEach((value, index) => {
      const ref = `linear:reference:${index + 1}`;
      this.documents.set(ref, value);
      candidates.push({
        reference: this.reference(ref),
        sourceVersion: request.runId,
        authority: "product_documentation",
        reason: "the Work Item links this reference",
        priority: DISCOVERY_PRIORITY.work_item_reference,
        topics: request.topics,
        sizeBytes: Buffer.byteLength(value, "utf8"),
        // SDD section 18 forbids unbounded retrieval, and Factoree cannot fetch an arbitrary
        // link in Version 1. The link stays visible to a human and to a tool.
        suggestedClassification: "discoverable",
      });
    });

    return Promise.resolve(candidates);
  }

  fetch(ref: ContextReference): Promise<ContextDocument> {
    const content = this.documents.get(ref.ref);
    if (content === undefined) {
      return Promise.reject(new Error(`The Linear context source never offered "${ref.ref}".`));
    }
    return Promise.resolve({ reference: ref, sourceVersion: ref.ref, content });
  }
}
```

- [ ] **Step 4: Write the failing repository source test**

Create `tests/unit/repository-context-source.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RepositoryContextSource, classifyPath } from "~/domain/context/repository-source.js";
import type { ContextDiscoveryRequest } from "~/domain/context/context-source.js";
import { FakeRepositoryReader } from "../support/fake-repository-reader.js";

const PRIMARY_URL = "https://git/acme/webhook-service";
const REFERENCE_URL = "https://git/acme/notification-service";

const files = {
  ".factoree/config.yaml": "version: 1\nverify:\n  commands:\n    - name: test\n      run: npm test\n",
  "README.md": "# Webhook service\n",
  "docs/ADR-031.md": "# ADR 31\n\nStatus: accepted\n",
  "docs/overview.md": "An overview.\n",
  "openapi.yaml": "openapi: 3.1.0\n",
  "src/retry.ts": "export const retry = () => undefined;\n",
  "src/unrelated.ts": "export const other = () => undefined;\n",
  "tests/retry.test.ts": "it('retries', () => undefined);\n",
  "LICENSE": "MIT\n",
};

const reader = () =>
  new FakeRepositoryReader({
    [PRIMARY_URL]: { sha: "a".repeat(40), files },
    [REFERENCE_URL]: { sha: "b".repeat(40), files: { "openapi.yaml": "openapi: 3.1.0\n" } },
  });

const request = (over: Partial<ContextDiscoveryRequest> = {}): ContextDiscoveryRequest => ({
  runId: "run-1",
  goal: "Retry webhook deliveries.",
  topics: ["deliveries", "retry", "webhook"],
  primaryRepository: { slug: "acme/webhook-service", url: PRIMARY_URL, ref: "main" },
  referenceRepositories: [{ slug: "acme/notification-service", url: REFERENCE_URL, ref: "main" }],
  workItemReferences: [],
  decisions: [],
  ...over,
});

describe("classifyPath", () => {
  it("classifies the repository configuration", () => {
    expect(classifyPath(".factoree/config.yaml")?.authority).toBe("repository_configuration");
  });

  it("classifies an ADR under a decisions directory", () => {
    expect(classifyPath("docs/decisions/0007-queue.md")?.authority).toBe("accepted_adr");
  });

  it("classifies an ADR by its file name", () => {
    expect(classifyPath("docs/ADR-031.md")?.authority).toBe("accepted_adr");
  });

  it("classifies a machine readable contract", () => {
    expect(classifyPath("openapi.yaml")?.authority).toBe("machine_readable_contract");
    expect(classifyPath("api/events.proto")?.authority).toBe("machine_readable_contract");
  });

  it("classifies an executable test", () => {
    expect(classifyPath("tests/retry.test.ts")?.authority).toBe("executable_tests");
    expect(classifyPath("src/retry.spec.ts")?.authority).toBe("executable_tests");
  });

  it("classifies the root README", () => {
    expect(classifyPath("README.md")?.authority).toBe("repository_readme");
  });

  it("classifies a nested README as documentation, not as the repository README", () => {
    expect(classifyPath("docs/README.md")?.authority).toBe("architecture_documentation");
  });

  it("classifies other repository documentation", () => {
    expect(classifyPath("docs/overview.md")?.authority).toBe("architecture_documentation");
  });

  it("classifies a source file", () => {
    expect(classifyPath("src/retry.ts")?.authority).toBe("source_code");
  });

  it("classifies nothing else", () => {
    expect(classifyPath("LICENSE")).toBeNull();
    expect(classifyPath("assets/logo.png")).toBeNull();
  });
});

describe("RepositoryContextSource", () => {
  it("identifies itself as repository", () => {
    expect(new RepositoryContextSource({ reader: reader() }).id()).toBe("repository");
  });

  it("pins every repository to an explicit SHA", async () => {
    const candidates = await new RepositoryContextSource({ reader: reader() }).discover(request());
    const shas = new Set(candidates.map((candidate) => candidate.reference.sha));
    expect([...shas].sort()).toEqual(["a".repeat(40), "b".repeat(40)]);
    for (const candidate of candidates) expect(candidate.sourceVersion).toMatch(/^[0-9a-f]{40}$/);
  });

  it("offers the primary repository as a required item", async () => {
    const candidates = await new RepositoryContextSource({ reader: reader() }).discover(request());
    const repository = candidates.find(
      (candidate) => candidate.reference.ref === "repository:acme/webhook-service",
    );
    expect(repository?.suggestedClassification).toBe("required");
    expect(repository?.reference.path).toBeNull();
    expect(repository?.reason).toBe("the primary repository of the Project");
  });

  it("offers a reference repository as a reference item", async () => {
    const candidates = await new RepositoryContextSource({ reader: reader() }).discover(request());
    const repository = candidates.find(
      (candidate) => candidate.reference.ref === "repository:acme/notification-service",
    );
    expect(repository?.suggestedClassification).toBe("reference");
    expect(repository?.reason).toBe("a configured reference repository");
  });

  it("offers a source file only when it carries a Work Item topic", async () => {
    const candidates = await new RepositoryContextSource({ reader: reader() }).discover(request());
    const refs = candidates.map((candidate) => candidate.reference.ref);
    expect(refs).toContain("repository:acme/webhook-service:src/retry.ts");
    expect(refs).not.toContain("repository:acme/webhook-service:src/unrelated.ts");
  });

  it("offers a source file from the primary repository only", async () => {
    const withSource = new FakeRepositoryReader({
      [PRIMARY_URL]: { sha: "a".repeat(40), files: {} },
      [REFERENCE_URL]: { sha: "b".repeat(40), files: { "src/retry.ts": "x" } },
    });
    const candidates = await new RepositoryContextSource({ reader: withSource }).discover(request());
    expect(candidates.map((candidate) => candidate.reference.ref)).not.toContain(
      "repository:acme/notification-service:src/retry.ts",
    );
  });

  it("records the topics a path carries", async () => {
    const candidates = await new RepositoryContextSource({ reader: reader() }).discover(request());
    const file = candidates.find(
      (candidate) => candidate.reference.ref === "repository:acme/webhook-service:src/retry.ts",
    );
    expect(file?.topics).toEqual(["retry"]);
  });

  it("records the size of each path from the tree", async () => {
    const candidates = await new RepositoryContextSource({ reader: reader() }).discover(request());
    const readme = candidates.find(
      (candidate) => candidate.reference.ref === "repository:acme/webhook-service:README.md",
    );
    expect(readme?.sizeBytes).toBe(Buffer.byteLength(files["README.md"], "utf8"));
  });

  it("reports a truncated tree in the reason of the repository item", async () => {
    const truncating = new FakeRepositoryReader({
      [PRIMARY_URL]: { sha: "a".repeat(40), files, truncated: true },
      [REFERENCE_URL]: { sha: "b".repeat(40), files: {}, truncated: false },
    });
    const candidates = await new RepositoryContextSource({ reader: truncating }).discover(request());
    const repository = candidates.find(
      (candidate) => candidate.reference.ref === "repository:acme/webhook-service",
    );
    expect(repository?.reason).toMatch(/truncated/);
  });

  it("reads a blob at the pinned SHA", async () => {
    const source = new RepositoryContextSource({ reader: reader() });
    await source.discover(request());
    const document = await source.fetch({
      sourceId: "repository",
      ref: "repository:acme/webhook-service:docs/ADR-031.md",
      repository: "acme/webhook-service",
      sha: "a".repeat(40),
      path: "docs/ADR-031.md",
    });
    expect(document.content).toContain("Status: accepted");
    expect(document.sourceVersion).toBe("a".repeat(40));
  });

  it("fails when a selected blob cannot be read", async () => {
    const source = new RepositoryContextSource({ reader: reader() });
    await source.discover(request());
    await expect(
      source.fetch({
        sourceId: "repository",
        ref: "repository:acme/webhook-service:absent.md",
        repository: "acme/webhook-service",
        sha: "a".repeat(40),
        path: "absent.md",
      }),
    ).rejects.toThrow(/absent\.md/);
  });

  it("exposes the pinned SHA of every repository after discovery", async () => {
    const source = new RepositoryContextSource({ reader: reader() });
    await source.discover(request());
    expect(source.pinnedShas()).toEqual({
      "acme/webhook-service": "a".repeat(40),
      "acme/notification-service": "b".repeat(40),
    });
  });
});
```

- [ ] **Step 5: Write the repository source**

Create `src/domain/context/repository-source.ts`:

```ts
import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { RepositoryReadError } from "~/adapters/github/git-repository-reader.js";
import { FACTOREE_CONFIG_PATH } from "~/domain/projects/factoree-config.js";
import type { AuthorityClass } from "./authority.js";
import type {
  ContextCandidate,
  ContextClassification,
  ContextDiscoveryRequest,
  ContextDocument,
  ContextReference,
  ContextSource,
  DiscoveryRule,
  RepositoryRef,
} from "./context-source.js";
import { DISCOVERY_PRIORITY } from "./context-source.js";

export interface PathClassification {
  authority: AuthorityClass;
  reason: string;
  rule: DiscoveryRule;
}

const ADR_DIRECTORIES = new Set(["adr", "adrs", "decisions", "architecture"]);
const DOC_DIRECTORIES = new Set(["doc", "docs"]);
const TEST_DIRECTORIES = new Set(["test", "tests", "spec", "__tests__"]);

const CONTRACT_FILES = new Set([
  "openapi.yaml",
  "openapi.yml",
  "openapi.json",
  "asyncapi.yaml",
  "asyncapi.yml",
]);

const CONTRACT_EXTENSIONS = new Set([".proto", ".graphql"]);

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rb", ".java", ".kt", ".rs", ".cs", ".php",
  ".scala", ".swift",
]);

const ADR_FILE = /^adr[-_]?\d+/i;

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
};

/**
 * Maps a repository path to an SDD section 22 authority class and an SDD section 18 discovery
 * rule. A path that matches no rule is not context, so it is skipped. The order of the rules is
 * the order of the specification: a machine-readable contract outranks a test, a test outranks
 * documentation, and the README is the lowest architecture rung.
 */
export const classifyPath = (path: string): PathClassification | null => {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  const directories = new Set(segments.slice(0, -1).map((segment) => segment.toLowerCase()));
  const lowerName = name.toLowerCase();
  const extension = extensionOf(lowerName);

  if (path === FACTOREE_CONFIG_PATH) {
    return {
      authority: "repository_configuration",
      reason: "the repository configuration of SDD section 15",
      rule: "project_repository_mapping",
    };
  }

  if (extension === ".md" && ([...directories].some((d) => ADR_DIRECTORIES.has(d)) || ADR_FILE.test(lowerName))) {
    return {
      authority: "accepted_adr",
      reason: "an accepted architecture decision record",
      rule: "accepted_adr_reference",
    };
  }

  if (CONTRACT_FILES.has(lowerName) || CONTRACT_EXTENSIONS.has(extension)) {
    return {
      authority: "machine_readable_contract",
      reason: "a versioned machine-readable contract",
      rule: "declared_client_or_import",
    };
  }

  if (
    [...directories].some((directory) => TEST_DIRECTORIES.has(directory)) ||
    lowerName.includes(".test.") ||
    lowerName.includes(".spec.")
  ) {
    return {
      authority: "executable_tests",
      reason: "an executable test that shows the current behavior",
      rule: "declared_client_or_import",
    };
  }

  // Only the file at the repository root is the README of SDD section 22. A nested one is
  // ordinary documentation.
  if (segments.length === 1 && lowerName === "readme.md") {
    return {
      authority: "repository_readme",
      reason: "the repository README",
      rule: "project_repository_mapping",
    };
  }

  if (extension === ".md" && [...directories].some((directory) => DOC_DIRECTORIES.has(directory))) {
    return {
      authority: "architecture_documentation",
      reason: "repository architecture documentation",
      rule: "accepted_adr_reference",
    };
  }

  if (SOURCE_EXTENSIONS.has(extension)) {
    return {
      authority: "source_code",
      reason: "an existing implementation pattern in the primary repository",
      rule: "scoped_semantic_search",
    };
  }

  return null;
};

const topicsIn = (path: string, topics: string[]): string[] => {
  const lower = path.toLowerCase();
  return topics.filter((topic) => lower.includes(topic));
};

export interface RepositoryContextSourceOptions {
  reader: RepositoryReader;
}

/**
 * SDD section 17 requires a primary GitHub repository source and a reference GitHub repository
 * source. Both are the same source here, because a repository is read the same way whichever
 * role it holds. SDD section 20 requires an explicit commit SHA for every reference repository,
 * and SDD section 55 requires the repository, the SHA, the path, and the content hash of every
 * recorded item, so discovery pins a SHA before it lists anything.
 *
 * The source runs on the control plane through a read-only git port. It executes no repository
 * code. See controller decision 2.
 */
export class RepositoryContextSource implements ContextSource {
  private readonly urls = new Map<string, string>();
  private readonly shas = new Map<string, string>();

  constructor(private readonly options: RepositoryContextSourceOptions) {}

  id(): string {
    return "repository";
  }

  /** The pinned SHA of every repository this discovery saw, by slug. */
  pinnedShas(): Record<string, string> {
    return Object.fromEntries(this.shas);
  }

  private async discoverRepository(
    repository: RepositoryRef,
    request: ContextDiscoveryRequest,
    role: "primary" | "reference",
  ): Promise<ContextCandidate[]> {
    // SDD section 20. An explicit commit SHA, never a moving ref.
    const sha = await this.options.reader.resolveRef(repository.url, repository.ref);
    this.urls.set(repository.slug, repository.url);
    this.shas.set(repository.slug, sha);

    const tree = await this.options.reader.listTree(repository.url, sha);

    const repositoryReason =
      role === "primary" ? "the primary repository of the Project" : "a configured reference repository";
    const truncatedNote = tree.truncated
      ? ` The file listing was truncated, so this repository is only partly indexed.`
      : "";

    const candidates: ContextCandidate[] = [
      {
        reference: {
          sourceId: this.id(),
          ref: `repository:${repository.slug}`,
          repository: repository.slug,
          sha,
          path: null,
        },
        sourceVersion: sha,
        authority: "source_code",
        reason: `${repositoryReason}${truncatedNote}`,
        priority: DISCOVERY_PRIORITY.project_repository_mapping,
        topics: request.topics,
        sizeBytes: null,
        // SDD section 21. A repository is never preloaded; the Implementer reaches it by path in
        // the sandbox. AT-09 requires exactly this.
        suggestedClassification: role === "primary" ? "required" : "reference",
      },
    ];

    for (const entry of tree.entries) {
      const classification = classifyPath(entry.path);
      if (classification === null) continue;

      const topics = topicsIn(entry.path, request.topics);

      // SDD section 18 disables unbounded retrieval. A source file is offered only from the
      // primary repository, and only when the path carries a Work Item topic, so a large
      // repository never floods the contract. AT-02 needs at least one such pattern.
      if (classification.authority === "source_code") {
        if (role !== "primary" || topics.length === 0) continue;
      }

      const suggested: ContextClassification =
        classification.authority === "repository_configuration" ? "reference" : "reference";

      candidates.push({
        reference: {
          sourceId: this.id(),
          ref: `repository:${repository.slug}:${entry.path}`,
          repository: repository.slug,
          sha,
          path: entry.path,
        },
        sourceVersion: sha,
        authority: classification.authority,
        reason: classification.reason,
        priority: DISCOVERY_PRIORITY[classification.rule],
        topics,
        sizeBytes: entry.sizeBytes,
        suggestedClassification: suggested,
      });
    }

    return candidates;
  }

  async discover(request: ContextDiscoveryRequest): Promise<ContextCandidate[]> {
    this.urls.clear();
    this.shas.clear();
    const primary = await this.discoverRepository(request.primaryRepository, request, "primary");
    const references: ContextCandidate[] = [];
    for (const repository of request.referenceRepositories) {
      references.push(...(await this.discoverRepository(repository, request, "reference")));
    }
    return [...primary, ...references];
  }

  async fetch(ref: ContextReference): Promise<ContextDocument> {
    const slug = ref.repository;
    const url = slug === null ? undefined : this.urls.get(slug);
    if (slug === null || url === undefined || ref.sha === null || ref.path === null) {
      throw new RepositoryReadError(`"${ref.ref}" is not a readable repository path.`);
    }
    const content = await this.options.reader.readBlob(url, ref.sha, ref.path);
    if (content === null) {
      throw new RepositoryReadError(
        `the blob "${ref.path}" of ${slug} at ${ref.sha} is absent or too large to read.`,
      );
    }
    return { reference: ref, sourceVersion: ref.sha, content };
  }
}
```

- [ ] **Step 6: Run both tests and confirm they pass**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/linear-context-source.test.ts tests/unit/repository-context-source.test.ts
```

Expected: PASS, 7 + 22 tests.

- [ ] **Step 7: Simplify the dead branch the tests exposed**

`suggested` in `discoverRepository` returns `"reference"` on both sides of its condition. Replace
the whole expression with the constant `"reference"` and keep this comment above it:

```ts
      // SDD section 21. Every discovered file starts as a reference item. The resolver promotes
      // it to `required` or demotes it to `discoverable` under the context budget, because only
      // the resolver knows the whole selection.
      const suggested: ContextClassification = "reference";
```

Run the two tests again and confirm they still pass.

- [ ] **Step 8: Run lint and typecheck, then commit**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck
git add src/domain/context/linear-source.ts src/domain/context/repository-source.ts tests/support/fake-repository-reader.ts tests/unit/linear-context-source.test.ts tests/unit/repository-context-source.test.ts
git commit -m "feat: add the Linear and repository context sources of SDD section 17"
```

---

### Task 6: The conflict model

**Files:**
- Create: `src/domain/context/conflicts.ts`
- Test: `tests/unit/context-conflicts.test.ts`

**Interfaces:**
- Consumes: `compareAuthority`, `authorityDomainOf` from Task 3; `ContextCandidate` from Task 3.
- Produces:
  - `interface SelectedContextItem { reference: ContextReference; sourceVersion: string; authority: AuthorityClass; reason: string; classification: ContextClassification; topics: string[]; contentSha256: string | null }`
  - `interface ContextConflictRecord { id: string; subject: string; winnerRef: string | null; loserRef: string | null; reason: string; resolution: "resolved" | "unresolved" }`
  - `detectConflicts(items: SelectedContextItem[]): ContextConflictRecord[]`
  - `firstUnresolved(conflicts: ContextConflictRecord[]): ContextConflictRecord | null`
  - `conflictQuestion(conflict: ContextConflictRecord): string`

**Behaviour:**

- A pair conflicts when both items are classified `required` or `reference`, both belong to the same authority domain, and they share at least one topic. A `discoverable` item is not preloaded, so it cannot conflict.
- Two items of the same reference never conflict with themselves.
- A pair whose authority classes differ resolves automatically. The higher class is the winner, and the reason names the rule, as SDD §23 shows.
- A pair whose authority classes are equal is unresolved. `winnerRef` and `loserRef` are both null, and the reason names the two references and the shared subject.
- The subject is the shared topic, and a pair sharing several topics uses the first in sorted order, so the identifier is deterministic.
- Conflicts are returned in a deterministic order: by subject, then by the two references sorted.
- The identifier is `CTX-<n>` counting from one over the returned order, matching the SDD §23 example.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/context-conflicts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  conflictQuestion,
  detectConflicts,
  firstUnresolved,
} from "~/domain/context/conflicts.js";
import type { SelectedContextItem } from "~/domain/context/conflicts.js";
import type { AuthorityClass } from "~/domain/context/authority.js";
import type { ContextClassification } from "~/domain/context/context-source.js";

const item = (
  ref: string,
  authority: AuthorityClass,
  topics: string[],
  classification: ContextClassification = "reference",
): SelectedContextItem => ({
  reference: { sourceId: "repository", ref, repository: "acme/service", sha: "a".repeat(40), path: ref },
  sourceVersion: "a".repeat(40),
  authority,
  reason: "test",
  classification,
  topics,
  contentSha256: null,
});

describe("detectConflicts", () => {
  it("resolves a README against an accepted ADR in favour of the ADR", () => {
    const conflicts = detectConflicts([
      item("docs/ADR-031.md", "accepted_adr", ["notification"]),
      item("README.md", "repository_readme", ["notification"]),
    ]);
    expect(conflicts).toEqual([
      {
        id: "CTX-1",
        subject: "notification",
        winnerRef: "docs/ADR-031.md",
        loserRef: "README.md",
        reason: "accepted ADR has higher architecture authority than repository README",
        resolution: "resolved",
      },
    ]);
  });

  it("reports two accepted ADRs as unresolved", () => {
    const conflicts = detectConflicts([
      item("docs/ADR-031.md", "accepted_adr", ["notification"]),
      item("docs/ADR-042.md", "accepted_adr", ["notification"]),
    ]);
    expect(conflicts[0]?.resolution).toBe("unresolved");
    expect(conflicts[0]?.winnerRef).toBeNull();
    expect(conflicts[0]?.loserRef).toBeNull();
    expect(conflicts[0]?.reason).toMatch(/equally authoritative/);
    expect(conflicts[0]?.reason).toContain("docs/ADR-031.md");
    expect(conflicts[0]?.reason).toContain("docs/ADR-042.md");
  });

  it("does not pair two items of different authority domains", () => {
    expect(
      detectConflicts([
        item("docs/ADR-031.md", "accepted_adr", ["notification"]),
        item("openapi.yaml", "machine_readable_contract", ["notification"]),
      ]),
    ).toEqual([]);
  });

  it("does not pair two items that share no topic", () => {
    expect(
      detectConflicts([
        item("docs/ADR-031.md", "accepted_adr", ["notification"]),
        item("README.md", "repository_readme", ["billing"]),
      ]),
    ).toEqual([]);
  });

  it("does not pair a discoverable item", () => {
    expect(
      detectConflicts([
        item("docs/ADR-031.md", "accepted_adr", ["notification"]),
        item("README.md", "repository_readme", ["notification"], "discoverable"),
      ]),
    ).toEqual([]);
  });

  it("pairs a required item with a reference item", () => {
    const conflicts = detectConflicts([
      item("docs/ADR-031.md", "accepted_adr", ["notification"], "required"),
      item("README.md", "repository_readme", ["notification"], "reference"),
    ]);
    expect(conflicts).toHaveLength(1);
  });

  it("uses the first shared topic in sorted order as the subject", () => {
    const conflicts = detectConflicts([
      item("docs/ADR-031.md", "accepted_adr", ["queue", "notification"]),
      item("README.md", "repository_readme", ["notification", "queue"]),
    ]);
    expect(conflicts[0]?.subject).toBe("notification");
  });

  it("numbers every conflict from one in a deterministic order", () => {
    const conflicts = detectConflicts([
      item("README.md", "repository_readme", ["queue"]),
      item("docs/ADR-031.md", "accepted_adr", ["queue"]),
      item("docs/ADR-042.md", "accepted_adr", ["billing"]),
      item("docs/other.md", "architecture_documentation", ["billing"]),
    ]);
    expect(conflicts.map((conflict) => [conflict.id, conflict.subject])).toEqual([
      ["CTX-1", "billing"],
      ["CTX-2", "queue"],
    ]);
  });

  it("returns nothing for a single item", () => {
    expect(detectConflicts([item("README.md", "repository_readme", ["queue"])])).toEqual([]);
  });
});

describe("firstUnresolved", () => {
  it("returns the first unresolved conflict", () => {
    const conflicts = detectConflicts([
      item("README.md", "repository_readme", ["queue"]),
      item("docs/ADR-031.md", "accepted_adr", ["queue"]),
      item("docs/ADR-042.md", "accepted_adr", ["billing"]),
      item("docs/ADR-055.md", "accepted_adr", ["billing"]),
    ]);
    expect(firstUnresolved(conflicts)?.subject).toBe("billing");
  });

  it("returns null when every conflict resolved", () => {
    const conflicts = detectConflicts([
      item("README.md", "repository_readme", ["queue"]),
      item("docs/ADR-031.md", "accepted_adr", ["queue"]),
    ]);
    expect(firstUnresolved(conflicts)).toBeNull();
  });
});

describe("conflictQuestion", () => {
  it("asks one focused question that names both references and the subject", () => {
    const conflicts = detectConflicts([
      item("docs/ADR-031.md", "accepted_adr", ["notification"]),
      item("docs/ADR-042.md", "accepted_adr", ["notification"]),
    ]);
    const conflict = conflicts[0];
    if (conflict === undefined) throw new Error("expected one conflict");
    const question = conflictQuestion(conflict);
    expect(question).toContain("docs/ADR-031.md");
    expect(question).toContain("docs/ADR-042.md");
    expect(question).toContain("notification");
    expect(question.endsWith("?")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails, then write the module**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/context-conflicts.test.ts
```

Expected: FAIL. The module does not exist.

Create `src/domain/context/conflicts.ts`:

```ts
import type { AuthorityClass } from "./authority.js";
import { authorityDomainOf, compareAuthority } from "./authority.js";
import type { ContextClassification, ContextReference } from "./context-source.js";

/** One item the resolver selected. It is the row a Context Contract persists. */
export interface SelectedContextItem {
  reference: ContextReference;
  sourceVersion: string;
  authority: AuthorityClass;
  reason: string;
  classification: ContextClassification;
  topics: string[];
  contentSha256: string | null;
}

/** SDD section 23 fixes this record shape. */
export interface ContextConflictRecord {
  id: string;
  subject: string;
  winnerRef: string | null;
  loserRef: string | null;
  reason: string;
  resolution: "resolved" | "unresolved";
}

/** A readable name for an authority class, used in the recorded reason. */
const NAMES: Record<string, string> = {
  work_item_decision: "explicit Work Item decision",
  approved_product_specification: "approved product specification",
  product_documentation: "general product documentation",
  accepted_adr: "accepted ADR",
  approved_architecture_specification: "approved architecture specification",
  architecture_documentation: "architecture documentation",
  repository_readme: "repository README",
  machine_readable_contract: "versioned machine-readable contract",
  contract_tests: "executable contract tests",
  api_documentation: "API documentation",
  prose_documentation: "prose documentation",
  source_code: "source code",
  executable_tests: "executable tests",
  runtime_behavior: "runtime behavior",
  declarative_catalog: "declarative catalog",
  repository_configuration: "repository configuration",
};

const DOMAIN_NAMES: Record<string, string> = {
  product_intent: "product",
  architecture_intent: "architecture",
  interface_contract: "interface",
  current_implementation: "implementation",
  system_topology: "topology",
};

const nameOf = (authority: AuthorityClass): string => NAMES[authority] ?? authority;

/** An item can conflict only when Factoree will actually put it in front of an agent. */
const conflictable = (classification: ContextClassification): boolean =>
  classification === "required" || classification === "reference";

/**
 * SDD section 23. A material conflict must be recorded, and Factoree may resolve it
 * automatically only when authority policy gives a clear winner.
 *
 * The detector is deterministic by design. Two selected items conflict when they sit in one
 * authority domain and both address the same Work Item topic. SDD section 8 forbids Refinement
 * from silently resolving an ambiguous architecture choice, so a similarity model would be the
 * wrong control here: it would guess, and a guess is exactly what the specification forbids.
 * See controller decision 7.
 */
export const detectConflicts = (items: SelectedContextItem[]): ContextConflictRecord[] => {
  const candidates = items.filter((item) => conflictable(item.classification));
  const found: Omit<ContextConflictRecord, "id">[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i];
      const right = candidates[j];
      if (left === undefined || right === undefined) continue;
      if (left.reference.ref === right.reference.ref) continue;
      if (authorityDomainOf(left.authority) !== authorityDomainOf(right.authority)) continue;

      const shared = left.topics.filter((topic) => right.topics.includes(topic)).sort();
      const subject = shared[0];
      if (subject === undefined) continue;

      const order = compareAuthority(left.authority, right.authority);
      if (order === "unrelated") continue;

      if (order === "equal") {
        // SDD section 23. No safe resolution exists, so a human must decide.
        const [first, second] = [left.reference.ref, right.reference.ref].sort();
        found.push({
          subject,
          winnerRef: null,
          loserRef: null,
          reason:
            `"${first}" and "${second}" are equally authoritative ` +
            `${nameOf(left.authority)} sources for "${subject}".`,
          resolution: "unresolved",
        });
        continue;
      }

      const winner = order === "a" ? left : right;
      const loser = order === "a" ? right : left;
      const domain = DOMAIN_NAMES[authorityDomainOf(left.authority)] ?? "";
      found.push({
        subject,
        winnerRef: winner.reference.ref,
        loserRef: loser.reference.ref,
        reason: `${nameOf(winner.authority)} has higher ${domain} authority than ${nameOf(loser.authority)}`,
        resolution: "resolved",
      });
    }
  }

  // A deterministic order, so the identifiers of one Run are stable across two resolutions.
  found.sort((a, b) => {
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
    const left = `${a.winnerRef ?? ""}|${a.loserRef ?? ""}|${a.reason}`;
    const right = `${b.winnerRef ?? ""}|${b.loserRef ?? ""}|${b.reason}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });

  return found.map((conflict, index) => ({ id: `CTX-${index + 1}`, ...conflict }));
};

export const firstUnresolved = (conflicts: ContextConflictRecord[]): ContextConflictRecord | null =>
  conflicts.find((conflict) => conflict.resolution === "unresolved") ?? null;

/** SDD section 23 requires one focused question. */
export const conflictQuestion = (conflict: ContextConflictRecord): string =>
  `${conflict.reason} Which one governs "${conflict.subject}" for this change, and why?`;
```

- [ ] **Step 3: Run the test and confirm it passes**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/context-conflicts.test.ts
```

Expected: PASS, 13 tests.

- [ ] **Step 4: Run lint and typecheck, then commit**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck
git add src/domain/context/conflicts.ts tests/unit/context-conflicts.test.ts
git commit -m "feat: add the SDD section 23 context conflict model"
```

---
### Task 7: The Context Contract and the Context Resolver

**Files:**
- Create: `src/domain/context/context-contract.ts`
- Create: `src/domain/context/context-resolver.ts`
- Test: `tests/unit/context-contract.test.ts`
- Test: `tests/unit/context-resolver.test.ts`

**Interfaces:**
- Consumes: everything Tasks 3, 5, and 6 produce.
- Produces:
  - `CONTEXT_CONTRACT_VERSION = 1`
  - `CONTEXT_REQUIRED_MAX_ITEMS = 20`, `CONTEXT_REQUIRED_MAX_BYTES = 64 * 1024`
  - `interface ContextContract { version: 1; runId: string; goal: string; primaryRepository: { repo: string; sha: string }; referenceRepositories: Array<{ repo: string; sha: string; reason: string }>; items: SelectedContextItem[]; conflicts: ContextConflictRecord[] }`
  - `class ContextContractInvalidError extends Error`
  - `validateContextContract(contract: ContextContract): void`
  - `hashContextContract(contract: ContextContract): string`
  - `renderContextContract(contract: ContextContract): string`
  - `requiredContextLines(contract: ContextContract): string[]`
  - `class ContextResolver { constructor(options: { sources: ContextSourceRegistry }); resolve(input: ResolveContextInput): Promise<ResolvedContext> }`
  - `interface ResolveContextInput { runId: string; goal: string; acceptanceCriteria: string[]; primaryRepository: RepositoryRef; referenceRepositories: RepositoryRef[]; workItemReferences: string[]; decisions: RecordedDecision[] }`
  - `interface ResolvedContext { contract: ContextContract; sha256: string; document: string; pinned: { primary: { slug: string; sha: string }; references: Array<{ slug: string; sha: string }> }; unresolvedConflict: ContextConflictRecord | null }`

**Behaviour of `validateContextContract` (AT-06):**

Every item must carry a non-empty `reference.sourceId`, a non-empty `reference.ref`, a non-empty
`sourceVersion`, an authority class the SDD §22 list holds, a non-empty `reason`, and a
classification the SDD §21 list holds. A missing field throws `ContextContractInvalidError`, and
the message names the reference and the missing field. Every repository SHA, primary and
reference, must be forty hexadecimal characters. Two items must not share a reference. A
`required` item must carry a `contentSha256`, because a preloaded item is content Factoree
promised to reproduce.

**Behaviour of `hashContextContract`:** SHA-256 over a canonical JSON serialisation with sorted
object keys, so the same contract always hashes the same way.

**Behaviour of `ContextResolver.resolve`:**

1. Compute the topics with `topicsOf`.
2. Ask every registered source to `discover`, in registry order.
3. Sort candidates by priority ascending, then by shared topic count descending, then by
   reference ascending, so the order is total and deterministic.
4. Promote in that order to `required` while the item count is below `CONTEXT_REQUIRED_MAX_ITEMS`
   and the running byte total plus the item size is at most `CONTEXT_REQUIRED_MAX_BYTES`.
   A candidate whose `suggestedClassification` is `discoverable` is never promoted.
   A repository candidate, meaning one whose `reference.path` is null, is never promoted beyond
   its suggestion, because a repository is reached by path inside the sandbox and never preloaded.
5. Every candidate that is not promoted keeps `reference` when it was suggested `reference`, and
   becomes `discoverable` when the budget is spent. AT-09.
6. Fetch every `required` item and hash its content with SHA-256. A fetch failure demotes the item
   to `discoverable` and records the failure in its reason, so one unreadable file cannot fail a
   Run.
7. Detect and record conflicts.
8. Build the contract, validate it, hash it, render it.

- [ ] **Step 1: Write the failing contract test**

Create `tests/unit/context-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CONTEXT_CONTRACT_VERSION,
  ContextContractInvalidError,
  hashContextContract,
  renderContextContract,
  requiredContextLines,
  validateContextContract,
} from "~/domain/context/context-contract.js";
import type { ContextContract } from "~/domain/context/context-contract.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const contract = (over: Partial<ContextContract> = {}): ContextContract => ({
  version: CONTEXT_CONTRACT_VERSION,
  runId: "run-1",
  goal: "Retry webhook deliveries.",
  primaryRepository: { repo: "acme/webhook-service", sha: SHA_A },
  referenceRepositories: [
    { repo: "acme/notification-service", sha: SHA_B, reason: "provides the notification API" },
  ],
  items: [
    {
      reference: {
        sourceId: "repository",
        ref: "repository:acme/webhook-service:docs/ADR-031.md",
        repository: "acme/webhook-service",
        sha: SHA_A,
        path: "docs/ADR-031.md",
      },
      sourceVersion: SHA_A,
      authority: "accepted_adr",
      reason: "an accepted architecture decision record",
      classification: "required",
      topics: ["notification"],
      contentSha256: "c".repeat(64),
    },
  ],
  conflicts: [],
  ...over,
});

describe("validateContextContract", () => {
  it("accepts a complete contract", () => {
    expect(() => validateContextContract(contract())).not.toThrow();
  });

  it("rejects an item with no source", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.reference = { ...item.reference, sourceId: "" };
    expect(() => validateContextContract(broken)).toThrow(ContextContractInvalidError);
  });

  it("rejects an item with no stable reference", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.reference = { ...item.reference, ref: "" };
    expect(() => validateContextContract(broken)).toThrow(/reference/i);
  });

  it("rejects an item with no source version", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.sourceVersion = "";
    expect(() => validateContextContract(broken)).toThrow(/version/i);
  });

  it("rejects an item with an unknown authority class", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    // The cast reaches the runtime guard the type system would otherwise hide.
    item.authority = "made_up" as typeof item.authority;
    expect(() => validateContextContract(broken)).toThrow(/authority/i);
  });

  it("rejects an item with no selection reason", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.reason = "  ";
    expect(() => validateContextContract(broken)).toThrow(/reason/i);
  });

  it("rejects an item with an unknown classification", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.classification = "maybe" as typeof item.classification;
    expect(() => validateContextContract(broken)).toThrow(/classification/i);
  });

  it("rejects a required item with no content hash", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.contentSha256 = null;
    expect(() => validateContextContract(broken)).toThrow(/content hash/i);
  });

  it("accepts a discoverable item with no content hash", () => {
    const fine = contract();
    const item = fine.items[0];
    if (item === undefined) throw new Error("fixture");
    item.classification = "discoverable";
    item.contentSha256 = null;
    expect(() => validateContextContract(fine)).not.toThrow();
  });

  it("names the offending reference in the message", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    item.reason = "";
    expect(() => validateContextContract(broken)).toThrow(/docs\/ADR-031\.md/);
  });

  it("rejects a primary repository SHA that is not forty hexadecimal characters", () => {
    expect(() =>
      validateContextContract(contract({ primaryRepository: { repo: "acme/x", sha: "main" } })),
    ).toThrow(/SHA/);
  });

  it("rejects a reference repository SHA that is not forty hexadecimal characters", () => {
    expect(() =>
      validateContextContract(
        contract({ referenceRepositories: [{ repo: "acme/y", sha: "HEAD", reason: "r" }] }),
      ),
    ).toThrow(/SHA/);
  });

  it("rejects two items that share a reference", () => {
    const broken = contract();
    const item = broken.items[0];
    if (item === undefined) throw new Error("fixture");
    broken.items = [item, { ...item }];
    expect(() => validateContextContract(broken)).toThrow(/twice/i);
  });
});

describe("hashContextContract", () => {
  it("returns sixty-four hexadecimal characters", () => {
    expect(hashContextContract(contract())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same hash for the same contract", () => {
    expect(hashContextContract(contract())).toBe(hashContextContract(contract()));
  });

  it("returns a different hash when any field changes", () => {
    expect(hashContextContract(contract())).not.toBe(
      hashContextContract(contract({ goal: "Something else." })),
    );
  });

  it("ignores the order the object keys were built in", () => {
    const a = contract();
    const b = contract();
    b.primaryRepository = { sha: SHA_A, repo: "acme/webhook-service" };
    expect(hashContextContract(a)).toBe(hashContextContract(b));
  });
});

describe("renderContextContract", () => {
  it("names the pinned SHA of every repository", () => {
    const text = renderContextContract(contract());
    expect(text).toContain("acme/webhook-service");
    expect(text).toContain(SHA_A);
    expect(text).toContain("acme/notification-service");
    expect(text).toContain(SHA_B);
  });

  it("names the authority, the classification, and the reason of every item", () => {
    const text = renderContextContract(contract());
    expect(text).toContain("accepted_adr");
    expect(text).toContain("required");
    expect(text).toContain("an accepted architecture decision record");
  });

  it("records a resolved conflict with its winner and its loser", () => {
    const text = renderContextContract(
      contract({
        conflicts: [
          {
            id: "CTX-1",
            subject: "notification",
            winnerRef: "docs/ADR-031.md",
            loserRef: "README.md",
            reason: "accepted ADR has higher architecture authority than repository README",
            resolution: "resolved",
          },
        ],
      }),
    );
    expect(text).toContain("CTX-1");
    expect(text).toContain("docs/ADR-031.md");
    expect(text).toContain("README.md");
  });

  it("holds no file body, so a repository is never copied into the contract", () => {
    expect(renderContextContract(contract())).not.toContain("Status: accepted");
  });
});

describe("requiredContextLines", () => {
  it("lists the required items only", () => {
    const fine = contract();
    fine.items = [
      ...fine.items,
      {
        reference: {
          sourceId: "repository",
          ref: "repository:acme/webhook-service:README.md",
          repository: "acme/webhook-service",
          sha: SHA_A,
          path: "README.md",
        },
        sourceVersion: SHA_A,
        authority: "repository_readme",
        reason: "the repository README",
        classification: "discoverable",
        topics: [],
        contentSha256: null,
      },
    ];
    const lines = requiredContextLines(fine);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("docs/ADR-031.md");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails, then write the contract module**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/context-contract.test.ts
```

Expected: FAIL. The module does not exist.

Create `src/domain/context/context-contract.ts`:

```ts
import { createHash } from "node:crypto";
import type { AuthorityClass } from "./authority.js";
import { AUTHORITY_CLASSES } from "./authority.js";
import type { ContextConflictRecord, SelectedContextItem } from "./conflicts.js";
import { CONTEXT_CLASSIFICATIONS } from "./context-source.js";

/** SDD section 21 fixes the document schema version. */
export const CONTEXT_CONTRACT_VERSION = 1 as const;

/**
 * SDD section 18 disables organization-wide unbounded retrieval by default, and AT-09 requires a
 * large repository to stay tool-accessible without entering the initial prompt. These two values
 * are that default. An item beyond them is demoted to `discoverable`, never dropped, so the
 * contract still explains it. See controller decision 12.
 */
export const CONTEXT_REQUIRED_MAX_ITEMS = 20;
export const CONTEXT_REQUIRED_MAX_BYTES = 64 * 1024;

export interface ContextContractRepository {
  repo: string;
  sha: string;
}

export interface ContextContractReferenceRepository extends ContextContractRepository {
  reason: string;
}

/** SDD section 21. The immutable record of the context one Run will use. */
export interface ContextContract {
  version: typeof CONTEXT_CONTRACT_VERSION;
  runId: string;
  goal: string;
  primaryRepository: ContextContractRepository;
  referenceRepositories: ContextContractReferenceRepository[];
  items: SelectedContextItem[];
  conflicts: ContextConflictRecord[];
}

export class ContextContractInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextContractInvalidError";
  }
}

const SHA = /^[0-9a-f]{40}$/;

const KNOWN_AUTHORITIES = new Set<string>(AUTHORITY_CLASSES);
const KNOWN_CLASSIFICATIONS = new Set<string>(CONTEXT_CLASSIFICATIONS);

const present = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.trim() !== "";

/**
 * AT-06. Every selected Context Item must contain source, version, authority, and reason.
 * Missing provenance causes Context Contract validation failure. SDD section 21 adds the stable
 * reference and the classification, and SDD section 55 adds the content hash where practical, so
 * a preloaded item must carry one.
 */
export const validateContextContract = (contract: ContextContract): void => {
  const fail = (message: string): never => {
    throw new ContextContractInvalidError(message);
  };

  if (!SHA.test(contract.primaryRepository.sha)) {
    fail(
      `The primary repository ${contract.primaryRepository.repo} has no explicit commit SHA: ` +
        `"${contract.primaryRepository.sha}".`,
    );
  }
  for (const repository of contract.referenceRepositories) {
    if (!SHA.test(repository.sha)) {
      fail(`The reference repository ${repository.repo} has no explicit commit SHA: "${repository.sha}".`);
    }
  }

  const seen = new Set<string>();
  for (const item of contract.items) {
    const name = item.reference.ref === "" ? "an item with no reference" : item.reference.ref;
    if (!present(item.reference.sourceId)) fail(`Context item "${name}" records no source.`);
    if (!present(item.reference.ref)) fail(`A context item records no stable reference.`);
    if (!present(item.sourceVersion)) fail(`Context item "${name}" records no source version.`);
    if (!KNOWN_AUTHORITIES.has(item.authority)) {
      fail(`Context item "${name}" records the unknown authority class "${item.authority}".`);
    }
    if (!present(item.reason)) fail(`Context item "${name}" records no selection reason.`);
    if (!KNOWN_CLASSIFICATIONS.has(item.classification)) {
      fail(`Context item "${name}" records the unknown classification "${item.classification}".`);
    }
    // A required item enters the initial role context, so Factoree promised to reproduce exactly
    // that content. SDD section 55.
    if (item.classification === "required" && !present(item.contentSha256)) {
      fail(`Context item "${name}" is required and records no content hash.`);
    }
    if (seen.has(item.reference.ref)) fail(`Context item "${name}" appears twice.`);
    seen.add(item.reference.ref);
  }
};

/** A JSON serialisation whose object keys are sorted, so one contract always hashes the same. */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
  return `{${entries.join(",")}}`;
};

/** SDD section 21 requires an immutable contract. The hash is its identity. */
export const hashContextContract = (contract: ContextContract): string =>
  createHash("sha256").update(canonical(contract)).digest("hex");

const itemLine = (item: SelectedContextItem): string => {
  const where = item.reference.path === null ? item.reference.ref : item.reference.path;
  const repository = item.reference.repository === null ? "" : `${item.reference.repository} `;
  return (
    `- ${repository}${where} — authority ${item.authority}, ${item.classification}, ` +
    `version ${item.sourceVersion}, hash ${item.contentSha256 ?? "not recorded"}. ` +
    `Selected because ${item.reason}.`
  );
};

/**
 * The human-readable Context Contract. The Phase 4 exit condition is that Factoree can explain
 * what context it will use before code changes begin, and this text is that explanation. It
 * holds no file body, because SDD section 55 forbids copying a repository and AT-09 forbids
 * preloading a large one.
 */
export const renderContextContract = (contract: ContextContract): string => {
  const references =
    contract.referenceRepositories.length === 0
      ? ["- None."]
      : contract.referenceRepositories.map(
          (repository) => `- ${repository.repo} at ${repository.sha} — ${repository.reason}`,
        );

  const items = contract.items.length === 0 ? ["- None."] : contract.items.map(itemLine);

  const conflicts =
    contract.conflicts.length === 0
      ? ["- None."]
      : contract.conflicts.map((conflict) =>
          conflict.resolution === "resolved"
            ? `- ${conflict.id} on "${conflict.subject}": ${conflict.winnerRef ?? ""} wins over ` +
              `${conflict.loserRef ?? ""}. ${conflict.reason}`
            : `- ${conflict.id} on "${conflict.subject}": unresolved. ${conflict.reason}`,
        );

  return [
    "# Context Contract",
    "",
    `version: ${contract.version}`,
    `runId: ${contract.runId}`,
    "",
    "## Goal",
    "",
    contract.goal,
    "",
    "## Primary repository",
    "",
    `- ${contract.primaryRepository.repo} at ${contract.primaryRepository.sha}`,
    "",
    "## Reference repositories",
    "",
    ...references,
    "",
    "## Selected context",
    "",
    ...items,
    "",
    "## Context conflicts",
    "",
    ...conflicts,
    "",
  ].join("\n");
};

/** SDD section 21. Only a required item enters the initial role context. */
export const requiredContextLines = (contract: ContextContract): string[] =>
  contract.items.filter((item) => item.classification === "required").map(itemLine);
```

- [ ] **Step 3: Run the contract test and confirm it passes**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/context-contract.test.ts
```

Expected: PASS, 23 tests.

- [ ] **Step 4: Write the failing resolver test**

Create `tests/unit/context-resolver.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ContextResolver } from "~/domain/context/context-resolver.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import {
  CONTEXT_REQUIRED_MAX_BYTES,
  CONTEXT_REQUIRED_MAX_ITEMS,
} from "~/domain/context/context-contract.js";
import { FakeRepositoryReader } from "../support/fake-repository-reader.js";
import type { ResolveContextInput } from "~/domain/context/context-resolver.js";

const PRIMARY_URL = "https://git/acme/webhook-service";
const REFERENCE_URL = "https://git/acme/notification-service";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const primaryFiles = {
  "README.md": "# Webhook service\n\nThe README says notification retry is owned here.\n",
  "docs/ADR-031.md": "# ADR 31\n\nStatus: accepted\n\nNotification retry is owned elsewhere.\n",
  "src/retry.ts": "export const retry = () => undefined;\n",
  "tests/retry.test.ts": "it('retries', () => undefined);\n",
};

const build = (over: {
  primary?: Record<string, string>;
  reference?: Record<string, string>;
} = {}) => {
  const reader = new FakeRepositoryReader({
    [PRIMARY_URL]: { sha: SHA_A, files: over.primary ?? primaryFiles },
    [REFERENCE_URL]: { sha: SHA_B, files: over.reference ?? { "openapi.yaml": "openapi: 3.1.0\n" } },
  });
  const registry = new ContextSourceRegistry([
    new LinearContextSource(),
    new RepositoryContextSource({ reader }),
  ]);
  return new ContextResolver({ sources: registry });
};

const input = (over: Partial<ResolveContextInput> = {}): ResolveContextInput => ({
  runId: "run-1",
  goal: "Retry a failed notification delivery.",
  acceptanceCriteria: ["A failed notification is retried."],
  primaryRepository: { slug: "acme/webhook-service", url: PRIMARY_URL, ref: "main" },
  referenceRepositories: [{ slug: "acme/notification-service", url: REFERENCE_URL, ref: "main" }],
  workItemReferences: [],
  decisions: [],
  ...over,
});

describe("ContextResolver", () => {
  it("pins the primary repository and every reference repository to an explicit SHA", async () => {
    const resolved = await build().resolve(input());
    expect(resolved.pinned.primary).toEqual({ slug: "acme/webhook-service", sha: SHA_A });
    expect(resolved.pinned.references).toEqual([{ slug: "acme/notification-service", sha: SHA_B }]);
    expect(resolved.contract.primaryRepository.sha).toBe(SHA_A);
    expect(resolved.contract.referenceRepositories[0]?.sha).toBe(SHA_B);
  });

  it("produces a valid contract with a hash and a rendered document", async () => {
    const resolved = await build().resolve(input());
    expect(resolved.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(resolved.document).toContain("# Context Contract");
    expect(resolved.contract.version).toBe(1);
    expect(resolved.contract.runId).toBe("run-1");
  });

  it("gives every item complete provenance", async () => {
    const resolved = await build().resolve(input());
    expect(resolved.contract.items.length).toBeGreaterThan(0);
    for (const item of resolved.contract.items) {
      expect(item.reference.sourceId).not.toBe("");
      expect(item.reference.ref).not.toBe("");
      expect(item.sourceVersion).not.toBe("");
      expect(item.authority).not.toBe("");
      expect(item.reason).not.toBe("");
      expect(["required", "reference", "discoverable"]).toContain(item.classification);
    }
  });

  it("hashes the content of every required item", async () => {
    const resolved = await build().resolve(input());
    const required = resolved.contract.items.filter((item) => item.classification === "required");
    expect(required.length).toBeGreaterThan(0);
    for (const item of required) expect(item.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never preloads a repository itself", async () => {
    const resolved = await build().resolve(input());
    const repository = resolved.contract.items.find(
      (item) => item.reference.ref === "repository:acme/notification-service",
    );
    expect(repository?.classification).toBe("reference");
  });

  it("finds an existing implementation pattern in the primary repository", async () => {
    const resolved = await build().resolve(input());
    const refs = resolved.contract.items.map((item) => item.reference.ref);
    expect(refs).toContain("repository:acme/webhook-service:src/retry.ts");
  });

  it("records the accepted ADR as the winner over the README", async () => {
    const resolved = await build().resolve(input());
    const conflict = resolved.contract.conflicts.find(
      (candidate) => candidate.resolution === "resolved",
    );
    expect(conflict?.winnerRef).toBe("repository:acme/webhook-service:docs/ADR-031.md");
    expect(conflict?.loserRef).toBe("repository:acme/webhook-service:README.md");
    expect(resolved.unresolvedConflict).toBeNull();
  });

  it("reports an unresolved conflict between two accepted ADRs", async () => {
    const resolved = await build({
      primary: {
        "docs/ADR-031.md": "Status: accepted. Notification retry lives here.\n",
        "docs/ADR-042.md": "Status: accepted. Notification retry lives elsewhere.\n",
      },
    }).resolve(input());
    expect(resolved.unresolvedConflict?.resolution).toBe("unresolved");
    expect(resolved.unresolvedConflict?.subject).toBe("notification");
  });

  it("keeps a human decision as a required product intent item", async () => {
    const resolved = await build().resolve(
      input({ decisions: [{ questionId: "Q-1", question: "Retry a 4xx?", answer: "No." }] }),
    );
    const decision = resolved.contract.items.find(
      (item) => item.reference.ref === "linear:decision:Q-1",
    );
    expect(decision?.classification).toBe("required");
    expect(decision?.authority).toBe("work_item_decision");
    expect(decision?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("demotes an item beyond the required item budget to discoverable", async () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < CONTEXT_REQUIRED_MAX_ITEMS + 10; index += 1) {
      many[`docs/ADR-${String(index).padStart(3, "0")}.md`] = `notification retry ${index}\n`;
    }
    const resolved = await build({ primary: many }).resolve(input());
    const required = resolved.contract.items.filter((item) => item.classification === "required");
    const discoverable = resolved.contract.items.filter(
      (item) => item.classification === "discoverable",
    );
    expect(required.length).toBeLessThanOrEqual(CONTEXT_REQUIRED_MAX_ITEMS);
    expect(discoverable.length).toBeGreaterThan(0);
  });

  it("demotes an item beyond the required byte budget to discoverable", async () => {
    const large = "notification ".repeat(CONTEXT_REQUIRED_MAX_BYTES / 4);
    const resolved = await build({
      primary: { "docs/ADR-031.md": large, "docs/ADR-042.md": large, "README.md": large },
    }).resolve(input());
    const required = resolved.contract.items.filter((item) => item.classification === "required");
    const bytes = required.reduce((total, item) => total + (item.reference.path === null ? 0 : 1), 0);
    expect(bytes).toBeLessThanOrEqual(CONTEXT_REQUIRED_MAX_ITEMS);
    expect(
      resolved.contract.items.some((item) => item.classification === "discoverable"),
    ).toBe(true);
  });

  it("demotes an item whose content cannot be read and records why", async () => {
    const reader = new FakeRepositoryReader({
      [PRIMARY_URL]: { sha: SHA_A, files: primaryFiles },
      [REFERENCE_URL]: { sha: SHA_B, files: {} },
    });
    // The tree lists the path, and the blob read then fails, which is the race a real repository
    // can produce between `ls-tree` and `cat-file`.
    const original = reader.readBlob.bind(reader);
    reader.readBlob = (url, sha, path) =>
      path === "docs/ADR-031.md" ? Promise.resolve(null) : original(url, sha, path);
    const registry = new ContextSourceRegistry([
      new LinearContextSource(),
      new RepositoryContextSource({ reader }),
    ]);
    const resolved = await new ContextResolver({ sources: registry }).resolve(input());
    const item = resolved.contract.items.find(
      (candidate) => candidate.reference.ref === "repository:acme/webhook-service:docs/ADR-031.md",
    );
    expect(item?.classification).toBe("discoverable");
    expect(item?.reason).toMatch(/could not be read/);
  });

  it("ranks a higher priority rule first", async () => {
    const resolved = await build().resolve(input());
    const first = resolved.contract.items[0];
    expect(first?.reference.ref).toBe("linear:issue:run-1");
  });

  it("returns a deterministic contract for the same input", async () => {
    const one = await build().resolve(input());
    const two = await build().resolve(input());
    expect(one.sha256).toBe(two.sha256);
  });
});
```

- [ ] **Step 5: Write the resolver**

Create `src/domain/context/context-resolver.ts`:

```ts
import { createHash } from "node:crypto";
import type { RecordedDecision } from "~/domain/refinement/refinement-engine.js";
import type { ContextConflictRecord, SelectedContextItem } from "./conflicts.js";
import { detectConflicts, firstUnresolved } from "./conflicts.js";
import type {
  ContextCandidate,
  ContextClassification,
  RepositoryRef,
} from "./context-source.js";
import type { ContextSourceRegistry } from "./context-source-registry.js";
import type { ContextContract } from "./context-contract.js";
import {
  CONTEXT_CONTRACT_VERSION,
  CONTEXT_REQUIRED_MAX_BYTES,
  CONTEXT_REQUIRED_MAX_ITEMS,
  hashContextContract,
  renderContextContract,
  validateContextContract,
} from "./context-contract.js";
import { topicsOf } from "./topics.js";

export interface ResolveContextInput {
  runId: string;
  goal: string;
  acceptanceCriteria: string[];
  primaryRepository: RepositoryRef;
  referenceRepositories: RepositoryRef[];
  workItemReferences: string[];
  decisions: RecordedDecision[];
}

export interface ResolvedContext {
  contract: ContextContract;
  /** SDD section 21 requires immutability. This hash is the identity of the contract. */
  sha256: string;
  /** The human-readable contract. It reaches Linear and the Implementer prompt. */
  document: string;
  pinned: {
    primary: { slug: string; sha: string };
    references: Array<{ slug: string; sha: string }>;
  };
  /** SDD section 23. Non-null means implementation must not start. */
  unresolvedConflict: ContextConflictRecord | null;
}

export interface ContextResolverOptions {
  sources: ContextSourceRegistry;
}

/**
 * A total order over candidates. SDD section 18 ranks the discovery rules, so the rule decides
 * first. A candidate carrying more Work Item topics is more relevant, so it decides second. The
 * reference decides last, so the order never depends on the order a source happened to return.
 */
const compareCandidates = (a: ContextCandidate, b: ContextCandidate): number => {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.topics.length !== b.topics.length) return b.topics.length - a.topics.length;
  return a.reference.ref < b.reference.ref ? -1 : a.reference.ref > b.reference.ref ? 1 : 0;
};

/**
 * SDD section 14 names this module `ContextResolver`. SDD section 18 gives it the discovery
 * priority, SDD section 21 gives it the contract shape and the classification, SDD section 22
 * gives it the authority ladders, and SDD section 23 gives it the conflict model.
 */
export class ContextResolver {
  constructor(private readonly options: ContextResolverOptions) {}

  async resolve(input: ResolveContextInput): Promise<ResolvedContext> {
    const topics = topicsOf({ goal: input.goal, acceptanceCriteria: input.acceptanceCriteria });
    const request = {
      runId: input.runId,
      goal: input.goal,
      topics,
      primaryRepository: input.primaryRepository,
      referenceRepositories: input.referenceRepositories,
      workItemReferences: input.workItemReferences,
      decisions: input.decisions,
    };

    const sources = this.options.sources.all();
    const candidates: ContextCandidate[] = [];
    for (const source of sources) candidates.push(...(await source.discover(request)));
    candidates.sort(compareCandidates);

    // The pinned SHA of each repository comes from the candidate that names the repository and no
    // path, so the resolver never guesses a SHA a source did not report.
    const shaBySlug = new Map<string, string>();
    for (const candidate of candidates) {
      const slug = candidate.reference.repository;
      const sha = candidate.reference.sha;
      if (slug !== null && sha !== null && !shaBySlug.has(slug)) shaBySlug.set(slug, sha);
    }

    // SDD section 21 and AT-09. Promotion stops at the budget, and everything past it stays
    // available through a tool rather than in the prompt.
    let requiredCount = 0;
    let requiredBytes = 0;
    const items: SelectedContextItem[] = candidates.map((candidate) => {
      let classification: ContextClassification = candidate.suggestedClassification;
      const size = candidate.sizeBytes ?? 0;
      const promotable =
        candidate.suggestedClassification === "required" && candidate.reference.path !== null;
      const isRepository = candidate.reference.path === null && candidate.reference.repository !== null;

      if (candidate.suggestedClassification === "required" && !isRepository) {
        const fits =
          requiredCount < CONTEXT_REQUIRED_MAX_ITEMS &&
          requiredBytes + size <= CONTEXT_REQUIRED_MAX_BYTES;
        classification = fits ? "required" : "discoverable";
        if (fits) {
          requiredCount += 1;
          requiredBytes += size;
        }
      } else if (candidate.suggestedClassification === "reference" && promotable) {
        const fits =
          requiredCount < CONTEXT_REQUIRED_MAX_ITEMS &&
          requiredBytes + size <= CONTEXT_REQUIRED_MAX_BYTES;
        classification = fits ? "required" : "discoverable";
        if (fits) {
          requiredCount += 1;
          requiredBytes += size;
        }
      }

      return {
        reference: candidate.reference,
        sourceVersion: candidate.sourceVersion,
        authority: candidate.authority,
        reason: candidate.reason,
        classification,
        topics: candidate.topics,
        contentSha256: null,
      };
    });

    // SDD section 55. A required item is content Factoree promised to reproduce, so it is fetched
    // once and hashed. An item that cannot be read is demoted rather than fatal, because one
    // unreadable file must not fail a Run.
    for (const item of items) {
      if (item.classification !== "required") continue;
      const source = this.options.sources.get(item.reference.sourceId);
      try {
        const document = await source.fetch(item.reference);
        item.contentSha256 = createHash("sha256").update(document.content, "utf8").digest("hex");
      } catch (error) {
        item.classification = "discoverable";
        item.reason = `${item.reason}. The content could not be read, so it is not preloaded: ${String(error)}`;
      }
    }

    const conflicts = detectConflicts(items);

    const contract: ContextContract = {
      version: CONTEXT_CONTRACT_VERSION,
      runId: input.runId,
      goal: input.goal,
      primaryRepository: {
        repo: input.primaryRepository.slug,
        sha: shaBySlug.get(input.primaryRepository.slug) ?? "",
      },
      referenceRepositories: input.referenceRepositories.map((repository) => ({
        repo: repository.slug,
        sha: shaBySlug.get(repository.slug) ?? "",
        reason: "a configured reference repository",
      })),
      items,
      conflicts,
    };

    validateContextContract(contract);

    return {
      contract,
      sha256: hashContextContract(contract),
      document: renderContextContract(contract),
      pinned: {
        primary: {
          slug: input.primaryRepository.slug,
          sha: contract.primaryRepository.sha,
        },
        references: contract.referenceRepositories.map((repository) => ({
          slug: repository.repo,
          sha: repository.sha,
        })),
      },
      unresolvedConflict: firstUnresolved(conflicts),
    };
  }
}
```

- [ ] **Step 6: Simplify the promotion branch**

The two branches above compute the same budget test. Replace the whole `items` mapping body with
one branch and keep this comment:

```ts
      // SDD section 21. A repository itself is never preloaded: the Implementer reaches it by
      // path inside the sandbox, and AT-09 requires exactly that. Every other candidate a source
      // offered as `required` or `reference` competes for the budget, and what does not fit
      // becomes `discoverable`.
      const isRepository = candidate.reference.path === null && candidate.reference.repository !== null;
      const competes =
        !isRepository &&
        (candidate.suggestedClassification === "required" ||
          candidate.suggestedClassification === "reference");

      let classification: ContextClassification = candidate.suggestedClassification;
      if (competes) {
        const size = candidate.sizeBytes ?? 0;
        const fits =
          requiredCount < CONTEXT_REQUIRED_MAX_ITEMS &&
          requiredBytes + size <= CONTEXT_REQUIRED_MAX_BYTES;
        classification = fits ? "required" : "discoverable";
        if (fits) {
          requiredCount += 1;
          requiredBytes += size;
        }
      }
```

- [ ] **Step 7: Run the resolver test and confirm it passes**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/context-resolver.test.ts
```

Expected: PASS, 14 tests.

- [ ] **Step 8: Run lint and typecheck, then commit**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck
git add src/domain/context/context-contract.ts src/domain/context/context-resolver.ts tests/unit/context-contract.test.ts tests/unit/context-resolver.test.ts
git commit -m "feat: build, validate, and hash the Context Contract of SDD section 21"
```

---

### Task 8: Persist the Context Contract

**Files:**
- Create: `src/domain/context/context-contract-store.ts`
- Create: `src/persistence/prisma/context-contract.prisma.ts`
- Create: `tests/support/fake-context-contract-store.ts`
- Create: `prisma/migrations/20260823120000_add_context_contract/migration.sql`
- Modify: `prisma/schema.prisma`
- Modify: `src/domain/runs/run-repository.ts`, `src/persistence/prisma/run-repository.prisma.ts`
- Test: `tests/integration/context-contract.test.ts`

**Interfaces:**
- Consumes: `ContextContract`, `SelectedContextItem`, `ContextConflictRecord`.
- Produces:
  - `interface StoredContextContract { id: string; tenantId: string; runId: string; version: number; sha256: string; document: string; items: SelectedContextItem[]; conflicts: ContextConflictRecord[]; createdAt: Date }`
  - `interface SaveContextContractInput { tenantId: string; runId: string; contract: ContextContract; sha256: string; document: string }`
  - `interface ContextContractStore { save(input: SaveContextContractInput): Promise<StoredContextContract>; findByRun(tenantId: string, runId: string): Promise<StoredContextContract | null> }`
  - `class PrismaContextContractStore implements ContextContractStore`
  - `class FakeContextContractStore implements ContextContractStore`
  - `RunRepository.setContextContractVersion(tenantId: string, runId: string, version: string): Promise<void>`

**Behaviour:**

- `save` writes the contract, every item, and every conflict in one Prisma transaction.
- A second `save` for the same Run returns the stored contract unchanged and writes nothing, so a
  Temporal activity retry is safe and SDD §21 immutability holds. The unique index on `runId`
  enforces it in the database as well as in the code.
- `findByRun` rejects a tenant mismatch by returning null, matching the evidence store of Phase 3.
- No update method exists on the store.

- [ ] **Step 1: Add the Prisma models**

Add to `prisma/schema.prisma`, after the `Evidence` model:

```prisma
model ContextContract {
  id          String   @id @default(uuid())
  tenantId    String
  runId       String   @unique
  run         Run      @relation(fields: [runId], references: [id], onDelete: Cascade)
  // SDD section 21 fixes the document schema version. `Run.contextContractVersion` holds the
  // SHA-256 below, because that value identifies the exact contract. See controller decision 11.
  version     Int
  sha256      String
  // The rendered contract. SDD section 55 forbids copying a repository, so this text names paths
  // and hashes and holds no file body.
  document    String
  createdAt   DateTime @default(now())
  items       ContextItem[]
  conflicts   ContextConflict[]

  @@index([tenantId])
}

model ContextItem {
  id                String          @id @default(uuid())
  tenantId          String
  contextContractId String
  contextContract   ContextContract @relation(fields: [contextContractId], references: [id], onDelete: Cascade)
  // SDD section 21 requires source, stable reference, source version, authority, reason, and
  // classification on every selected item. SDD section 55 adds the repository, the SHA, the path,
  // and the content hash.
  sourceId          String
  ref               String
  repository        String?
  sha               String?
  path              String?
  sourceVersion     String
  authority         String
  reason            String
  classification    String
  topics            String[]        @default([])
  contentSha256     String?
  createdAt         DateTime        @default(now())

  @@unique([contextContractId, ref])
  @@index([tenantId])
}

model ContextConflict {
  id                String          @id @default(uuid())
  tenantId          String
  contextContractId String
  contextContract   ContextContract @relation(fields: [contextContractId], references: [id], onDelete: Cascade)
  // SDD section 23 fixes this shape. `winnerRef` and `loserRef` are null for an unresolved
  // conflict, because no authority rule produced a winner.
  conflictKey       String
  subject           String
  winnerRef         String?
  loserRef          String?
  reason            String
  resolution        String
  createdAt         DateTime        @default(now())

  @@unique([contextContractId, conflictKey])
  @@index([tenantId])
}
```

Add these two lines to the `Run` model, beside `evidence`:

```prisma
  contextContract          ContextContract?
```

- [ ] **Step 2: Write the migration by hand**

Create `prisma/migrations/20260823120000_add_context_contract/migration.sql`:

```sql
-- SDD section 53. The ContextContract, ContextItem, and ContextConflict entities.
-- Every table is new, so this migration is safe against a populated database.

CREATE TABLE "ContextContract" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextContract_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContextContract_runId_key" ON "ContextContract"("runId");
CREATE INDEX "ContextContract_tenantId_idx" ON "ContextContract"("tenantId");

ALTER TABLE "ContextContract" ADD CONSTRAINT "ContextContract_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContextItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contextContractId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "repository" TEXT,
    "sha" TEXT,
    "path" TEXT,
    "sourceVersion" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contentSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContextItem_contextContractId_ref_key" ON "ContextItem"("contextContractId", "ref");
CREATE INDEX "ContextItem_tenantId_idx" ON "ContextItem"("tenantId");

ALTER TABLE "ContextItem" ADD CONSTRAINT "ContextItem_contextContractId_fkey"
    FOREIGN KEY ("contextContractId") REFERENCES "ContextContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContextConflict" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contextContractId" TEXT NOT NULL,
    "conflictKey" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "winnerRef" TEXT,
    "loserRef" TEXT,
    "reason" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextConflict_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContextConflict_contextContractId_conflictKey_key" ON "ContextConflict"("contextContractId", "conflictKey");
CREATE INDEX "ContextConflict_tenantId_idx" ON "ContextConflict"("tenantId");

ALTER TABLE "ContextConflict" ADD CONSTRAINT "ContextConflict_contextContractId_fkey"
    FOREIGN KEY ("contextContractId") REFERENCES "ContextContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Regenerate the Prisma client**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
DATABASE_URL="postgresql://placeholder" npx prisma generate
```

Expected: exit 0, and the generated client holds `contextContract`, `contextItem`, and
`contextConflict`.

- [ ] **Step 4: Write the port**

Create `src/domain/context/context-contract-store.ts`:

```ts
import type { ContextConflictRecord, SelectedContextItem } from "./conflicts.js";
import type { ContextContract } from "./context-contract.js";

export interface StoredContextContract {
  id: string;
  tenantId: string;
  runId: string;
  version: number;
  sha256: string;
  document: string;
  items: SelectedContextItem[];
  conflicts: ContextConflictRecord[];
  createdAt: Date;
}

export interface SaveContextContractInput {
  tenantId: string;
  runId: string;
  contract: ContextContract;
  sha256: string;
  document: string;
}

/**
 * SDD section 21 requires an immutable Context Contract. The port therefore offers no update.
 * `save` is idempotent: a second call for the same Run returns the contract already stored, so a
 * Temporal activity retry can never write a second version.
 */
export interface ContextContractStore {
  save(input: SaveContextContractInput): Promise<StoredContextContract>;
  findByRun(tenantId: string, runId: string): Promise<StoredContextContract | null>;
}
```

- [ ] **Step 5: Write the fake store**

Create `tests/support/fake-context-contract-store.ts`:

```ts
import type {
  ContextContractStore,
  SaveContextContractInput,
  StoredContextContract,
} from "~/domain/context/context-contract-store.js";

export class FakeContextContractStore implements ContextContractStore {
  private readonly byRun = new Map<string, StoredContextContract>();
  private sequence = 0;

  save(input: SaveContextContractInput): Promise<StoredContextContract> {
    const existing = this.byRun.get(input.runId);
    if (existing !== undefined) return Promise.resolve(existing);
    this.sequence += 1;
    const stored: StoredContextContract = {
      id: `ctx-${this.sequence}`,
      tenantId: input.tenantId,
      runId: input.runId,
      version: input.contract.version,
      sha256: input.sha256,
      document: input.document,
      items: input.contract.items,
      conflicts: input.contract.conflicts,
      createdAt: new Date(0),
    };
    this.byRun.set(input.runId, stored);
    return Promise.resolve(stored);
  }

  findByRun(tenantId: string, runId: string): Promise<StoredContextContract | null> {
    const stored = this.byRun.get(runId);
    // The tenant guard of the Phase 3 evidence store, kept identical here. SDD section 52.
    return Promise.resolve(stored?.tenantId === tenantId ? stored : null);
  }

  all(): StoredContextContract[] {
    return [...this.byRun.values()];
  }
}
```

- [ ] **Step 6: Write the failing integration test**

Create `tests/integration/context-contract.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaContextContractStore } from "~/persistence/prisma/context-contract.prisma.js";
import { CONTEXT_CONTRACT_VERSION } from "~/domain/context/context-contract.js";
import type { ContextContract } from "~/domain/context/context-contract.js";
import { startDatabase, stopDatabase, prisma, seedRun } from "./support/database.js";

const SHA_A = "a".repeat(40);

let store: PrismaContextContractStore;
let tenantId = "";
let runId = "";
let otherTenantId = "";

const contract = (): ContextContract => ({
  version: CONTEXT_CONTRACT_VERSION,
  runId,
  goal: "Retry a failed notification delivery.",
  primaryRepository: { repo: "acme/webhook-service", sha: SHA_A },
  referenceRepositories: [],
  items: [
    {
      reference: {
        sourceId: "repository",
        ref: "repository:acme/webhook-service:docs/ADR-031.md",
        repository: "acme/webhook-service",
        sha: SHA_A,
        path: "docs/ADR-031.md",
      },
      sourceVersion: SHA_A,
      authority: "accepted_adr",
      reason: "an accepted architecture decision record",
      classification: "required",
      topics: ["notification"],
      contentSha256: "c".repeat(64),
    },
  ],
  conflicts: [
    {
      id: "CTX-1",
      subject: "notification",
      winnerRef: "repository:acme/webhook-service:docs/ADR-031.md",
      loserRef: "repository:acme/webhook-service:README.md",
      reason: "accepted ADR has higher architecture authority than repository README",
      resolution: "resolved",
    },
  ],
});

beforeAll(async () => {
  await startDatabase();
  store = new PrismaContextContractStore(prisma());
  const seeded = await seedRun();
  tenantId = seeded.tenantId;
  runId = seeded.runId;
  otherTenantId = (await seedRun()).tenantId;
}, 180_000);

afterAll(async () => {
  await stopDatabase();
});

describe("PrismaContextContractStore", () => {
  it("stores the contract, its items, and its conflicts", async () => {
    const stored = await store.save({
      tenantId,
      runId,
      contract: contract(),
      sha256: "d".repeat(64),
      document: "# Context Contract\n",
    });
    expect(stored.version).toBe(1);
    expect(stored.sha256).toBe("d".repeat(64));
    expect(stored.items).toHaveLength(1);
    expect(stored.conflicts).toHaveLength(1);
  });

  it("reads the contract back with complete provenance", async () => {
    const found = await store.findByRun(tenantId, runId);
    const item = found?.items[0];
    expect(item?.reference.sourceId).toBe("repository");
    expect(item?.reference.path).toBe("docs/ADR-031.md");
    expect(item?.sourceVersion).toBe(SHA_A);
    expect(item?.authority).toBe("accepted_adr");
    expect(item?.reason).toBe("an accepted architecture decision record");
    expect(item?.classification).toBe("required");
    expect(item?.contentSha256).toBe("c".repeat(64));
    expect(item?.topics).toEqual(["notification"]);
  });

  it("reads the conflict back with its winner and its loser", async () => {
    const found = await store.findByRun(tenantId, runId);
    expect(found?.conflicts[0]).toEqual({
      id: "CTX-1",
      subject: "notification",
      winnerRef: "repository:acme/webhook-service:docs/ADR-031.md",
      loserRef: "repository:acme/webhook-service:README.md",
      reason: "accepted ADR has higher architecture authority than repository README",
      resolution: "resolved",
    });
  });

  it("is immutable: a second save writes nothing and returns the stored contract", async () => {
    const again = await store.save({
      tenantId,
      runId,
      contract: { ...contract(), goal: "A different goal." },
      sha256: "e".repeat(64),
      document: "# Different\n",
    });
    expect(again.sha256).toBe("d".repeat(64));
    expect(again.document).toBe("# Context Contract\n");
    const rows = await prisma().contextContract.count({ where: { runId } });
    expect(rows).toBe(1);
  });

  it("hides the contract from another tenant", async () => {
    await expect(store.findByRun(otherTenantId, runId)).resolves.toBeNull();
  });

  it("returns null for a Run with no contract", async () => {
    await expect(store.findByRun(tenantId, "00000000-0000-0000-0000-000000000000")).resolves.toBeNull();
  });
});
```

If `tests/integration/support/database.ts` has no `seedRun` helper, add one that creates a
Tenant, a Project, and a Run and returns `{ tenantId, projectId, runId }`. Read the existing
`tests/integration/evidence.test.ts` first and reuse whatever seeding helper it already uses,
rather than adding a second one.

- [ ] **Step 7: Write the Prisma store**

Create `src/persistence/prisma/context-contract.prisma.ts`:

```ts
import type { PrismaClient } from "@prisma/client";
import type {
  ContextContractStore,
  SaveContextContractInput,
  StoredContextContract,
} from "~/domain/context/context-contract-store.js";
import type { ContextConflictRecord, SelectedContextItem } from "~/domain/context/conflicts.js";
import type { AuthorityClass } from "~/domain/context/authority.js";
import { isAuthorityClass } from "~/domain/context/authority.js";
import type { ContextClassification } from "~/domain/context/context-source.js";
import { CONTEXT_CLASSIFICATIONS } from "~/domain/context/context-source.js";

const CLASSIFICATIONS = new Set<string>(CONTEXT_CLASSIFICATIONS);

/**
 * A column holds a string, so the value read back is guarded rather than cast. Phase 3 left a
 * bare cast on `Evidence.kind` and recorded that as a finding; this store does not repeat it.
 */
const toAuthority = (value: string, ref: string): AuthorityClass => {
  if (!isAuthorityClass(value)) {
    throw new Error(`Context item "${ref}" holds the unknown authority class "${value}".`);
  }
  return value;
};

const toClassification = (value: string, ref: string): ContextClassification => {
  if (!CLASSIFICATIONS.has(value)) {
    throw new Error(`Context item "${ref}" holds the unknown classification "${value}".`);
  }
  return value as ContextClassification;
};

interface ItemRow {
  sourceId: string;
  ref: string;
  repository: string | null;
  sha: string | null;
  path: string | null;
  sourceVersion: string;
  authority: string;
  reason: string;
  classification: string;
  topics: string[];
  contentSha256: string | null;
}

interface ConflictRow {
  conflictKey: string;
  subject: string;
  winnerRef: string | null;
  loserRef: string | null;
  reason: string;
  resolution: string;
}

interface ContractRow {
  id: string;
  tenantId: string;
  runId: string;
  version: number;
  sha256: string;
  document: string;
  createdAt: Date;
  items: ItemRow[];
  conflicts: ConflictRow[];
}

const toItem = (row: ItemRow): SelectedContextItem => ({
  reference: {
    sourceId: row.sourceId,
    ref: row.ref,
    repository: row.repository,
    sha: row.sha,
    path: row.path,
  },
  sourceVersion: row.sourceVersion,
  authority: toAuthority(row.authority, row.ref),
  reason: row.reason,
  classification: toClassification(row.classification, row.ref),
  topics: row.topics,
  contentSha256: row.contentSha256,
});

const toConflict = (row: ConflictRow): ContextConflictRecord => ({
  id: row.conflictKey,
  subject: row.subject,
  winnerRef: row.winnerRef,
  loserRef: row.loserRef,
  reason: row.reason,
  resolution: row.resolution === "resolved" ? "resolved" : "unresolved",
});

const toStored = (row: ContractRow): StoredContextContract => ({
  id: row.id,
  tenantId: row.tenantId,
  runId: row.runId,
  version: row.version,
  sha256: row.sha256,
  document: row.document,
  items: row.items.map(toItem),
  conflicts: row.conflicts.map(toConflict),
  createdAt: row.createdAt,
});

export class PrismaContextContractStore implements ContextContractStore {
  constructor(private readonly prisma: PrismaClient) {}

  async save(input: SaveContextContractInput): Promise<StoredContextContract> {
    // SDD section 21. The contract is immutable, so an existing one wins and nothing is written.
    // A Temporal activity retry therefore cannot produce a second version.
    const existing = await this.findByRun(input.tenantId, input.runId);
    if (existing !== null) return existing;

    const row = await this.prisma.contextContract.create({
      data: {
        tenantId: input.tenantId,
        runId: input.runId,
        version: input.contract.version,
        sha256: input.sha256,
        document: input.document,
        items: {
          create: input.contract.items.map((item) => ({
            tenantId: input.tenantId,
            sourceId: item.reference.sourceId,
            ref: item.reference.ref,
            repository: item.reference.repository,
            sha: item.reference.sha,
            path: item.reference.path,
            sourceVersion: item.sourceVersion,
            authority: item.authority,
            reason: item.reason,
            classification: item.classification,
            topics: item.topics,
            contentSha256: item.contentSha256,
          })),
        },
        conflicts: {
          create: input.contract.conflicts.map((conflict) => ({
            tenantId: input.tenantId,
            conflictKey: conflict.id,
            subject: conflict.subject,
            winnerRef: conflict.winnerRef,
            loserRef: conflict.loserRef,
            reason: conflict.reason,
            resolution: conflict.resolution,
          })),
        },
      },
      include: { items: true, conflicts: true },
    });

    return toStored(row);
  }

  async findByRun(tenantId: string, runId: string): Promise<StoredContextContract | null> {
    const row = await this.prisma.contextContract.findUnique({
      where: { runId },
      include: { items: true, conflicts: true },
    });
    // SDD section 52. The tenant boundary is checked on the read as well as on the write.
    if (row === null || row.tenantId !== tenantId) return null;
    return toStored(row);
  }
}
```

- [ ] **Step 8: Add the Run repository method**

Add to the `RunRepository` interface in `src/domain/runs/run-repository.ts`:

```ts
  /** SDD section 53. `Run.context_contract_version` holds the SHA-256 of the frozen contract. */
  setContextContractVersion(tenantId: string, runId: string, version: string): Promise<void>;
```

Add the implementation to `src/persistence/prisma/run-repository.prisma.ts`, following the
pattern `clearSandbox` already uses there:

```ts
  async setContextContractVersion(tenantId: string, runId: string, version: string): Promise<void> {
    await this.prisma.run.updateMany({
      where: { id: runId, tenantId },
      data: { contextContractVersion: version },
    });
  }
```

Add the same method to every in-memory `RunRepository` the test suite already holds. Run
`npm run typecheck` to find each one; the compiler names them all.

- [ ] **Step 9: Run the integration test and confirm it passes**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.integration.config.ts tests/integration/context-contract.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 10: Run lint, typecheck, and the whole unit suite, then commit**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck && npm test
git add prisma src/domain/context/context-contract-store.ts src/persistence/prisma/context-contract.prisma.ts src/domain/runs/run-repository.ts src/persistence/prisma/run-repository.prisma.ts tests/support/fake-context-contract-store.ts tests/integration/context-contract.test.ts
git commit -m "feat: persist the Context Contract, its items, and its conflicts"
```

---
### Task 9: The refinement and context activities

**Files:**
- Create: `src/activities/refinement.activities.ts`
- Create: `src/activities/context.activities.ts`
- Modify: `src/telemetry/metrics.ts`
- Modify: `src/activities/index.ts`
- Modify: `src/bin/worker.ts`
- Test: `tests/unit/refine-activity.test.ts`
- Test: `tests/unit/resolve-context-activity.test.ts`

**Interfaces:**
- Consumes: `RefinementEngine`, `ContextResolver`, `ContextContractStore`, `RunRepository`, `Logger`.
- Produces:
  - `createRefinementActivities({ refinement, logger })` with `refine(input: RefineActivityInput): Promise<RefineActivityOutput>`
  - `createContextActivities({ resolver, contracts, runs, logger })` with `resolveContext(input: ResolveContextActivityInput): Promise<ResolveContextActivityOutput>`
  - `interface RefineActivityInput { runId: string; tenantId: string; projectId: string; source: WorkItemSource; project: RefinementProject; decisions: RecordedDecision[] }`
  - `interface RefineActivityOutput { status: "ready" | "needs_input"; goal: string; primaryRepository: string; referenceRepositories: string[]; acceptanceCriteria: string[]; workItemReferences: string[]; risks: string[]; unresolvedQuestions: RefinementQuestion[]; autonomyLevel: string }`
  - `interface ResolveContextActivityInput { runId: string; tenantId: string; projectId: string; goal: string; acceptanceCriteria: string[]; primaryRepository: RepositoryRef; referenceRepositories: RepositoryRef[]; workItemReferences: string[]; decisions: RecordedDecision[] }`
  - `interface ResolveContextActivityOutput { sha256: string; document: string; requiredContext: string[]; primary: { slug: string; sha: string }; references: Array<{ slug: string; sha: string }>; unresolvedConflict: { id: string; subject: string; question: string } | null; conflictCount: number; summary: string }`
- Metrics added: `refinementDuration`, `contextResolutionDuration`, `contextConflicts`.

**Behaviour:**

- Both activities are pure functions of their input plus the injected engine, so a Temporal retry
  repeats the same work and produces the same result.
- `resolveContext` writes the contract through the store, which is idempotent, and then writes the
  hash to `Run.contextContractVersion`.
- `resolveContext` returns `requiredContext` from `requiredContextLines`, so the workflow can put
  it in the Implementer prompt without holding the contract object.
- The conflict counter increments once per recorded conflict, labelled by resolution. SDD §62
  requires `factoree_context_conflicts_total`, and the label separates the resolvable case from
  the case that stops a Run.

- [ ] **Step 1: Add the three metrics**

Add to the `metrics` object in `src/telemetry/metrics.ts`, beside `verificationDuration`:

```ts
  refinementDuration: new Histogram({
    name: "factoree_refinement_duration_seconds",
    help: "Refinement duration in seconds",
    labelNames,
    buckets: [0.01, 0.1, 1, 5, 30],
    registers: [registry],
  }),
  contextResolutionDuration: new Histogram({
    name: "factoree_context_resolution_duration_seconds",
    help: "Context resolution duration in seconds",
    labelNames,
    buckets: [1, 5, 15, 60, 300, 900],
    registers: [registry],
  }),
  contextConflicts: new Counter({
    name: "factoree_context_conflicts_total",
    help: "Context conflicts recorded on a Context Contract",
    labelNames: [...labelNames, "resolution"],
    registers: [registry],
  }),
```

- [ ] **Step 2: Write the failing refine activity test**

Create `tests/unit/refine-activity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createRefinementActivities } from "~/activities/refinement.activities.js";
import { RefinementEngine } from "~/domain/refinement/refinement-engine.js";
import type { RefineActivityInput } from "~/activities/refinement.activities.js";
import { silentLogger } from "../support/fake-runner.js";

const activities = createRefinementActivities({
  refinement: new RefinementEngine(),
  logger: silentLogger,
});

const input = (over: Partial<RefineActivityInput> = {}): RefineActivityInput => ({
  runId: "run-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  source: {
    issueId: "issue-1",
    title: "Add a webhook retry",
    description: "## Goal\n\nRetry a failed delivery.\n\n## References\n\n- https://example.com/adr/031\n",
    url: "https://linear.app/acme/issue/ACME-1",
    labels: [],
  },
  project: {
    primaryRepository: "acme/webhook-service",
    referenceRepositories: ["acme/notification-service"],
    defaultAutonomy: "L3",
  },
  decisions: [],
  ...over,
});

describe("refine activity", () => {
  it("reports a ready Work Item with its goal and repositories", async () => {
    const output = await activities.refine(input());
    expect(output.status).toBe("ready");
    expect(output.goal).toBe("Add a webhook retry\n\nRetry a failed delivery.");
    expect(output.primaryRepository).toBe("acme/webhook-service");
    expect(output.referenceRepositories).toEqual(["acme/notification-service"]);
  });

  it("returns the acceptance criteria as plain statements", async () => {
    const output = await activities.refine(
      input({
        source: {
          ...input().source,
          description: "## Acceptance criteria\n\n- AC-1: A failed delivery is retried.\n",
        },
      }),
    );
    expect(output.acceptanceCriteria).toEqual(["A failed delivery is retried."]);
  });

  it("returns every Work Item reference as written", async () => {
    expect((await activities.refine(input())).workItemReferences).toEqual([
      "https://example.com/adr/031",
    ]);
  });

  it("reports a material question and needs input", async () => {
    const output = await activities.refine(
      input({
        source: {
          ...input().source,
          description: "## Goal\n\nRetry.\n\n## Open questions\n\n- Which queue?\n",
        },
      }),
    );
    expect(output.status).toBe("needs_input");
    expect(output.unresolvedQuestions).toHaveLength(1);
    expect(output.unresolvedQuestions[0]?.question).toBe("Which queue?");
  });

  it("becomes ready once the question is answered", async () => {
    const withQuestion = input({
      source: {
        ...input().source,
        description: "## Goal\n\nRetry.\n\n## Open questions\n\n- Which queue?\n",
      },
    });
    const output = await activities.refine({
      ...withQuestion,
      decisions: [{ questionId: "Q-1", question: "Which queue?", answer: "The existing one." }],
    });
    expect(output.status).toBe("ready");
  });

  it("caps autonomy for a high risk label", async () => {
    const output = await activities.refine(
      input({ source: { ...input().source, labels: ["payments"] } }),
    );
    expect(output.autonomyLevel).toBe("L2");
    expect(output.risks).toContain("payments");
  });

  it("returns the same output for the same input, so a retry is safe", async () => {
    const first = await activities.refine(input());
    const second = await activities.refine(input());
    expect(second).toEqual(first);
  });
});
```

If `tests/support/fake-runner.ts` exports no `silentLogger`, read the file and use whichever
logger stub the existing `tests/unit/verify-activity.test.ts` already uses. Do not add a second
stub.

- [ ] **Step 3: Write the refinement activity**

Create `src/activities/refinement.activities.ts`:

```ts
import type { Logger } from "~/telemetry/logger.js";
import { metrics } from "~/telemetry/metrics.js";
import type {
  RecordedDecision,
  RefinementEngine,
  RefinementProject,
  RefinementQuestion,
} from "~/domain/refinement/refinement-engine.js";
import type { WorkItemSource } from "~/domain/refinement/work-item.js";

export interface RefineActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  source: WorkItemSource;
  project: RefinementProject;
  decisions: RecordedDecision[];
}

export interface RefineActivityOutput {
  status: "ready" | "needs_input";
  goal: string;
  primaryRepository: string;
  referenceRepositories: string[];
  /** The statements only. The workflow needs them for the context topics. */
  acceptanceCriteria: string[];
  /** Every reference the Work Item declared, as written. */
  workItemReferences: string[];
  risks: string[];
  unresolvedQuestions: RefinementQuestion[];
  autonomyLevel: string;
}

export interface RefinementActivityDependencies {
  refinement: RefinementEngine;
  logger: Logger;
}

/**
 * SDD section 63 names this file. SDD section 8 places Refinement before the readiness gate and
 * before any sandbox exists, so the activity holds no sandbox and no agent runner. It is a pure
 * function of its input, which makes a Temporal retry free of side effects.
 */
export const createRefinementActivities = (dependencies: RefinementActivityDependencies) => ({
  refine(input: RefineActivityInput): Promise<RefineActivityOutput> {
    const started = Date.now();
    const output = dependencies.refinement.refine({
      source: input.source,
      project: input.project,
      decisions: input.decisions,
    });
    metrics.refinementDuration.observe(
      { tenant_id: input.tenantId, project_id: input.projectId },
      (Date.now() - started) / 1000,
    );
    dependencies.logger.info("run refined", {
      tenant_id: input.tenantId,
      project_id: input.projectId,
      run_id: input.runId,
      step: "refine",
      status: output.status,
    });
    return Promise.resolve({
      status: output.status,
      goal: output.goal,
      primaryRepository: output.primaryRepository,
      referenceRepositories: output.referenceRepositories,
      acceptanceCriteria: output.proposedAcceptanceCriteria.map((criterion) => criterion.statement),
      workItemReferences: output.workItem.references.map((reference) => reference.value),
      risks: output.risks,
      unresolvedQuestions: output.unresolvedQuestions,
      autonomyLevel: output.autonomyLevel,
    });
  },
});
```

- [ ] **Step 4: Write the failing context activity test**

Create `tests/unit/resolve-context-activity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createContextActivities } from "~/activities/context.activities.js";
import { ContextResolver } from "~/domain/context/context-resolver.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import { FakeContextContractStore } from "../support/fake-context-contract-store.js";
import { FakeRepositoryReader } from "../support/fake-repository-reader.js";
import { silentLogger } from "../support/fake-runner.js";
import type { ResolveContextActivityInput } from "~/activities/context.activities.js";

const PRIMARY_URL = "https://git/acme/webhook-service";
const SHA_A = "a".repeat(40);

const versions: Array<{ runId: string; version: string }> = [];

const runs = {
  setContextContractVersion: (_tenantId: string, runId: string, version: string): Promise<void> => {
    versions.push({ runId, version });
    return Promise.resolve();
  },
};

const build = (files: Record<string, string>) => {
  const reader = new FakeRepositoryReader({ [PRIMARY_URL]: { sha: SHA_A, files } });
  const contracts = new FakeContextContractStore();
  const activities = createContextActivities({
    resolver: new ContextResolver({
      sources: new ContextSourceRegistry([
        new LinearContextSource(),
        new RepositoryContextSource({ reader }),
      ]),
    }),
    contracts,
    runs: runs as never,
    logger: silentLogger,
  });
  return { activities, contracts };
};

const input = (): ResolveContextActivityInput => ({
  runId: "run-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  goal: "Retry a failed notification delivery.",
  acceptanceCriteria: ["A failed notification is retried."],
  primaryRepository: { slug: "acme/webhook-service", url: PRIMARY_URL, ref: "main" },
  referenceRepositories: [],
  workItemReferences: [],
  decisions: [],
});

const files = {
  "README.md": "# Service\n\nThe README claims notification retry lives here.\n",
  "docs/ADR-031.md": "Status: accepted. Notification retry lives elsewhere.\n",
  "src/retry.ts": "export const retry = () => undefined;\n",
};

describe("resolveContext activity", () => {
  it("returns the pinned SHA of the primary repository", async () => {
    const { activities } = build(files);
    const output = await activities.resolveContext(input());
    expect(output.primary).toEqual({ slug: "acme/webhook-service", sha: SHA_A });
  });

  it("persists the contract and records its hash on the Run", async () => {
    versions.length = 0;
    const { activities, contracts } = build(files);
    const output = await activities.resolveContext(input());
    expect(contracts.all()).toHaveLength(1);
    expect(contracts.all()[0]?.sha256).toBe(output.sha256);
    expect(versions).toEqual([{ runId: "run-1", version: output.sha256 }]);
  });

  it("writes one contract only when the activity runs twice", async () => {
    const { activities, contracts } = build(files);
    const first = await activities.resolveContext(input());
    const second = await activities.resolveContext(input());
    expect(contracts.all()).toHaveLength(1);
    expect(second.sha256).toBe(first.sha256);
  });

  it("returns the required context lines and the rendered document", async () => {
    const { activities } = build(files);
    const output = await activities.resolveContext(input());
    expect(output.document).toContain("# Context Contract");
    expect(output.requiredContext.length).toBeGreaterThan(0);
  });

  it("reports a resolved conflict in the summary and no unresolved conflict", async () => {
    const { activities } = build(files);
    const output = await activities.resolveContext(input());
    expect(output.conflictCount).toBeGreaterThan(0);
    expect(output.unresolvedConflict).toBeNull();
    expect(output.summary).toMatch(/conflict/i);
  });

  it("reports an unresolved conflict with one focused question", async () => {
    const { activities } = build({
      "docs/ADR-031.md": "Status: accepted. Notification retry lives here.\n",
      "docs/ADR-042.md": "Status: accepted. Notification retry lives elsewhere.\n",
    });
    const output = await activities.resolveContext(input());
    expect(output.unresolvedConflict?.subject).toBe("notification");
    expect(output.unresolvedConflict?.question.endsWith("?")).toBe(true);
  });

  it("names every pinned repository in the summary", async () => {
    const { activities } = build(files);
    const output = await activities.resolveContext(input());
    expect(output.summary).toContain("acme/webhook-service");
    expect(output.summary).toContain(SHA_A.slice(0, 7));
  });
});
```

- [ ] **Step 5: Write the context activity**

Create `src/activities/context.activities.ts`:

```ts
import type { Logger } from "~/telemetry/logger.js";
import { metrics } from "~/telemetry/metrics.js";
import type { RecordedDecision } from "~/domain/refinement/refinement-engine.js";
import type { ContextResolver } from "~/domain/context/context-resolver.js";
import type { ContextContractStore } from "~/domain/context/context-contract-store.js";
import type { RepositoryRef } from "~/domain/context/context-source.js";
import { conflictQuestion } from "~/domain/context/conflicts.js";
import { requiredContextLines } from "~/domain/context/context-contract.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";

export interface ResolveContextActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  goal: string;
  acceptanceCriteria: string[];
  primaryRepository: RepositoryRef;
  referenceRepositories: RepositoryRef[];
  workItemReferences: string[];
  decisions: RecordedDecision[];
}

export interface ResolveContextActivityOutput {
  sha256: string;
  document: string;
  /** SDD section 21. Only a required item enters the initial role context. */
  requiredContext: string[];
  primary: { slug: string; sha: string };
  references: Array<{ slug: string; sha: string }>;
  /** SDD section 23. Non-null means implementation must not start. */
  unresolvedConflict: { id: string; subject: string; question: string } | null;
  conflictCount: number;
  /** The line Factoree posts to Linear. It is the Phase 4 exit condition in one sentence. */
  summary: string;
}

export interface ContextActivityDependencies {
  resolver: ContextResolver;
  contracts: ContextContractStore;
  runs: RunRepository;
  logger: Logger;
}

const shortSha = (sha: string): string => sha.slice(0, 7);

/** SDD section 63 names this file. */
export const createContextActivities = (dependencies: ContextActivityDependencies) => ({
  async resolveContext(input: ResolveContextActivityInput): Promise<ResolveContextActivityOutput> {
    const started = Date.now();
    const labels = { tenant_id: input.tenantId, project_id: input.projectId };

    const resolved = await dependencies.resolver.resolve({
      runId: input.runId,
      goal: input.goal,
      acceptanceCriteria: input.acceptanceCriteria,
      primaryRepository: input.primaryRepository,
      referenceRepositories: input.referenceRepositories,
      workItemReferences: input.workItemReferences,
      decisions: input.decisions,
    });

    // SDD section 21. The store is idempotent, so an activity retry returns the contract already
    // frozen rather than writing a second one.
    const stored = await dependencies.contracts.save({
      tenantId: input.tenantId,
      runId: input.runId,
      contract: resolved.contract,
      sha256: resolved.sha256,
      document: resolved.document,
    });

    await dependencies.runs.setContextContractVersion(input.tenantId, input.runId, stored.sha256);

    metrics.contextResolutionDuration.observe(labels, (Date.now() - started) / 1000);
    for (const conflict of resolved.contract.conflicts) {
      metrics.contextConflicts.inc({ ...labels, resolution: conflict.resolution });
    }

    dependencies.logger.info("context resolved", {
      tenant_id: input.tenantId,
      project_id: input.projectId,
      run_id: input.runId,
      step: "resolve_context",
      context_contract_version: stored.sha256,
    });

    const repositories = [
      `${resolved.pinned.primary.slug}@${shortSha(resolved.pinned.primary.sha)}`,
      ...resolved.pinned.references.map(
        (repository) => `${repository.slug}@${shortSha(repository.sha)}`,
      ),
    ].join(", ");

    const required = resolved.contract.items.filter((item) => item.classification === "required");

    const summary =
      `Factoree resolved the context of this Run. Repositories: ${repositories}. ` +
      `${resolved.contract.items.length} context items, ${required.length} of them preloaded. ` +
      `${resolved.contract.conflicts.length} conflicts recorded. ` +
      `Context Contract ${shortSha(stored.sha256)}.`;

    return {
      // The stored contract wins, so a retry after a successful write reports the frozen values.
      sha256: stored.sha256,
      document: stored.document,
      requiredContext: requiredContextLines(resolved.contract),
      primary: resolved.pinned.primary,
      references: resolved.pinned.references,
      unresolvedConflict:
        resolved.unresolvedConflict === null
          ? null
          : {
              id: resolved.unresolvedConflict.id,
              subject: resolved.unresolvedConflict.subject,
              question: conflictQuestion(resolved.unresolvedConflict),
            },
      conflictCount: resolved.contract.conflicts.length,
      summary,
    };
  },
});
```

- [ ] **Step 6: Register both activity groups**

In `src/activities/index.ts`, add to `ActivityDependencies`:

```ts
  refinement: RefinementEngine;
  contextResolver: ContextResolver;
  contextContracts: ContextContractStore;
```

and add to `createActivities`:

```ts
  ...createRefinementActivities({
    refinement: dependencies.refinement,
    logger: dependencies.logger,
  }),
  ...createContextActivities({
    resolver: dependencies.contextResolver,
    contracts: dependencies.contextContracts,
    runs: dependencies.runs,
    logger: dependencies.logger,
  }),
```

with the matching imports.

- [ ] **Step 7: Wire the worker**

In `src/bin/worker.ts`, construct the three new dependencies beside the existing ones:

```ts
const repositoryReader = new GitRepositoryReader();
const contextSources = new ContextSourceRegistry([
  new LinearContextSource(),
  new RepositoryContextSource({ reader: repositoryReader }),
]);
```

and pass `refinement: new RefinementEngine()`, `contextResolver: new ContextResolver({ sources: contextSources })`, and `contextContracts: new PrismaContextContractStore(prisma)` into `createActivities`.

Read the existing shutdown path of `worker.ts` and add `repositoryReader.close()` to it, so the
temporary mirrors are removed when the worker stops.

- [ ] **Step 8: Run both tests, then lint and typecheck**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/refine-activity.test.ts tests/unit/resolve-context-activity.test.ts
npm run lint && npm run typecheck
```

Expected: PASS, 7 + 7 tests. Lint and typecheck exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/activities src/telemetry/metrics.ts src/bin/worker.ts tests/unit/refine-activity.test.ts tests/unit/resolve-context-activity.test.ts
git commit -m "feat: add the refinement and context activities with their SDD section 62 metrics"
```

---

### Task 10: The workflow states, the question rounds, and the pinned refs

**Files:**
- Modify: `src/workflows/agent-run.workflow.ts`
- Modify: `src/domain/runs/run-status.ts`
- Modify: `src/activities/agent.activities.ts`
- Test: `tests/workflow/agent-run.workflow.test.ts` (extend)
- Test: `tests/workflow/at-03-material-uncertainty.test.ts` (create)
- Test: `tests/workflow/at-08-unresolvable-conflict.test.ts` (create)

**Interfaces:**
- Consumes: the two activities of Task 9.
- Produces:
  - `AgentRunWorkflowInput` gains `workItem: WorkItemSource` and `project: { primaryRepository: string; referenceRepositories: string[]; defaultBranch: string; repositoryBaseUrl: string; stagingRead: boolean; spriteRetentionHours: number }`, and loses `sandbox`.
  - `RunSnapshot` gains `contextContractVersion: string | null` and `openQuestion: string | null`.
  - `RUN_FAILURE_REASONS` gains `REFINEMENT_UNRESOLVED` and `CONTEXT_UNRESOLVED`.
  - `ImplementActivityInput` gains `contextContract: string | null` and `requiredContext: string[]`.

**Workflow order, per SDD §49:**

```text
createRun → acknowledge → REFINING
  ├─ needs_input → WAITING_FOR_INPUT → elicit one question → wait for one human input → REFINING
  ↓
RESOLVING_CONTEXT
  ├─ unresolved conflict → WAITING_FOR_INPUT → elicit one question → wait → RESOLVING_CONTEXT
  ↓
PREPARING (primary and reference refs are the pinned SHAs)
  ↓
IMPLEMENTING → VERIFYING → REPAIRING as Phase 3 built them
```

**Rules the workflow must keep:**

- The session is acknowledged before refinement, because SDD §26 requires acknowledgement before
  long-running context work.
- `MAX_QUESTION_ROUNDS = 5` applies to refinement and to conflict resolution together. A sixth
  round fails the Run with `REFINEMENT_UNRESOLVED` for a refinement question and
  `CONTEXT_UNRESOLVED` for a conflict question. Controller decision 6.
- The wait for a human input is bounded by the remaining Run budget. A budget that ends first is
  `RUN_TIMEOUT`.
- A stop signal during any wait ends the Run through the existing `cancelRun`.
- A human input answers the currently open question only, and becomes a `RecordedDecision`.
  Controller decision 5.
- The Implementer receives the rendered contract and the required-context lines. Nothing else
  about the contract reaches the prompt, so no file body can enter it. AT-09.
- `Run.baseSha` continues to be written by `prepareSandbox` from the real checkout, which now
  lands on the pinned SHA, so the recorded SHA and the pinned SHA agree.

- [ ] **Step 1: Add the two failure reasons**

In `src/domain/runs/run-status.ts`, add to `RUN_FAILURE_REASONS`:

```ts
  // SDD section 8. A material question stayed unanswered past the bounded question rounds.
  "REFINEMENT_UNRESOLVED",
  // SDD section 23. A conflict with no authority winner stayed unanswered.
  "CONTEXT_UNRESOLVED",
```

- [ ] **Step 2: Write the failing AT-03 workflow test**

Create `tests/workflow/at-03-material-uncertainty.test.ts`. Read
`tests/workflow/at-16-deterministic-failure.test.ts` first and reuse its harness exactly; the
test below only states what it asserts.

```ts
import { describe, expect, it } from "vitest";
import { withWorkflowEnvironment } from "./support/harness.js";

describe("AT-03 material uncertainty", () => {
  it("leaves the Run in WAITING_FOR_INPUT and starts no Implementer", async () => {
    await withWorkflowEnvironment(async (harness) => {
      const handle = await harness.start({
        workItem: {
          issueId: "issue-1",
          title: "Send a notification",
          description: "## Goal\n\nSend one.\n\n## Open questions\n\n- Which channel do we use?\n",
          url: null,
          labels: [],
        },
      });
      await harness.waitForStatus(handle, "WAITING_FOR_INPUT");
      const snapshot = await handle.query(harness.runStatusQuery);
      expect(snapshot.status).toBe("WAITING_FOR_INPUT");
      expect(snapshot.openQuestion).toBe("Which channel do we use?");
      expect(harness.runner.runs).toHaveLength(0);
      expect(harness.elicitations).toEqual(["Which channel do we use?"]);
      await handle.signal(harness.stopSignal);
      await handle.result();
    });
  });

  it("continues to context resolution once a human answers", async () => {
    await withWorkflowEnvironment(async (harness) => {
      const handle = await harness.start({
        workItem: {
          issueId: "issue-1",
          title: "Send a notification",
          description: "## Goal\n\nSend one.\n\n## Open questions\n\n- Which channel do we use?\n",
          url: null,
          labels: [],
        },
      });
      await harness.waitForStatus(handle, "WAITING_FOR_INPUT");
      await handle.signal(harness.humanInputSignal, "Use the existing email channel.");
      await harness.waitForStatus(handle, "IMPLEMENTING");
      const snapshot = await handle.query(harness.runStatusQuery);
      expect(snapshot.contextContractVersion).toMatch(/^[0-9a-f]{64}$/);
      await handle.signal(harness.stopSignal);
      await handle.result();
    });
  });

  it("fails the Run when the question is never answered and the rounds are spent", async () => {
    await withWorkflowEnvironment(async (harness) => {
      const handle = await harness.start({
        workItem: {
          issueId: "issue-1",
          title: "Send a notification",
          description: "## Goal\n\nSend one.\n\n## Open questions\n\n- Which channel do we use?\n",
          url: null,
          labels: [],
        },
      });
      await harness.waitForStatus(handle, "WAITING_FOR_INPUT");
      // Each answer resolves the question it was asked against and the engine asks it again,
      // because the fixture Work Item still states it. Six rounds exhaust the bound.
      for (let round = 0; round < 6; round += 1) {
        await handle.signal(harness.humanInputSignal, `answer ${round}`);
      }
      const result = await handle.result();
      expect(result.status).toBe("FAILED");
      expect(harness.completions.at(-1)?.failureReason).toBe("REFINEMENT_UNRESOLVED");
    });
  });
});
```

The harness must gain: `elicitations: string[]` collected from the `postElicitation` activity,
`completions` collected from `completeRun`, a `start` that takes a `workItem` and fills the rest
from a default fixture Project, and `waitForStatus(handle, status)` that polls the `runStatus`
query. Extend `tests/workflow/support/harness.ts` rather than adding a second harness.

Note on the third test: the refinement engine numbers questions by position, so an answer to
`Q-1` resolves it. The fixture must therefore re-raise a question each round. Implement this by
having the harness's default refine path use a Work Item with **two** open questions, so answering
the first leaves the second, and the loop keeps a question open. Adjust the fixture description to
`- Which channel do we use?\n- Which template do we use?\n` and assert the second question is
elicited after the first answer. If a bounded fixture cannot exhaust the rounds honestly, delete
this third test and instead unit-test the round bound directly against the workflow's constant;
do not weaken the assertion to make it pass.

- [ ] **Step 3: Write the workflow changes**

Replace `AgentRunSandboxInput` in `src/workflows/agent-run.workflow.ts` with:

```ts
export interface AgentRunProjectInput {
  primaryRepository: string;
  referenceRepositories: string[];
  defaultBranch: string;
  /** Turns an `owner/repo` slug into a clone URL until the Phase 9 GitHub adapter exists. */
  repositoryBaseUrl: string;
  /** SDD section 57. The Project owns these two values; the repository must not widen them. */
  stagingRead: boolean;
  spriteRetentionHours: number;
  defaultAutonomy: string;
}

export interface AgentRunWorkItemInput {
  issueId: string | null;
  title: string;
  description: string;
  url: string | null;
  labels: string[];
}
```

`AgentRunWorkflowInput` becomes:

```ts
export interface AgentRunWorkflowInput {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  linearIssueId: string | null;
  agentSessionId: string;
  autonomyLevel: string;
  maxRunMinutes: number;
  workItem: AgentRunWorkItemInput;
  project: AgentRunProjectInput;
}
```

`RunSnapshot` becomes:

```ts
export interface RunSnapshot {
  runId: string | null;
  status: RunStatus;
  humanInputs: string[];
  spriteId: string | null;
  /** SDD section 53. The SHA-256 of the frozen Context Contract. */
  contextContractVersion: string | null;
  /** SDD section 23. The one question Factoree is waiting on, or null. */
  openQuestion: string | null;
}
```

Add these activity proxies beside the existing ones:

```ts
/**
 * Refinement is a pure computation, so it is fast and a retry costs nothing. Context resolution
 * clones and reads repositories, so it is bounded by the remaining Run budget in the same way
 * preparation is.
 */
const REFINE_TIMEOUT_MS = 60_000;

const buildContextActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${Math.min(30 * 60_000, budgetMs)} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs} milliseconds`,
    retry: { maximumAttempts: 3, initialInterval: "5 seconds", backoffCoefficient: 2 },
  });
```

Add the constants and the state:

```ts
/**
 * SDD section 8 and section 23 impose no bound on the elicitation loop, and an unbounded loop is
 * a workflow that never ends. Five rounds cover a realistic clarification and then stop. The Run
 * budget of SDD section 50 bounds it as well. See controller decision 6.
 */
const MAX_QUESTION_ROUNDS = 5;
```

Inside the workflow body, after `acknowledgeSession` and the `RECEIVED` status write, insert the
refinement loop and the context loop. Write it as one helper so the two loops share the wait:

```ts
  const decisions: RecordedDecision[] = [];
  let openQuestion: string | null = null;
  let contextContractVersion: string | null = null;
  let questionRounds = 0;

  /**
   * SDD section 23 requires one focused question. The workflow asks it, waits for exactly one
   * human input, and records the answer against that question. It returns false when the Run must
   * end instead, so every caller checks the result.
   */
  const askAndWait = async (questionId: string, question: string): Promise<boolean> => {
    if (questionRounds >= MAX_QUESTION_ROUNDS) return false;
    questionRounds += 1;
    openQuestion = question;
    status = "WAITING_FOR_INPUT";
    await activities.setRunStatus({ runId: id, status });
    await notify(() =>
      activities.postElicitation({ sessionId: input.agentSessionId, question }),
    );
    const answersBefore = humanInputs.length;
    const answered = await condition(
      () => stopRequested || humanInputs.length > answersBefore,
      remainingMs(),
    );
    openQuestion = null;
    if (!answered || stopRequested) return false;
    const answer = humanInputs[humanInputs.length - 1] ?? "";
    decisions.push({ questionId, question, answer });
    return true;
  };
```

The refinement loop:

```ts
      status = "REFINING";
      await activities.setRunStatus({ runId: id, status });

      let refined = await refineActivities.refine({
        runId: id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        source: input.workItem,
        project: {
          primaryRepository: input.project.primaryRepository,
          referenceRepositories: input.project.referenceRepositories,
          defaultAutonomy: input.project.defaultAutonomy,
        },
        decisions,
      });

      while (refined.status === "needs_input") {
        const question = refined.unresolvedQuestions[0];
        if (question === undefined) break;
        const proceeded = await askAndWait(question.id, question.question);
        if (stopRequested) return await cancelRun();
        if (!proceeded) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          return await failRun(
            "REFINEMENT_UNRESOLVED",
            "Factoree could not start, because a material product decision is still open: " +
              `${question.question} Factoree must not invent product behavior, so it published nothing.`,
          );
        }
        status = "REFINING";
        await activities.setRunStatus({ runId: id, status });
        refined = await refineActivities.refine({
          runId: id,
          tenantId: input.tenantId,
          projectId: input.projectId,
          source: input.workItem,
          project: {
            primaryRepository: input.project.primaryRepository,
            referenceRepositories: input.project.referenceRepositories,
            defaultAutonomy: input.project.defaultAutonomy,
          },
          decisions,
        });
      }
```

The context loop:

```ts
      const repositoryRef = (slug: string) => ({
        slug,
        url: buildRepositoryUrl(input.project.repositoryBaseUrl, slug),
        ref: input.project.defaultBranch,
      });

      let resolvedContext: ResolveContextActivityOutput;
      for (;;) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
        status = "RESOLVING_CONTEXT";
        await activities.setRunStatus({ runId: id, status });

        resolvedContext = await buildContextActivities(remainingMs()).resolveContext({
          runId: id,
          tenantId: input.tenantId,
          projectId: input.projectId,
          goal: refined.goal,
          acceptanceCriteria: refined.acceptanceCriteria,
          primaryRepository: repositoryRef(refined.primaryRepository),
          referenceRepositories: refined.referenceRepositories.map(repositoryRef),
          workItemReferences: refined.workItemReferences,
          decisions,
        });
        contextContractVersion = resolvedContext.sha256;

        await notify(() =>
          activities.postProgress({
            sessionId: input.agentSessionId,
            message: resolvedContext.summary,
          }),
        );

        const conflict = resolvedContext.unresolvedConflict;
        if (conflict === null) break;

        // SDD section 23. No safe resolution exists, so implementation must not start.
        const proceeded = await askAndWait(conflict.id, conflict.question);
        if (stopRequested) return await cancelRun();
        if (!proceeded) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          return await failRun(
            "CONTEXT_UNRESOLVED",
            "Factoree could not start, because two equally authoritative sources disagree: " +
              `${conflict.question} Factoree published nothing.`,
          );
        }
      }
```

**Important:** the contract is frozen on the first `resolveContext` call, because the store is
idempotent. A second call after a human answer therefore returns the first contract, and the new
decision would not reach it. Fix this by giving the store a per-attempt key: pass
`attempt: questionRounds` into `resolveContext`, and let the activity save under
`runId` only when the resolution has no unresolved conflict. Change the activity so that it saves
the contract **only** when `resolved.unresolvedConflict === null`, and returns the unsaved values
otherwise. Add this comment there:

```ts
    // SDD section 21 freezes the Context Contract, and SDD section 23 forbids starting
    // implementation while a conflict is unresolved. A contract that still holds an unresolved
    // conflict is therefore not the contract of this Run, so it is not frozen. Only the
    // resolution that a human settled reaches the store, and it reaches it exactly once.
```

Update `tests/unit/resolve-context-activity.test.ts` to assert this: the unresolved case stores
nothing, and `sha256` is still returned so the Run snapshot can show it.

Then replace the `sandbox` block that follows with the same Phase 3 body, changed only in these
places:

```ts
      const sandboxSpec = {
        primary: {
          url: buildRepositoryUrl(input.project.repositoryBaseUrl, resolvedContext.primary.slug),
          // SDD section 20. The checkout lands on the SHA discovery pinned, never on a moving ref.
          ref: resolvedContext.primary.sha,
        },
        references: resolvedContext.references.map((repository) => ({
          url: buildRepositoryUrl(input.project.repositoryBaseUrl, repository.slug),
          ref: repository.sha,
        })),
        defaults: {
          stagingRead: input.project.stagingRead,
          spriteRetentionHours: input.project.spriteRetentionHours,
        },
        goal: refined.goal,
      };
```

and pass `contextContract: resolvedContext.document` and
`requiredContext: resolvedContext.requiredContext` into every `implement` call.

`buildRepositoryUrl` is a value import, so it must use a relative path, exactly as
`RUN_CONFIGURATION_ERROR_TYPE` already does in this file. Add:

```ts
// The workflow bundler resolves a relative path only, so this value import does not use the
// `~/` alias.
import { buildRepositoryUrl } from "../domain/projects/repository-url.js";
```

Update the `runStatusQuery` handler to return `contextContractVersion` and `openQuestion`.

- [ ] **Step 4: Pass the contract into the Implementer prompt**

In `src/activities/agent.activities.ts`, add `contextContract: string | null` and
`requiredContext: string[]` to `ImplementActivityInput`, and pass them into
`buildImplementerInput`, which already accepts both fields. Nothing else changes there.

- [ ] **Step 5: Write the failing AT-08 workflow test**

Create `tests/workflow/at-08-unresolvable-conflict.test.ts`, using the same harness. It drives a
fixture primary repository holding two accepted ADRs that both carry the Work Item topic, and
asserts:

```ts
      await harness.waitForStatus(handle, "WAITING_FOR_INPUT");
      const snapshot = await handle.query(harness.runStatusQuery);
      expect(snapshot.openQuestion).toMatch(/ADR-031/);
      expect(snapshot.openQuestion).toMatch(/ADR-042/);
      expect(harness.runner.runs).toHaveLength(0);
```

and, after a human answer, that the Run reaches `PREPARING`. If the fixture still reports the
conflict after the answer, the harness must supply a second primary fixture for the second round
rather than weakening the assertion.

**A note the implementer must act on:** a human answer does not remove the two ADRs, so the second
resolution finds the same conflict. Resolve this in the domain, not in the test: in
`detectConflicts`, treat a conflict as resolved when a `work_item_decision` item in the same
contract carries the conflict subject as a topic, and record the reason
`a recorded human decision settles this subject`. Add a unit test for that rule in
`tests/unit/context-conflicts.test.ts`:

```ts
  it("treats a conflict as resolved when a recorded human decision covers the subject", () => {
    const conflicts = detectConflicts([
      item("docs/ADR-031.md", "accepted_adr", ["notification"]),
      item("docs/ADR-042.md", "accepted_adr", ["notification"]),
      item("linear:decision:CTX-1", "work_item_decision", ["notification"], "required"),
    ]);
    const unresolved = conflicts.filter((conflict) => conflict.resolution === "unresolved");
    expect(unresolved).toEqual([]);
    const settled = conflicts.find((conflict) => conflict.subject === "notification");
    expect(settled?.winnerRef).toBe("linear:decision:CTX-1");
    expect(settled?.reason).toBe("a recorded human decision settles this subject");
  });
```

This is the SDD §22 rule, not an invention: an explicit Work Item decision is the highest
product-intent authority, and SDD §23 requires the human answer to be persisted as a Run decision
that governs the Run.

- [ ] **Step 6: Update every existing workflow test to the new input shape**

`tests/workflow/agent-run.workflow.test.ts`, `tests/workflow/verification.workflow.test.ts`,
`tests/workflow/at-16-deterministic-failure.test.ts`, `tests/workflow/at-35-worker-restart.test.ts`,
`tests/acceptance/phase-02-exit.test.ts`, and `tests/acceptance/phase-03-exit.test.ts` all build an
`AgentRunWorkflowInput`. Give each of them a `workItem` and a `project` block instead of a
`sandbox` block, and register the two new activities in every harness. Do not change what any of
those tests assert.

- [ ] **Step 7: Run the whole workflow suite**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run test:workflow
```

Expected: every existing workflow test still passes, and the AT-03 and AT-08 tests pass.

- [ ] **Step 8: Run lint, typecheck, and every suite, then commit**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck && npm test
git add src tests
git commit -m "feat: add REFINING, WAITING_FOR_INPUT, and RESOLVING_CONTEXT to the workflow"
```

---

### Task 11: Wire the delegation service to the new workflow input

**Files:**
- Modify: `src/domain/runs/delegation-service.ts`
- Test: `tests/unit/delegation-service.test.ts` (extend)

**Interfaces:**
- Consumes: `AgentRunWorkflowInput` from Task 10.
- Produces: no new export. `DelegationService` builds `workItem` and `project` instead of `sandbox`.

**Behaviour:**

- `buildGoal` is deleted. The workflow now derives the goal from Refinement, so the delegation
  service must not compute one.
- `buildRepositoryUrl` is no longer called at delegation time, because the workflow builds the
  URLs after Refinement decides the repositories. The `unconfigured` outcome that guarded a bad
  slug moves with it: validate the primary slug here so a misconfigured Project still fails fast
  and returns `unconfigured`, and leave the URL construction to the workflow.
- The Linear webhook already carries `title`, `description`, and `url`. If it carries no labels
  field, pass an empty label list and record that gap as a Phase 5 finding rather than inventing a
  Linear API read here.

- [ ] **Step 1: Extend the failing test**

Add to `tests/unit/delegation-service.test.ts`:

```ts
  it("passes the Work Item to the workflow instead of a prebuilt goal", async () => {
    const { service, starter } = build();
    await service.handleAgentSessionEvent(createdEvent(), "delivery-1");
    const [started] = starter.started;
    expect(started?.args[0]?.workItem).toEqual({
      issueId: "issue-1",
      title: "Add a webhook retry",
      description: "Deliveries are lost.",
      url: "https://linear.app/acme/issue/ACME-1",
      labels: [],
    });
  });

  it("passes the Project repository configuration to the workflow", async () => {
    const { service, starter } = build();
    await service.handleAgentSessionEvent(createdEvent(), "delivery-1");
    const [started] = starter.started;
    expect(started?.args[0]?.project).toEqual({
      primaryRepository: "acme/webhook-service",
      referenceRepositories: ["acme/notification-service"],
      defaultBranch: "main",
      repositoryBaseUrl: "https://github.com",
      stagingRead: false,
      spriteRetentionHours: 24,
      defaultAutonomy: "L2",
    });
  });

  it("reports an unusable primary repository slug as unconfigured", async () => {
    const { service, starter } = build({ primaryRepository: "not-a-slug" });
    const outcome = await service.handleAgentSessionEvent(createdEvent(), "delivery-1");
    expect(outcome.kind).toBe("unconfigured");
    expect(starter.started).toHaveLength(0);
  });
```

Adjust the fixture builders in that file to match its existing style. Read the file before
editing it.

- [ ] **Step 2: Change the delegation service**

Replace the `sandbox` block in `dispatch` with:

```ts
    // SDD section 8 and section 49. Refinement decides the goal and the repositories, and context
    // resolution pins every SHA, so the delegation service passes the raw Work Item and the
    // Project configuration and computes neither.
    try {
      // A slug the URL builder cannot use is a Project misconfiguration, and it must fail here
      // rather than inside the workflow, where the operator sees only a failed Run.
      buildRepositoryUrl(this.dependencies.repositoryBaseUrl, project.primaryRepository);
      for (const slug of project.referenceRepositories) {
        buildRepositoryUrl(this.dependencies.repositoryBaseUrl, slug);
      }
    } catch (error) {
      await this.dependencies.webhookLog.remove(deliveryId);
      return {
        kind: "unconfigured",
        reason: `project ${project.key} has an unusable repository: ${String(error)}`,
      };
    }

    const issue = event.agentSession.issue;
    const workItem = {
      issueId: event.agentSession.issueId ?? issue?.id ?? null,
      title: issue?.title ?? "",
      description: issue?.description ?? "",
      url: issue?.url ?? null,
      // The agent session webhook carries no label list. Phase 5 reads the labels through the
      // Linear API, and SDD section 28 then caps autonomy on a real high-risk label. Until then
      // no label is claimed, because an invented label would be worse than none.
      labels: [] as string[],
    };
```

and pass `workItem` and

```ts
          project: {
            primaryRepository: project.primaryRepository,
            referenceRepositories: project.referenceRepositories,
            defaultBranch: project.defaultBranch,
            repositoryBaseUrl: this.dependencies.repositoryBaseUrl,
            stagingRead: DEFAULT_PROJECT_DEFAULTS.stagingRead,
            spriteRetentionHours: DEFAULT_PROJECT_DEFAULTS.spriteRetentionHours,
            defaultAutonomy: project.defaultAutonomy,
          },
```

into `starter.start`. Delete `buildGoal` and its import of `AgentRunSandboxInput`.

- [ ] **Step 3: Run the delegation tests and the integration suite**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/delegation-service.test.ts
npx vitest run --config vitest.integration.config.ts tests/integration/at-01-delegation.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run lint and typecheck, then commit**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck
git add src/domain/runs/delegation-service.ts tests/unit/delegation-service.test.ts
git commit -m "feat: pass the Work Item and the Project configuration to the workflow"
```

---
### Task 12: The acceptance tests and the phase exit condition

**Files:**
- Create: `tests/acceptance/support/context-fixture-repository.ts`
- Create: `tests/acceptance/at-02-refinement.test.ts`
- Create: `tests/acceptance/at-05-reference-repository.test.ts`
- Create: `tests/acceptance/at-06-context-provenance.test.ts`
- Create: `tests/acceptance/at-07-resolvable-conflict.test.ts`
- Create: `tests/acceptance/at-09-context-limit.test.ts`
- Create: `tests/acceptance/phase-04-exit.test.ts`

**Interfaces:**
- Consumes: everything the earlier tasks produce, plus the existing
  `tests/acceptance/support/fixture-repository.ts`.
- Produces: `buildContextFixture(options): Promise<ContextFixture>` with
  `{ root: string; primaryUrl: string; primarySha: string; referenceUrl: string; referenceSha: string; cleanup(): void }`.

**The fixture repositories**

`buildContextFixture` creates two real local git repositories. Read
`tests/acceptance/support/fixture-repository.ts` first and reuse its commit helper rather than
writing a second one.

The primary repository, `acme/webhook-service`:

- `.factoree/config.yaml` — a minimal valid file with one verification command.
- `README.md` — `# Webhook service` and a line claiming `notification retry` is owned here.
- `docs/ADR-031.md` — `Status: accepted` and a line stating `notification retry` is owned by the
  notification service.
- `src/retry.ts` — a small function, the existing implementation pattern AT-02 needs.
- `tests/retry.test.ts` — the relevant test AT-02 mentions.
- `assets/large.bin` — 200 kilobytes, which AT-09 must not preload.

The reference repository, `acme/notification-service`:

- `openapi.yaml` — a small contract.
- `README.md`.

`options.extraPrimaryFiles` adds a file, so one test can add `docs/ADR-042.md` for AT-08.

The tests below drive the domain, not the Temporal workflow, except `phase-04-exit.test.ts`, which
drives the workflow through the existing harness. A domain-level test is enough for AT-02, AT-06,
AT-07, and AT-09, because those requirements are statements about the Context Contract, and the
workflow adds nothing to them. AT-05 needs a real checkout, so it drives `SandboxManager` with the
local sandbox adapter, exactly as `tests/acceptance/at-12-isolation.test.ts` already does.

- [ ] **Step 1: Write AT-02**

Create `tests/acceptance/at-02-refinement.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RefinementEngine } from "~/domain/refinement/refinement-engine.js";
import { ContextResolver } from "~/domain/context/context-resolver.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { buildContextFixture } from "./support/context-fixture-repository.js";
import type { ContextFixture } from "./support/context-fixture-repository.js";

let fixture: ContextFixture;
const reader = new GitRepositoryReader();

beforeAll(async () => {
  fixture = await buildContextFixture();
}, 120_000);

afterAll(() => {
  reader.close();
  fixture.cleanup();
});

/**
 * AT-02. A technically vague fixture issue with clear intent is enriched with the correct primary
 * repository, at least one relevant implementation pattern, and candidate acceptance assertions.
 * No source code is changed.
 */
describe("AT-02 refinement", () => {
  it("enriches a vague issue and changes no source code", async () => {
    const before = execFileSync("git", ["-C", fixture.primaryPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    const refined = new RefinementEngine().refine({
      source: {
        issueId: "issue-1",
        title: "Notification retry is broken",
        description: "A failed notification delivery is never retried. Users lose messages.",
        url: "https://linear.app/acme/issue/ACME-1",
        labels: [],
      },
      project: {
        primaryRepository: "acme/webhook-service",
        referenceRepositories: ["acme/notification-service"],
        defaultAutonomy: "L3",
      },
      decisions: [],
    });

    // The correct primary repository.
    expect(refined.primaryRepository).toBe("acme/webhook-service");
    expect(refined.status).toBe("ready");

    // Candidate acceptance assertions, derived and marked as derived so a human can see they are
    // proposals. SDD section 7 forbids inventing product behavior, so each one restates the issue.
    expect(refined.proposedAcceptanceCriteria.length).toBeGreaterThan(0);
    for (const criterion of refined.proposedAcceptanceCriteria) {
      expect(criterion.source).toBe("derived:goal");
      expect(refined.goal).toContain(criterion.statement);
    }

    const resolver = new ContextResolver({
      sources: new ContextSourceRegistry([
        new LinearContextSource(),
        new RepositoryContextSource({ reader }),
      ]),
    });
    const resolved = await resolver.resolve({
      runId: "run-at-02",
      goal: refined.goal,
      acceptanceCriteria: refined.proposedAcceptanceCriteria.map((c) => c.statement),
      primaryRepository: { slug: "acme/webhook-service", url: fixture.primaryUrl, ref: "main" },
      referenceRepositories: [
        { slug: "acme/notification-service", url: fixture.referenceUrl, ref: "main" },
      ],
      workItemReferences: [],
      decisions: [],
    });

    // At least one relevant implementation pattern.
    const paths = resolved.contract.items.map((item) => item.reference.path);
    expect(paths).toContain("src/retry.ts");

    // At least one relevant test.
    expect(paths).toContain("tests/retry.test.ts");

    // No source code changed. Refinement holds no port, and the reader only reads.
    const after = execFileSync("git", ["-C", fixture.primaryPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    expect(after).toBe(before);
    expect(
      execFileSync("git", ["-C", fixture.primaryPath, "status", "--porcelain"], { encoding: "utf8" }),
    ).toBe("");
  }, 120_000);
});
```

- [ ] **Step 2: Write AT-05**

Create `tests/acceptance/at-05-reference-repository.test.ts`. Read
`tests/acceptance/at-12-isolation.test.ts` first and reuse the way it builds a
`LocalProcessSandbox` and a `SandboxManager`. The test:

1. Resolves the reference repository SHA with `GitRepositoryReader.resolveRef`.
2. Calls `SandboxManager.prepare` with `references: [{ url, ref: <that SHA> }]`.
3. Asserts the reference checkout `baseSha` is that exact forty-character SHA.
4. Asserts a write inside the reference checkout fails, by running
   `sh -c 'echo x > <referencePath>/README.md'` through `sandbox.exec` and expecting a non-zero
   exit code.
5. Asserts the primary checkout is writable, so the read-only control is specific and not a blanket
   failure.

```ts
    // SDD section 20. Every reference repository is checked out at an explicit commit SHA.
    expect(prepared.checkout.references[0]?.baseSha).toBe(referenceSha);
    expect(referenceSha).toMatch(/^[0-9a-f]{40}$/);

    // SDD section 20 and section 29. The Implementer must not modify a reference repository.
    const write = await sandbox.exec(prepared.ref, {
      file: "sh",
      args: ["-c", `echo changed > ${prepared.checkout.references[0]?.path ?? ""}/README.md`],
    });
    expect(write.exitCode).not.toBe(0);

    const primaryWrite = await sandbox.exec(prepared.ref, {
      file: "sh",
      args: ["-c", `echo changed > ${prepared.checkout.primary.path}/scratch.txt`],
    });
    expect(primaryWrite.exitCode).toBe(0);
```

Carry forward the known limitation the Phase 2 record already states: the read-only control is a
file mode the owning user can reverse, and the real control is running the agent as a different
user. Add that sentence as a comment in the test so a reader is not misled.

- [ ] **Step 3: Write AT-06**

Create `tests/acceptance/at-06-context-provenance.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContextResolver } from "~/domain/context/context-resolver.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import {
  ContextContractInvalidError,
  validateContextContract,
} from "~/domain/context/context-contract.js";
import { buildContextFixture } from "./support/context-fixture-repository.js";
import type { ContextFixture } from "./support/context-fixture-repository.js";

let fixture: ContextFixture;
const reader = new GitRepositoryReader();

beforeAll(async () => {
  fixture = await buildContextFixture();
}, 120_000);

afterAll(() => {
  reader.close();
  fixture.cleanup();
});

const resolve = () =>
  new ContextResolver({
    sources: new ContextSourceRegistry([
      new LinearContextSource(),
      new RepositoryContextSource({ reader }),
    ]),
  }).resolve({
    runId: "run-at-06",
    goal: "Retry a failed notification delivery.",
    acceptanceCriteria: ["A failed notification is retried."],
    primaryRepository: { slug: "acme/webhook-service", url: fixture.primaryUrl, ref: "main" },
    referenceRepositories: [
      { slug: "acme/notification-service", url: fixture.referenceUrl, ref: "main" },
    ],
    workItemReferences: [],
    decisions: [],
  });

/** AT-06. Every selected Context Item contains source, version, authority, and reason. */
describe("AT-06 context provenance", () => {
  it("gives every selected item complete provenance", async () => {
    const resolved = await resolve();
    expect(resolved.contract.items.length).toBeGreaterThan(0);
    for (const item of resolved.contract.items) {
      expect(item.reference.sourceId.length).toBeGreaterThan(0);
      expect(item.reference.ref.length).toBeGreaterThan(0);
      expect(item.sourceVersion.length).toBeGreaterThan(0);
      expect(item.authority.length).toBeGreaterThan(0);
      expect(item.reason.length).toBeGreaterThan(0);
      expect(["required", "reference", "discoverable"]).toContain(item.classification);
    }
  }, 120_000);

  it("fails validation when any provenance field is missing", async () => {
    const resolved = await resolve();
    const fields = ["sourceId", "sourceVersion", "authority", "reason"] as const;
    for (const field of fields) {
      const broken = structuredClone(resolved.contract);
      const item = broken.items[0];
      if (item === undefined) throw new Error("expected at least one item");
      if (field === "sourceId") item.reference = { ...item.reference, sourceId: "" };
      else if (field === "sourceVersion") item.sourceVersion = "";
      else if (field === "authority") item.authority = "" as typeof item.authority;
      else item.reason = "";
      expect(() => validateContextContract(broken)).toThrow(ContextContractInvalidError);
    }
  }, 120_000);

  it("records the repository, the SHA, the path, and the content hash of a repository item", async () => {
    const resolved = await resolve();
    const item = resolved.contract.items.find((candidate) => candidate.reference.path !== null);
    expect(item?.reference.repository).toBe("acme/webhook-service");
    expect(item?.reference.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(item?.reference.path?.length).toBeGreaterThan(0);
    if (item?.classification === "required") expect(item.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);
});
```

- [ ] **Step 4: Write AT-07**

Create `tests/acceptance/at-07-resolvable-conflict.test.ts`. It uses the same fixture and asserts:

```ts
    const conflict = resolved.contract.conflicts.find(
      (candidate) => candidate.subject === "notification",
    );
    // AT-07. The README loses to the accepted ADR, and the decision is recorded.
    expect(conflict?.resolution).toBe("resolved");
    expect(conflict?.winnerRef).toBe("repository:acme/webhook-service:docs/ADR-031.md");
    expect(conflict?.loserRef).toBe("repository:acme/webhook-service:README.md");
    expect(conflict?.reason).toBe(
      "accepted ADR has higher architecture authority than repository README",
    );
    // The recorded decision reaches a human through the rendered contract.
    expect(resolved.document).toContain(conflict?.id ?? "");
    expect(resolved.document).toContain("docs/ADR-031.md");
```

- [ ] **Step 5: Write AT-09**

Create `tests/acceptance/at-09-context-limit.test.ts`. It resolves the same fixture and asserts:

```ts
    // AT-09. The large repository is referenced and tool-accessible.
    const repository = resolved.contract.items.find(
      (item) => item.reference.ref === "repository:acme/notification-service",
    );
    expect(repository).toBeDefined();
    expect(repository?.reference.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(repository?.classification).not.toBe("required");

    // It is not copied in full into the initial agent prompt. The prompt receives the rendered
    // contract and the required-context lines only, and neither holds a file body.
    const prompt = renderImplementerPrompt({
      goal: "Retry a failed notification delivery.",
      humanDecisions: [],
      validationContract: null,
      contextContract: resolved.document,
      requiredContext: requiredContextLines(resolved.contract),
      primaryRepositoryPath: "/workspace/primary",
      referenceRepositoryPaths: ["/workspace/reference/notification-service"],
      repositoryInstructions: "",
      skills: [],
      actionPolicyLines: [],
      repairFindings: [],
    });
    expect(prompt).not.toContain(LARGE_FILE_MARKER);
    expect(prompt.length).toBeLessThan(CONTEXT_REQUIRED_MAX_BYTES * 2);
    // The large file is still reachable, because the reference repository is checked out and its
    // path is named in the prompt.
    expect(prompt).toContain("/workspace/reference/notification-service");
```

`LARGE_FILE_MARKER` is a distinctive string the fixture writes inside `assets/large.bin`.

- [ ] **Step 6: Write the phase exit test**

Create `tests/acceptance/phase-04-exit.test.ts`. It drives the Temporal workflow through the
existing harness with the fixture repositories and a stub Implementer, and proves the exit
condition: **Factoree can explain what context it will use before code changes begin.**

```ts
/**
 * The Phase 4 exit condition of SDD section 69: Factoree can explain what context it will use
 * before code changes begin.
 *
 * The proof is a Run that reaches IMPLEMENTING with a frozen, persisted Context Contract whose
 * every item carries complete provenance, whose every repository carries an explicit SHA, and
 * whose text reached both Linear and the Implementer prompt, before the Implementer changed
 * anything.
 */
describe("Phase 4 exit condition", () => {
  it("explains its context before the Implementer starts", async () => {
    await withWorkflowEnvironment(async (harness) => {
      const handle = await harness.start({ fixture });
      await harness.waitForStatus(handle, "IMPLEMENTING");

      // The contract is frozen and recorded on the Run before the Implementer starts.
      const snapshot = await handle.query(harness.runStatusQuery);
      expect(snapshot.contextContractVersion).toMatch(/^[0-9a-f]{64}$/);

      const stored = harness.contracts.all()[0];
      expect(stored?.sha256).toBe(snapshot.contextContractVersion);
      expect(stored?.runId).toBe(snapshot.runId);

      // Every repository carries an explicit SHA.
      expect(stored?.document).toMatch(/acme\/webhook-service at [0-9a-f]{40}/);
      expect(stored?.document).toMatch(/acme\/notification-service at [0-9a-f]{40}/);

      // Every item carries complete provenance.
      for (const item of stored?.items ?? []) {
        expect(item.reference.sourceId).not.toBe("");
        expect(item.sourceVersion).not.toBe("");
        expect(item.authority).not.toBe("");
        expect(item.reason).not.toBe("");
      }

      // The conflict decision is recorded.
      expect(stored?.conflicts.some((conflict) => conflict.resolution === "resolved")).toBe(true);

      // The explanation reached the human, through Linear, before implementation.
      expect(harness.progress.join("\n")).toContain("Context Contract");

      // The explanation reached the Implementer.
      const prompt = harness.runner.runs[0]?.prompt ?? "";
      expect(prompt).toContain("# Context Contract");
      expect(prompt).toContain("acme/webhook-service");

      // The Implementer had changed nothing when the contract was frozen: the checkout landed on
      // the pinned SHA, which is the SHA discovery recorded.
      expect(harness.preparedPrimaryRef).toBe(stored?.document.match(/acme\/webhook-service at ([0-9a-f]{40})/)?.[1]);

      await handle.signal(harness.stopSignal);
      await handle.result();
    });
  }, 300_000);
});
```

The harness must expose `contracts` (the `FakeContextContractStore`), `progress` (every
`postProgress` message), and `preparedPrimaryRef` (the `ref` the prepare activity received).

- [ ] **Step 7: Run every acceptance test**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run test:workflow
npx vitest run --config vitest.integration.config.ts
```

Expected: every new acceptance test passes and no existing test changed its result.

- [ ] **Step 8: Run the full verification and commit**

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run verify
```

Expected: exit 0.

```bash
git add tests
git commit -m "test: prove AT-02, AT-05, AT-06, AT-07, AT-09, and the Phase 4 exit condition"
```

---

## Self-review notes

**Spec coverage.** Every SDD section this phase owns has a task in the requirement mapping table
above. Three sections are deliberately not covered, and each has a stated reason:

- SDD §19 Backstage and SDD §58 MCP policy belong to Phase 5, which SDD §69 assigns them to. The
  `ContextSource` interface this phase builds is what Phase 5 plugs into.
- SDD §22 "Project configuration MAY explicitly override these rules" is not built. See controller
  decision 9.
- SDD §53 `ContextSourceConfiguration` is not built. See controller decision 15.

**Interaction with Phase 3.** The `.factoree/config.yaml` reader inside `SandboxManager` is
unchanged. Discovery reads the same file at the same pinned SHA through a different path, so the
two cannot disagree. The verification command list is still pinned from the real checkout at
prepare time.

**Carried findings this phase must close.** The Phase 3 record lists five findings for Phase 4:

1. `referenceBaseShas` reaches the activity output but nothing persists it. **Closed by Task 8:**
   every repository SHA is now a `ContextContract` and `ContextItem` column in PostgreSQL.
2. A reference repository is checked out at `HEAD`. **Closed by Task 10:** the checkout ref is the
   SHA discovery pinned.
3. The goal is the raw issue title and description. **Closed by Task 2 and Task 11.**
4. `checkoutHosts` derives no host from an scp-style address. **Not closed.** No caller produces
   one, because `buildRepositoryUrl` always emits `https://`, and this phase adds no new caller.
   Carry it forward.
5. `buildRepositoryUrl` accepts `owner/.`. **Closed by Task 1 and Task 11**, in the sense that
   `REPOSITORY_SLUG` now rejects a dot segment and the delegation service validates the Project
   slugs before a Run starts. Task 11 must also tighten `buildRepositoryUrl` itself with the same
   rule, and add a unit test to `tests/unit/repository-url.test.ts` proving `owner/.` is rejected.

**Two known risks in this plan, stated so the implementer does not discover them late:**

- **The `resolveContext` freeze point.** Task 10 Step 3 changes the activity so that it saves only
  a contract with no unresolved conflict. The implementer must make that change in
  `src/activities/context.activities.ts` and must update
  `tests/unit/resolve-context-activity.test.ts` in the same task. Skipping it makes AT-08 pass for
  the wrong reason.
- **The AT-03 round-bound test.** The bound is hard to exhaust honestly with a fixture that keeps
  raising the same question. Task 10 Step 2 states the fallback: unit-test the bound against the
  workflow constant rather than weakening the workflow assertion.

**Type consistency check.** `AuthorityClass` is a written-out union, so every authority string in
every task is checked by the compiler. `SelectedContextItem` is defined once, in
`src/domain/context/conflicts.ts`, and every other module imports it. `ContextClassification` is
defined once, in `src/domain/context/context-source.ts`. `RecordedDecision` is defined once, in
`src/domain/refinement/refinement-engine.ts`. `RepositoryRef` is defined once, in
`src/domain/context/context-source.ts`.

**Verification at the end of the phase.** `npm run verify` must exit 0 on the branch and again on
`main` after the merge. The skip count must stay at the Phase 3 baseline of 7. A phase that skips
a test has not proved its exit condition.
