# Factoree Phase 8 — Review and repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Factoree an independent Reviewer that runs after user validation passes, receives the fixed review baseline and the source diff in a fresh session, reports findings as data, and lets Factoree alone decide which findings block, repair, or end the Run.

**Architecture:** A new `src/domain/review/` module holds the finding schema, the report parser, and the blocking rules. A fresh agent session receives the goal, the frozen Validation Contract, the Context Contract, the constraints, the source diff, the changed files, the deterministic verification result, the user validation evidence, and the repository rules. It writes one JSON report into `${workspacePath}/review/report.json` and it changes no source file. Factoree parses that report against the frozen contract and the changed-file list, refuses any finding that names no concrete defect, and decides blocking itself. The agent `verdict` field is recorded and never decides. A blocking finding enters the same bounded repair loop that deterministic verification and user validation already share.

**Tech Stack:** TypeScript (strict), Node.js 24 LTS, npm, Temporal TypeScript SDK, Prisma, PostgreSQL, Vitest, Testcontainers, prom-client.

**Spec:** `docs/sdd.md` (version 2.0, SHA-256 `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`)

## Global Constraints

These hold for every task. Every value is copied from the SDD.

- Production runtime is Node.js 24 LTS. Bun MUST NOT run Temporal Worker code (SDD section 11).
- TypeScript MUST keep `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true` (SDD section 10).
- npm with a committed `package-lock.json` (SDD section 10).
- Provider SDKs and provider HTTP clients MUST stay in `src/adapters/**`. Core workflow policy MUST NOT import a provider client (SDD section 14).
- Source layout MUST follow SDD section 63. Phase 8 fills `src/domain/review/` and adds `src/activities/review.activities.ts`.
- Tenant boundary is the Linear workspace. Every tenant-owned persisted record MUST carry a tenant identifier, and every read MUST filter on it (SDD section 52).
- Factoree MUST NOT log an OAuth token, a GitHub token, a model API key, a Project secret, or an authorization header (SDD section 60). Sensitive values MUST be redacted before persistence.
- The Reviewer MUST NOT reuse Implementer context (SDD section 40).
- The Reviewer MUST NOT expand scope beyond the fixed review baseline (SDD section 43).
- Allowed severities are exactly `blocker`, `high`, `medium`, `low` (SDD section 41).
- Only valid `blocker` and `high` findings block by default. Style preferences do not block (SDD section 41).
- The default total repair limit is 2. No third repair may occur when the limit is two (SDD section 42).
- Run state names MUST stay exactly the names of SDD section 48. Phase 8 adds no state name. It activates `REVIEWING` and `FAILED_REVIEW`, which already exist in the list.
- Semantic failures MUST use workflow decisions and MUST NOT consume Temporal retry policy (SDD section 49).
- No agent claim decides a result. Factoree decides from the artefacts (SDD principle P-01).
- Required checks MUST NOT use `continue-on-error`. `npm run verify` MUST pass (SDD section 65).

---

## Phase 8 scope (SDD section 69)

> Build fresh Reviewer, finding schema, blocking rules, and bounded repair.
> **Exit:** a known defect is found, repaired, revalidated, and re-reviewed.

**In scope:** the fresh Reviewer session of SDD section 40 and its exact input list; the report schema of SDD section 41 and its parser; the four severities; the deterministic blocking rules of SDD section 41; the fixed review baseline of SDD section 43; the source diff and the changed-file list; the `ReviewFinding` entity of SDD section 53 and its migration; the `review` activity; the `REVIEWING` state, the review repair branch, and the `FAILED_REVIEW` terminal state of SDD section 48; the shared repair budget of SDD section 42; the `factoree_review_duration_seconds` metric of SDD section 62; AT-20, AT-21, AT-22, AT-23, AT-24; the Phase 8 exit test.

**Out of scope (later phases, do not build):** patch capture, the patch hash, the stale base guard, the trusted checkout, and publication (Phase 9); the Proof Pack (Phase 10); `ClaudeCodeRunner` and skill discovery (Phase 11); `READY_FOR_HUMAN`, which SDD section 68 still forbids without a PR and a Proof Pack, so Phase 8 invents no success terminal state; the Action Policy enforcement gap carried from Phase 7, which Phase 9 owns; the cross-cutting redaction sweep, which Phase 12 owns; a second model family for the Reviewer, because SDD section 40 says SHOULD and the runner name is already repository configuration.

---

## Decisions taken by the controller

Recorded so a later reviewer does not treat them as drift.

1. **The Reviewer writes data, and Factoree decides.** SDD section 41 fixes the report as a JSON document with a verdict and findings. Principle P-01 forbids Factoree to accept an agent claim as evidence. So the session writes one report file, Factoree parses it, and Factoree alone decides which findings block. This mirrors the Phase 7 Validation Plan, and it reuses its shape on purpose.

2. **The agent `verdict` field never decides the Run.** Factoree records the verdict on the review record and derives the outcome from the findings. A `pass` verdict that carries a valid blocking finding still blocks. A `fail` verdict that carries no valid blocking finding does not block. SDD section 41 says a blocking finding must identify a concrete defect, so a verdict without such a finding names nothing to repair.

3. **A finding blocks only when four conditions hold together.** SDD section 41 requires a concrete defect, a mandatory requirement or rule, and specific evidence, and it says only valid `blocker` and `high` findings block. Factoree therefore blocks when: the severity is `blocker` or `high`; the category is not a style category; the `requirement` field is present and resolvable; and the `evidence` field names a file the source diff actually changed. Every other finding is recorded and does not block.

4. **A `requirement` that begins with `VAL-` must name an assertion of the frozen Validation Contract.** A Reviewer that invents an assertion identifier names no mandatory requirement. Any other non-empty requirement text is accepted as a repository rule or a constraint, because Factoree cannot enumerate every repository rule deterministically.

5. **`evidence` must name a changed file.** SDD section 41 requires specific evidence. Factoree resolves `path` and `path:line` forms against the changed-file list of this Run. A finding whose evidence names a file the diff did not change reports something outside the change under review, which SDD section 43 forbids the Reviewer to block on.

6. **A style finding cannot block at any severity.** SDD section 41 says style preferences do not block. The closed category list holds `style`, and a `blocker` severity on a `style` category does not raise it above that rule.

7. **An unusable review report ends the Run with `REVIEW_UNAVAILABLE`, not with a repair.** A report that is absent, is not JSON, or does not match the schema proves nothing about the code. A repair cannot fix a broken review. SDD section 68 forbids completion without a passing review, so the Run fails. The state is `FAILED`, because the code was not rejected.

8. **Blocking findings with a spent repair budget end the Run in `FAILED_REVIEW`.** SDD section 48 lists `FAILED_REVIEW` as a terminal state, and this is the one case that means it: the review rejected the change and Factoree may not repair again.

9. **The repair budget is shared across every stage.** SDD section 42 bounds repairs per Run, not per stage. A review repair therefore increments the same counter deterministic verification and user validation already increment. AT-24 counts every repair of the Run.

10. **A review repair re-runs the whole chain.** SDD section 42 draws repair, then deterministic verification, then user-level validation, then fresh review. The existing loop already runs implement, verify, and user validate in that order, so a review repair uses `continue` on the same loop and needs no second loop.

11. **Every new Reviewer run uses fresh context.** SDD section 42 states this for the repair path. The activity starts a new session for each attempt and passes no session reference between attempts, so a resumed Reviewer session cannot exist.

12. **The source diff comes from the SDD section 44 command.** `git add -A` followed by `git diff --cached <base_sha>` is the command SDD section 44 fixes for the patch. Phase 8 reads it, and Phase 9 hashes it. One shared module produces it, so the review and the publication can never read a different change. Staging a file changes no source file, so this is not a write the Action Policy governs.

13. **The diff the prompt carries is redacted and bounded.** SDD section 60 forbids a secret in a captured output, and a prompt is a captured output. The diff passes the redactor. A diff above a fixed byte ceiling is truncated, and the prompt states plainly that Factoree truncated it, and it always carries the complete changed-file list.

14. **A binary file appears in the changed-file list and not in the diff text.** `git diff --cached` without `--binary` reports a binary file by name only. The Reviewer needs the name, and binary bytes in a prompt help nobody.

15. **The Reviewer writes only into `${workspacePath}/review`.** SDD section 40 gives the Reviewer no write task at all. Phase 9 captures the patch from the primary worktree, so a Reviewer artefact inside the worktree would reach the published patch. `buildActionPolicy({ role: "reviewer" })` already denies `writePrimaryWorktree`.

16. **An unregistered reviewer runner is a configuration fault.** SDD section 15 sets `reviewer: claude` in its own example, and `ClaudeCodeRunner` arrives in Phase 11. Phase 8 therefore mirrors the Phase 7 validator rule exactly: `RunConfigurationError` names the configured and the registered runners, and the Run ends in `FAILED_CONFIGURATION`. The default value stays `claude`.

17. **Every finding is persisted, blocking or not.** SDD section 43 permits out-of-scope work as a follow-up recommendation, and SDD section 47 gives the Proof Pack a review section. A dropped non-blocking finding could never reach a human. The row records whether Factoree treated the finding as blocking and why it did not.

18. **The review record lives on the `ReviewFinding` rows and the `AgentExecution` row.** SDD section 53 requires the `ReviewFinding` entity and requires no separate review entity. The verdict, the attempt, and the blocking decision are columns of the finding rows, and a review that found nothing writes no finding row. The `AgentExecution` row of role `reviewer` proves the review ran.

---

## Requirement mapping

