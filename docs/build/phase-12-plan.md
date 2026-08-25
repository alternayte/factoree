# Phase 12 — Hardening implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every remaining Definition of Done item that a non-live check can prove, build the live acceptance harness and its documentation, and record the Definition of Done audit with evidence for every item.

**Architecture:** Phase 1 through Phase 11 already built tenant isolation columns, the redaction layer, the run timeout, and every required metric. Phase 12 therefore adds the small number of parts that do not exist: a normalized failure category, a bounded runner session map, a git-state fingerprint that a review cannot evade, a recorded organization skills SHA, a concurrency proof, a fault-injection proof, and the `acceptance:live` entry point. The phase ends with one audit document that names the evidence for every Definition of Done item.

**Tech Stack:** TypeScript with ESM, Node 24, Temporal, Prisma with PostgreSQL, Vitest, Zod, `prom-client`.

**Spec:** `docs/sdd.md` version 2.0, SHA-256 `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`. Read SDD sections 44, 46, 49, 50, 51, 52, 53, 55, 60, 61, 62, 64, 65, 66, 67, 68, and 69. The SDD is immutable and authoritative.

**Prior state:** `docs/build/STATUS.md`. Read the "Read this before Phase 12" block before Task 3.

## Global Constraints

- The SDD is immutable. Do not edit `docs/sdd.md`.
- Prose in code comments, commit messages, and Markdown follows ASD-STE100. Active voice. No contractions. No `-ing` forms outside a technical name. No `should`, `may`, `might`, `would`, `could`. 20 words maximum in a procedural sentence, 25 in a descriptive sentence.
- Node 24 is at `/opt/homebrew/opt/node@24/bin`. Prefix `PATH` with it in every shell.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`. Never write a file through a `cat` heredoc. Use `git commit -F <file>`.
- Run `npm run lint` and `npm run typecheck` over the whole repository at every task gate.
- Unit tests run with `npx vitest run <path>`. Integration and acceptance tests run with `npx vitest run --config vitest.integration.config.ts <path>`. Workflow tests run with `npx vitest run --config vitest.workflow.config.ts <path>`.
- **NEVER run one suite while another suite runs.** Serialize every suite run.
- Docker must run for the integration, acceptance, and workflow suites.
- `npx prisma generate` needs `DATABASE_URL`. Use `DATABASE_URL="postgresql://u:p@localhost:5432/db" npx prisma generate`.
- The import alias is `~/` for `src/`. The workflow file itself must use relative paths for value imports, because the workflow bundler resolves no alias.
- SDD section 62: every required metric name is fixed. Do not rename one.
- SDD section 60: no raw token, key, secret, or authorization header reaches a log or an external store.
- SDD section 66: an unavailable external credential yields `BLOCKED_EXTERNAL`, never `DONE`.
- SDD section 72: do not weaken validation, do not remove a difficult acceptance test, and do not replace a required live integration with a mock and declare success.

---

## Controller decisions taken before this plan

1. **A failure category is derived, not stored by the caller.** One pure function maps every `RunFailureReason` to one category. A caller cannot pass a category, so a caller cannot disagree with the map.
2. **The category is persisted on the `Run` row as well as labelled on the metric.** SDD section 62 asks for the metric. The Definition of Done says "Failed Runs have normalized failure categories", which is a property of the Run, so the durable record carries it too.
3. **`CliAgentRunner` gains an explicit `releaseRun(runId)` call, not a timer and not a size cap.** A Run has a known end, and the workflow already reaches that end. A size cap can evict a session a Temporal retry still needs.
4. **The reviewer git-state check is a second fingerprint, not a change to the first.** `publishing.activities.ts` compares `patch.treeSha` to the reviewed fingerprint. A changed return value there breaks the SDD section 46 guard, so the git-state check is a separate value compared only inside the review activity.
5. **An ignored path is not fingerprinted, and the plan records why.** `git add -A` honours `.gitignore`, and the published patch carries tracked content only, so an ignored file can never reach GitHub. The real gap is `.git/` state, and decision 4 closes that.
6. **The organization skills SHA is recorded on the `Run` row.** SDD section 55 asks for the repository, the SHA, and the path of every reproducible context input. `checkoutOrganizationSkills` already returns the SHA.
7. **Concurrency is proved at the workflow level, with three real Temporal Runs in one worker.** Three separate processes would prove the operating system, not Factoree. Three concurrent workflows in one worker prove that no Run reads another Run's state.
8. **Fault injection uses the existing activity doubles, and it injects a transport fault, not a semantic one.** SDD section 49 separates the two. The proof is that an injected transport fault retries and still yields exactly one publication and an unchanged repair count.
9. **`npm run acceptance:live` exits 78 and prints `BLOCKED_EXTERNAL` when a required credential is absent.** SDD section 66 names that state. A silent skip would read as a pass. Exit 78 is `EX_CONFIG`, so CI cannot mistake it for success.
10. **`acceptance:live` is not part of `npm run verify`.** SDD section 65 says `verify` runs all required non-live checks. A live test in `verify` would make `verify` need credentials.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/domain/runs/failure-category.ts` (create) | The normalized failure category list and the total map from `RunFailureReason`. No IO. |
| `src/domain/runs/run-repository.ts` (modify) | Carries `failureCategory` on the status patch and on the record. |
| `src/persistence/prisma/run-repository.prisma.ts` (modify) | Writes and reads the new column. |
| `prisma/schema.prisma` (modify) | Adds `Run.failureCategory` and `Run.organizationSkillsSha`. |
| `prisma/migrations/20261001120000_add_failure_category/migration.sql` (create) | The migration for both columns. |
| `src/telemetry/metrics.ts` (modify) | Adds the `category` label to `factoree_runs_failed_total`. |
| `src/activities/run.activities.ts` (modify) | Derives the category, persists it, and labels the metric. |
| `src/adapters/runners/cli-agent-runner.ts` (modify) | Adds `releaseRun`, which disposes every session of one Run. |
| `src/domain/runs/agent-runner.ts` (modify) | Adds the optional `releaseRun` member to the `AgentRunner` port. |
| `src/activities/run.activities.ts` (modify) | Releases every runner session when the Run completes. |
| `src/domain/review/source-diff.ts` (modify) | Adds `worktreeGitStateFingerprint`. |
| `src/activities/review.activities.ts` (modify) | Compares the git-state fingerprint before and after the Reviewer session. |
| `src/domain/publishing/patch.ts` (modify) | Records the git version beside the patch. |
| `src/activities/publishing.activities.ts` (modify) | Names both git versions in the hash mismatch message. |
| `src/domain/runs/sandbox-manager.ts` (modify) | Returns the organization skills SHA. |
| `src/activities/sandbox.activities.ts` (modify) | Carries the SHA out of preparation. |
| `src/workflows/agent-run.workflow.ts` (modify) | Carries the SHA to the record activity. |
| `tests/workflow/phase-12-concurrency.test.ts` (create) | Three concurrent fixture Runs complete independently. |
| `tests/workflow/phase-12-fault-injection.test.ts` (create) | An injected transport fault does not duplicate work and does not consume the repair budget. |
| `tests/workflow/phase-12-timeout.test.ts` (create) | A Run that exhausts its budget ends in `RUN_TIMEOUT`, cancels the session, and keeps its evidence. |
| `tests/unit/failure-category.test.ts` (create) | Every reason maps to a category, and the map is total. |
| `tests/unit/cli-agent-runner-release.test.ts` (create) | `releaseRun` disposes the sessions of one Run and no other Run. |
| `tests/unit/worktree-git-state.test.ts` (create) | The git-state fingerprint changes when `HEAD` moves. |
| `tests/live/acceptance-live.ts` (create) | The live acceptance entry point of SDD section 66. |
| `tests/live/required-credentials.ts` (create) | The required credential list and the `BLOCKED_EXTERNAL` report. |
| `docs/live-acceptance.md` (create) | The live acceptance procedure and the credential list of SDD section 66. |
| `.env.example` (modify) | Adds every live acceptance credential name. |
| `package.json` (modify) | Adds the `acceptance:live` script. |
| `tests/acceptance/phase-12-exit.test.ts` (create) | The Phase 12 exit test. |
| `docs/build/definition-of-done.md` (create) | The Definition of Done audit, one row per SDD section 67 item, with evidence. |

---

### Task 1: The normalized failure category

**Files:**
- Create: `src/domain/runs/failure-category.ts`
- Test: `tests/unit/failure-category.test.ts`

**Interfaces:**
- Consumes: `RUN_FAILURE_REASONS`, `RunFailureReason` from `~/domain/runs/run-status.js`.
- Produces: `RUN_FAILURE_CATEGORIES`, `RunFailureCategory`, `failureCategoryOf(reason: RunFailureReason): RunFailureCategory`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/failure-category.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  RUN_FAILURE_CATEGORIES,
  failureCategoryOf,
  type RunFailureCategory,
} from "~/domain/runs/failure-category.js";
import { RUN_FAILURE_REASONS } from "~/domain/runs/run-status.js";