| SDD requirement | Task |
| --- | --- |
| Section 40 — fresh Reviewer, the exact input list, no Implementer context | Tasks 3, 4, 6, 8 |
| Section 41 — the report schema, the four severities, the blocking rules | Tasks 1, 2 |
| Section 42 — the bounded repair loop and the fresh context of each review | Tasks 6, 7 |
| Section 43 — the fixed review baseline, and no scope expansion | Tasks 2, 3 |
| Section 44 — the diff command that Phase 9 will hash | Task 4 |
| Section 48 and section 49 — `REVIEWING`, the repair branch, `FAILED_REVIEW` | Task 7 |
| Section 52 — the tenant filter on every read | Task 5 |
| Section 53 — the `ReviewFinding` entity | Task 5 |
| Section 56 — the reviewer prompt version on the `AgentExecution` row | Task 6 |
| Section 62 — `factoree_review_duration_seconds` | Task 6 |
| Section 63 — `src/activities/review.activities.ts` and `src/domain/review/` | Tasks 1 to 6 |
| AT-20 — a behaviorally wrong change fails validation, repairs, and reverifies | Task 8 |
| AT-21 — the Reviewer session differs and holds no Implementer transcript | Task 8 |
| AT-22 — a concrete high finding blocks the Run and triggers repair | Task 8 |
| AT-23 — a style-only medium finding does not block | Task 8 |
| AT-24 — no third repair starts when the maximum is two | Task 8 |
| Phase 8 exit — a known defect is found, repaired, revalidated, and re-reviewed | Task 9 |

---

## File structure

**Created**

- `src/domain/review/review-report.ts` — the finding types, the severities, the categories, the report schema, and the parser. No provider SDK, no persistence.
- `src/domain/review/blocking.ts` — the deterministic blocking rules of SDD section 41. It takes a parsed report, the frozen contract, and the changed-file list, and it returns one decision per finding.
- `src/domain/review/source-diff.ts` — the SDD section 44 diff command against the sandbox, the changed-file list, redaction, and truncation.
- `src/domain/review/reviewer-input.ts` — the reviewer prompt builder and the forbidden-material guard, mirroring `user-validator-input.ts`.
- `src/domain/review/review-finding-store.ts` — the `ReviewFindingStore` port.
- `src/prompts/reviewer.ts` — the reviewer prompt template and its version.
- `src/persistence/prisma/review-finding.prisma.ts` — the Prisma `ReviewFindingStore`.
- `src/activities/review.activities.ts` — the `review` activity of SDD section 63.
- `prisma/migrations/20260827120000_add_review_findings/migration.sql` — the `ReviewFinding` table.
- `tests/unit/review-report.test.ts`, `tests/unit/review-blocking.test.ts`, `tests/unit/source-diff.test.ts`, `tests/unit/reviewer-input.test.ts`, `tests/unit/review-activity.test.ts`.
- `tests/integration/review-findings.test.ts` — the Prisma store against a real database.
- `tests/workflow/review.workflow.test.ts` — the `REVIEWING` state and the review repair branch.
- `tests/workflow/at-22-blocking-finding.test.ts`, `tests/workflow/at-23-scope-control.test.ts`, `tests/workflow/at-24-repair-limit.test.ts`.
- `tests/acceptance/at-20-validation-repair.test.ts`, `tests/acceptance/at-21-fresh-review.test.ts`.
- `tests/acceptance/phase-08-exit.test.ts` — the Phase 8 exit condition.

**Modified**

- `prisma/schema.prisma` — the `ReviewFinding` model and its relation on `Run`.
- `src/domain/runs/run-status.ts` — the failure reasons `REVIEW_BLOCKING_FINDINGS` and `REVIEW_UNAVAILABLE`.
- `src/telemetry/metrics.ts` — `factoree_review_duration_seconds`.
- `src/activities/run.activities.ts` — the repair metric reason label.
- `src/activities/index.ts` — the review activity and its dependencies.
- `src/bin/worker.ts` — the wiring of the review dependencies.
- `src/workflows/agent-run.workflow.ts` — the `REVIEWING` stage, the review repair branch, and `FAILED_REVIEW`.
- `tests/workflow/support/harness.ts` — the `review` activity double.
- `tests/workflow/at-35-worker-restart.test.ts` — the hand-built activity map. See the STATUS note.

---

## Task 1: The review report schema and its parser

**Files:**
- Create: `src/domain/review/review-report.ts`
- Test: `tests/unit/review-report.test.ts`

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces:
  - `REVIEW_SEVERITIES: readonly ["blocker","high","medium","low"]`, `type ReviewSeverity`.
  - `REVIEW_CATEGORIES: readonly ["correctness","security","contract","reliability","performance","maintainability","style","scope"]`, `type ReviewCategory`.
  - `interface ReviewFinding { id: string; severity: ReviewSeverity; category: ReviewCategory; requirement: string; evidence: string; description: string }`
  - `interface ReviewReport { version: 1; verdict: "pass" | "fail"; findings: ReviewFinding[] }`
  - `class ReviewReportInvalidError extends Error`
  - `parseReviewReport(text: string): ReviewReport`
  - `REVIEW_REPORT_SCHEMA_TEXT: string` — the prompt description of the shape. Task 3 renders it.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/review-report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseReviewReport, ReviewReportInvalidError } from "~/domain/review/review-report.js";

const finding = {
  id: "RV-1",
  severity: "high",
  category: "correctness",
  requirement: "VAL-API-001",
  evidence: "src/auth.ts:84",
  description: "The handler returns 200 for an expired token.",
};

describe("parseReviewReport", () => {
  it("parses a pass report with no finding", () => {
    const report = parseReviewReport(JSON.stringify({ version: 1, verdict: "pass", findings: [] }));
    expect(report.verdict).toBe("pass");
    expect(report.findings).toEqual([]);
  });

  it("parses a fail report with one finding", () => {
    const report = parseReviewReport(
      JSON.stringify({ version: 1, verdict: "fail", findings: [finding] }),
    );
    expect(report.findings[0]?.id).toBe("RV-1");
    expect(report.findings[0]?.severity).toBe("high");
  });

  it("refuses text that is not JSON", () => {
    expect(() => parseReviewReport("not json")).toThrow(ReviewReportInvalidError);
  });

  it("refuses a severity the SDD does not list", () => {
    const bad = { ...finding, severity: "critical" };
    expect(() =>
      parseReviewReport(JSON.stringify({ version: 1, verdict: "fail", findings: [bad] })),
    ).toThrow(ReviewReportInvalidError);
  });

  it("refuses a category the schema does not list", () => {
    const bad = { ...finding, category: "vibes" };
    expect(() =>
      parseReviewReport(JSON.stringify({ version: 1, verdict: "fail", findings: [bad] })),
    ).toThrow(ReviewReportInvalidError);
  });

  it("refuses an unknown key", () => {
    const bad = { ...finding, extra: true };
    expect(() =>
      parseReviewReport(JSON.stringify({ version: 1, verdict: "fail", findings: [bad] })),
    ).toThrow(ReviewReportInvalidError);
  });

  it("refuses two findings that share one identifier", () => {
    expect(() =>
      parseReviewReport(
        JSON.stringify({ version: 1, verdict: "fail", findings: [finding, finding] }),
      ),
    ).toThrow(/more than one finding/);
  });

  it("refuses an empty description", () => {
    const bad = { ...finding, description: "   " };
    expect(() =>
      parseReviewReport(JSON.stringify({ version: 1, verdict: "fail", findings: [bad] })),
    ).toThrow(ReviewReportInvalidError);
  });

  it("names the field in the message", () => {
    const bad = { ...finding, evidence: 4 };
    expect(() =>
      parseReviewReport(JSON.stringify({ version: 1, verdict: "fail", findings: [bad] })),
    ).toThrow(/evidence/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/review-report.test.ts`
Expected: FAIL, because `~/domain/review/review-report.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/domain/review/review-report.ts`:

```ts
import { z } from "zod";

/** SDD section 41 lists exactly these severities. No other value is allowed. */
export const REVIEW_SEVERITIES = ["blocker", "high", "medium", "low"] as const;

export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

/**
 * The closed category list. SDD section 41 shows `correctness` and says style preferences do not
 * block, so the list must hold a `style` value the blocking rules can recognise. A closed list
 * also keeps a Reviewer from inventing a category that no rule covers.
 */
export const REVIEW_CATEGORIES = [
  "correctness",
  "security",
  "contract",
  "reliability",
  "performance",
  "maintainability",
  "style",
  "scope",
] as const;

export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

/** SDD section 41. One reported finding. */
export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  /** The mandatory requirement or rule the finding names. */
  requirement: string;
  /** The specific evidence, for example `src/auth.ts:84`. */
  evidence: string;
  description: string;
}

/** SDD section 41. The whole Reviewer output. */
export interface ReviewReport {
  version: 1;
  /** The agent claim. It is recorded and it never decides. See controller decision 2. */
  verdict: "pass" | "fail";
  findings: ReviewFinding[];
}

export class ReviewReportInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewReportInvalidError";
  }
}

const nonBlank = z.string().refine((value) => value.trim() !== "", "must not be blank");

const findingSchema = z
  .object({
    id: nonBlank,
    severity: z.enum(REVIEW_SEVERITIES),
    category: z.enum(REVIEW_CATEGORIES),
    requirement: nonBlank,
    evidence: nonBlank,
    description: nonBlank,
  })
  .strict();

const reportSchema = z
  .object({
    version: z.literal(1),
    verdict: z.enum(["pass", "fail"]),
    findings: z.array(findingSchema),
  })
  .strict();

const describeIssue = (issue: z.core.$ZodIssue): string => {
  const path = issue.path.length === 0 ? "the document" : issue.path.join(".");
  const keys = issue.code === "unrecognized_keys" ? ` (${issue.keys.join(", ")})` : "";
  return `${path}: ${issue.message}${keys}`;
};

const fail = (message: string): never => {
  throw new ReviewReportInvalidError(message);
};

/** The prompt text that describes the shape above. SDD section 41 fixes it. */
export const REVIEW_REPORT_SCHEMA_TEXT = [
  'The document is one JSON object: { "version": 1, "verdict": "pass" | "fail", "findings": [...] }.',
  "Each finding holds exactly these fields: id, severity, category, requirement, evidence, description.",
  `severity is one of: ${REVIEW_SEVERITIES.join(", ")}.`,
  `category is one of: ${REVIEW_CATEGORIES.join(", ")}.`,
  "requirement names the mandatory requirement or rule the change breaks. Use the assertion " +
    "identifier of the Validation Contract when the finding breaks an assertion.",
  "evidence names one changed file, and a line where you can give one, for example src/auth.ts:84.",
  "description states one concrete defect in plain words.",
  "Write no other key. Write no comment.",
].join("\n");

/** Parses the report text one fresh Reviewer session wrote. It decides nothing. */
export const parseReviewReport = (text: string): ReviewReport => {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    fail(
      `The review report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = reportSchema.safeParse(document);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(describeIssue).join("; ");
    return fail(`The review report does not match the report schema: ${detail}`);
  }

  const report = parsed.data;
  const seen = new Set<string>();
  for (const finding of report.findings) {
    if (seen.has(finding.id)) {
      fail(`The review report holds more than one finding with the identifier "${finding.id}".`);
    }
    seen.add(finding.id);
  }

  return report;
};
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/review-report.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the whole-repository gate**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0. Read the real output. A scoped lint result is not accepted.

- [ ] **Step 6: Commit**

```bash
git add src/domain/review/review-report.ts tests/unit/review-report.test.ts
git commit -F - <<'MSG'
feat(review): add the SDD section 41 finding schema and its parser
MSG
```

Do not build the commit message through a `cat` heredoc. Write the message to a file and use `git commit -F <file>` when the shell above is not available.

---

## Task 2: The deterministic blocking rules

**Files:**
- Create: `src/domain/review/blocking.ts`
- Test: `tests/unit/review-blocking.test.ts`

**Interfaces:**
- Consumes: `ReviewReport`, `ReviewFinding`, `ReviewSeverity` from Task 1. `ValidationContract` from `~/domain/validation/validation-contract.js`.
- Produces:
  - `interface FindingDecision { finding: ReviewFinding; blocking: boolean; reason: string }`
  - `interface ReviewDecision { blocking: FindingDecision[]; nonBlocking: FindingDecision[]; decisions: FindingDecision[]; passed: boolean; summary: string; failures: string[] }`
  - `decideReview(input: { report: ReviewReport; contract: ValidationContract; changedFiles: string[] }): ReviewDecision`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/review-blocking.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideReview } from "~/domain/review/blocking.js";
import type { ReviewFinding, ReviewReport } from "~/domain/review/review-report.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";

const contract: ValidationContract = {
  version: 1,
  runId: "run-1",
  workItem: "FAC-1",
  goal: "The token check rejects an expired token.",
  assertions: [
    {
      id: "VAL-API-001",
      requirement: "An expired token is rejected.",
      statement: "A request with an expired token answers 401.",
      method: "http",
      evidence: ["request-response"],
      preconditions: [],
    },
  ],
};

const changedFiles = ["src/auth.ts", "tests/unit/auth.test.ts"];

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: "RV-1",
  severity: "high",
  category: "correctness",
  requirement: "VAL-API-001",
  evidence: "src/auth.ts:84",
  description: "The handler returns 200 for an expired token.",
  ...over,
});

const report = (findings: ReviewFinding[], verdict: "pass" | "fail" = "fail"): ReviewReport => ({
  version: 1,
  verdict,
  findings,
});

describe("decideReview", () => {
  it("passes a report with no finding", () => {
    const decision = decideReview({ report: report([], "pass"), contract, changedFiles });
    expect(decision.passed).toBe(true);
    expect(decision.blocking).toEqual([]);
  });

  it("blocks a valid high finding", () => {
    const decision = decideReview({ report: report([finding()]), contract, changedFiles });
    expect(decision.passed).toBe(false);
    expect(decision.blocking).toHaveLength(1);
    expect(decision.failures[0]).toContain("RV-1");
  });

  it("blocks a valid blocker finding", () => {
    const decision = decideReview({
      report: report([finding({ severity: "blocker" })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(false);
  });

  it("does not block a medium finding", () => {
    const decision = decideReview({
      report: report([finding({ severity: "medium" })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(true);
    expect(decision.nonBlocking).toHaveLength(1);
    expect(decision.nonBlocking[0]?.reason).toContain("severity");
  });

  it("does not block a style finding at any severity", () => {
    const decision = decideReview({
      report: report([finding({ category: "style", severity: "blocker" })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(true);
    expect(decision.nonBlocking[0]?.reason).toContain("style");
  });

  it("does not block a finding whose evidence names an unchanged file", () => {
    const decision = decideReview({
      report: report([finding({ evidence: "src/other.ts:12" })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(true);
    expect(decision.nonBlocking[0]?.reason).toContain("changed");
  });

  it("does not block a finding whose VAL requirement names no frozen assertion", () => {
    const decision = decideReview({
      report: report([finding({ requirement: "VAL-API-999" })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(true);
    expect(decision.nonBlocking[0]?.reason).toContain("frozen Validation Contract");
  });

  it("accepts a repository rule as a requirement", () => {
    const decision = decideReview({
      report: report([finding({ requirement: "The repository forbids a bare catch." })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(false);
  });

  it("blocks even when the agent verdict says pass", () => {
    const decision = decideReview({ report: report([finding()], "pass"), contract, changedFiles });
    expect(decision.passed).toBe(false);
  });

  it("passes when the agent verdict says fail and no finding is valid", () => {
    const decision = decideReview({
      report: report([finding({ severity: "low" })], "fail"),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(true);
  });

  it("resolves an evidence path with a leading dot slash", () => {
    const decision = decideReview({
      report: report([finding({ evidence: "./src/auth.ts:84" })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(false);
  });

  it("resolves an evidence path with no line", () => {
    const decision = decideReview({
      report: report([finding({ evidence: "src/auth.ts" })]),
      contract,
      changedFiles,
    });
    expect(decision.passed).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/review-blocking.test.ts`
Expected: FAIL, because `~/domain/review/blocking.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/domain/review/blocking.ts`:

```ts
import type { ReviewFinding, ReviewReport, ReviewSeverity } from "~/domain/review/review-report.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";

/** SDD section 41. Only these two severities can block. */
const BLOCKING_SEVERITIES = new Set<ReviewSeverity>(["blocker", "high"]);

/**
 * SDD section 41. A style preference does not block, whatever severity the Reviewer gave it.
 * See controller decision 6.
 */
const NON_BLOCKING_CATEGORIES = new Set<string>(["style"]);

/** One finding and the decision Factoree took about it. */
export interface FindingDecision {
  finding: ReviewFinding;
  blocking: boolean;
  /** Plain words for a human. A non-blocking decision states why the finding did not block. */
  reason: string;
}

export interface ReviewDecision {
  decisions: FindingDecision[];
  blocking: FindingDecision[];
  nonBlocking: FindingDecision[];
  /** True when no finding blocks. It is Factoree's decision, never the agent verdict. */
  passed: boolean;
  /** The line Factoree posts to Linear. */
  summary: string;
  /** The blocking findings, formatted for `ImplementActivityInput.repairFindings`. */
  failures: string[];
}

/**
 * Reads the file part of an evidence string. SDD section 41 shows the `path:line` form, and a
 * bare path is also specific enough to name a file. A leading `./` is removed, because a
 * Reviewer can write either form and both name one file.
 */
export const evidenceFileOf = (evidence: string): string => {
  const text = evidence.trim();
  // A trailing `:84` or `:84:12` is a location, not part of the file name.
  const withoutLocation = text.replace(/(:\d+){1,2}$/, "");
  return withoutLocation.replace(/^\.\//, "");
};

const requirementIsResolvable = (requirement: string, contract: ValidationContract): boolean => {
  const text = requirement.trim();
  // Controller decision 4. A Reviewer that invents an assertion identifier names no mandatory
  // requirement. Any other text names a repository rule or a constraint, and Factoree cannot
  // enumerate those deterministically.
  if (!text.startsWith("VAL-")) return true;
  return contract.assertions.some((assertion) => assertion.id === text);
};

const decideFinding = (
  finding: ReviewFinding,
  contract: ValidationContract,
  changed: Set<string>,
): FindingDecision => {
  if (!BLOCKING_SEVERITIES.has(finding.severity)) {
    return {
      finding,
      blocking: false,
      reason:
        `SDD section 41: the severity "${finding.severity}" does not block. Only a blocker or ` +
        "a high finding blocks.",
    };
  }

  if (NON_BLOCKING_CATEGORIES.has(finding.category)) {
    return {
      finding,
      blocking: false,
      reason: "SDD section 41: a style preference does not block.",
    };
  }

  if (!requirementIsResolvable(finding.requirement, contract)) {
    return {
      finding,
      blocking: false,
      reason:
        `SDD section 41: the requirement "${finding.requirement}" names no assertion of the ` +
        "frozen Validation Contract, so the finding names no mandatory requirement.",
    };
  }

  const file = evidenceFileOf(finding.evidence);
  if (!changed.has(file)) {
    return {
      finding,
      blocking: false,
      reason:
        `SDD section 41 and section 43: the evidence "${finding.evidence}" names no file this ` +
        "Run changed, so the finding lies outside the change under review.",
    };
  }

  return {
    finding,
    blocking: true,
    reason:
      `SDD section 41: a ${finding.severity} ${finding.category} finding names a mandatory ` +
      "requirement and specific evidence inside the change.",
  };
};

const failureLine = (decision: FindingDecision): string =>
  `${decision.finding.id} (${decision.finding.severity}, ${decision.finding.category}) at ` +
  `${decision.finding.evidence}: ${decision.finding.description} It breaks: ` +
  `${decision.finding.requirement}`;

/**
 * SDD section 41. Factoree decides which findings block. The agent `verdict` field is carried
 * on the report and decides nothing. See controller decision 2.
 */
export const decideReview = (input: {
  report: ReviewReport;
  contract: ValidationContract;
  changedFiles: string[];
}): ReviewDecision => {
  const changed = new Set(input.changedFiles.map((file) => file.replace(/^\.\//, "")));
  const decisions = input.report.findings.map((finding) =>
    decideFinding(finding, input.contract, changed),
  );
  const blocking = decisions.filter((decision) => decision.blocking);
  const nonBlocking = decisions.filter((decision) => !decision.blocking);
  const passed = blocking.length === 0;

  const counted = `${decisions.length} ${decisions.length === 1 ? "finding" : "findings"}`;
  const summary = passed
    ? `The independent review reported ${counted}, and none of them blocks.`
    : `The independent review reported ${counted}, and ${blocking.length} of them ` +
      `${blocking.length === 1 ? "blocks" : "block"} the Run.`;

  return {
    decisions,
    blocking,
    nonBlocking,
    passed,
    summary,
    failures: blocking.map(failureLine),
  };
};
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/review-blocking.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run the whole-repository gate**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain/review/blocking.ts tests/unit/review-blocking.test.ts
git commit -F - <<'MSG'
feat(review): add the SDD section 41 blocking rules
MSG
```

---

## Task 3: The reviewer prompt and its input builder

**Files:**
- Create: `src/prompts/reviewer.ts`, `src/domain/review/reviewer-input.ts`
- Test: `tests/unit/reviewer-input.test.ts`

**Interfaces:**
- Consumes: `REVIEW_REPORT_SCHEMA_TEXT` from Task 1. `ActionPolicy` from `~/domain/policy/action-policy.js`. `guardAgainstForbiddenMaterial` from `~/domain/runs/implementer-input.js`.
- Produces:
  - `REVIEWER_PROMPT_VERSION = "reviewer@1"`
  - `renderReviewerPrompt(fields: ReviewerPromptFields): string`
  - `interface BuildReviewerInput { goal: string; validationContract: string; contextContract: string | null; constraints: string[]; sourceDiff: string; diffTruncated: boolean; changedFiles: string[]; verificationSummary: string; validationEvidence: string[]; repositoryInstructions: string; reportPath: string; actionPolicy: ActionPolicy; projectTestSecrets: Record<string, string> }`
  - `buildReviewerInput(input: BuildReviewerInput): { prompt: string; promptVersion: string; environment: Record<string, string> }`

**Rule:** No field of `BuildReviewerInput` can carry an Implementer transcript or an Implementer summary. SDD section 40 forbids it, and an absent field is the strongest form of that guarantee. Do not add one.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/reviewer-input.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildReviewerInput } from "~/domain/review/reviewer-input.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";

const base = {
  goal: "Reject an expired token.",
  validationContract: "# Validation Contract\n\nVAL-API-001 answers 401.\n",
  contextContract: "# Context Contract\n\nADR-4 is authoritative.\n",
  constraints: ["Do not change the public route table."],
  sourceDiff: "diff --git a/src/auth.ts b/src/auth.ts\n+const ok = true;\n",
  diffTruncated: false,
  changedFiles: ["src/auth.ts"],
  verificationSummary: "Every configured check passed.",
  validationEvidence: ["VAL-API-001: PASS. The response status was 401."],
  repositoryInstructions: "Use the shared logger.",
  reportPath: "/workspace/review/report.json",
  actionPolicy: buildActionPolicy({ role: "reviewer" }),
  projectTestSecrets: {},
};

describe("buildReviewerInput", () => {
  it("carries every SDD section 40 input", () => {
    const built = buildReviewerInput(base);
    expect(built.prompt).toContain("Reject an expired token.");
    expect(built.prompt).toContain("VAL-API-001 answers 401.");
    expect(built.prompt).toContain("ADR-4 is authoritative.");
    expect(built.prompt).toContain("Do not change the public route table.");
    expect(built.prompt).toContain("diff --git a/src/auth.ts");
    expect(built.prompt).toContain("src/auth.ts");
    expect(built.prompt).toContain("Every configured check passed.");
    expect(built.prompt).toContain("The response status was 401.");
    expect(built.prompt).toContain("Use the shared logger.");
    expect(built.prompt).toContain("/workspace/review/report.json");
  });

  it("states plainly that the session is fresh", () => {
    expect(buildReviewerInput(base).prompt).toContain("fresh context");
  });

  it("states plainly that the diff was truncated", () => {
    const built = buildReviewerInput({ ...base, diffTruncated: true });
    expect(built.prompt).toContain("Factoree truncated");
  });

  it("denies the primary worktree write in the described policy", () => {
    expect(buildReviewerInput(base).prompt).toContain("deny: write the primary worktree");
  });

  it("carries the prompt version", () => {
    expect(buildReviewerInput(base).promptVersion).toBe("reviewer@1");
  });

  it("refuses a forbidden credential in the environment", () => {
    expect(() =>
      buildReviewerInput({
        ...base,
        projectTestSecrets: { GITHUB_TOKEN: "ghp_realtokenvalue00000000000000000000" },
      }),
    ).toThrow();
  });
});
```

Read `src/domain/runs/implementer-input.ts` before Step 3 and confirm the exact name and the throw behaviour of `guardAgainstForbiddenMaterial`. Match the existing test in `tests/unit/` that already exercises it, so the last test above uses a value that guard really refuses.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/reviewer-input.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Write the prompt**

Create `src/prompts/reviewer.ts`:

```ts
/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const REVIEWER_PROMPT_VERSION = "reviewer@1";

export interface ReviewerPromptFields {
  goal: string;
  validationContract: string;
  contextContract: string | null;
  constraints: string[];
  sourceDiff: string;
  diffTruncated: boolean;
  changedFiles: string[];
  verificationSummary: string;
  validationEvidence: string[];
  repositoryInstructions: string;
  reportPath: string;
  actionPolicy: string[];
  reportSchema: string;
}

const section = (title: string, body: string): string => `## ${title}\n\n${body}\n`;

const list = (items: string[], empty: string): string =>
  items.length === 0 ? empty : items.map((item) => `- ${item}`).join("\n");

/**
 * SDD section 40 fixes the Reviewer input list. This function receives the goal, the frozen
 * Validation Contract, the Context Contract, the constraints, the source diff, the changed
 * files, the deterministic verification result, the user-validation evidence, and the
 * repository rules. It receives no Implementer transcript and no Implementer summary, and it
 * renders no such field.
 */
export const renderReviewerPrompt = (fields: ReviewerPromptFields): string =>
  [
    "# Reviewer instructions",
    "",
    "You are the independent Reviewer. You run in a fresh context. You hold no memory of any " +
      "earlier session, and you received no Implementer transcript.",
    "",
    section("Goal", fields.goal),
    section("Validation Contract", fields.validationContract),
    section("Context Contract", fields.contextContract ?? "No Context Contract exists for this Run."),
    section("Constraints", list(fields.constraints, "None recorded.")),
    section("Repository rules", fields.repositoryInstructions),
    section("Changed files", list(fields.changedFiles, "The change touched no file.")),
    section(
      "Source diff",
      fields.diffTruncated
        ? `Factoree truncated this diff. The changed-file list above is complete.\n\n${fields.sourceDiff}`
        : fields.sourceDiff,
    ),
    section("Deterministic verification", fields.verificationSummary),
    section("User validation evidence", list(fields.validationEvidence, "None recorded.")),
    section(
      "Your report",
      `Write your report as one JSON document to ${fields.reportPath}.\n\n${fields.reportSchema}`,
    ),
    section(
      "Action Policy",
      `${list(fields.actionPolicy, "None supplied.")}\n\n` +
        "Factoree enforces these rules outside this prompt. A rule you cannot see still applies.",
    ),
    section(
      "Rules",
      [
        "You must not change any file of the repository.",
        "You must review only the change above, against the baseline above.",
        "You must not report a style preference as a blocker or as a high finding.",
        "You must name a mandatory requirement and one changed file for every blocker and every high finding.",
        "You must report useful work outside this change as a low finding of category scope.",
        "Factoree decides which findings block. Your verdict does not decide it.",
      ].join("\n"),
    ),
  ].join("\n");
```

- [ ] **Step 4: Write the input builder**

Create `src/domain/review/reviewer-input.ts`:

```ts
import type { ActionPolicy } from "~/domain/policy/action-policy.js";
import { guardAgainstForbiddenMaterial } from "~/domain/runs/implementer-input.js";
import { REVIEW_REPORT_SCHEMA_TEXT } from "~/domain/review/review-report.js";
import { REVIEWER_PROMPT_VERSION, renderReviewerPrompt } from "~/prompts/reviewer.js";

/**
 * SDD section 40 and SDD section 43. Exactly the fixed review baseline, plus the change under
 * review. No field can carry an Implementer transcript or an Implementer summary, which is the
 * strongest form of the SDD section 40 rule.
 */
export interface BuildReviewerInput {
  goal: string;
  validationContract: string;
  contextContract: string | null;
  constraints: string[];
  sourceDiff: string;
  diffTruncated: boolean;
  changedFiles: string[];
  verificationSummary: string;
  validationEvidence: string[];
  repositoryInstructions: string;
  reportPath: string;
  actionPolicy: ActionPolicy;
  /** Non-production Project test secrets only. See SDD section 30. */
  projectTestSecrets: Record<string, string>;
}

export interface ReviewerInput {
  prompt: string;
  promptVersion: string;
  environment: Record<string, string>;
}

export const buildReviewerInput = (input: BuildReviewerInput): ReviewerInput => {
  guardAgainstForbiddenMaterial(input.projectTestSecrets);

  return {
    prompt: renderReviewerPrompt({
      goal: input.goal,
      validationContract: input.validationContract,
      contextContract: input.contextContract,
      constraints: input.constraints,
      sourceDiff: input.sourceDiff,
      diffTruncated: input.diffTruncated,
      changedFiles: input.changedFiles,
      verificationSummary: input.verificationSummary,
      validationEvidence: input.validationEvidence,
      repositoryInstructions: input.repositoryInstructions,
      reportPath: input.reportPath,
      actionPolicy: input.actionPolicy.describe(),
      reportSchema: REVIEW_REPORT_SCHEMA_TEXT,
    }),
    promptVersion: REVIEWER_PROMPT_VERSION,
    environment: { ...input.projectTestSecrets },
  };
};
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/reviewer-input.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the whole-repository gate**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/prompts/reviewer.ts src/domain/review/reviewer-input.ts tests/unit/reviewer-input.test.ts
git commit -F - <<'MSG'
feat(review): add the fresh Reviewer prompt and its input builder
MSG
```

---

## Task 4: The source diff and the changed-file list

**Files:**
- Create: `src/domain/review/source-diff.ts`
- Test: `tests/unit/source-diff.test.ts`

**Interfaces:**
- Consumes: `Sandbox`, `SandboxRef` from `~/domain/runs/sandbox.js`. `Redactor` from `~/telemetry/redaction.js`.
- Produces:
  - `MAX_REVIEW_DIFF_BYTES = 200_000`
  - `interface SourceDiff { text: string; truncated: boolean; changedFiles: string[] }`
  - `class SourceDiffError extends Error`
  - `captureSourceDiff(dependencies: { sandbox: Sandbox; redactor: Redactor }, input: { ref: SandboxRef; primaryPath: string; baseSha: string; maxBytes?: number }): Promise<SourceDiff>`

Read `src/domain/runs/sandbox.ts` before Step 3 and match the exact `exec` signature and result shape. `src/domain/runs/checkout.ts` already runs `git` through the sandbox, so copy its call form.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/source-diff.test.ts`. It uses a fake sandbox, so no git process runs:

```ts
import { describe, expect, it } from "vitest";
import { captureSourceDiff, SourceDiffError } from "~/domain/review/source-diff.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";

const ref = { id: "sprite-1", adapter: "local", workspacePath: "/workspace" };

/** Answers each recorded command with a fixed result, and records every call. */
const fakeSandbox = (answers: Array<{ match: string; stdout: string; exitCode?: number }>) => {
  const calls: string[] = [];
  const sandbox = {
    name: "fake",
    async exec(_ref: unknown, command: { file: string; args: string[] }) {
      const line = [command.file, ...command.args].join(" ");
      calls.push(line);
      const answer = answers.find((entry) => line.includes(entry.match));
      return {
        exitCode: answer?.exitCode ?? 0,
        stdout: answer?.stdout ?? "",
        stderr: "",
        timedOut: false,
        durationMs: 1,
      };
    },
  } as unknown as Sandbox;
  return { sandbox, calls };
};

const redactor = new Redactor(["s3cr3t-value-000"]);

describe("captureSourceDiff", () => {
  it("stages everything and diffs against the base SHA", async () => {
    const { sandbox, calls } = fakeSandbox([
      { match: "--name-only", stdout: "src/auth.ts\ntests/unit/auth.test.ts\n" },
      { match: "diff --cached", stdout: "diff --git a/src/auth.ts b/src/auth.ts\n" },
    ]);
    const diff = await captureSourceDiff(
      { sandbox, redactor },
      { ref, primaryPath: "/workspace/primary", baseSha: "a".repeat(40) },
    );
    expect(calls.some((line) => line.includes("add -A"))).toBe(true);
    expect(calls.some((line) => line.includes("a".repeat(40)))).toBe(true);
    expect(diff.changedFiles).toEqual(["src/auth.ts", "tests/unit/auth.test.ts"]);
    expect(diff.text).toContain("diff --git");
    expect(diff.truncated).toBe(false);
  });

  it("redacts a Project secret out of the diff", async () => {
    const { sandbox } = fakeSandbox([
      { match: "--name-only", stdout: "src/auth.ts\n" },
      { match: "diff --cached", stdout: "+const token = \"s3cr3t-value-000\";\n" },
    ]);
    const diff = await captureSourceDiff(
      { sandbox, redactor },
      { ref, primaryPath: "/workspace/primary", baseSha: "a".repeat(40) },
    );
    expect(diff.text).not.toContain("s3cr3t-value-000");
  });

  it("truncates a diff above the ceiling and says so", async () => {
    const { sandbox } = fakeSandbox([
      { match: "--name-only", stdout: "src/auth.ts\n" },
      { match: "diff --cached", stdout: "x".repeat(5_000) },
    ]);
    const diff = await captureSourceDiff(
      { sandbox, redactor },
      { ref, primaryPath: "/workspace/primary", baseSha: "a".repeat(40), maxBytes: 1_000 },
    );
    expect(diff.truncated).toBe(true);
    expect(diff.text.length).toBeLessThan(2_000);
    expect(diff.text).toContain("truncated");
  });

  it("reports an empty change with no file", async () => {
    const { sandbox } = fakeSandbox([
      { match: "--name-only", stdout: "" },
      { match: "diff --cached", stdout: "" },
    ]);
    const diff = await captureSourceDiff(
      { sandbox, redactor },
      { ref, primaryPath: "/workspace/primary", baseSha: "a".repeat(40) },
    );
    expect(diff.changedFiles).toEqual([]);
    expect(diff.text).toContain("no change");
  });

  it("throws when git fails", async () => {
    const { sandbox } = fakeSandbox([{ match: "add -A", stdout: "", exitCode: 128 }]);
    await expect(
      captureSourceDiff(
        { sandbox, redactor },
        { ref, primaryPath: "/workspace/primary", baseSha: "a".repeat(40) },
      ),
    ).rejects.toBeInstanceOf(SourceDiffError);
  });

  it("refuses a base SHA that is not forty hexadecimal characters", async () => {
    const { sandbox } = fakeSandbox([]);
    await expect(
      captureSourceDiff(
        { sandbox, redactor },
        { ref, primaryPath: "/workspace/primary", baseSha: "not-a-sha" },
      ),
    ).rejects.toBeInstanceOf(SourceDiffError);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/source-diff.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/domain/review/source-diff.ts`:

```ts
import type { Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import type { Redactor } from "~/telemetry/redaction.js";

/**
 * The byte ceiling of the diff text the Reviewer prompt carries. A diff above it is truncated,
 * and the prompt states that plainly. The changed-file list is never truncated. See controller
 * decision 13.
 */
export const MAX_REVIEW_DIFF_BYTES = 200_000;

const SHA = /^[0-9a-f]{40}$/;

export interface SourceDiff {
  /** The redacted diff text, truncated when it passed the ceiling. */
  text: string;
  truncated: boolean;
  /** Every path the change touched, relative to the primary worktree. */
  changedFiles: string[];
}

export class SourceDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceDiffError";
  }
}

export interface SourceDiffDependencies {
  sandbox: Sandbox;
  redactor: Redactor;
}

export interface SourceDiffInput {
  ref: SandboxRef;
  primaryPath: string;
  baseSha: string;
  maxBytes?: number;
}

const git = async (
  dependencies: SourceDiffDependencies,
  input: SourceDiffInput,
  args: string[],
): Promise<string> => {
  const result = await dependencies.sandbox.exec(input.ref, {
    file: "git",
    args: ["-C", input.primaryPath, ...args],
  });
  if (result.exitCode !== 0) {
    throw new SourceDiffError(
      `git ${args.join(" ")} failed with exit code ${result.exitCode}: ` +
        dependencies.redactor.redactText(result.stderr.trim()),
    );
  }
  return result.stdout;
};

/**
 * SDD section 44 fixes this command pair for the verified patch. Phase 8 reads it for the
 * Reviewer, and Phase 9 hashes the same output, so the change under review and the change under
 * publication can never differ. See controller decision 12.
 *
 * `--binary` is deliberately absent. A binary file appears in the changed-file list by name, and
 * binary bytes help no Reviewer. See controller decision 14.
 */
export const captureSourceDiff = async (
  dependencies: SourceDiffDependencies,
  input: SourceDiffInput,
): Promise<SourceDiff> => {
  if (!SHA.test(input.baseSha)) {
    throw new SourceDiffError(
      `the base SHA is not forty hexadecimal characters: "${input.baseSha}"`,
    );
  }

  // Staging changes no source file. It records what the worktree already holds, so the diff
  // covers a new file as well as a changed file.
  await git(dependencies, input, ["add", "-A"]);

  const names = await git(dependencies, input, [
    "diff",
    "--cached",
    "--name-only",
    input.baseSha,
  ]);
  const changedFiles = names
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const raw = await git(dependencies, input, ["diff", "--cached", input.baseSha]);
  const redacted = dependencies.redactor.redactText(raw);

  if (changedFiles.length === 0 && redacted.trim() === "") {
    return {
      text: "The primary worktree holds no change against the base SHA.",
      truncated: false,
      changedFiles: [],
    };
  }

  const ceiling = input.maxBytes ?? MAX_REVIEW_DIFF_BYTES;
  if (redacted.length <= ceiling) {
    return { text: redacted, truncated: false, changedFiles };
  }

  return {
    text:
      `${redacted.slice(0, ceiling)}\n\n` +
      `[Factoree truncated this diff at ${ceiling} characters. The changed-file list is complete.]`,
    truncated: true,
    changedFiles,
  };
};
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/source-diff.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the whole-repository gate**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain/review/source-diff.ts tests/unit/source-diff.test.ts
git commit -F - <<'MSG'
feat(review): capture the source diff and the changed-file list
MSG
```

---

## Task 5: The ReviewFinding entity and its store

**Files:**
- Create: `src/domain/review/review-finding-store.ts`, `src/persistence/prisma/review-finding.prisma.ts`, `prisma/migrations/20260827120000_add_review_findings/migration.sql`
- Modify: `prisma/schema.prisma`
- Test: `tests/integration/review-findings.test.ts`

**Interfaces:**
- Consumes: `ReviewSeverity`, `ReviewCategory` from Task 1.
- Produces:
  - `interface RecordReviewFindingInput { tenantId: string; runId: string; attempt: number; verdict: "pass" | "fail"; findingKey: string; severity: ReviewSeverity; category: ReviewCategory; requirement: string; evidence: string; description: string; blocking: boolean; decisionReason: string }`
  - `interface ReviewFindingRecord extends RecordReviewFindingInput { id: string; createdAt: Date }`
  - `interface ReviewFindingStore { record(input): Promise<ReviewFindingRecord>; listForRun(tenantId, runId): Promise<ReviewFindingRecord[]> }`
  - `class PrismaReviewFindingStore implements ReviewFindingStore`

**Rule:** Read `src/persistence/prisma/validation-result.prisma.ts` first and copy its idempotency shape exactly. It is the pattern of this repository. The STATUS file records that its create-then-read fallback catches any create error, not only a unique-constraint violation. Keep the same behaviour here, so a later sweep can repair both together.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/review-findings.test.ts`. Copy the database setup, the tenant creation, and the Run creation from `tests/integration/validation-results.test.ts`. The test body:

```ts
  it("writes one immutable row per finding per attempt", async () => {
    const store = new PrismaReviewFindingStore(prisma);
    const input = {
      tenantId,
      runId,
      attempt: 1,
      verdict: "fail" as const,
      findingKey: "RV-1",
      severity: "high" as const,
      category: "correctness" as const,
      requirement: "VAL-API-001",
      evidence: "src/auth.ts:84",
      description: "The handler returns 200 for an expired token.",
      blocking: true,
      decisionReason: "SDD section 41: a high correctness finding names a mandatory requirement.",
    };
    const first = await store.record(input);
    const second = await store.record(input);
    expect(second.id).toBe(first.id);

    const rows = await store.listForRun(tenantId, runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blocking).toBe(true);
  });

  it("writes a second row for a later attempt", async () => {
    const store = new PrismaReviewFindingStore(prisma);
    const base = { /* the same fields as above */ };
    await store.record({ ...base, attempt: 1 });
    await store.record({ ...base, attempt: 2 });
    expect(await store.listForRun(tenantId, runId)).toHaveLength(2);
  });

  it("does not read a row of another tenant", async () => {
    // Create a second tenant and a second Run, write a finding there, and confirm that
    // listForRun of the first tenant returns nothing from it.
  });
```

Fill in every body. Do not leave a comment where a test belongs.

- [ ] **Step 2: Add the Prisma model**

In `prisma/schema.prisma`, add the relation field `reviewFindings ReviewFinding[]` to `model Run`, and add:

```prisma
model ReviewFinding {
  id             String   @id @default(uuid())
  tenantId       String
  runId          String
  run            Run      @relation(fields: [runId], references: [id], onDelete: Cascade)
  // The review pass this finding belongs to. The first pass is 1. SDD section 42.
  attempt        Int
  // The agent claim of SDD section 41. It is recorded and it decides nothing.
  verdict        String
  // The identifier the Reviewer gave the finding, for example RV-1.
  findingKey     String
  // blocker, high, medium, or low. SDD section 41.
  severity       String
  category       String
  requirement    String
  evidence       String
  description    String
  // Factoree's own decision. SDD section 41 and controller decision 2.
  blocking       Boolean
  decisionReason String
  createdAt      DateTime @default(now())

  @@unique([runId, attempt, findingKey])
  @@index([tenantId, runId])
}
```

- [ ] **Step 3: Write the migration by hand**

Create `prisma/migrations/20260827120000_add_review_findings/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "ReviewFinding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "verdict" TEXT NOT NULL,
    "findingKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "requirement" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL,
    "decisionReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewFinding_runId_attempt_findingKey_key" ON "ReviewFinding"("runId", "attempt", "findingKey");

-- CreateIndex
CREATE INDEX "ReviewFinding_tenantId_runId_idx" ON "ReviewFinding"("tenantId", "runId");

-- AddForeignKey
ALTER TABLE "ReviewFinding" ADD CONSTRAINT "ReviewFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

**Warning: confirm the index names against Prisma before you accept this file.** Postgres truncates an identifier at 63 bytes, and the Phase 7 task 6 report records exactly this defect. Run `prisma migrate diff` against a real shadow database, the way the Phase 7 task 6 report describes, and confirm the output says "No difference detected". Repair the SQL if it does not.

- [ ] **Step 4: Write the port and the Prisma store**

Create `src/domain/review/review-finding-store.ts` with the interfaces named above and this comment on `record`:

```ts
/**
 * SDD section 53. A finding row is immutable once written. `record` is idempotent on
 * `(runId, attempt, findingKey)`, so a Temporal activity retry writes nothing new.
 */
```

Create `src/persistence/prisma/review-finding.prisma.ts` and mirror `validation-result.prisma.ts` exactly: `create` inside a `try`, and on any error read the existing row by the unique key and return it. Every read filters on `tenantId`.

- [ ] **Step 5: Run the integration test**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/review-findings.test.ts`
Expected: PASS. Docker must run.

- [ ] **Step 6: Run the whole integration suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts`
Expected: exit 0. The STATUS file requires the whole suite, not one file.

- [ ] **Step 7: Run the whole-repository gate**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add prisma src/domain/review/review-finding-store.ts src/persistence/prisma/review-finding.prisma.ts tests/integration/review-findings.test.ts
git commit -F - <<'MSG'
feat(review): add the ReviewFinding entity, its store, and its migration
MSG
```

---

## Task 6: The review activity

**Files:**
- Create: `src/activities/review.activities.ts`
- Modify: `src/telemetry/metrics.ts`, `src/activities/index.ts`, `src/bin/worker.ts`
- Test: `tests/unit/review-activity.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 5.
- Produces:
  - `interface ReviewActivityInput { runId: string; tenantId: string; projectId: string; runnerName: string; spriteId: string; adapter: string; workspacePath: string; primaryPath: string; baseSha: string; goal: string; contextContract: string | null; constraints: string[]; verificationSummary: string; validationEvidence: string[]; repositoryInstructions: string; timeoutMs: number; attempt: number }`
  - `interface ReviewActivityOutput { passed: boolean; verdict: "pass" | "fail"; findingCount: number; blockingCount: number; summary: string; failures: string[]; sessionId: string; reportUsable: boolean; reportProblem: string | null }`
  - `createReviewActivities(dependencies: ReviewActivityDependencies)` exporting one activity named `review`.

**Rule:** `ReviewActivityInput` carries no Implementer transcript and no Implementer summary. Do not add one. AT-21 asserts this against the real type.

**Rule:** Copy the session heartbeat, the cancellation lookup, the cancel timeout, and the `RunConfigurationError` mapping from the `userValidate` activity in `src/activities/validation.activities.ts`. Do not invent a second shape. Read that file first.

- [ ] **Step 1: Add the metric**

In `src/telemetry/metrics.ts`, beside `validationDuration`:

```ts
  reviewDuration: new Histogram({
    name: "factoree_review_duration_seconds",
    help: "Independent review duration in seconds",
    labelNames,
    buckets: [0.1, 1, 5, 30, 120, 600],
    registers: [registry],
  }),
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/review-activity.test.ts`. Build the activity with fake dependencies: a fake sandbox that answers the git commands and the report read, a fake runner registry, an in-memory execution repository, an in-memory finding store, a fake contract store, and a `Redactor`. Copy the double shapes from an existing unit test that exercises `userValidate`, if one exists; otherwise build them from the interfaces.

The tests:

```ts
  it("passes when the report holds no finding", async () => { /* ... */ });

  it("blocks when the report holds a valid high finding", async () => { /* ... */ });

  it("does not block a style finding, and still records it", async () => {
    // Expect passed === true and one persisted row with blocking === false.
  });

  it("records one AgentExecution row of role reviewer per attempt", async () => { /* ... */ });

  it("starts a session whose prompt holds no Implementer summary", async () => {
    // Assert on the captured prompt text.
  });

  it("reports reportUsable false when the report file is absent", async () => { /* ... */ });

  it("reports reportUsable false when the report is not valid JSON", async () => { /* ... */ });

  it("raises a RunConfigurationError for an unregistered reviewer runner", async () => { /* ... */ });

  it("persists every finding, blocking and non-blocking", async () => { /* ... */ });
```

Fill in every body.

- [ ] **Step 3: Run the test and confirm it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/review-activity.test.ts`
Expected: FAIL, because the activity does not exist.

- [ ] **Step 4: Write the activity**

Create `src/activities/review.activities.ts`. The body, in order:

1. Register the Project secrets with the redactor, exactly as `userValidate` does. Do this first, because the diff is captured next.
2. Read the frozen Validation Contract through `contracts.findByRun`. Throw when it is absent, because review cannot start before the contract freezes.
3. Build the Action Policy with `buildActionPolicy({ role: "reviewer" })`.
4. Build `ref` and the review directory `${input.workspacePath}/review`, and create it with `mkdir -p` through the sandbox.
5. Capture the diff with `captureSourceDiff`. A `SourceDiffError` is a real fault, so let it propagate.
6. Collect the Project test secrets marked for injection, exactly as `userValidate` does.
7. Build the prompt with `buildReviewerInput`, with `reportPath = ${reviewDirectory}/report.json`.
8. Resolve the runner. Map `UnknownAgentRunnerError` to `RunConfigurationError` with a message that names the configured runner, the registered runners, and `reviewer_runner` in `.factoree/config.yaml`.
9. Run the session with `role: "reviewer"` and `workingDirectory: reviewDirectory`, under the same heartbeat and the same cancellation watcher `userValidate` uses.
10. Record the `AgentExecution` row with `idempotencyKey: \`run:${input.runId}:reviewer:${input.attempt}\``.
11. Read the report with `sandbox.exec({ file: "cat", args: [reportPath] })`. An exit code other than zero gives no text.
12. When there is no text, or `parseReviewReport` throws, return `reportUsable: false` with `passed: false`, `reportProblem` set to the parse message or to the fixed sentence `The Reviewer wrote no report.`, `verdict: "fail"`, `findingCount: 0`, `blockingCount: 0`, and an empty `failures`. Persist nothing. Controller decision 7 owns this path.
13. Otherwise call `decideReview` with the parsed report, the frozen contract, and `diff.changedFiles`.
14. Persist every decision through the finding store, blocking and non-blocking, with the verdict, the attempt, and the decision reason. Controller decision 17 owns this.
15. Log at info level with `step: "review"`, the verdict, the finding count, and the blocking count.
16. Return the output. `passed` comes from `decideReview`, never from the agent verdict.
17. Wrap the whole body in `try { ... } finally { metrics.reviewDuration.observe(labels, (Date.now() - started) / 1000); }`.

The frozen contract passed to `decideReview` must be rebuilt the way `userValidate` rebuilds it, so the numeric `version` column of the stored row does not reach the literal `1` field:

```ts
      const frozenContract: ValidationContract = {
        version: 1,
        runId: storedContract.runId,
        workItem: storedContract.workItem,
        goal: storedContract.goal,
        assertions: storedContract.assertions,
      };
```

- [ ] **Step 5: Wire the activity**

In `src/activities/index.ts`, add `reviewFindings: ReviewFindingStore` to `ActivityDependencies` and spread `createReviewActivities({...})` into `createActivities`. Give it the sandbox, the runners, the executions, the secrets, the redactor, the contracts, the finding store, and the logger.

In `src/bin/worker.ts`, construct `new PrismaReviewFindingStore(prisma)` and pass it.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/review-activity.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 7: Run the whole unit suite and the whole-repository gate**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: all exit 0. The skip count must stay 7.

- [ ] **Step 8: Commit**

```bash
git add src/activities src/telemetry/metrics.ts src/bin/worker.ts tests/unit/review-activity.test.ts
git commit -F - <<'MSG'
feat(review): add the review activity and its metric
MSG
```

---

## Task 7: The REVIEWING stage and the review repair branch

**Files:**
- Modify: `src/workflows/agent-run.workflow.ts`, `src/domain/runs/run-status.ts`, `src/activities/run.activities.ts`, `src/activities/refinement.activities.ts`, `tests/workflow/support/harness.ts`, `tests/workflow/at-35-worker-restart.test.ts`
- Create: `tests/workflow/review.workflow.test.ts`

**Interfaces:**
- Consumes: `ReviewActivityOutput` from Task 6.
- Produces: the `REVIEWING` status transition, the `FAILED_REVIEW` terminal state, and the failure reasons `REVIEW_BLOCKING_FINDINGS` and `REVIEW_UNAVAILABLE`.

- [ ] **Step 0: Carry the Work Item constraints through Refinement**

SDD section 40 gives the Reviewer the constraints of the Work Item. `RefineActivityOutput` does
not carry them today, and the parsed Work Item already holds them. In
`src/activities/refinement.activities.ts` add `constraints: string[]` to `RefineActivityOutput`,
with the comment `/** SDD section 7 and section 40. The constraints the Work Item stated. */`,
and return `constraints: output.workItem.constraints`. Update the refinement double in
`tests/workflow/support/harness.ts` and any unit test that asserts the exact output shape. Add
one unit assertion in the existing refinement test that a Work Item constraint reaches the
output. The variable `refined` already holds this value in the workflow scope the review needs.

- [ ] **Step 1: Add the failure reasons**

In `src/domain/runs/run-status.ts`, add to `RUN_FAILURE_REASONS`:

```ts
  // SDD section 41 and section 42. The review reported at least one blocking finding, and the
  // repair budget of SDD section 42 is spent.
  "REVIEW_BLOCKING_FINDINGS",
  // SDD section 40. Factoree could not obtain a usable review, so it proved nothing about the
  // change. A repair cannot help. See controller decision 7.
  "REVIEW_UNAVAILABLE",
```

Update `tests/unit/run-status.test.ts` if it asserts the exact list.

- [ ] **Step 2: Write the failing workflow test**

Create `tests/workflow/review.workflow.test.ts`. Model it on `tests/workflow/user-validation.workflow.test.ts`. The tests:

```ts
  it("enters REVIEWING after user validation passes", async () => {
    // Assert the recorded status order holds VERIFYING, USER_VALIDATING, REVIEWING.
  });

  it("repairs once when the review blocks, then passes", async () => {
    // The review double blocks on attempt 1 and passes on attempt 2.
    // Assert repairCount 1, and assert the second implement call carries the review failure text
    // in repairFindings.
  });

  it("re-runs verification and user validation before the second review", async () => {
    // Assert the recorded call order for attempt 2: implement, verify, userValidate, review.
  });

  it("ends in FAILED_REVIEW when the budget is spent", async () => {
    // maxAttempts 2, the review double blocks every time.
    // Assert the completion call holds status FAILED_REVIEW and reason REVIEW_BLOCKING_FINDINGS.
  });

  it("ends in FAILED with REVIEW_UNAVAILABLE when the report is unusable", async () => {
    // The review double returns reportUsable false. Assert no repair started.
  });

  it("ends in FAILED_CONFIGURATION for an unregistered reviewer runner", async () => { /* ... */ });

  it("cancels the Run when a stop arrives during the review", async () => { /* ... */ });
```

Fill in every body from the harness pattern.

- [ ] **Step 3: Extend the harness**

In `tests/workflow/support/harness.ts` add:

- `reviewCalls: ReviewActivityInput[]`
- `reviewOutcomes: Map<string, (attempt: number) => Partial<ReviewActivityOutput>>`
- `heldReviews: Map<string, Promise<void>>`
- `reviewerConfigurationFaults: Set<string>`
- a `review` double that records the call, honours a held promise, raises `RunConfigurationError` for a run id in the fault set, and returns a passing output by default.

Record the review calls in the same ordered list the test of the call order needs. If the harness has no such list, add `callOrder: string[]` and push `"implement"`, `"verify"`, `"userValidate"`, and `"review"` from the four doubles.

- [ ] **Step 4: Update the hand-built activity map**

`tests/workflow/at-35-worker-restart.test.ts` builds its own activity map and is not typed as `Activities`, so the typecheck cannot catch a missing entry. Add a `review` entry to it by hand. The STATUS file records this trap.

- [ ] **Step 5: Add the workflow stage**

In `src/workflows/agent-run.workflow.ts`:

Add the activity proxy beside `buildUserValidateActivities`, with the same options and the same comment shape:

```ts
/**
 * The Reviewer activity runs a fresh agent session against the source diff, the same way the
 * User Validator runs one against the preview. SDD section 42 puts it inside the same bounded
 * loop, so it takes the same long-activity options.
 */
const buildReviewActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${budgetMs + IMPLEMENT_MARGIN_MS} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs + IMPLEMENT_MARGIN_MS} milliseconds`,
    heartbeatTimeout: `${IMPLEMENT_HEARTBEAT_TIMEOUT_MS} milliseconds`,
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
  });
```

Add `runReview` beside `runUserValidate`. It MUST call `runAgentActivity`, because the STATUS file forbids a third long-activity stage that bypasses the shared helper:

```ts
  /**
   * One Reviewer pass. SDD section 40 and section 42. Every pass starts a new session, so no
   * session reference passes between attempts. See controller decision 11.
   */
  const runReview = async (attemptInput: {
    prepared: PrepareSandboxActivityOutput;
    goal: string;
    attempt: number;
    contextContract: string | null;
    constraints: string[];
    verificationSummary: string;
    validationEvidence: string[];
  }): Promise<ReviewActivityOutput | null> => {
    const budgetMs = remainingMs();
    const reviewActivities = buildReviewActivities(budgetMs);
    return await runAgentActivity(() =>
      reviewActivities.review({
        runId: id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        runnerName: attemptInput.prepared.runtime.reviewerRunner,
        spriteId: attemptInput.prepared.spriteId,
        adapter: attemptInput.prepared.adapter,
        workspacePath: attemptInput.prepared.workspacePath,
        primaryPath: attemptInput.prepared.primaryPath,
        baseSha: attemptInput.prepared.baseSha,
        goal: attemptInput.goal,
        contextContract: attemptInput.contextContract,
        constraints: attemptInput.constraints,
        verificationSummary: attemptInput.verificationSummary,
        validationEvidence: attemptInput.validationEvidence,
        repositoryInstructions: attemptInput.prepared.repositoryInstructions,
        timeoutMs: budgetMs,
        attempt: attemptInput.attempt,
      }),
    );
  };
```

Add the two failure reasons to the `failRun` union, and set the status correctly. `failRun` currently maps every reason except `CONFIGURATION_INVALID` to `FAILED`. Change the mapping so it reads:

```ts
    status =
      failureReason === "CONFIGURATION_INVALID"
        ? "FAILED_CONFIGURATION"
        : failureReason === "REVIEW_BLOCKING_FINDINGS"
          ? "FAILED_REVIEW"
          : "FAILED";
```

Replace the `if (userValidation.passed) break;` line so the loop continues into the review instead of leaving. The new block, placed after the user validation branch and before the loop closes:

```ts
        // SDD section 40 and section 49. User validation passed, so a fresh Reviewer session
        // examines the change against the fixed review baseline of SDD section 43.
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "REVIEWING";
        await activities.setRunStatus({ runId: id, status });

        let review: ReviewActivityOutput;
        try {
          const result = await runReview({
            prepared: preparedSandbox,
            goal: sandbox.goal,
            attempt,
            contextContract: resolvedContext.document,
            constraints: refined.constraints,
            verificationSummary: verification.summary,
            validationEvidence: userValidation.results.map(
              (entry) => `${entry.assertionId}: ${entry.result}. ${entry.reason}`,
            ),
          });
          if (stopRequested) return await cancelRun();
          if (result === null) {
            if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
            throw new Error("the review activity returned no result");
          }
          review = result;
        } catch (error) {
          if (isCancellation(error)) throw error;
          // A reviewer runner the Project names but no worker registers is a configuration
          // fault, exactly as the validator runner is.
          if (isConfigurationFault(error)) {
            return await failRun(
              "CONFIGURATION_INVALID",
              "Factoree could not start the Reviewer, because the Run configuration is " +
                "invalid. Repair `reviewer_runner` in `.factoree/config.yaml`.",
            );
          }
          if (remainingMs() > 0) throw error;
          return await failRun("RUN_TIMEOUT", timeoutMessage);
        }

        await notify(() =>
          activities.postProgress({ sessionId: input.agentSessionId, message: review.summary }),
        );

        if (stopRequested) return await cancelRun();

        // Controller decision 7. A report Factoree cannot read proves nothing, and a repair
        // cannot fix it. SDD section 68 forbids completion without a review, so the Run ends.
        if (!review.reportUsable) {
          return await failRun(
            "REVIEW_UNAVAILABLE",
            "Factoree could not obtain a usable independent review, so it proved nothing about " +
              `this change. ${review.reportProblem ?? ""} Factoree published nothing.`.trim(),
          );
        }

        if (review.passed) break;

        // SDD section 42. A blocking finding enters the same bounded repair loop.
        if (repairCount >= maxRepairs) {
          return await failRun(
            "REVIEW_BLOCKING_FINDINGS",
            "The independent review rejected this change, and the repair budget is spent. " +
              `${review.summary} Factoree published nothing.`,
          );
        }
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        repairCount += 1;
        attempt += 1;
        repairFindings = review.failures;
        status = "REPAIRING";
        await activities.setRunStatus({ runId: id, status, repairCount });
        continue;
```

Note that `verification` and `userValidation` are already in scope at that point in the loop. Confirm this while you edit, and do not widen a scope to make it true.

- [ ] **Step 5b: Name the repair reason on the metric**

`src/activities/run.activities.ts` increments `metrics.repairs` with the fixed label
`reason: "VERIFICATION"` for every `REPAIRING` status. Three stages now cause a repair, so the
label lies for two of them. Add an optional `repairReason?: "VERIFICATION" | "VALIDATION" | "REVIEW"`
field to the `setRunStatus` input, default it to `"VERIFICATION"`, and pass the right value from
each of the three repair branches in the workflow. Update the harness `StatusCall` type and the
existing unit test of `setRunStatus`.

- [ ] **Step 6: Keep the residual wait honest**

The comment above the residual `condition` still says user validation passed. Change it to say that the review passed as well, and keep the rest unchanged. SDD section 68 still forbids `READY_FOR_HUMAN` without a PR and a Proof Pack, so Phase 8 still invents no success terminal state.

- [ ] **Step 7: Run the workflow suite twice**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.workflow.config.ts`
Expected: exit 0. Run it a second time. The STATUS file requires two runs for a task that adds an activity, and it forbids you to accept "a known flake" from anyone.

- [ ] **Step 8: Run the whole-repository gate**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run`
Expected: all exit 0. The skip count must stay 7.

- [ ] **Step 9: Commit**

```bash
git add src tests
git commit -F - <<'MSG'
feat(review): add the REVIEWING stage and the bounded review repair branch
MSG
```

---

## Task 8: The acceptance tests AT-20 to AT-24

**Files:**
- Create: `tests/acceptance/at-20-validation-repair.test.ts`, `tests/acceptance/at-21-fresh-review.test.ts`, `tests/workflow/at-22-blocking-finding.test.ts`, `tests/workflow/at-23-scope-control.test.ts`, `tests/workflow/at-24-repair-limit.test.ts`

**Rule:** The acceptance tests run under `vitest.integration.config.ts`, not under a config of their own. The workflow tests run under `vitest.workflow.config.ts`.

**Rule:** Prove each claim three ways where a claim can be faked, the way the Phase 7 tests do. A test that only reads a double's own return value proves nothing.

- [ ] **Step 1: Write AT-21, the fresh review**

`tests/acceptance/at-21-fresh-review.test.ts`. Model it on `tests/acceptance/at-17-fresh-user-validation.test.ts`. Prove three things:

1. The reviewer session identifier differs from every Implementer session identifier of the same Run.
2. The `AgentExecution` rows of the Run hold a row of role `implementer` and a row of role `reviewer`, with two distinct session references.
3. The real reviewer prompt holds neither the Implementer summary text nor the Implementer success sentence. Assert against the captured prompt string, not against the type.

- [ ] **Step 2: Write AT-20, the validation repair**

`tests/acceptance/at-20-validation-repair.test.ts`. Build a fixture whose implementation builds and whose behaviour is wrong. Prove:

1. Deterministic verification passes on the first attempt.
2. User validation reports at least one `FAIL`.
3. The Run enters `REPAIRING` and the repair count reaches 1.
4. The second attempt runs deterministic verification again and user validation again, in that order, before the review.
5. The second user validation reports every assertion `PASS`, and the persisted `ValidationAssertionResult` rows hold two attempts.

Point 5 is the "fully reverified" half of AT-20. Read the rows from the database. Do not read them from a return value alone.

- [ ] **Step 3: Write AT-22, the blocking finding**

`tests/workflow/at-22-blocking-finding.test.ts`. Drive the real `decideReview` through the real activity, with a Reviewer double that writes this report:

```json
{ "version": 1, "verdict": "fail", "findings": [ { "id": "RV-1", "severity": "high", "category": "correctness", "requirement": "VAL-API-001", "evidence": "src/auth.ts:84", "description": "The handler returns 200 for an expired token." } ] }
```

Assert: the Run enters `REPAIRING`; the repair count is 1; the next implement call carries `RV-1` in `repairFindings`; the persisted finding row holds `blocking = true`.

- [ ] **Step 4: Write AT-23, the scope control**

`tests/workflow/at-23-scope-control.test.ts`. The same shape, with `"severity": "medium"` and `"category": "style"`. Assert: the Run does not enter `REPAIRING` after the review; the repair count stays 0; the persisted finding row exists and holds `blocking = false`, with a reason that names SDD section 41.

Add a second case in the same file with `"severity": "blocker"` and `"category": "style"`, and assert the same outcome. Controller decision 6 owns it, and a plain medium case alone would not prove it.

- [ ] **Step 5: Write AT-24, the repair limit**

`tests/workflow/at-24-repair-limit.test.ts`. Set `repairMaxAttempts: 2` through the harness runtime override. Make the review block on every attempt. Assert:

1. Exactly three implement calls happen: the first attempt and two repairs.
2. Exactly three review calls happen.
3. The recorded status calls hold exactly two `REPAIRING` entries.
4. The completion call holds status `FAILED_REVIEW` and reason `REVIEW_BLOCKING_FINDINGS`.

Add a second case that mixes the stages: verification fails once, then the review blocks twice. Assert that the third repair does not start, because SDD section 42 bounds repairs per Run and not per stage. Controller decision 9 owns it.

- [ ] **Step 6: Run the suites**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.workflow.config.ts` twice, then `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts`.
Expected: all exit 0.

- [ ] **Step 7: Run the whole-repository gate**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add tests
git commit -F - <<'MSG'
test(review): add AT-20, AT-21, AT-22, AT-23, and AT-24
MSG
```

---

## Task 9: The Phase 8 exit test

**Files:**
- Create: `tests/acceptance/phase-08-exit.test.ts`

**Exit condition (SDD section 69):** a known defect is found, repaired, revalidated, and re-reviewed.

**Rule:** Model this test on `tests/acceptance/phase-07-exit.test.ts`. It must run the real parser, the real blocking rules, the real diff capture against a real fixture repository, the real activity, and the real persistence. It must not assert on a double's own return value.

- [ ] **Step 1: Build the fixture**

Create a fixture repository under `tests/fixtures/` that holds one known defect, and a second revision that repairs it. Use a real `git init` and a real commit, so the base SHA is real and `git diff --cached <base_sha>` produces a real diff. Read the Phase 7 fixture helper in `tests/acceptance/support/` first and reuse it where it fits.

- [ ] **Step 2: Write the positive half**

Prove the whole chain with evidence read from the database and from the artefacts:

1. The Reviewer prompt carries the real diff of the known defect, and the changed-file list names the defective file.
2. The parsed report names the defect, and `decideReview` marks the finding blocking, with the real changed-file list.
3. The Run enters `REPAIRING`, and the repair count reaches 1.
4. The repair applies the second revision, and deterministic verification runs again.
5. User validation runs again and reports every assertion `PASS`. The `ValidationAssertionResult` rows hold two attempts.
6. The second review runs in a session whose identifier differs from the first review session, and it reports no blocking finding.
7. The persisted `ReviewFinding` rows hold the attempt 1 blocking finding, and hold no blocking finding for attempt 2.

- [ ] **Step 3: Write the negative half**

Prove the gate cannot be fooled. Two cases:

1. A Reviewer that reports `"verdict": "pass"` while it also reports a valid high finding still blocks. This proves controller decision 2 against the real activity.
2. A Reviewer that writes no report at all ends the Run with `REVIEW_UNAVAILABLE`, and no repair starts.

- [ ] **Step 4: Run the acceptance suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts`
Expected: exit 0.

- [ ] **Step 5: Run the full verification**

Run `npm run verify` in stages in the background, and poll the output file. The STATUS file records that a foreground call is too short and that a killed background run reports nothing. Read the real output before you believe a result. Write the output to `docs/build/evidence/phase-08-verify.txt`, with the last line `exit=<code>`.

Expected: exit 0. Lint 0, typecheck 0, unit passed with 7 skipped, integration and acceptance passed, workflow passed, build 0.

- [ ] **Step 6: Commit**

```bash
git add tests docs/build/evidence/phase-08-verify.txt
git commit -F - <<'MSG'
test(review): prove the Phase 8 exit condition
MSG
```

---

## Self-review notes

Checked against the SDD before this plan was accepted.

- Section 40 input list: every item maps to a field of `BuildReviewerInput`. The Context Contract, the constraints, the changed files, the deterministic verification result, and the user-validation evidence all appear. Task 3 asserts each one against the rendered prompt.
- Section 41: the schema, the four severities, the blocking rule, and the style rule all live in Tasks 1 and 2, with a test each.
- Section 42: the repair limit is the existing `repairMaxAttempts`, and the review uses the same counter. AT-24 proves the mixed-stage case.
- Section 43: the baseline is the prompt input list, and the evidence rule of Task 2 stops a Reviewer from blocking outside the change.
- Section 48: no state name is added. `REVIEWING` and `FAILED_REVIEW` already exist.
- Section 53: `ReviewFinding` is the one required entity Phase 8 owes, and Task 5 builds it.
- Section 62: `factoree_review_duration_seconds` is added in Task 6.
- Section 63: `src/activities/review.activities.ts` and `src/domain/review/` are created.
- Type consistency: `ReviewActivityOutput.failures` feeds `ImplementActivityInput.repairFindings`, which is `string[]` in both. `decideReview` produces it. `evidenceFileOf` is the one place that parses an evidence string.