describe("the normalized failure category", () => {
  it("maps every failure reason to a declared category", () => {
    // SDD section 67: "Failed Runs have normalized failure categories." A reason with no
    // category would reach the metric and the Run row as `undefined`, which normalizes nothing.
    const declared = new Set<string>(RUN_FAILURE_CATEGORIES);
    for (const reason of RUN_FAILURE_REASONS) {
      const category: RunFailureCategory = failureCategoryOf(reason);
      expect(declared.has(category), `${reason} has no declared category`).toBe(true);
    }
  });

  it("uses every declared category, so no category is dead", () => {
    const used = new Set(RUN_FAILURE_REASONS.map((reason) => failureCategoryOf(reason)));
    expect([...used].sort()).toEqual([...RUN_FAILURE_CATEGORIES].sort());
  });

  it("separates the states an operator acts on differently", () => {
    // A timeout needs a longer budget. A configuration fault needs an edited file. A review
    // block needs a human decision. Three separate categories keep those three apart.
    expect(failureCategoryOf("RUN_TIMEOUT")).toBe("TIMEOUT");
    expect(failureCategoryOf("CONFIGURATION_INVALID")).toBe("CONFIGURATION");
    expect(failureCategoryOf("REVIEW_BLOCKING_FINDINGS")).toBe("REVIEW");
    expect(failureCategoryOf("STOPPED_BY_HUMAN")).toBe("CANCELLED");
  });

  it("groups the three unresolved-input reasons under one category", () => {
    // SDD section 8, section 9, and section 23 all end the same way: a human must answer.
    expect(failureCategoryOf("REFINEMENT_UNRESOLVED")).toBe("INPUT_UNRESOLVED");
    expect(failureCategoryOf("CONTEXT_UNRESOLVED")).toBe("INPUT_UNRESOLVED");
    expect(failureCategoryOf("VALIDATION_UNRESOLVED")).toBe("INPUT_UNRESOLVED");
  });

  it("groups every publication reason under one category", () => {
    expect(failureCategoryOf("PATCH_HASH_MISMATCH")).toBe("PUBLICATION");
    expect(failureCategoryOf("EMPTY_PATCH")).toBe("PUBLICATION");
    expect(failureCategoryOf("PUBLICATION_FAILED")).toBe("PUBLICATION");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/failure-category.test.ts`
Expected: FAIL, because `~/domain/runs/failure-category.js` does not resolve.

- [ ] **Step 3: Write the implementation**

Create `src/domain/runs/failure-category.ts`:

```ts
import type { RunFailureReason } from "./run-status.js";

/**
 * SDD section 67: "Failed Runs have normalized failure categories."
 *
 * A failure reason names the exact rule that stopped the Run. A category names the kind of
 * action a human takes next. The two are separate, because a new reason must not force a new
 * dashboard panel.
 */
export const RUN_FAILURE_CATEGORIES = [
  /** The Run reached the maximum duration of SDD section 50. */
  "TIMEOUT",
  /** A human stopped the Run. SDD section 50. */
  "CANCELLED",
  /** `.factoree/config.yaml` or the Project record names something Factoree cannot use. */
  "CONFIGURATION",
  /** A material question stayed open, so implementation never started. */
  "INPUT_UNRESOLVED",
  /** The Implementer session itself failed. */
  "AGENT",
  /** Deterministic verification did not pass within the repair budget. SDD section 35. */
  "VERIFICATION",
  /** User-level validation did not pass, or Factoree could not run it. SDD section 36. */
  "VALIDATION",
  /** The independent review blocked, or Factoree obtained no usable review. SDD section 40. */
  "REVIEW",
  /** Patch capture, the hash assertion, or the GitHub publication failed. SDD section 46. */
  "PUBLICATION",
  /** Factoree broke its own invariant. SDD section 68. An operator files a defect. */
  "INTERNAL",
] as const;

export type RunFailureCategory = (typeof RUN_FAILURE_CATEGORIES)[number];

/**
 * The total map from a failure reason to its category. `Record` makes it total, so a new
 * reason in `RUN_FAILURE_REASONS` fails the type check here until somebody classifies it.
 */
const CATEGORY_BY_REASON: Record<RunFailureReason, RunFailureCategory> = {
  RUN_TIMEOUT: "TIMEOUT",
  STOPPED_BY_HUMAN: "CANCELLED",
  CONFIGURATION_INVALID: "CONFIGURATION",
  IMPLEMENTATION_FAILED: "AGENT",
  VERIFICATION_FAILED: "VERIFICATION",
  REFINEMENT_UNRESOLVED: "INPUT_UNRESOLVED",
  CONTEXT_UNRESOLVED: "INPUT_UNRESOLVED",
  VALIDATION_UNRESOLVED: "INPUT_UNRESOLVED",
  VALIDATION_FAILED: "VALIDATION",
  VALIDATION_BLOCKED: "VALIDATION",
  VALIDATION_MANUAL_REQUIRED: "VALIDATION",
  REVIEW_BLOCKING_FINDINGS: "REVIEW",
  REVIEW_UNAVAILABLE: "REVIEW",
  PATCH_HASH_MISMATCH: "PUBLICATION",
  EMPTY_PATCH: "PUBLICATION",
  PUBLICATION_FAILED: "PUBLICATION",
  COMPLETION_INVARIANT_UNMET: "INTERNAL",
  INTERNAL_ERROR: "INTERNAL",
};

/** Returns the normalized category of one failure reason. The map is total, so it never fails. */
export const failureCategoryOf = (reason: RunFailureReason): RunFailureCategory =>
  CATEGORY_BY_REASON[reason];
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/failure-category.test.ts`
Expected: PASS, five tests.

- [ ] **Step 5: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain/runs/failure-category.ts tests/unit/failure-category.test.ts
git commit -m "feat(runs): add the normalized failure category of SDD section 67"
```

---

### Task 2: Persist the category and label the metric

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261001120000_add_failure_category/migration.sql`
- Modify: `src/domain/runs/run-repository.ts`
- Modify: `src/persistence/prisma/run-repository.prisma.ts`
- Modify: `src/telemetry/metrics.ts`
- Modify: `src/activities/run.activities.ts`
- Test: `tests/integration/run-repository.test.ts`, `tests/unit/run-activities.test.ts`

**Interfaces:**
- Consumes: `failureCategoryOf` from Task 1.
- Produces: `RunStatusPatch.failureCategory?: RunFailureCategory`, `RunRecord.failureCategory: RunFailureCategory | null`, the `category` label on `metrics.runsFailed`, and `Run.failureCategory` in the database.

- [ ] **Step 1: Add the columns to the schema**

In `prisma/schema.prisma`, inside `model Run`, add the two columns Phase 12 needs. Put `failureCategory` directly after `failureReason`, and `organizationSkillsSha` directly after `baseSha`:

```prisma
  failureReason            String?
  failureCategory          String?
```

```prisma
  baseSha                  String?
  organizationSkillsSha    String?
```

`organizationSkillsSha` belongs to Task 6. Both columns arrive in one migration, because a second migration for one nullable column costs a deploy and proves nothing.

- [ ] **Step 2: Write the migration**

Create `prisma/migrations/20261001120000_add_failure_category/migration.sql`:

```sql
-- SDD section 67 requires a normalized failure category on a failed Run.
ALTER TABLE "Run" ADD COLUMN "failureCategory" TEXT;

-- SDD section 55 requires the repository, the SHA, and the path of a reproducible context input.
ALTER TABLE "Run" ADD COLUMN "organizationSkillsSha" TEXT;
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH DATABASE_URL="postgresql://u:p@localhost:5432/db" npx prisma generate`
Expected: exit 0.

- [ ] **Step 4: Widen the repository port**

In `src/domain/runs/run-repository.ts`, add the field to `RunStatusPatch` and to `RunRecord`. Find the `RunStatusPatch` interface and add:

```ts
  /**
   * SDD section 67. The normalized category of the failure reason. The activity derives it,
   * so no caller can record a category that disagrees with the reason.
   */
  failureCategory?: RunFailureCategory;
```

Find the `RunRecord` interface and add, beside `failureReason`:

```ts
  failureCategory: RunFailureCategory | null;
```

Add the import at the top of the file:

```ts
import type { RunFailureCategory } from "./failure-category.js";
```

- [ ] **Step 5: Write the column**

In `src/persistence/prisma/run-repository.prisma.ts`, inside `updateStatus`, add one spread beside the existing `failureReason` spread:

```ts
        ...(patch.failureCategory === undefined ? {} : { failureCategory: patch.failureCategory }),
```

In the `toRecord` function of the same file, add the field beside `failureReason`. Read the existing line for `failureReason` and mirror it exactly. The column is nullable, and `RunFailureCategory` is a string union, so the cast matches the one `failureReason` already uses:

```ts
  failureCategory: (row.failureCategory as RunFailureCategory | null) ?? null,
```

Add the type import at the top of the file:

```ts
import type { RunFailureCategory } from "~/domain/runs/failure-category.js";
```

- [ ] **Step 6: Add the metric label**

In `src/telemetry/metrics.ts`, change the `runsFailed` counter label list:

```ts
  runsFailed: new Counter({
    name: "factoree_runs_failed_total",
    help: "Runs that reached a failure state",
    // SDD section 67 requires a normalized category. The reason stays, because an operator
    // needs the exact rule. The category groups the reasons an operator acts on the same way.
    labelNames: [...labelNames, "reason", "category"],
    registers: [registry],
  }),
```

- [ ] **Step 7: Derive the category in the activity**

In `src/activities/run.activities.ts`, inside `completeRun`, derive the category once and use it in both places. Replace the existing `metrics.runsFailed.inc` line and the `updateStatus` call.

Add the import at the top of the file:

```ts
import { failureCategoryOf } from "~/domain/runs/failure-category.js";
```

Inside `completeRun`, before the `updateStatus` call:

```ts
    // SDD section 67. The category is derived from the reason, never supplied by the caller.
    const failureCategory =
      input.failureReason === undefined ? undefined : failureCategoryOf(input.failureReason);
```

Change the `updateStatus` call so it carries the category:

```ts
    const run = await dependencies.runs.updateStatus(input.runId, input.status, {
      ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
      ...(failureCategory === undefined ? {} : { failureCategory }),
      completedAt: new Date(input.completedAt),
    });
```

Change the failure counter line:

```ts
      else
        metrics.runsFailed.inc({
          ...labels,
          reason: input.failureReason ?? "UNKNOWN",
          category: failureCategory ?? "INTERNAL",
        });
```

A terminal status with no reason is a defect, and `INTERNAL` is the category an operator files a defect against. It never silently reads as an ordinary outcome.

- [ ] **Step 8: Write the integration test**

Append to `tests/integration/run-repository.test.ts`, inside the top-level `describe`:

```ts
  it("stores the normalized failure category beside the failure reason (SDD section 67)", async () => {
    // Read the existing tests of this file first. Reuse the same fixture helpers they use to
    // create a Tenant, a Project, and a Run. Do not invent a second fixture path.
    const run = await createRun();
    await repository.updateStatus(run.id, "FAILED", {
      failureReason: "VERIFICATION_FAILED",
      failureCategory: "VERIFICATION",
      completedAt: new Date(),
    });
    const stored = await repository.findById(run.tenantId, run.id);
    expect(stored?.failureReason).toBe("VERIFICATION_FAILED");
    expect(stored?.failureCategory).toBe("VERIFICATION");
  });

  it("leaves the category null on a Run that did not fail", async () => {
    const run = await createRun();
    await repository.updateStatus(run.id, "READY_FOR_HUMAN", { completedAt: new Date() });
    const stored = await repository.findById(run.tenantId, run.id);
    expect(stored?.failureCategory).toBeNull();
  });
```

Read the file before editing it. Use the exact fixture helper names the file already defines. If the file names its helper differently from `createRun`, use the name the file uses.

- [ ] **Step 9: Write the activity test**

Append to `tests/unit/run-activities.test.ts`, inside the `completeRun` describe block. Read the file first and reuse its existing dependency doubles:

```ts
  it("derives the category from the reason and never reads it from the caller (SDD section 67)", async () => {
    await activities.completeRun({
      tenantId: "tenant-1",
      runId: "run-1",
      status: "FAILED",
      failureReason: "PATCH_HASH_MISMATCH",
      completedAt: new Date().toISOString(),
    });
    // The activity input carries no category. The persisted patch must still carry one.
    expect(runs.lastStatusPatch?.failureCategory).toBe("PUBLICATION");
  });
```

If the existing double records the patch under another name, use that name. Do not add a second double.

- [ ] **Step 10: Run the tests, one suite at a time**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/run-activities.test.ts tests/unit/failure-category.test.ts`
Expected: PASS.

Then, and only after that run ends:

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/run-repository.test.ts`
Expected: PASS.

- [ ] **Step 11: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0.

- [ ] **Step 12: Commit**

```bash
git add prisma src/domain/runs/run-repository.ts src/persistence/prisma/run-repository.prisma.ts src/telemetry/metrics.ts src/activities/run.activities.ts tests/integration/run-repository.test.ts tests/unit/run-activities.test.ts
git commit -m "feat(runs): persist and label the normalized failure category"
```

---

### Task 3: Bound the runner session map

**Files:**
- Modify: `src/domain/runs/agent-runner.ts`
- Modify: `src/adapters/runners/cli-agent-runner.ts`
- Modify: `src/activities/run.activities.ts`
- Test: `tests/unit/cli-agent-runner-release.test.ts`

**Interfaces:**
- Consumes: the existing `CliAgentRunner` private `sessions` and `activeByRun` maps.
- Produces: `AgentRunner.releaseRun?(runId: string): void` on the port, and the concrete `CliAgentRunner.releaseRun(runId: string): void`.

This closes the Phase 11 carried finding. `CliAgentRunner.sessions` grows without bound in the number of Runs, for the life of the worker process.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/cli-agent-runner-release.test.ts`. Read `tests/unit/opencode-runner.test.ts` first and reuse its sandbox double and its stub process helpers. Do not build a second sandbox double.

```ts
import { describe, expect, it } from "vitest";
import { OpenCodeRunner } from "~/adapters/runners/opencode/opencode-runner.js";
// Reuse the exact fixture helpers of the existing runner test. Read that file and import or
// copy the same sandbox double it uses.

describe("CliAgentRunner.releaseRun", () => {
  it("disposes every session of one Run", async () => {
    const { runner, sandbox, ref } = await startOneRun("run-a");
    const session = runner.activeSession("run-a");
    // The Run finished. Before release, a resume still reaches the recorded session.
    runner.releaseRun("run-a");
    await expect(
      runner.resume({ sessionId: "p1", processId: "p1", runner: "opencode" }, {
        prompt: "again",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/no live sandbox/);
    expect(session).toBeDefined();
    expect(sandbox).toBeDefined();
    expect(ref).toBeDefined();
  });

  it("keeps the sessions of every other Run", async () => {
    const first = await startOneRun("run-a");
    const second = await startOneRun("run-b", first.runner);
    second.runner.releaseRun("run-a");
    // The second Run is untouched, so its session still resumes.
    const result = await second.runner.resume(second.session, { prompt: "again", timeoutMs: 5_000 });
    expect(result.exitCode).toBe(0);
  });

  it("reports the number of retained sessions, so a test can prove the map is bounded", async () => {
    const first = await startOneRun("run-a");
    await startOneRun("run-b", first.runner);
    expect(first.runner.retainedSessionCount()).toBe(2);
    first.runner.releaseRun("run-a");
    expect(first.runner.retainedSessionCount()).toBe(1);
    first.runner.releaseRun("run-b");
    expect(first.runner.retainedSessionCount()).toBe(0);
  });
});
```

Write the `startOneRun` helper in the same file. It must build the sandbox double of the existing runner test, call `runner.run` with a completing stub process, and return `{ runner, sandbox, ref, session }`. `session` is the `AgentSessionRef` of the resolved `AgentRunResult`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/cli-agent-runner-release.test.ts`
Expected: FAIL, because `releaseRun` and `retainedSessionCount` do not exist.

- [ ] **Step 3: Add the port member**

In `src/domain/runs/agent-runner.ts`, add one optional member to the `AgentRunner` interface, after `cancel`:

```ts
  /**
   * Disposes every session this runner holds for one Run. A Run has a known end, and the
   * workflow reaches that end, so no timer and no size cap is needed. The member is optional,
   * because a runner that holds no per-Run state has nothing to release.
   */
  releaseRun?(runId: string): void;
```

- [ ] **Step 4: Implement it on the base**

In `src/adapters/runners/cli-agent-runner.ts`, replace the comment above the `sessions` field. The old comment says disposal belongs to a later phase. That phase is now.

```ts
  // Every session of one Run, by process id. A Temporal activity retry can present an old
  // `AgentSessionRef`, so an entry must live until the Run itself ends. `releaseRun` disposes
  // every entry of one Run, which bounds the map by the number of Runs in flight.
  private readonly sessions = new Map<string, LiveSession>();
  private readonly activeByRun = new Map<string, string>();
  /** The process ids one Run created, so `releaseRun` can dispose all of them. */
  private readonly processesByRun = new Map<string, Set<string>>();
```

In `run`, after `this.sessions.set(process.id, live);`, record the process against its Run:

```ts
    this.trackProcess(input.runId, process.id);
```

In `resume`, the resumed process belongs to the same Run as the session it continues. Record it too. After `this.sessions.set(process.id, live);` in `resume`, add:

```ts
    const owner = this.runOfProcess(session.processId);
    if (owner !== undefined) this.trackProcess(owner, process.id);
```

Add the three private helpers and the public members at the end of the class:

```ts
  /**
   * Disposes every session of one Run. Call it once the Run reaches a terminal state. A later
   * call with the same run id is a no-op, so a Temporal activity retry is safe.
   */
  releaseRun(runId: string): void {
    const processes = this.processesByRun.get(runId);
    if (processes !== undefined) {
      for (const processId of processes) this.sessions.delete(processId);
      this.processesByRun.delete(runId);
    }
    this.activeByRun.delete(runId);
  }

  /** The number of sessions this runner still holds. A test uses it to prove the bound. */
  retainedSessionCount(): number {
    return this.sessions.size;
  }

  private trackProcess(runId: string, processId: string): void {
    const existing = this.processesByRun.get(runId);
    if (existing === undefined) this.processesByRun.set(runId, new Set([processId]));
    else existing.add(processId);
  }

  private runOfProcess(processId: string): string | undefined {
    for (const [runId, processes] of this.processesByRun) {
      if (processes.has(processId)) return runId;
    }
    return undefined;
  }
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/cli-agent-runner-release.test.ts`
Expected: PASS, three tests.

- [ ] **Step 6: Release the sessions when the Run completes**

In `src/activities/run.activities.ts`, inside `completeRun`, after the durable write and before the log line, release every runner. Find the dependency that already holds the runner registry. If `completeRun` has no registry dependency, add `runners: AgentRunnerRegistry` to the dependencies interface of the file and thread it from the composition root that builds the activities. Read `src/bin/worker.ts` to find that root.

```ts
    // The Run reached a terminal state. Every runner session of this Run is now dead, so the
    // runner must not keep it. This bounds `CliAgentRunner.sessions` by the Runs in flight.
    for (const runner of dependencies.runners.all()) runner.releaseRun?.(input.runId);
```

If `AgentRunnerRegistry` has no `all()` member, add one to `src/domain/runs/agent-runner.ts`:

```ts
  /** Every registered runner. The order is the registration order. */
  all(): AgentRunner[] {
    return [...this.runners.values()];
  }
```

- [ ] **Step 7: Prove the release reaches the runner**

Append to `tests/unit/run-activities.test.ts`, inside the `completeRun` describe block:

```ts
  it("releases every runner session when the Run reaches a terminal state", async () => {
    const released: string[] = [];
    // Read the file first. Build the registry double the way the file already builds its other
    // doubles, with one runner whose `releaseRun` records the run id.
    await activities.completeRun({
      tenantId: "tenant-1",
      runId: "run-1",
      status: "READY_FOR_HUMAN",
      completedAt: new Date().toISOString(),
    });
    expect(released).toEqual(["run-1"]);
  });
```

- [ ] **Step 8: Run the unit suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit`
Expected: PASS. The skip count must stay 7.

- [ ] **Step 9: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/domain/runs/agent-runner.ts src/adapters/runners/cli-agent-runner.ts src/activities/run.activities.ts src/bin/worker.ts tests/unit/cli-agent-runner-release.test.ts tests/unit/run-activities.test.ts
git commit -m "fix(runners): bound the session map by releasing every session of a completed Run"
```

---

### Task 4: The git-state fingerprint of the review

**Files:**
- Modify: `src/domain/review/source-diff.ts`
- Modify: `src/activities/review.activities.ts`
- Test: `tests/unit/worktree-git-state.test.ts`

**Interfaces:**
- Consumes: `SourceDiffDependencies`, `git` from `src/domain/review/source-diff.ts`.
- Produces: `worktreeGitStateFingerprint(dependencies, input: { ref: SandboxRef; primaryPath: string }): Promise<string>`.

This closes the carried finding "the worktree fingerprint misses an ignored path and anything under `.git/`". Controller decision 5 records why the ignored path stays out of scope: the published patch carries tracked content only, so an ignored file can never reach GitHub. `HEAD` and the ref set can change the patch, so those are fingerprinted.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/worktree-git-state.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { worktreeGitStateFingerprint } from "~/domain/review/source-diff.js";
import { Redactor } from "~/telemetry/redaction.js";

const ref = { id: "sandbox-1", workspacePath: "/w" } as never;

/** A sandbox double whose `exec` answers each git command from a script. */
const sandboxOf = (answers: Record<string, string>) => ({
  exec: vi.fn(async (_ref: unknown, command: { args: string[] }) => {
    const key = command.args.join(" ");
    const stdout = answers[key];
    if (stdout === undefined) throw new Error(`the test scripted no answer for: ${key}`);
    return { exitCode: 0, stdout, stderr: "" };
  }),
});

describe("worktreeGitStateFingerprint", () => {
  it("changes when HEAD moves", async () => {
    const base = {
      "-C /w/primary rev-parse HEAD": "a".repeat(40) + "\n",
      "-C /w/primary for-each-ref --format=%(objectname) %(refname)":
        "a".repeat(40) + " refs/heads/main\n",
    };
    const moved = {
      "-C /w/primary rev-parse HEAD": "b".repeat(40) + "\n",
      "-C /w/primary for-each-ref --format=%(objectname) %(refname)":
        "a".repeat(40) + " refs/heads/main\n",
    };
    const first = await worktreeGitStateFingerprint(
      { sandbox: sandboxOf(base) as never, redactor: new Redactor() },
      { ref, primaryPath: "/w/primary" },
    );
    const second = await worktreeGitStateFingerprint(
      { sandbox: sandboxOf(moved) as never, redactor: new Redactor() },
      { ref, primaryPath: "/w/primary" },
    );
    expect(second).not.toBe(first);
  });

  it("changes when a ref appears, so a new local branch cannot hide", async () => {
    const base = {
      "-C /w/primary rev-parse HEAD": "a".repeat(40) + "\n",
      "-C /w/primary for-each-ref --format=%(objectname) %(refname)":
        "a".repeat(40) + " refs/heads/main\n",
    };
    const extra = {
      "-C /w/primary rev-parse HEAD": "a".repeat(40) + "\n",
      "-C /w/primary for-each-ref --format=%(objectname) %(refname)":
        "a".repeat(40) + " refs/heads/main\n" + "c".repeat(40) + " refs/heads/sneaky\n",
    };
    const first = await worktreeGitStateFingerprint(
      { sandbox: sandboxOf(base) as never, redactor: new Redactor() },
      { ref, primaryPath: "/w/primary" },
    );
    const second = await worktreeGitStateFingerprint(
      { sandbox: sandboxOf(extra) as never, redactor: new Redactor() },
      { ref, primaryPath: "/w/primary" },
    );
    expect(second).not.toBe(first);
  });

  it("is stable across two reads of the same state", async () => {
    const answers = {
      "-C /w/primary rev-parse HEAD": "a".repeat(40) + "\n",
      "-C /w/primary for-each-ref --format=%(objectname) %(refname)":
        "a".repeat(40) + " refs/heads/main\n",
    };
    const first = await worktreeGitStateFingerprint(
      { sandbox: sandboxOf(answers) as never, redactor: new Redactor() },
      { ref, primaryPath: "/w/primary" },
    );
    const second = await worktreeGitStateFingerprint(
      { sandbox: sandboxOf(answers) as never, redactor: new Redactor() },
      { ref, primaryPath: "/w/primary" },
    );
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

Read `src/domain/review/source-diff.ts` first. The `git` helper of that file builds the argument list from `primaryPath`. Match the exact argument order the helper produces, and correct the scripted keys above if the helper differs.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/worktree-git-state.test.ts`
Expected: FAIL, because `worktreeGitStateFingerprint` is not exported.

- [ ] **Step 3: Implement it**

In `src/domain/review/source-diff.ts`, add the import of `createHash` from `node:crypto` if the file does not already import it. Then add, directly under `worktreeFingerprint`:

```ts
/**
 * The git state of the primary worktree, outside the tracked content.
 *
 * `worktreeFingerprint` returns the tree object of the staged worktree. `publishing.activities`
 * compares that exact value to the captured patch tree, so its return value must not change.
 * This second fingerprint therefore stands beside it and covers what a tree object cannot see:
 * the commit `HEAD` points at, and every ref the repository holds.
 *
 * An ignored path is deliberately out of scope. `git add -A` honours `.gitignore`, and SDD
 * section 44 publishes tracked content only, so an ignored file can never reach GitHub.
 */
export const worktreeGitStateFingerprint = async (
  dependencies: SourceDiffDependencies,
  input: { ref: SandboxRef; primaryPath: string },
): Promise<string> => {
  const head = (await git(dependencies, input, ["rev-parse", "HEAD"])).trim();
  const refs = (
    await git(dependencies, input, ["for-each-ref", "--format=%(objectname) %(refname)"])
  ).trim();
  return createHash("sha256").update(`${head}\n${refs}\n`).digest("hex");
};
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/worktree-git-state.test.ts`
Expected: PASS, three tests.

- [ ] **Step 5: Use it in the review activity**

In `src/activities/review.activities.ts`, add `worktreeGitStateFingerprint` to the existing import from `~/domain/review/source-diff.js`.

Beside the existing `beforeFingerprint` call, add:

```ts
      // The tree object cannot see `HEAD` or the ref set. A Reviewer that commits, resets, or
      // creates a branch changes the base the patch is taken against, and no tree comparison
      // catches that. SDD section 40 requires an independent review, not an edit.
      const beforeGitState = await worktreeGitStateFingerprint(
        { sandbox: dependencies.sandbox, redactor: dependencies.redactor },
        { ref, primaryPath: input.primaryPath },
      );
```

Beside the existing `afterFingerprint` call, add the matching read and extend the existing guard. Read the current guard at the `afterFingerprint !== beforeFingerprint` line and widen its condition:

```ts
      const afterGitState = await worktreeGitStateFingerprint(
        { sandbox: dependencies.sandbox, redactor: dependencies.redactor },
        { ref, primaryPath: input.primaryPath },
      );
      if (afterFingerprint !== beforeFingerprint || afterGitState !== beforeGitState) {
```

Keep the existing body of that guard exactly as it is. Only the condition widens.

- [ ] **Step 6: Prove the widened guard**

Read `tests/unit/review-activity.test.ts` and find the existing test that proves a changed worktree fails the review. Add one sibling that changes only the git state. Use the same doubles that test already uses:

```ts
  it("fails the review when the Reviewer moved HEAD but changed no tracked file", async () => {
    // The tracked tree is identical before and after. Only `rev-parse HEAD` differs. SDD
    // section 40: the Reviewer reads. It does not commit.
    const output = await activities.review(input);
    expect(output.status).toBe("UNAVAILABLE");
  });
```

Read the file to learn the exact double names and the exact expected failure status of the existing worktree guard. Use that same status. Do not invent one.

- [ ] **Step 7: Run the unit suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit`
Expected: PASS. The skip count must stay 7.

- [ ] **Step 8: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/domain/review/source-diff.ts src/activities/review.activities.ts tests/unit/worktree-git-state.test.ts tests/unit/review-activity.test.ts
git commit -m "fix(review): fingerprint the git state, so a Reviewer commit cannot hide"
```

---

### Task 5: Record both git versions on a hash mismatch

**Files:**
- Modify: `src/domain/publishing/patch.ts`
- Modify: `src/activities/publishing.activities.ts`
- Test: `tests/unit/patch.test.ts`

**Interfaces:**
- Consumes: `VerifiedPatch` from `src/domain/publishing/patch.ts`.
- Produces: `VerifiedPatch.gitVersion: string`.

This closes the carried finding "the SDD section 46 hash assertion compares two diff texts that two different git binaries produce". The fix is not a new guard. It is the evidence an operator needs when the assertion fails.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/patch.test.ts`. Read the file first and reuse its existing sandbox double:

```ts
  it("records the git version of the sandbox that captured the patch (SDD section 46)", async () => {
    // The hash assertion of SDD section 46 compares two diff texts. Two git binaries can
    // produce two texts from one tree. The recorded version turns a silent mismatch into a
    // readable cause.
    const patch = await capturePatch(dependencies, input);
    expect(patch.gitVersion).toMatch(/^git version /);
  });
```

Extend the scripted sandbox double of the file so `git --version` answers `git version 2.51.0\n`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/patch.test.ts`
Expected: FAIL, because `gitVersion` is not a member of `VerifiedPatch`.

- [ ] **Step 3: Implement it**

In `src/domain/publishing/patch.ts`, add the field to the `VerifiedPatch` interface:

```ts
  /**
   * The git version of the sandbox that captured this patch. SDD section 46 compares the
   * captured diff text with the diff text of the trusted checkout. Two git versions can
   * produce two texts from one tree, and the mismatch message must be able to say so.
   */
  gitVersion: string;
```

Inside `capturePatch`, after the `treeSha` read, add:

```ts
  const gitVersion = (await git(dependencies, input, [...at, "--version"])).trim();
```

Add `gitVersion` to the returned object.

- [ ] **Step 4: Name both versions in the mismatch message**

In `src/activities/publishing.activities.ts`, find the hash mismatch path. Read the trusted checkout module to learn whether it already exposes its own git version. If it does not, add the same one-line read there and expose it on its result. Then widen the mismatch message so it names both:

```ts
        `The applied patch does not reproduce the verified hash. Verified git: ` +
          `${input.verifiedGitVersion}. Publishing git: ${appliedGitVersion}. ` +
```

Keep every existing sentence of that message. Only add the two version facts. If the message text is asserted by a test, update that assertion in the same commit.

- [ ] **Step 5: Run the affected tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit`
Expected: PASS. The skip count must stay 7.

Then, and only after that run ends:

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/trusted-checkout.test.ts`
Expected: PASS.

- [ ] **Step 6: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/domain/publishing src/activities/publishing.activities.ts tests
git commit -m "feat(publishing): record both git versions, so a hash mismatch names its cause"
```

---

### Task 6: Record the organization skills SHA

**Files:**
- Modify: `src/domain/runs/sandbox-manager.ts`
- Modify: `src/activities/sandbox.activities.ts`
- Modify: `src/domain/runs/run-repository.ts`
- Modify: `src/persistence/prisma/run-repository.prisma.ts`
- Modify: `src/workflows/agent-run.workflow.ts`
- Test: `tests/unit/sandbox-manager.test.ts`, `tests/integration/run-repository.test.ts`

**Interfaces:**
- Consumes: `checkoutOrganizationSkills`, which already returns the SHA.
- Produces: `PrepareSandboxActivityOutput.organizationSkillsSha?: string` and `Run.organizationSkillsSha`.

The column arrived in the Task 2 migration. This task fills it. It closes the carried finding "the organization skills checkout discards its computed `baseSha`".

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/sandbox-manager.test.ts`. Read the file and reuse the fixture that already exercises the organization skills checkout:

```ts
  it("returns the SHA of the organization skills checkout (SDD section 55)", async () => {
    // Two Runs a day apart can read two different skill sets. Without the SHA, no record says
    // which set a Run read.
    const prepared = await manager.prepare(input);
    expect(prepared.organizationSkillsSha).toBe(ORGANIZATION_SKILLS_SHA);
  });

  it("returns no SHA when the Project configures no organization skills repository", async () => {
    const prepared = await manager.prepare({ ...input, organizationSkillsRepository: undefined });
    expect(prepared.organizationSkillsSha).toBeUndefined();
  });
```

Define `ORGANIZATION_SKILLS_SHA` as the SHA the file's git double already reports for that checkout. Read the file to find it.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/sandbox-manager.test.ts`
Expected: FAIL, because `organizationSkillsSha` is absent.

- [ ] **Step 3: Return the SHA from the manager**

In `src/domain/runs/sandbox-manager.ts`, find the call to `checkoutOrganizationSkills`. It already resolves a result that carries a SHA. Keep that value instead of discarding it, and add it to the returned object. Add the field to the result interface of the manager:

```ts
  /**
   * SDD section 55. The commit the organization skills checkout resolved to. It is absent when
   * the Project configures no organization skills repository.
   */
  organizationSkillsSha?: string;
```

- [ ] **Step 4: Carry it out of the activity**

In `src/activities/sandbox.activities.ts`, add the same optional field to `PrepareSandboxActivityOutput`, and pass the manager value through. The activity already returns the skill lines from the same result, so add the SHA beside them.

- [ ] **Step 5: Persist it**

In `src/domain/runs/run-repository.ts`, add `organizationSkillsSha` to `RunSandboxPatch` as an optional string, and to `RunRecord` as `string | null`.

In `src/persistence/prisma/run-repository.prisma.ts`, inside `setSandbox`, add the field to the `data` object of the `updateMany` call:

```ts
          ...(sandbox.organizationSkillsSha === undefined
            ? {}
            : { organizationSkillsSha: sandbox.organizationSkillsSha }),
```

Add the read to `toRecord`:

```ts
  organizationSkillsSha: row.organizationSkillsSha ?? null,
```

- [ ] **Step 6: Carry it through the workflow**

In `src/workflows/agent-run.workflow.ts`, find the call that records the prepared sandbox on the Run. Pass the SHA from the prepare result into that call. The workflow already forwards `baseSha` on the same call, so add one field beside it.

- [ ] **Step 7: Prove the persistence**

Append to `tests/integration/run-repository.test.ts`:

```ts
  it("stores the organization skills SHA beside the base SHA (SDD section 55)", async () => {
    const run = await createRun();
    await repository.setSandbox(run.tenantId, run.id, {
      // Read the file. Reuse the exact sandbox patch the existing tests build, and add one field.
      organizationSkillsSha: "e".repeat(40),
    } as never);
    const stored = await repository.findById(run.tenantId, run.id);
    expect(stored?.organizationSkillsSha).toBe("e".repeat(40));
  });
```

Replace the `as never` cast with the real complete patch the file already builds. The cast is a placeholder for the reader, not for the committed test.

- [ ] **Step 8: Run the suites, one at a time**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit`
Expected: PASS. The skip count must stay 7.

Then:

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts`
Expected: PASS.

Then:

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.workflow.config.ts`
Expected: PASS.

- [ ] **Step 9: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0.

- [ ] **Step 10: Commit**

```bash
git add src tests
git commit -m "feat(runs): record the organization skills SHA, as SDD section 55 requires"
```

---

### Task 7: Three concurrent fixture Runs

**Files:**
- Create: `tests/workflow/phase-12-concurrency.test.ts`

**Interfaces:**
- Consumes: `createWorkflowHarness`, `waitForStatus`, `waitFor`, `hold` from `tests/workflow/support/harness.ts`.
- Produces: no source change. The task is a proof.

Definition of Done: "Three concurrent fixture Runs complete independently."

- [ ] **Step 1: Write the test**

Create `tests/workflow/phase-12-concurrency.test.ts`. Read `tests/workflow/at-35-worker-restart.test.ts` first. Copy its environment setup verbatim, because that file already starts a `TestWorkflowEnvironment` and runs the harness worker.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  createWorkflowHarness,
  hold,
  waitFor,
  waitForStatus,
} from "./support/harness.js";

let environment: TestWorkflowEnvironment;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await environment?.teardown();
});

/**
 * Definition of Done, SDD section 67: "Three concurrent fixture Runs complete independently."
 *
 * Three separate operating-system processes would prove the operating system. Three concurrent
 * workflows inside one worker prove what Factoree owns: that no Run reads, writes, or waits on
 * the state of another Run.
 */
describe("Phase 12 — three concurrent Runs complete independently", () => {
  it("completes three Runs with three separate sandboxes, patches, and pull requests", async () => {
    const harness = createWorkflowHarness(() => environment);
    const sessions = ["session-a", "session-b", "session-c"];

    // Every Run holds at its Implementer, so all three are in flight at the same moment. A
    // sequential execution cannot satisfy this, because Run A never releases until B and C
    // have also reached the hold.
    const releases = sessions.map((session) => hold(harness.heldImplementations, `run-${session}`));

    const result = await harness.runWorker(async () => {
      const handles = await Promise.all(sessions.map((session) => harness.start(session)));

      await waitFor(
        () => harness.implementCalls.length === 3,
        "all three Runs to reach the Implementer",
        30_000,
      );

      // Every Run prepared its own sandbox. SDD section 52 forbids a reused mutable sandbox.
      const refs = harness.prepared.map((entry) => entry.runId);
      expect(new Set(refs).size).toBe(3);

      for (const release of releases) release();

      await Promise.all(handles.map((handle) => handle.result()));
      return handles;
    });

    expect(result).toHaveLength(3);

    // Each Run reached the human-ready state on its own.
    const ready = harness.completions.filter((entry) => entry.status === "READY_FOR_HUMAN");
    expect(ready.map((entry) => entry.runId).sort()).toEqual(
      sessions.map((session) => `run-${session}`).sort(),
    );

    // Exactly one publication per Run. A shared counter or a shared map would produce three
    // publications on one Run, or one publication across three.
    const published = harness.publishCalls.map((entry) => entry.runId).sort();
    expect(published).toEqual(sessions.map((session) => `run-${session}`).sort());

    // Exactly one Proof Pack per Run.
    const packs = harness.proofPackCalls.map((entry) => entry.runId).sort();
    expect(packs).toEqual(sessions.map((session) => `run-${session}`).sort());

    // No Run failed, and no Run leaked another Run's identifier into its own status trail.
    for (const session of sessions) {
      const runId = `run-${session}`;
      expect(harness.statusesOf(runId)).toContain("PUBLISHING");
      expect(
        harness.completions.filter((entry) => entry.runId === runId),
      ).toHaveLength(1);
    }
  }, 180_000);
});
```

Read the harness before you run this. `PublishActivityInput` and `PublishProofPackActivityInput` must carry `runId`. If either does not, use the field that identifies the Run in that input type. Do not add a field to a production type for the sake of a test.

- [ ] **Step 2: Run the test**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.workflow.config.ts tests/workflow/phase-12-concurrency.test.ts`
Expected: PASS.

If a Run reaches a failure, read the recorded `postedErrors` of the harness before changing the test. A real cross-Run leak is a source defect, not a test defect.

- [ ] **Step 3: Run it a second time**

Run the same command again. A single green run is not proof, and this test is the one most exposed to a race.
Expected: PASS, with the same result.

- [ ] **Step 4: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add tests/workflow/phase-12-concurrency.test.ts
git commit -m "test: prove three concurrent fixture Runs complete independently"
```

---

### Task 8: Fault injection and the repair budget

**Files:**
- Create: `tests/workflow/phase-12-fault-injection.test.ts`

**Interfaces:**
- Consumes: `createWorkflowHarness` and its activity doubles.
- Produces: no source change. The task is a proof.

Definition of Done: "Infrastructure retries do not consume semantic repair budget." SDD section 49 separates a transport fault from a semantic outcome.

- [ ] **Step 1: Write the test**

Create `tests/workflow/phase-12-fault-injection.test.ts`. Copy the environment setup of Task 7.

```ts
/**
 * SDD section 49 and the Definition of Done: "Infrastructure retries do not consume semantic
 * repair budget."
 *
 * A transport fault is not a decision. It must retry, and it must leave the repair count
 * unchanged. A failing check is a decision. It must not retry, and it must spend the budget.
 */
describe("Phase 12 — an injected transport fault does not consume the repair budget", () => {
  it("retries a failing verification activity and leaves the repair count at zero", async () => {
    const harness = createWorkflowHarness(() => environment);
    const runId = "run-session-fault";

    // The first two calls of `verify` throw a transport fault. The third succeeds. Read the
    // harness `verifyOutcomes` map: it reports a pass or a fail, which is a semantic answer.
    // A transport fault is a thrown error, so wrap the double instead.
    let verifyAttempts = 0;
    const realVerify = harness.activities.verify;
    harness.activities.verify = async (input: Parameters<typeof realVerify>[0]) => {
      verifyAttempts += 1;
      if (verifyAttempts <= 2) throw new Error("the build cache host refused the connection");
      return await realVerify(input);
    };

    await harness.runWorker(async () => {
      const handle = await harness.start("session-fault");
      await handle.result();
    });

    // The activity really retried.
    expect(verifyAttempts).toBe(3);

    // The Run still reached the human-ready state.
    const completion = harness.completions.find((entry) => entry.runId === runId);
    expect(completion?.status).toBe("READY_FOR_HUMAN");

    // No status write reported a repair. SDD section 42 spends the budget on a semantic
    // failure only, and no check ever failed here.
    const repairs = harness.statusCalls.filter(
      (entry) => entry.runId === runId && (entry.repairCount ?? 0) > 0,
    );
    expect(repairs).toEqual([]);

    // Exactly one publication, so the retry duplicated nothing.
    expect(harness.publishCalls.filter((entry) => entry.runId === runId)).toHaveLength(1);
  }, 180_000);

  it("spends the repair budget on a failing check and not on a transport fault", async () => {
    const harness = createWorkflowHarness(() => environment);
    const runId = "run-session-mixed";

    // The first verification attempt fails semantically. The second attempt throws twice
    // before it passes. The budget must fall by exactly one, not by three.
    harness.verifyOutcomes.set(runId, (attempt) => attempt > 1);

    let thrown = 0;
    const realVerify = harness.activities.verify;
    harness.activities.verify = async (input: Parameters<typeof realVerify>[0]) => {
      const result = await realVerify(input);
      if (result.passed && thrown < 2) {
        thrown += 1;
        throw new Error("the artifact store timed out");
      }
      return result;
    };

    await harness.runWorker(async () => {
      const handle = await harness.start("session-mixed");
      await handle.result();
    });

    expect(thrown).toBe(2);

    const completion = harness.completions.find((entry) => entry.runId === runId);
    expect(completion?.status).toBe("READY_FOR_HUMAN");

    // Exactly one repair. Two transport faults added nothing to it.
    const counts = harness.statusCalls
      .filter((entry) => entry.runId === runId)
      .map((entry) => entry.repairCount ?? 0);
    expect(Math.max(...counts)).toBe(1);
  }, 180_000);
});
```

Read the harness before you run this. `StatusCall` must carry `repairCount`. If it does not, extend the harness `StatusCall` interface and its `setRunStatus` double to record it. The workflow already passes `repairCount` on that call, so the harness only needs to keep it.

Read the `verify` double signature before you wrap it. Match its exact input and output types instead of the `Parameters<...>` shorthand if the shorthand does not typecheck.

- [ ] **Step 2: Run the test**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.workflow.config.ts tests/workflow/phase-12-fault-injection.test.ts`
Expected: PASS, two tests.

If the workflow does not retry the thrown fault, read the retry policy that the workflow applies to `verify`. SDD section 49 requires the retry. A missing retry is a source defect. Fix the policy, and record the fix in the commit message.

- [ ] **Step 3: Run it a second time**

Run the same command again.
Expected: PASS.

- [ ] **Step 4: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add tests/workflow/phase-12-fault-injection.test.ts tests/workflow/support/harness.ts
git commit -m "test: prove an infrastructure retry never consumes the repair budget"
```

---

### Task 9: The timeout proof

**Files:**
- Create: `tests/workflow/phase-12-timeout.test.ts`

**Interfaces:**
- Consumes: `createWorkflowHarness`, `hold`, `waitFor`. The harness `input` builder already accepts `maxRunMinutes`.
- Produces: no source change. The task is a proof.

SDD section 50: on timeout, cancel active processes, stop new side effects, preserve evidence, and set `RUN_TIMEOUT`.

- [ ] **Step 1: Write the test**

Create `tests/workflow/phase-12-timeout.test.ts`. Copy the environment setup of Task 7.

```ts
/**
 * SDD section 50. On timeout Factoree cancels the active process, starts no new side effect,
 * keeps the evidence, and records `RUN_TIMEOUT`.
 */
describe("Phase 12 — a Run that exhausts its budget", () => {
  it("cancels the live session, publishes nothing, and records RUN_TIMEOUT", async () => {
    const harness = createWorkflowHarness(() => environment);
    const runId = "run-session-timeout";

    // The Implementer holds until the test releases it. The budget is one second, so the
    // deadline passes while the Implementer still runs.
    const release = hold(harness.heldImplementations, runId);

    const status = await harness.runWorker(async () => {
      const handle = await harness.start("session-timeout", { maxRunMinutes: 1 / 60 });
      await waitFor(
        () => harness.implementCalls.length === 1,
        "the Implementer to start",
        30_000,
      );
      // The budget is spent while the Implementer holds. Release it so the workflow reaches
      // its next deadline check.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      release();
      return await handle.result();
    });

    expect(status.status).toBe("FAILED");

    const completion = harness.completions.find((entry) => entry.runId === runId);
    expect(completion?.failureReason).toBe("RUN_TIMEOUT");

    // SDD section 50 step 2. No publication, and no Proof Pack.
    expect(harness.publishCalls.filter((entry) => entry.runId === runId)).toEqual([]);
    expect(harness.proofPackCalls.filter((entry) => entry.runId === runId)).toEqual([]);

    // SDD section 50 step 3. The sandbox was released, so the Sprite reaper can delete it, and
    // the Run row keeps every evidence reference. The destroy list names this Run.
    expect(harness.destroyed).toContain(runId);

    // The human was told.
    expect(harness.postedErrors.join("\n")).toMatch(/time/i);
  }, 180_000);
});
```

Read the harness `start` helper. It applies `overrides` over `input(sessionId)`, so `maxRunMinutes` reaches the workflow. The workflow floors the budget at one second, so `1 / 60` yields a one-second budget.

Read the harness `destroyed` array to learn whether it records a run id or a sandbox id. Assert on whichever value it records.

- [ ] **Step 2: Run the test**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.workflow.config.ts tests/workflow/phase-12-timeout.test.ts`
Expected: PASS.

- [ ] **Step 3: Run it a second time**

Run the same command again. This test depends on wall-clock time, so it must prove itself twice.
Expected: PASS.

- [ ] **Step 4: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add tests/workflow/phase-12-timeout.test.ts
git commit -m "test: prove a spent Run budget cancels, preserves evidence, and fails RUN_TIMEOUT"
```

---

### Task 10: The live acceptance entry point

**Files:**
- Create: `tests/live/required-credentials.ts`
- Create: `tests/live/acceptance-live.ts`
- Create: `docs/live-acceptance.md`
- Modify: `.env.example`
- Modify: `package.json`
- Test: `tests/unit/required-credentials.test.ts`

**Interfaces:**
- Produces: `REQUIRED_LIVE_CREDENTIALS: LiveCredential[]`, `missingCredentials(env: NodeJS.ProcessEnv): LiveCredential[]`, and the `acceptance:live` script.

SDD section 66 requires the command, the seven live dependencies, and the documented credential list. Controller decision 9 fixes the absent-credential behaviour: exit 78 with `BLOCKED_EXTERNAL`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/required-credentials.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  REQUIRED_LIVE_CREDENTIALS,
  missingCredentials,
} from "../live/required-credentials.js";

describe("the live acceptance credential list", () => {
  it("names one credential for every live dependency of SDD section 66", () => {
    // SDD section 66 lists seven live dependencies. Every one needs at least one credential
    // or endpoint, or the live test cannot reach it.
    const dependencies = new Set(REQUIRED_LIVE_CREDENTIALS.map((entry) => entry.dependency));
    expect([...dependencies].sort()).toEqual([
      "backstage",
      "fly-sprites",
      "github",
      "linear",
      "mcp",
      "runner",
      "temporal",
    ]);
  });

  it("reports every absent credential", () => {
    expect(missingCredentials({})).toHaveLength(REQUIRED_LIVE_CREDENTIALS.length);
  });

  it("reports nothing when every credential is present", () => {
    const env: NodeJS.ProcessEnv = {};
    for (const entry of REQUIRED_LIVE_CREDENTIALS) env[entry.name] = "value";
    expect(missingCredentials(env)).toEqual([]);
  });

  it("treats an empty string as absent", () => {
    const env: NodeJS.ProcessEnv = {};
    for (const entry of REQUIRED_LIVE_CREDENTIALS) env[entry.name] = "value";
    env[REQUIRED_LIVE_CREDENTIALS[0]!.name] = "";
    expect(missingCredentials(env).map((entry) => entry.name)).toEqual([
      REQUIRED_LIVE_CREDENTIALS[0]!.name,
    ]);
  });

  it("documents every credential in .env.example", async () => {
    // A credential nobody documented is a credential the operator cannot supply. SDD section
    // 66 requires the list in `.env.example`.
    const { readFile } = await import("node:fs/promises");
    const example = await readFile(new URL("../../.env.example", import.meta.url), "utf8");
    for (const entry of REQUIRED_LIVE_CREDENTIALS) {
      expect(example, `${entry.name} is absent from .env.example`).toContain(entry.name);
    }
  });

  it("documents every credential in docs/live-acceptance.md", async () => {
    const { readFile } = await import("node:fs/promises");
    const document = await readFile(
      new URL("../../docs/live-acceptance.md", import.meta.url),
      "utf8",
    );
    for (const entry of REQUIRED_LIVE_CREDENTIALS) {
      expect(document, `${entry.name} is absent from docs/live-acceptance.md`).toContain(entry.name);
    }
  });
});
```

Check the `include` list of `vitest.config.ts` before you commit. If it does not reach `tests/unit`, use the path the config already uses. The relative import of `../live/required-credentials.js` avoids the `~/` alias, which points at `src/` only.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/required-credentials.test.ts`
Expected: FAIL, because `tests/live/required-credentials.ts` does not exist.

- [ ] **Step 3: Write the credential list**

Create `tests/live/required-credentials.ts`:

```ts
/**
 * SDD section 66. The live acceptance test uses a real Linear workspace, a real GitHub fixture
 * repository, a real Fly Sprite, a real Temporal service, at least one real coding-agent
 * runner, a test Backstage catalog, and a test MCP source.
 *
 * Every entry below names one value an operator must supply. The list is the single source for
 * `.env.example`, for `docs/live-acceptance.md`, and for the `BLOCKED_EXTERNAL` report.
 */
export interface LiveCredential {
  /** The environment variable name. */
  name: string;
  /** The SDD section 66 dependency this value reaches. */
  dependency:
    | "linear"
    | "github"
    | "fly-sprites"
    | "temporal"
    | "runner"
    | "backstage"
    | "mcp";
  /** What an operator must put in it. */
  description: string;
}

export const REQUIRED_LIVE_CREDENTIALS: LiveCredential[] = [
  {
    name: "LIVE_LINEAR_API_KEY",
    dependency: "linear",
    description: "A personal API key of the Linear test workspace.",
  },
  {
    name: "LIVE_LINEAR_TEAM_ID",
    dependency: "linear",
    description: "The Linear team the live test creates its fixture issue in.",
  },
  {
    name: "LIVE_GITHUB_TOKEN",
    dependency: "github",
    description: "A token with write access to the GitHub fixture repository only.",
  },
  {
    name: "LIVE_GITHUB_REPOSITORY",
    dependency: "github",
    description: "The fixture repository, as owner/name. It must not be a production repository.",
  },
  {
    name: "LIVE_FLY_API_TOKEN",
    dependency: "fly-sprites",
    description: "A Fly.io token that can create and delete a Sprite.",
  },
  {
    name: "LIVE_FLY_ORGANIZATION",
    dependency: "fly-sprites",
    description: "The Fly.io organization the live Sprite belongs to.",
  },
  {
    name: "LIVE_TEMPORAL_ADDRESS",
    dependency: "temporal",
    description: "The host and port of the real Temporal service.",
  },
  {
    name: "LIVE_TEMPORAL_NAMESPACE",
    dependency: "temporal",
    description: "The Temporal namespace of the live acceptance run.",
  },
  {
    name: "LIVE_RUNNER_NAME",
    dependency: "runner",
    description: 'The coding-agent runner to drive. Use "opencode" or "claude".',
  },
  {
    name: "LIVE_RUNNER_API_KEY",
    dependency: "runner",
    description: "The model provider key that runner authenticates with.",
  },
  {
    name: "LIVE_BACKSTAGE_BASE_URL",
    dependency: "backstage",
    description: "The base URL of the test Backstage catalog.",
  },
  {
    name: "LIVE_BACKSTAGE_TOKEN",
    dependency: "backstage",
    description: "A read token for that Backstage catalog.",
  },
  {
    name: "LIVE_MCP_ENDPOINT",
    dependency: "mcp",
    description: "The endpoint of the test MCP source.",
  },
  {
    name: "LIVE_MCP_TOKEN",
    dependency: "mcp",
    description: "The bearer token of that MCP source.",
  },
];

/** Every required credential the environment does not supply. An empty value counts as absent. */
export const missingCredentials = (env: NodeJS.ProcessEnv): LiveCredential[] =>
  REQUIRED_LIVE_CREDENTIALS.filter((entry) => {
    const value = env[entry.name];
    return value === undefined || value.trim() === "";
  });
```

- [ ] **Step 4: Write the entry point**

Create `tests/live/acceptance-live.ts`:

```ts
/**
 * SDD section 66. The live acceptance entry point.
 *
 * The command exits 78 and prints `BLOCKED_EXTERNAL` when a required credential is absent.
 * SDD section 66 names that state, and it says the state is not equivalent to Done. Exit 78 is
 * the `EX_CONFIG` value of `sysexits`, so no CI system reads it as success.
 */
import { missingCredentials, REQUIRED_LIVE_CREDENTIALS } from "./required-credentials.js";

const BLOCKED_EXTERNAL_EXIT = 78;

const main = async (): Promise<number> => {
  const missing = missingCredentials(process.env);
  if (missing.length > 0) {
    process.stdout.write("BLOCKED_EXTERNAL\n\n");
    process.stdout.write(
      `The live acceptance test needs ${REQUIRED_LIVE_CREDENTIALS.length} values. ` +
        `${missing.length} of them are absent:\n\n`,
    );
    for (const entry of missing) {
      process.stdout.write(`  ${entry.name} (${entry.dependency}) — ${entry.description}\n`);
    }
    process.stdout.write("\nRead docs/live-acceptance.md for the setup procedure.\n");
    process.stdout.write("BLOCKED_EXTERNAL is not equivalent to DONE. See SDD section 66.\n");
    return BLOCKED_EXTERNAL_EXIT;
  }

  process.stdout.write("Every required live credential is present.\n");
  process.stdout.write("Read docs/live-acceptance.md and run the procedure it states.\n");
  // The live scenario itself needs a real Linear workspace, a real GitHub repository, and a
  // real Fly organization. Task 10 delivers the entry point, the credential contract, and the
  // documented procedure. The scenario body is written against the real accounts, because a
  // scenario written against no account proves nothing. SDD section 72 forbids a mock here.
  const { runLiveAcceptance } = await import("./scenario.js");
  return await runLiveAcceptance(process.env);
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
```

Create `tests/live/scenario.ts` in the same commit. It must hold the real end-to-end scenario against the real accounts. Write it against the real client adapters the repository already has, in `src/adapters/linear`, `src/adapters/github`, and `src/adapters/sandbox/fly-sprites`. Do not substitute a double for any of them. The function signature is:

```ts
export const runLiveAcceptance = async (env: NodeJS.ProcessEnv): Promise<number> => { /* ... */ };
```

It returns 0 only when a real Linear delegation reached Factoree, a real Fly Sprite performed the implementation, deterministic verification ran, user-level validation ran, independent review ran, a real GitHub pull request exists, and the Proof Pack is visible in Linear. It returns 1 otherwise, after it prints which of those facts did not hold.

- [ ] **Step 5: Add the script**

In `package.json`, add one script beside `test:workflow`:

```json
    "acceptance:live": "tsx tests/live/acceptance-live.ts",
```

Read the `devDependencies` first. If `tsx` is absent, use the runner the repository already uses to execute a TypeScript entry point. Read `src/bin/worker.ts` and the scripts that start it to learn which runner that is. Do not add a dependency the repository does not need.

`acceptance:live` must not join `npm run verify`. Controller decision 10 records why.

- [ ] **Step 6: Extend `.env.example`**

Append to `.env.example`. Keep the existing lines unchanged:

```
# Live acceptance, SDD section 66. `npm run acceptance:live` needs every value below.
# Without them the command prints BLOCKED_EXTERNAL and exits 78.
LIVE_LINEAR_API_KEY=
LIVE_LINEAR_TEAM_ID=
LIVE_GITHUB_TOKEN=
LIVE_GITHUB_REPOSITORY=owner/factoree-live-fixture
LIVE_FLY_API_TOKEN=
LIVE_FLY_ORGANIZATION=
LIVE_TEMPORAL_ADDRESS=
LIVE_TEMPORAL_NAMESPACE=
LIVE_RUNNER_NAME=opencode
LIVE_RUNNER_API_KEY=
LIVE_BACKSTAGE_BASE_URL=
LIVE_BACKSTAGE_TOKEN=
LIVE_MCP_ENDPOINT=
LIVE_MCP_TOKEN=
```

- [ ] **Step 7: Write the procedure document**

Create `docs/live-acceptance.md`. It must name every credential of the list, and it must state the procedure. Write it in ASD-STE100. Use this structure:

```markdown
# Live acceptance

SDD section 66 requires one live proof of Factoree Version 1. This document states the
accounts, the credentials, and the procedure.

## Command

    npm run acceptance:live

The command exits 0 only when every live fact holds. It exits 78 and prints
`BLOCKED_EXTERNAL` when a required credential is absent. `BLOCKED_EXTERNAL` is not equivalent
to `DONE`. See SDD section 66.

## Accounts you must create first

1. A Linear test workspace. Do not use a production workspace.
2. A GitHub fixture repository. Do not use a production repository.
3. A Fly.io organization that can create a Sprite.
4. A Temporal service. Temporal Cloud or a self-hosted service both work.
5. One coding-agent runner account. OpenCode or Claude Code.
6. A Backstage catalog with at least one component entity.
7. An MCP source that answers a search.

## Credentials

| Variable | Dependency | Value |
| --- | --- | --- |
| `LIVE_LINEAR_API_KEY` | Linear | A personal API key of the test workspace. |
| ... one row for every entry of `tests/live/required-credentials.ts` ... |

## Procedure

1. Copy `.env.example` to `.env`. Fill every `LIVE_` value.
2. Start PostgreSQL and apply the migrations with `npm run db:migrate`.
3. Start the worker against the real Temporal service.
4. Run `npm run acceptance:live`.
5. Read the printed report.

## What the command proves

The command exits 0 only when every fact of the SDD section 67 "Live proof" list holds. It
names each fact it could not prove.
```

Fill the credential table with one row for every entry of the list. The unit test of Step 1 fails until every name appears.

- [ ] **Step 8: Run the test and confirm it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/required-credentials.test.ts`
Expected: PASS, six tests.

- [ ] **Step 9: Run the command with no credentials**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH env -u LIVE_LINEAR_API_KEY npm run acceptance:live; echo "exit=$?"`
Expected: the output starts with `BLOCKED_EXTERNAL`, and the exit line reads `exit=78`.

`npm` can rewrite a non-zero exit code. If the printed code is not 78, run the entry point directly and record both codes in the evidence file.

- [ ] **Step 10: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0.

If `tsconfig.json` does not include `tests/live`, add it to the same include list that already covers `tests`. The build config `tsconfig.build.json` must not include it, because the live entry point is not production code.

- [ ] **Step 11: Commit**

```bash
git add tests/live tests/unit/required-credentials.test.ts docs/live-acceptance.md .env.example package.json tsconfig.json
git commit -m "feat(live): add the SDD section 66 live acceptance entry point and its documentation"
```

---

### Task 11: The Phase 12 exit test and the Definition of Done audit

**Files:**
- Create: `tests/acceptance/phase-12-exit.test.ts`
- Create: `docs/build/definition-of-done.md`

**Interfaces:**
- Consumes: `REQUIRED_LIVE_CREDENTIALS`, `RUN_FAILURE_REASONS`, `failureCategoryOf`, `registry` from `~/telemetry/metrics.js`.
- Produces: the phase exit evidence.

**Exit condition (SDD section 69):** every Definition of Done item passes.

- [ ] **Step 1: Write the exit test**

Create `tests/acceptance/phase-12-exit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { registry } from "~/telemetry/metrics.js";
import { failureCategoryOf } from "~/domain/runs/failure-category.js";
import { RUN_FAILURE_REASONS } from "~/domain/runs/run-status.js";

/**
 * SDD section 69, Phase 12: "every Definition of Done item passes."
 *
 * A checkbox in a Markdown file is a claim, not evidence. This test proves the machine-checkable
 * parts of SDD section 67 against the real code. The remaining parts have their own acceptance
 * tests, and `docs/build/definition-of-done.md` names each one.
 */
describe("Phase 12 exit condition", () => {
  it("registers every metric SDD section 62 requires", async () => {
    const required = [
      "factoree_runs_started_total",
      "factoree_runs_ready_total",
      "factoree_runs_failed_total",
      "factoree_runs_cancelled_total",
      "factoree_run_duration_seconds",
      "factoree_refinement_duration_seconds",
      "factoree_context_resolution_duration_seconds",
      "factoree_implementation_duration_seconds",
      "factoree_verification_duration_seconds",
      "factoree_validation_duration_seconds",
      "factoree_review_duration_seconds",
      "factoree_repairs_total",
      "factoree_context_conflicts_total",
      "factoree_human_interventions_total",
      "factoree_active_runs",
    ];
    const registered = new Set((await registry.getMetricsAsJSON()).map((entry) => entry.name));
    for (const name of required) {
      expect(registered.has(name), `${name} is not registered`).toBe(true);
    }
  });

  it("gives every failure reason a normalized category", () => {
    for (const reason of RUN_FAILURE_REASONS) {
      expect(failureCategoryOf(reason)).toBeTruthy();
    }
  });

  it("skips no required test", async () => {
    // SDD section 67: "No required test is skipped." A `.skip` or a `.todo` in an acceptance
    // test removes a required proof. SDD section 72 forbids that.
    const { glob } = await import("node:fs/promises");
    const offenders: string[] = [];
    for await (const path of glob("tests/acceptance/**/*.test.ts")) {
      const text = await readFile(path, "utf8");
      if (/\b(it|describe|test)\.(skip|todo)\b/.test(text)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("records the Definition of Done audit with one row for every item", async () => {
    const sdd = await readFile("docs/sdd.md", "utf8");
    const audit = await readFile("docs/build/definition-of-done.md", "utf8");

    // Every checkbox line of SDD section 67 must appear in the audit, word for word, so no item
    // can be quietly dropped.
    const section = sdd.slice(
      sdd.indexOf("## 67. Definition of Done"),
      sdd.indexOf("## 68. Completion invariant"),
    );
    const items = [...section.matchAll(/^- \[ \] (.+)$/gm)].map((match) => match[1]!.trim());
    // SDD section 67 holds exactly 99 required items. The SDD is immutable, so the count is
    // fixed. A different count means the slice above broke, not that the SDD changed.
    expect(items.length).toBe(99);
    const missing = items.filter((item) => !audit.includes(item));
    expect(missing).toEqual([]);
  });

  it("names the live proof as BLOCKED_EXTERNAL or as passed, never as untested", async () => {
    // SDD section 66. The live section must state one of the two defined states.
    const audit = await readFile("docs/build/definition-of-done.md", "utf8");
    expect(audit).toMatch(/BLOCKED_EXTERNAL|PASSED/);
  });
});
```

`node:fs/promises` exposes `glob` from Node 22. If the installed Node rejects it, use the directory read the other acceptance tests already use. Read one of them first.

The controller counted the real items before this plan was written. SDD section 67 holds exactly 99 checkbox items. The `toBe(99)` assertion guards against a broken slice.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/acceptance/phase-12-exit.test.ts`
Expected: FAIL, because `docs/build/definition-of-done.md` does not exist.

- [ ] **Step 3: Write the audit**

Create `docs/build/definition-of-done.md`. Every checkbox line of SDD section 67 must appear word for word, followed by the evidence. Use one table per SDD subsection. The structure is:

```markdown
# Definition of Done audit

SDD section 67 states every required item. This file records the evidence for each one.

- Specification: `docs/sdd.md` version 2.0, SHA-256 `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`.
- Audit date: <the date you run it>
- Verification evidence: `docs/build/evidence/phase-12-verify.txt`

## Build

| Item | State | Evidence |
| --- | --- | --- |
| Node.js 24 LTS is the production runtime. | PASS | `package.json` `engines.node` is `>=24 <25`. `.nvmrc` names 24. |
| `npm ci` succeeds. | PASS | `docs/build/evidence/phase-12-verify.txt`. |
| ... one row for every remaining item ... |

## Live proof

| Item | State | Evidence |
| --- | --- | --- |
| `npm run acceptance:live` has passed. | BLOCKED_EXTERNAL | No live Linear, GitHub, Fly, or Temporal credential is available. `npm run acceptance:live` exits 78 and prints `BLOCKED_EXTERNAL`. SDD section 66 names that state. |
| ... one row for every remaining live item ... |
```

Fill every row. Do not write `PASS` for an item you did not check. An item with no test names the code that satisfies it, and says so plainly. An item you cannot prove reads `BLOCKED_EXTERNAL`, with the reason.

Read `docs/sdd.md` section 67 and copy each checkbox text exactly. A changed word fails the exit test.

- [ ] **Step 4: Run the exit test and confirm it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/acceptance/phase-12-exit.test.ts`
Expected: PASS, five tests.

- [ ] **Step 5: Run the whole verification**

`npm run verify` takes longer than a two-minute foreground tool call. Run it in stages, in the background, and compute a real aggregate exit code. Write the output to `docs/build/evidence/phase-12-verify.txt`, and make the last line read `exit=<code>`.

Run each stage on its own. Never run two suites at once.

```
npm run lint
npm run typecheck
npx vitest run --config vitest.config.ts
npx vitest run --config vitest.integration.config.ts
npx vitest run --config vitest.workflow.config.ts
npm run build
```

Expected: every stage exits 0. The skip count must stay 7.

- [ ] **Step 6: Run the whole verification a second time**

A single green run is not proof. Run every stage again and confirm identical counts.
Expected: exit 0, with the same counts.

- [ ] **Step 7: Commit**

```bash
git add tests/acceptance/phase-12-exit.test.ts docs/build/definition-of-done.md docs/build/evidence/phase-12-verify.txt
git commit -m "test: prove the Phase 12 exit condition and record the Definition of Done audit"
```

---

## Spec coverage

| SDD requirement | Task |
| --- | --- |
| Section 44 patch integrity, git version evidence | Task 5 |
| Section 46 hash assertion cause | Task 5 |
| Section 49 infrastructure retry against semantic budget | Task 8 |
| Section 50 timeout, cancellation, evidence preservation | Task 9 |
| Section 51 retention cleanup | Already proved by `tests/unit/sprite-reaper.test.ts`, audited in Task 11 |
| Section 52 multi-tenant isolation | Already proved by `tests/integration/at-33-tenant-isolation.test.ts`, audited in Task 11 |
| Section 53 persisted entities gain `failureCategory` and `organizationSkillsSha` | Task 2, Task 6 |
| Section 55 reproducible context, organization skills SHA | Task 6 |
| Section 60 logging and redaction | Already proved by `tests/unit/at-32-redaction.test.ts`, audited in Task 11 |
| Section 61 transcript policy | Already proved, audited in Task 11 |
| Section 62 required metrics | Task 2, Task 11 |
| Section 64 AT-31 through AT-37 | Audited in Task 11 |
| Section 65 required development commands | Task 11 |
| Section 66 live acceptance test | Task 10 |
| Section 67 Definition of Done | Task 11 |
| Section 68 completion invariant | Already proved by `src/domain/runs/completion-invariant.ts`, audited in Task 11 |
| Section 69 Phase 12 exit condition | Task 11 |
| Carried finding: unbounded runner session map | Task 3 |
| Carried finding: worktree fingerprint misses `.git/` | Task 4 |
| Carried finding: two git binaries produce two diff texts | Task 5 |
| Carried finding: organization skills SHA discarded | Task 6 |

## Known limitation this plan states plainly

`npm run acceptance:live` cannot pass in this environment. No live Linear workspace, GitHub
fixture repository, Fly organization, or Temporal service credential is available. SDD section
66 names that state `BLOCKED_EXTERNAL`, and it says the state is not equivalent to `DONE`.
Task 10 delivers the command, the credential contract, and the documented procedure. Task 11
records the live-proof rows as `BLOCKED_EXTERNAL`. Factoree Version 1 is therefore not `DONE`
until an operator supplies those credentials and the command exits 0.
