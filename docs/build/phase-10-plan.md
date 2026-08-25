# Phase 10 — Proof Pack implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the human-facing Proof Pack of SDD section 47, and close the SDD section 68 completion invariant, so a successful L3 Run ends `READY_FOR_HUMAN`.

**Architecture:** A pure renderer in `src/domain/evidence/proof-pack.ts` turns one input record into the exact Markdown of SDD section 47. A pure checker in `src/domain/runs/completion-invariant.ts` states every clause of SDD section 68. One new activity, `publishProofPack`, reads the persisted Run state (Context Contract, Validation Contract, assertion results, evidence rows, review findings, Run row), renders the Proof Pack, redacts it, posts it as the Linear final response, and records its hash on the Run row. The workflow calls the checker, then the activity, then completes the Run `READY_FOR_HUMAN`.

**Tech Stack:** TypeScript with ESM, Node 24, Temporal, Prisma with PostgreSQL, Vitest, Zod.

**Spec:** `docs/sdd.md` version 2.0, SHA-256 `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`. Read SDD sections 39, 41, 47, 48, 51, 60, 64 (AT-30 and AT-32), 67, and 68. The SDD is immutable and authoritative.

**Prior state:** `docs/build/STATUS.md`. Read the "Read this before Phase 10" block before Task 6.

## Global Constraints

- The SDD is immutable. Do not edit `docs/sdd.md`.
- Prose in code comments, commit messages, and Markdown follows ASD-STE100. Active voice. No contractions. No `-ing` forms outside a technical name. No `should`, `may`, `might`, `would`, `could`. 20 words maximum in a procedural sentence, 25 in a descriptive sentence.
- Node 24 is at `/opt/homebrew/opt/node@24/bin`. Prefix `PATH` with it in every shell.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`. Never write a file through a `cat` heredoc. Use `git commit -F <file>`.
- Run `npm run lint` and `npm run typecheck` over the whole repository at every task gate.
- Unit tests run with `npx vitest run <path>`. Integration and acceptance tests run with `npx vitest run --config vitest.integration.config.ts <path>`. Workflow tests run with `npx vitest run --config vitest.workflow.config.ts <path>`.
- Docker must run for the integration, acceptance, and workflow suites.
- SDD section 47: the Proof Pack must not dump full raw logs into Linear.
- SDD section 60: no secret reaches Linear. Every text the Proof Pack posts passes the `Redactor` first.
- SDD section 68: `READY_FOR_HUMAN` is reachable only when every clause of the invariant holds.
- The import alias is `~/` for `src/`. The workflow file itself must use relative paths for value imports, because the workflow bundler resolves no alias.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/domain/evidence/proof-pack.ts` (create) | The Proof Pack input types and the pure renderer. It holds no IO and no log text. |
| `src/domain/runs/completion-invariant.ts` (create) | The SDD section 68 clauses as one pure function. |
| `src/domain/runs/run-status.ts` (modify) | Adds the `COMPLETION_INVARIANT_UNMET` failure reason. |
| `prisma/schema.prisma` (modify) | Adds `Run.proofPackSha256` and `Run.proofPackPostedAt`. |
| `prisma/migrations/20260828120000_add_proof_pack/migration.sql` (create) | The migration for those two columns. |
| `src/domain/runs/run-repository.ts` (modify) | Adds `setProofPack` and the two new `RunRecord` fields. |
| `src/persistence/prisma/run-repository.prisma.ts` (modify) | Implements `setProofPack`. |
| `src/activities/evidence.activities.ts` (modify) | Adds `createProofPackActivities` with the `publishProofPack` activity. |
| `src/activities/index.ts` (modify) | Wires the new activity set. |
| `src/activities/validation.activities.ts` (modify) | Adds `previewUrl` to `UserValidateActivityOutput`. |
| `src/workflows/agent-run.workflow.ts` (modify) | The success path: invariant, Proof Pack, `READY_FOR_HUMAN`. |
| `tests/workflow/support/harness.ts` (modify) | The `publishProofPack` double and its recorders. |

---

### Task 1: The Proof Pack renderer

**Files:**
- Create: `src/domain/evidence/proof-pack.ts`
- Test: `tests/unit/proof-pack.test.ts`

**Interfaces:**
- Consumes: `ValidationMethod` and `ValidationEvidenceKind` from `~/domain/validation/validation-contract.js`; `AssertionResult` from `~/domain/validation/validation-result.js`; `ReviewSeverity` and `ReviewCategory` from `~/domain/review/review-report.js`.
- Produces: `ProofPackInput`, `ProofPackAssertion`, `ProofPackEvidenceRef`, `ProofPackCheck`, `ProofPackFinding`, `ProofPackContextItem`, `ProofPackConflict`, `renderProofPack(input: ProofPackInput): string`, `hashProofPack(body: string): string`, `PROOF_PACK_HEADINGS: readonly string[]`, `MAX_LISTED_CHANGED_FILES = 50`, `MAX_FIELD_CHARACTERS = 500`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/proof-pack.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  hashProofPack,
  MAX_LISTED_CHANGED_FILES,
  PROOF_PACK_HEADINGS,
  renderProofPack,
  type ProofPackInput,
} from "~/domain/evidence/proof-pack.js";

const input = (overrides: Partial<ProofPackInput> = {}): ProofPackInput => ({
  runId: "run-1",
  workItem: { title: "Add the health endpoint", url: "https://linear.app/acme/issue/ENG-143" },
  pullRequestUrl: "https://github.com/acme/fixture/pull/1",
  assertions: [
    {
      id: "VAL-API-001",
      requirement: "AC-1",
      statement: "GET /health returns 200.",
      method: "http",
      requiredEvidence: ["request-response"],
      result: "PASS",
      reason: "The endpoint answered 200.",
      evidence: [
        {
          kind: "request-response",
          source: "http:VAL-API-001:request-response",
          sha256: "a".repeat(64),
          storageRef: "file:VAL-API-001-http-request-response.json",
        },
      ],
    },
  ],
  checks: [
    {
      name: "unit",
      command: "npm test",
      exitCode: 0,
      passed: true,
      durationMs: 1200,
      stdoutSha256: "b".repeat(64),
      stderrSha256: "c".repeat(64),
    },
  ],
  reviewVerdict: "pass",
  reviewPasses: 1,
  findings: [],
  contextItems: [
    {
      ref: "github:acme/fixture/README.md",
      authority: "repository_readme",
      classification: "required",
      sourceVersion: "824ac31",
      contentSha256: "d".repeat(64),
      reason: "it states the health endpoint contract",
    },
  ],
  discoverableItemCount: 3,
  conflicts: [],
  changedFiles: ["src/health.ts"],
  patchByteLength: 812,
  previewUrl: null,
  baseSha: "f".repeat(40),
  patchSha256: "e".repeat(64),
  commitSha: "1".repeat(40),
  repairCount: 0,
  repairLimit: 2,
  ...overrides,
});

describe("the Proof Pack renderer", () => {
  it("writes every SDD section 47 heading exactly once and in order", () => {
    const body = renderProofPack(input());
    let cursor = -1;
    for (const heading of PROOF_PACK_HEADINGS) {
      const at = body.indexOf(`\n${heading}\n`);
      expect(at, `${heading} is missing`).toBeGreaterThan(cursor);
      expect(body.indexOf(`\n${heading}\n`, at + 1), `${heading} appears twice`).toBe(-1);
      cursor = at;
    }
  });

  it("states the human decision status", () => {
    expect(renderProofPack(input())).toContain("Status: READY FOR HUMAN REVIEW");
  });

  it("maps every assertion to its result and its evidence", () => {
    const body = renderProofPack(input());
    expect(body).toContain("| Assertion | Result | Evidence |");
    expect(body).toContain("VAL-API-001");
    expect(body).toContain("PASS");
    expect(body).toContain("file:VAL-API-001-http-request-response.json");
  });

  it("states the success criterion of every assertion, so a human can audit it", () => {
    expect(renderProofPack(input())).toContain("GET /health returns 200.");
  });

  it("names an assertion with no stored evidence rather than hide it", () => {
    const body = renderProofPack(
      input({
        assertions: [{ ...input().assertions[0]!, evidence: [] }],
      }),
    );
    expect(body).toContain("No stored evidence.");
  });

  it("reports every deterministic check with its exit code", () => {
    const body = renderProofPack(input());
    expect(body).toContain("npm test");
    expect(body).toContain("exit code 0");
  });

  it("lists a non-blocking finding under known limitations with its decision reason", () => {
    const body = renderProofPack(
      input({
        findings: [
          {
            id: "RV-2",
            severity: "high",
            category: "performance",
            requirement: "AC-1",
            evidence: "src/health.ts:12",
            description: "The handler reads the whole table.",
            blocking: false,
            decisionReason: "the finding names no mandatory requirement",
            attempt: 1,
          },
        ],
      }),
    );
    expect(body).toContain("RV-2");
    expect(body).toContain("high");
    expect(body).toContain("the finding names no mandatory requirement");
  });

  it("writes None under known limitations when no finding survived", () => {
    expect(renderProofPack(input())).toMatch(/### Known limitations\n\nNone\./);
  });

  it("records the base SHA, the patch hash, and the repair count", () => {
    const body = renderProofPack(input());
    expect(body).toContain("f".repeat(40));
    expect(body).toContain("e".repeat(64));
    expect(body).toContain("Repairs: 0 of 2");
  });

  it("caps the changed-file list and states the remainder", () => {
    const files = Array.from({ length: 60 }, (unused, index) => `src/file-${index}.ts`);
    const body = renderProofPack(input({ changedFiles: files }));
    expect(body).toContain(`60 files`);
    expect(body).toContain(`${60 - MAX_LISTED_CHANGED_FILES} more files`);
    expect(body).not.toContain("src/file-59.ts");
  });

  it("truncates one long field rather than post an unbounded text", () => {
    const body = renderProofPack(
      input({
        assertions: [{ ...input().assertions[0]!, reason: "x".repeat(4000) }],
      }),
    );
    expect(body).toContain("[truncated]");
    expect(body).not.toContain("x".repeat(1000));
  });

  it("keeps a newline out of a table cell", () => {
    const body = renderProofPack(
      input({
        assertions: [{ ...input().assertions[0]!, reason: "line one\nline two" }],
      }),
    );
    const row = body.split("\n").find((line) => line.startsWith("| VAL-API-001"));
    expect(row).toContain("line one line two");
  });

  it("escapes a pipe inside a table cell", () => {
    const body = renderProofPack(
      input({
        assertions: [{ ...input().assertions[0]!, reason: "a | b" }],
      }),
    );
    const row = body.split("\n").find((line) => line.startsWith("| VAL-API-001"));
    expect(row).toContain("a \\| b");
  });

  it("names a resolved context conflict with its winner and its reason", () => {
    const body = renderProofPack(
      input({
        conflicts: [
          {
            id: "CTX-4",
            subject: "notification ownership",
            winnerRef: "ADR-031",
            loserRef: "README.md",
            reason: "an accepted ADR has higher architecture authority",
          },
        ],
      }),
    );
    expect(body).toContain("CTX-4");
    expect(body).toContain("ADR-031");
    expect(body).toContain("an accepted ADR has higher architecture authority");
  });

  it("writes Not available under preview when the Run started none", () => {
    expect(renderProofPack(input())).toMatch(/### Preview\n\nNot available\./);
  });

  it("hashes one body to one value and two bodies to two values", () => {
    const body = renderProofPack(input());
    expect(hashProofPack(body)).toBe(hashProofPack(body));
    expect(hashProofPack(body)).not.toBe(hashProofPack(`${body} `));
    expect(hashProofPack(body)).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/proof-pack.test.ts`

Expected: FAIL. The module `~/domain/evidence/proof-pack.js` does not resolve.

- [ ] **Step 3: Write the renderer**

Create `src/domain/evidence/proof-pack.ts`:

```ts
import { createHash } from "node:crypto";
import type {
  ValidationEvidenceKind,
  ValidationMethod,
} from "~/domain/validation/validation-contract.js";
import type { AssertionResult } from "~/domain/validation/validation-result.js";
import type { ReviewCategory, ReviewSeverity } from "~/domain/review/review-report.js";

/**
 * SDD section 47. The Proof Pack optimizes for one human acceptance decision. It must not dump a
 * full raw log into Linear, so no type in this file carries log text. A caller therefore cannot
 * pass one, and the rule holds by construction rather than by care.
 */

/** The largest number of changed files the Proof Pack names one by one. */
export const MAX_LISTED_CHANGED_FILES = 50;

/** The largest number of characters one free text field contributes. */
export const MAX_FIELD_CHARACTERS = 500;

/** SDD section 47 fixes these headings and this order. */
export const PROOF_PACK_HEADINGS = [
  "## Factoree delivery",
  "### Pull request",
  "### Validation contract",
  "### Deterministic verification",
  "### Independent review",
  "### Context used",
  "### Context conflicts",
  "### Change summary",
  "### Preview",
  "### Known limitations",
  "### Run metadata",
] as const;

/** One stored artefact of SDD section 39. The bytes stay in storage, and the reference travels. */
export interface ProofPackEvidenceRef {
  kind: ValidationEvidenceKind | "deterministic_check";
  source: string;
  sha256: string;
  storageRef: string | null;
}

export interface ProofPackAssertion {
  id: string;
  requirement: string;
  /** SDD section 24. The observable behavior. It is the success criterion a human audits. */
  statement: string;
  method: ValidationMethod;
  requiredEvidence: ValidationEvidenceKind[];
  result: AssertionResult;
  reason: string;
  evidence: ProofPackEvidenceRef[];
}

/** SDD section 35. One deterministic check. The retained log stays out of the Proof Pack. */
export interface ProofPackCheck {
  name: string;
  command: string;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  stdoutSha256: string;
  stderrSha256: string;
}

export interface ProofPackFinding {
  id: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  requirement: string;
  evidence: string;
  description: string;
  /** Factoree's own decision. SDD section 41. A non-blocking finding is a known limitation. */
  blocking: boolean;
  decisionReason: string;
  attempt: number;
}

export interface ProofPackContextItem {
  ref: string;
  authority: string;
  classification: string;
  sourceVersion: string;
  contentSha256: string | null;
  reason: string;
}

export interface ProofPackConflict {
  id: string;
  subject: string;
  winnerRef: string | null;
  loserRef: string | null;
  reason: string;
}

export interface ProofPackInput {
  runId: string;
  workItem: { title: string; url: string | null };
  pullRequestUrl: string;
  assertions: ProofPackAssertion[];
  checks: ProofPackCheck[];
  /** The agent claim of SDD section 41. Factoree's own decision drove the Run. */
  reviewVerdict: "pass" | "fail";
  /** The number of Reviewer sessions this Run ran. */
  reviewPasses: number;
  findings: ProofPackFinding[];
  contextItems: ProofPackContextItem[];
  /** SDD section 21. A discoverable item stays available through a tool and is not preloaded. */
  discoverableItemCount: number;
  conflicts: ProofPackConflict[];
  changedFiles: string[];
  patchByteLength: number;
  previewUrl: string | null;
  baseSha: string;
  patchSha256: string;
  commitSha: string;
  repairCount: number;
  repairLimit: number;
}

/** Keeps one field inside the cap. A truncated field says so, so a reader never guesses. */
const cap = (value: string): string =>
  value.length <= MAX_FIELD_CHARACTERS
    ? value
    : `${value.slice(0, MAX_FIELD_CHARACTERS)} [truncated]`;

/** One Markdown table cell. A newline breaks a table, and a pipe starts a new column. */
const cell = (value: string): string =>
  cap(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();

const evidenceCell = (assertion: ProofPackAssertion): string => {
  if (assertion.evidence.length === 0) return "No stored evidence.";
  return assertion.evidence
    .map((item) => `${item.kind}: ${item.storageRef ?? item.sha256.slice(0, 12)}`)
    .join("; ");
};

const validationSection = (input: ProofPackInput): string[] => {
  if (input.assertions.length === 0) return ["No assertion was recorded."];
  const rows = input.assertions.map(
    (assertion) =>
      `| ${cell(assertion.id)} | ${cell(assertion.result)} | ${cell(evidenceCell(assertion))} |`,
  );
  const criteria = input.assertions.map(
    (assertion) =>
      `- ${assertion.id} proves ${assertion.requirement} by ${assertion.method}: ` +
      `${cap(assertion.statement)} Result: ${assertion.result}. ${cap(assertion.reason)}`,
  );
  return [
    "| Assertion | Result | Evidence |",
    "|---|---|---|",
    ...rows,
    "",
    "Success criteria:",
    "",
    ...criteria,
  ];
};

const verificationSection = (input: ProofPackInput): string[] => {
  if (input.checks.length === 0) return ["No deterministic check ran."];
  return input.checks.map(
    (check) =>
      `- ${check.name}: \`${cell(check.command)}\` ended with exit code ${check.exitCode} ` +
      `after ${check.durationMs} ms. ${check.passed ? "Passed" : "Failed"}. ` +
      `stdout ${check.stdoutSha256.slice(0, 12)}, stderr ${check.stderrSha256.slice(0, 12)}.`,
  );
};

const reviewSection = (input: ProofPackInput): string[] => {
  const blocking = input.findings.filter((finding) => finding.blocking);
  return [
    `Factoree accepted the change after ${input.reviewPasses} independent review ` +
      `${input.reviewPasses === 1 ? "pass" : "passes"}. The last Reviewer verdict was ` +
      `${input.reviewVerdict}.`,
    "",
    `Findings: ${input.findings.length}. Blocking findings that remain: ${blocking.length}.`,
  ];
};

const contextSection = (input: ProofPackInput): string[] => {
  const lines =
    input.contextItems.length === 0
      ? ["No context item was preloaded."]
      : input.contextItems.map(
          (item) =>
            `- ${item.ref} — authority ${item.authority}, ${item.classification}, version ` +
            `${item.sourceVersion}, hash ${item.contentSha256 ?? "not recorded"}. ` +
            `Selected because ${cap(item.reason)}`,
        );
  return [
    ...lines,
    "",
    `${input.discoverableItemCount} further ${
      input.discoverableItemCount === 1 ? "item stayed" : "items stayed"
    } discoverable through a tool.`,
  ];
};

const conflictSection = (input: ProofPackInput): string[] =>
  input.conflicts.length === 0
    ? ["None."]
    : input.conflicts.map(
        (conflict) =>
          `- ${conflict.id} on "${cap(conflict.subject)}": ${conflict.winnerRef ?? "no winner"} ` +
          `wins over ${conflict.loserRef ?? "no loser"}. ${cap(conflict.reason)}`,
      );

const changeSection = (input: ProofPackInput): string[] => {
  const listed = input.changedFiles.slice(0, MAX_LISTED_CHANGED_FILES);
  const remainder = input.changedFiles.length - listed.length;
  return [
    `${input.changedFiles.length} ${input.changedFiles.length === 1 ? "file" : "files"}, ` +
      `${input.patchByteLength} patch bytes.`,
    "",
    ...listed.map((file) => `- ${file}`),
    ...(remainder > 0 ? [`- and ${remainder} more files.`] : []),
  ];
};

/**
 * SDD section 47. A finding Factoree judged non-blocking is exactly what a human must still
 * weigh, so every one appears here with the reason it did not block. See the Phase 8 carried
 * finding about a defect that failed only one gate.
 */
const limitationSection = (input: ProofPackInput): string[] => {
  const limitations = input.findings.filter((finding) => !finding.blocking);
  if (limitations.length === 0) return ["None."];
  return limitations.map(
    (finding) =>
      `- ${finding.id} (${finding.severity}, ${finding.category}) at ${cell(finding.evidence)}: ` +
      `${cap(finding.description)} It did not block, because ${cap(finding.decisionReason)}`,
  );
};

const metadataSection = (input: ProofPackInput): string[] => [
  `- Run: ${input.runId}`,
  `- Base SHA: ${input.baseSha}`,
  `- Patch SHA-256: ${input.patchSha256}`,
  `- Commit: ${input.commitSha}`,
  `- Repairs: ${input.repairCount} of ${input.repairLimit}`,
];

/** SDD section 47. One Proof Pack, in the exact section order the SDD fixes. */
export const renderProofPack = (input: ProofPackInput): string =>
  [
    "## Factoree delivery",
    "",
    "Status: READY FOR HUMAN REVIEW",
    "",
    `Work Item: ${cap(input.workItem.title)}${
      input.workItem.url === null ? "" : ` (${input.workItem.url})`
    }`,
    "",
    "### Pull request",
    "",
    input.pullRequestUrl,
    "",
    "### Validation contract",
    "",
    ...validationSection(input),
    "",
    "### Deterministic verification",
    "",
    ...verificationSection(input),
    "",
    "### Independent review",
    "",
    ...reviewSection(input),
    "",
    "### Context used",
    "",
    ...contextSection(input),
    "",
    "### Context conflicts",
    "",
    ...conflictSection(input),
    "",
    "### Change summary",
    "",
    ...changeSection(input),
    "",
    "### Preview",
    "",
    input.previewUrl ?? "Not available.",
    "",
    "### Known limitations",
    "",
    ...limitationSection(input),
    "",
    "### Run metadata",
    "",
    ...metadataSection(input),
    "",
  ].join("\n");

/** The identity of one Proof Pack body. The Run row records it, so its existence is provable. */
export const hashProofPack = (body: string): string =>
  createHash("sha256").update(body, "utf8").digest("hex");
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/proof-pack.test.ts`

Expected: PASS, 16 tests.

- [ ] **Step 5: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain/evidence/proof-pack.ts tests/unit/proof-pack.test.ts
git commit -m "feat(proof-pack): render the SDD section 47 Proof Pack"
```

---

### Task 2: The completion invariant

**Files:**
- Create: `src/domain/runs/completion-invariant.ts`
- Modify: `src/domain/runs/run-status.ts`
- Test: `tests/unit/completion-invariant.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `CompletionInvariantInput`, `completionInvariantFailures(input: CompletionInvariantInput): string[]`, and the new failure reason `COMPLETION_INVARIANT_UNMET` in `RUN_FAILURE_REASONS`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/completion-invariant.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  completionInvariantFailures,
  type CompletionInvariantInput,
} from "~/domain/runs/completion-invariant.js";
import { RUN_FAILURE_REASONS } from "~/domain/runs/run-status.js";

const satisfied = (overrides: Partial<CompletionInvariantInput> = {}): CompletionInvariantInput => ({
  workItemReady: true,
  contextContractVersion: "a".repeat(64),
  unresolvedConflict: false,
  validationContractVersion: "b".repeat(64),
  validationContractFrozenAt: "2026-01-01T00:00:00.000Z",
  validationPassed: true,
  verificationPassed: true,
  blockingFindingCount: 0,
  repairCount: 1,
  repairLimit: 2,
  patchSha256: "c".repeat(64),
  baseUnchanged: true,
  pullRequestUrl: "https://github.com/acme/fixture/pull/1",
  proofPackSha256: "d".repeat(64),
  ...overrides,
});

describe("the SDD section 68 completion invariant", () => {
  it("reports no failure when every clause holds", () => {
    expect(completionInvariantFailures(satisfied())).toEqual([]);
  });

  it("names the failure reason", () => {
    expect(RUN_FAILURE_REASONS).toContain("COMPLETION_INVARIANT_UNMET");
  });

  const cases: Array<[string, Partial<CompletionInvariantInput>, string]> = [
    ["the Work Item is not ready", { workItemReady: false }, "Work Item"],
    ["no Context Contract exists", { contextContractVersion: null }, "Context Contract"],
    ["a material conflict is unresolved", { unresolvedConflict: true }, "conflict"],
    ["no Validation Contract exists", { validationContractVersion: null }, "Validation Contract"],
    ["the contract never froze", { validationContractFrozenAt: null }, "froze"],
    ["one assertion did not pass", { validationPassed: false }, "assertion"],
    ["deterministic verification failed", { verificationPassed: false }, "verification"],
    ["a blocking finding remains", { blockingFindingCount: 1 }, "blocking"],
    ["the repair budget is exceeded", { repairCount: 3 }, "repair"],
    ["no patch hash exists", { patchSha256: "" }, "patch hash"],
    ["the base moved", { baseUnchanged: false }, "base"],
    ["no pull request exists", { pullRequestUrl: null }, "pull request"],
    ["no Proof Pack exists", { proofPackSha256: null }, "Proof Pack"],
  ];

  for (const [name, override, fragment] of cases) {
    it(`refuses completion when ${name}`, () => {
      const failures = completionInvariantFailures(satisfied(override));
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.join(" ")).toContain(fragment);
    });
  }

  it("refuses a patch hash that is not a SHA-256", () => {
    expect(completionInvariantFailures(satisfied({ patchSha256: "not-a-hash" }))).not.toEqual([]);
  });

  it("reports every broken clause, not only the first one", () => {
    const failures = completionInvariantFailures(
      satisfied({ pullRequestUrl: null, proofPackSha256: null }),
    );
    expect(failures.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/completion-invariant.test.ts`

Expected: FAIL. The module does not resolve.

- [ ] **Step 3: Write the checker**

Create `src/domain/runs/completion-invariant.ts`:

```ts
/**
 * SDD section 68. `READY_FOR_HUMAN` is reachable only when every clause below holds. No prompt
 * and no agent response can override it, so the check is a pure function of recorded facts and
 * it takes no agent claim. It reports every broken clause, because an operator must repair all
 * of them, not only the first one.
 */
export interface CompletionInvariantInput {
  workItemReady: boolean;
  contextContractVersion: string | null;
  unresolvedConflict: boolean;
  validationContractVersion: string | null;
  /** SDD section 24. The contract must freeze before implementation starts. */
  validationContractFrozenAt: string | null;
  validationPassed: boolean;
  verificationPassed: boolean;
  blockingFindingCount: number;
  repairCount: number;
  repairLimit: number;
  /**
   * SDD section 44 and section 46. The publication reproduced this hash inside the trusted
   * checkout before it created a branch, so one recorded value proves both sides of the clause
   * "verified patch hash == published patch hash".
   */
  patchSha256: string;
  baseUnchanged: boolean;
  pullRequestUrl: string | null;
  proofPackSha256: string | null;
}

const SHA256 = /^[0-9a-f]{64}$/;

export const completionInvariantFailures = (input: CompletionInvariantInput): string[] => {
  const failures: string[] = [];
  if (!input.workItemReady) failures.push("The Work Item is not ready.");
  if (input.contextContractVersion === null) failures.push("No Context Contract exists.");
  if (input.unresolvedConflict) failures.push("A material Context conflict is unresolved.");
  if (input.validationContractVersion === null) failures.push("No Validation Contract exists.");
  if (input.validationContractFrozenAt === null) {
    failures.push("The Validation Contract never froze before implementation.");
  }
  if (!input.validationPassed) failures.push("At least one Validation assertion did not pass.");
  if (!input.verificationPassed) failures.push("Deterministic verification did not pass.");
  if (input.blockingFindingCount > 0) failures.push("A blocking review finding remains.");
  if (input.repairCount > input.repairLimit) {
    failures.push(
      `The repair count ${input.repairCount} exceeds the limit ${input.repairLimit}.`,
    );
  }
  if (!SHA256.test(input.patchSha256)) failures.push("No verified patch hash exists.");
  if (!input.baseUnchanged) failures.push("The target base SHA changed.");
  if (input.pullRequestUrl === null || input.pullRequestUrl.trim() === "") {
    failures.push("No pull request exists.");
  }
  if (input.proofPackSha256 === null || !SHA256.test(input.proofPackSha256)) {
    failures.push("No Proof Pack exists.");
  }
  return failures;
};
```

- [ ] **Step 4: Add the failure reason**

In `src/domain/runs/run-status.ts`, add this entry to `RUN_FAILURE_REASONS`, directly before `"INTERNAL_ERROR"`:

```ts
  // SDD section 68. A clause of the completion invariant did not hold at the moment the Run was
  // ready to complete. Factoree must never report success it cannot prove, so the Run fails.
  "COMPLETION_INVARIANT_UNMET",
```

- [ ] **Step 5: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/completion-invariant.test.ts tests/unit/run-status.test.ts`

Expected: PASS.

- [ ] **Step 6: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/domain/runs/completion-invariant.ts src/domain/runs/run-status.ts tests/unit/completion-invariant.test.ts
git commit -m "feat(runs): state the SDD section 68 completion invariant"
```

---

### Task 3: Persist the Proof Pack on the Run row

**Files:**
- Modify: `prisma/schema.prisma` (the `Run` model)
- Create: `prisma/migrations/20260828120000_add_proof_pack/migration.sql`
- Modify: `src/domain/runs/run-repository.ts`
- Modify: `src/persistence/prisma/run-repository.prisma.ts`
- Test: `tests/integration/run-repository.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 or Task 2.
- Produces: `RunRecord.proofPackSha256: string | null`, `RunRecord.proofPackPostedAt: Date | null`, and `RunRepository.setProofPack(tenantId: string, runId: string, proofPack: { sha256: string; postedAt: Date }): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Append this case to the existing `describe` block of `tests/integration/run-repository.test.ts`. Match the surrounding style of that file for the client and the seed helper it already uses:

```ts
  it("records the Proof Pack of one Run and refuses another tenant", async () => {
    const seed = await seedTenantProjectAndRun(prisma);
    const repository = new PrismaRunRepository(prisma);
    const postedAt = new Date("2026-02-01T10:00:00.000Z");

    await repository.setProofPack(seed.tenantId, seed.runId, {
      sha256: "a".repeat(64),
      postedAt,
    });

    const run = await repository.findById(seed.tenantId, seed.runId);
    expect(run?.proofPackSha256).toBe("a".repeat(64));
    expect(run?.proofPackPostedAt?.toISOString()).toBe(postedAt.toISOString());

    await expect(
      repository.setProofPack("other-tenant", seed.runId, { sha256: "b".repeat(64), postedAt }),
    ).rejects.toThrow();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/run-repository.test.ts`

Expected: FAIL. `setProofPack` is not a function.

- [ ] **Step 3: Add the columns to the schema**

In `prisma/schema.prisma`, inside `model Run`, add these two fields directly after `validationContractVersion`:

```prisma
  proofPackSha256          String?
  proofPackPostedAt        DateTime?
```

- [ ] **Step 4: Write the migration**

Create `prisma/migrations/20260828120000_add_proof_pack/migration.sql`:

```sql
-- SDD section 47 and section 68. The Run records the Proof Pack it posted, so the completion
-- invariant clause "Proof Pack exists" is provable from durable state.

ALTER TABLE "Run" ADD COLUMN "proofPackSha256" TEXT;
ALTER TABLE "Run" ADD COLUMN "proofPackPostedAt" TIMESTAMP(3);
```

- [ ] **Step 5: Generate the client**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx prisma generate`

Expected: exit 0.

- [ ] **Step 6: Extend the port**

In `src/domain/runs/run-repository.ts`, add these two fields to `RunRecord`, directly after `validationContractVersion`:

```ts
  /** SDD section 47. The SHA-256 of the Proof Pack this Run posted, or null while none exists. */
  proofPackSha256: string | null;
  proofPackPostedAt: Date | null;
```

Add this method to `RunRepository`, directly after `setPublication`:

```ts
  /**
   * SDD section 47 and section 68. Records the Proof Pack of one Run. The method throws when it
   * reaches no Run of that tenant, because a silent success hides a caller defect.
   */
  setProofPack(
    tenantId: string,
    runId: string,
    proofPack: { sha256: string; postedAt: Date },
  ): Promise<void>;
```

- [ ] **Step 7: Implement it**

In `src/persistence/prisma/run-repository.prisma.ts`, add `proofPackSha256` and `proofPackPostedAt` to whatever mapping function turns a Prisma row into a `RunRecord`. Then add this method, and copy the tenant guard of the existing `setPublication` exactly:

```ts
  async setProofPack(
    tenantId: string,
    runId: string,
    proofPack: { sha256: string; postedAt: Date },
  ): Promise<void> {
    const updated = await this.prisma.run.updateMany({
      where: { id: runId, tenantId },
      data: { proofPackSha256: proofPack.sha256, proofPackPostedAt: proofPack.postedAt },
    });
    if (updated.count === 0) {
      throw new Error(`Run ${runId} of tenant ${tenantId} does not exist.`);
    }
  }
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/run-repository.test.ts`

Expected: PASS.

- [ ] **Step 9: Repair every other `RunRecord` construction**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`

Every test double that builds a `RunRecord` object now misses two fields. Add `proofPackSha256: null` and `proofPackPostedAt: null` to each one the compiler names. Add `setProofPack` to every fake `RunRepository` the compiler names.

- [ ] **Step 10: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`

Expected: both exit 0.

- [ ] **Step 11: Commit**

```bash
git add prisma src/domain/runs/run-repository.ts src/persistence/prisma/run-repository.prisma.ts tests
git commit -m "feat(runs): record the Proof Pack hash on the Run row"
```

---

### Task 4: The `publishProofPack` activity

**Files:**
- Modify: `src/activities/evidence.activities.ts`
- Modify: `src/activities/index.ts`
- Test: `tests/unit/proof-pack-activity.test.ts`

**Interfaces:**
- Consumes: `renderProofPack`, `hashProofPack`, and every `ProofPack*` type from Task 1. `RunRepository.setProofPack` from Task 3.
- Produces:

```ts
export interface PublishProofPackActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  workItem: { title: string; url: string | null };
  pullRequestUrl: string;
  commitSha: string;
  patchSha256: string;
  baseSha: string;
  changedFiles: string[];
  patchByteLength: number;
  previewUrl: string | null;
  repairCount: number;
  repairLimit: number;
  reviewVerdict: "pass" | "fail";
  reviewPasses: number;
}

export interface PublishProofPackActivityOutput {
  sha256: string;
  /** The number of assertions the Proof Pack mapped to evidence. */
  assertionCount: number;
  /** The number of non-blocking findings it reported as a known limitation. */
  limitationCount: number;
  postedAt: string;
}
```

The activity name is `publishProofPack`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/proof-pack-activity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createProofPackActivities } from "~/activities/evidence.activities.js";
import type { PublishProofPackActivityInput } from "~/activities/evidence.activities.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { EvidenceRecord, EvidenceStore } from "~/domain/evidence/evidence.js";
import type { ReviewFindingRecord, ReviewFindingStore } from "~/domain/review/review-finding-store.js";
import type {
  ValidationAssertionResultRecord,
  ValidationResultStore,
} from "~/domain/validation/validation-result-store.js";
import type { StoredValidationContract } from "~/domain/validation/validation-contract-store.js";
import type { StoredContextContract } from "~/domain/context/context-contract-store.js";

const contract: StoredValidationContract = {
  id: "vc-1",
  tenantId: "t1",
  runId: "run-1",
  version: 1,
  sha256: "b".repeat(64),
  workItem: "ENG-143",
  goal: "Add the health endpoint.",
  document: "# Validation Contract\n",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  assertions: [
    {
      rowId: "row-1",
      id: "VAL-API-001",
      requirement: "AC-1",
      statement: "GET /health returns 200.",
      method: "http",
      evidence: ["request-response"],
      preconditions: [],
    },
  ],
};

const contextContract: StoredContextContract = {
  id: "cc-1",
  tenantId: "t1",
  runId: "run-1",
  version: 1,
  sha256: "a".repeat(64),
  document: "# Context Contract\n",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  items: [
    {
      reference: {
        sourceId: "repository",
        ref: "github:acme/fixture/README.md",
        repository: "acme/fixture",
        sha: "0".repeat(40),
        path: "README.md",
        title: "README",
      },
      sourceVersion: "0".repeat(40),
      authority: "repository_readme",
      reason: "it states the health endpoint contract",
      classification: "required",
      topics: ["health"],
      contentSha256: "c".repeat(64),
    },
    {
      reference: {
        sourceId: "repository",
        ref: "github:acme/fixture/docs/big.md",
        repository: "acme/fixture",
        sha: "0".repeat(40),
        path: "docs/big.md",
        title: "big",
      },
      sourceVersion: "0".repeat(40),
      authority: "prose_documentation",
      reason: "it is too large to preload",
      classification: "discoverable",
      topics: ["health"],
      contentSha256: null,
    },
  ],
  conflicts: [
    {
      id: "CTX-4",
      subject: "notification ownership",
      authorityDomain: "architecture_intent",
      winnerRef: "ADR-031",
      loserRef: "README.md",
      reason: "an accepted ADR has higher architecture authority",
      resolution: "resolved",
    },
  ],
};

const results: ValidationAssertionResultRecord[] = [
  {
    id: "r1",
    tenantId: "t1",
    runId: "run-1",
    validationAssertionId: "row-1",
    assertionKey: "VAL-API-001",
    result: "FAIL",
    reason: "The endpoint answered 500.",
    attempt: 1,
    createdAt: new Date("2026-01-01T01:00:00.000Z"),
  },
  {
    id: "r2",
    tenantId: "t1",
    runId: "run-1",
    validationAssertionId: "row-1",
    assertionKey: "VAL-API-001",
    result: "PASS",
    reason: "The endpoint answered 200 with the secret sk-fixture-value-123.",
    attempt: 2,
    createdAt: new Date("2026-01-01T02:00:00.000Z"),
  },
];

const evidenceRows: EvidenceRecord[] = [
  {
    id: "e1",
    tenantId: "t1",
    runId: "run-1",
    validationAssertionId: "row-1",
    kind: "request-response",
    source: "http:VAL-API-001:request-response",
    createdAt: new Date("2026-01-01T02:00:00.000Z"),
    sha256: "d".repeat(64),
    storageRef: "file:VAL-API-001.json",
    metadata: {},
  },
  {
    id: "e2",
    tenantId: "t1",
    runId: "run-1",
    validationAssertionId: null,
    kind: "deterministic_check",
    source: "verify:unit",
    createdAt: new Date("2026-01-01T01:30:00.000Z"),
    sha256: "e".repeat(64),
    storageRef: null,
    metadata: {
      name: "unit",
      command: "npm test",
      exitCode: 0,
      passed: true,
      durationMs: 1200,
      stdoutSha256: "f".repeat(64),
      stderrSha256: "0".repeat(64),
    },
  },
];

const findings: ReviewFindingRecord[] = [
  {
    id: "f1",
    tenantId: "t1",
    runId: "run-1",
    attempt: 1,
    verdict: "fail",
    findingKey: "RV-1",
    severity: "blocker",
    category: "correctness",
    requirement: "AC-1",
    evidence: "src/health.ts:10",
    description: "The handler throws.",
    blocking: true,
    decisionReason: "a blocker finding blocks by default",
    createdAt: new Date("2026-01-01T01:40:00.000Z"),
  },
  {
    id: "f2",
    tenantId: "t1",
    runId: "run-1",
    attempt: 2,
    verdict: "pass",
    findingKey: "RV-2",
    severity: "high",
    category: "performance",
    requirement: "AC-1",
    evidence: "src/health.ts:12",
    description: "The handler reads the whole table.",
    blocking: false,
    decisionReason: "the finding names no mandatory requirement",
    createdAt: new Date("2026-01-01T02:10:00.000Z"),
  },
];

const build = () => {
  const posted: string[] = [];
  const proofPacks: Array<{ sha256: string; postedAt: Date }> = [];
  const redactor = new Redactor(["sk-fixture-value-123"]);
  const activities = createProofPackActivities({
    runs: {
      setProofPack: async (unusedTenant: string, unusedRun: string, proofPack) => {
        proofPacks.push(proofPack);
      },
    } as never,
    contextContracts: { findByRun: async () => contextContract } as never,
    validationContracts: { findByRun: async () => contract } as never,
    validationResults: { listForRun: async () => results } as never,
    evidence: { listForRun: async () => evidenceRows } as never as EvidenceStore,
    reviewFindings: { listForRun: async () => findings } as never as ReviewFindingStore,
    agentSession: {
      respond: async (unusedSession: string, body: string) => {
        posted.push(body);
      },
    } as never,
    secrets: { list: async () => [] } as never,
    redactor,
    logger: createLogger({ level: "error", redactor, sink: () => undefined }),
  });
  return { activities, posted, proofPacks };
};

const input: PublishProofPackActivityInput = {
  runId: "run-1",
  tenantId: "t1",
  projectId: "p1",
  sessionId: "session-1",
  workItem: { title: "Add the health endpoint", url: null },
  pullRequestUrl: "https://github.com/acme/fixture/pull/1",
  commitSha: "1".repeat(40),
  patchSha256: "2".repeat(64),
  baseSha: "3".repeat(40),
  changedFiles: ["src/health.ts"],
  patchByteLength: 812,
  previewUrl: null,
  repairCount: 1,
  repairLimit: 2,
  reviewVerdict: "pass",
  reviewPasses: 2,
};

describe("publishProofPack", () => {
  it("posts one Proof Pack as the Linear final response", async () => {
    const { activities, posted } = build();
    const output = await activities.publishProofPack(input);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("## Factoree delivery");
    expect(output.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses the last attempt of every assertion, not the first one", async () => {
    const { posted } = build();
    await build().activities.publishProofPack(input);
    const { activities, posted: body } = build();
    await activities.publishProofPack(input);
    expect(body[0]).toContain("PASS");
    expect(body[0]).not.toContain("The endpoint answered 500.");
    expect(posted).toBeDefined();
  });

  it("redacts a project secret that reached a persisted reason", async () => {
    const { activities, posted } = build();
    await activities.publishProofPack(input);
    expect(posted[0]).not.toContain("sk-fixture-value-123");
  });

  it("reads every deterministic check from its evidence row", async () => {
    const { activities, posted } = build();
    await activities.publishProofPack(input);
    expect(posted[0]).toContain("npm test");
    expect(posted[0]).toContain("exit code 0");
  });

  it("reports only the non-blocking finding as a known limitation", async () => {
    const { activities, posted } = build();
    const output = await activities.publishProofPack(input);
    expect(output.limitationCount).toBe(1);
    expect(posted[0]).toContain("RV-2");
    expect(posted[0]).not.toContain("RV-1");
  });

  it("counts a discoverable context item and preloads none of it", async () => {
    const { activities, posted } = build();
    await activities.publishProofPack(input);
    expect(posted[0]).toContain("github:acme/fixture/README.md");
    expect(posted[0]).toContain("1 further item stayed discoverable");
  });

  it("records the Proof Pack hash on the Run row", async () => {
    const { activities, proofPacks } = build();
    const output = await activities.publishProofPack(input);
    expect(proofPacks).toHaveLength(1);
    expect(proofPacks[0]?.sha256).toBe(output.sha256);
  });

  it("records the hash before it posts, so a Linear outage loses no proof", async () => {
    const order: string[] = [];
    const redactor = new Redactor();
    const activities = createProofPackActivities({
      runs: {
        setProofPack: async () => {
          order.push("record");
        },
      } as never,
      contextContracts: { findByRun: async () => contextContract } as never,
      validationContracts: { findByRun: async () => contract } as never,
      validationResults: { listForRun: async () => results } as never,
      evidence: { listForRun: async () => evidenceRows } as never as EvidenceStore,
      reviewFindings: { listForRun: async () => findings } as never as ReviewFindingStore,
      agentSession: {
        respond: async () => {
          order.push("post");
          throw new Error("Linear is down");
        },
      } as never,
      secrets: { list: async () => [] } as never,
      redactor,
      logger: createLogger({ level: "error", redactor, sink: () => undefined }),
    });
    await expect(activities.publishProofPack(input)).rejects.toThrow("Linear is down");
    expect(order).toEqual(["record", "post"]);
  });

  it("refuses to post when the Validation Contract is missing", async () => {
    const redactor = new Redactor();
    const activities = createProofPackActivities({
      runs: { setProofPack: async () => undefined } as never,
      contextContracts: { findByRun: async () => contextContract } as never,
      validationContracts: { findByRun: async () => null } as never,
      validationResults: { listForRun: async () => results } as never,
      evidence: { listForRun: async () => evidenceRows } as never as EvidenceStore,
      reviewFindings: { listForRun: async () => findings } as never as ReviewFindingStore,
      agentSession: { respond: async () => undefined } as never,
      secrets: { list: async () => [] } as never,
      redactor,
      logger: createLogger({ level: "error", redactor, sink: () => undefined }),
    });
    await expect(activities.publishProofPack(input)).rejects.toThrow(/Validation Contract/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/proof-pack-activity.test.ts`

Expected: FAIL. `createProofPackActivities` is not exported.

- [ ] **Step 3: Write the activity**

Append to `src/activities/evidence.activities.ts`. Add the imports at the top of the file:

```ts
import { ApplicationFailure } from "@temporalio/common";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { ContextContractStore } from "~/domain/context/context-contract-store.js";
import type { ValidationContractStore } from "~/domain/validation/validation-contract-store.js";
import type { ReviewFindingStore } from "~/domain/review/review-finding-store.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { registerProjectSecrets } from "~/domain/projects/redaction-loader.js";
import {
  hashProofPack,
  renderProofPack,
  type ProofPackAssertion,
  type ProofPackCheck,
  type ProofPackEvidenceRef,
} from "~/domain/evidence/proof-pack.js";
```

Then add the body:

```ts
export interface ProofPackActivityDependencies {
  runs: RunRepository;
  contextContracts: ContextContractStore;
  validationContracts: ValidationContractStore;
  validationResults: ValidationResultStore;
  evidence: EvidenceStore;
  reviewFindings: ReviewFindingStore;
  agentSession: AgentSessionPort;
  secrets: SecretStore;
  redactor: Redactor;
  logger: Logger;
}

export interface PublishProofPackActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  workItem: { title: string; url: string | null };
  pullRequestUrl: string;
  commitSha: string;
  patchSha256: string;
  baseSha: string;
  changedFiles: string[];
  patchByteLength: number;
  previewUrl: string | null;
  repairCount: number;
  repairLimit: number;
  reviewVerdict: "pass" | "fail";
  reviewPasses: number;
}

export interface PublishProofPackActivityOutput {
  sha256: string;
  assertionCount: number;
  limitationCount: number;
  postedAt: string;
}

/** Reads one number out of evidence metadata. An absent value becomes -1, never a silent 0. */
const metadataNumber = (metadata: Record<string, unknown>, key: string): number =>
  typeof metadata[key] === "number" ? (metadata[key] as number) : -1;

const metadataText = (metadata: Record<string, unknown>, key: string): string =>
  typeof metadata[key] === "string" ? (metadata[key] as string) : "";

/**
 * SDD section 47. Builds one Proof Pack from the persisted state of one Run, records its hash,
 * and posts it as the Linear final response. It reads recorded facts only. No agent claim and no
 * workflow-carried summary decides what it reports.
 */
export const createProofPackActivities = (dependencies: ProofPackActivityDependencies) => ({
  async publishProofPack(
    input: PublishProofPackActivityInput,
  ): Promise<PublishProofPackActivityOutput> {
    // SDD section 60. Every Project secret reaches the redactor before any text is built. A
    // persisted reason can carry one, because an agent wrote it.
    await registerProjectSecrets(
      dependencies.redactor,
      dependencies.secrets,
      input.tenantId,
      input.projectId,
      dependencies.logger,
    );

    const contract = await dependencies.validationContracts.findByRun(input.tenantId, input.runId);
    if (contract === null) {
      throw ApplicationFailure.nonRetryable(
        `Run ${input.runId} has no frozen Validation Contract, so no Proof Pack can prove it.`,
        "PROOF_PACK_INPUT_MISSING",
      );
    }
    const contextContract = await dependencies.contextContracts.findByRun(
      input.tenantId,
      input.runId,
    );
    const resultRows = await dependencies.validationResults.listForRun(input.tenantId, input.runId);
    const evidenceRows = await dependencies.evidence.listForRun(input.tenantId, input.runId);
    const findingRows = await dependencies.reviewFindings.listForRun(input.tenantId, input.runId);

    // The last attempt of one assertion is its outcome. An earlier repair attempt is history.
    const latest = new Map<string, (typeof resultRows)[number]>();
    for (const row of resultRows) {
      const held = latest.get(row.assertionKey);
      if (held === undefined || row.attempt >= held.attempt) latest.set(row.assertionKey, row);
    }

    const evidenceByAssertion = new Map<string, ProofPackEvidenceRef[]>();
    for (const row of evidenceRows) {
      if (row.validationAssertionId === null) continue;
      const list = evidenceByAssertion.get(row.validationAssertionId) ?? [];
      list.push({
        kind: row.kind,
        source: row.source,
        sha256: row.sha256,
        storageRef: row.storageRef,
      });
      evidenceByAssertion.set(row.validationAssertionId, list);
    }

    const assertions: ProofPackAssertion[] = contract.assertions.map((assertion) => {
      const outcome = latest.get(assertion.id);
      return {
        id: assertion.id,
        requirement: assertion.requirement,
        statement: assertion.statement,
        method: assertion.method,
        requiredEvidence: assertion.evidence,
        result: outcome?.result ?? "BLOCKED",
        reason: outcome?.reason ?? "No result row exists for this assertion.",
        evidence: evidenceByAssertion.get(assertion.rowId) ?? [],
      };
    });

    const checks: ProofPackCheck[] = evidenceRows
      .filter((row) => row.kind === "deterministic_check")
      .map((row) => ({
        name: metadataText(row.metadata, "name"),
        command: metadataText(row.metadata, "command"),
        exitCode: metadataNumber(row.metadata, "exitCode"),
        passed: row.metadata["passed"] === true,
        durationMs: metadataNumber(row.metadata, "durationMs"),
        stdoutSha256: metadataText(row.metadata, "stdoutSha256"),
        stderrSha256: metadataText(row.metadata, "stderrSha256"),
      }));

    // SDD section 42. Only the last review pass describes the change Factoree published. An
    // earlier pass reported a defect a repair already closed.
    const lastAttempt = findingRows.reduce((held, row) => Math.max(held, row.attempt), 0);
    const findings = findingRows
      .filter((row) => row.attempt === lastAttempt)
      .map((row) => ({
        id: row.findingKey,
        severity: row.severity,
        category: row.category,
        requirement: row.requirement,
        evidence: row.evidence,
        description: row.description,
        blocking: row.blocking,
        decisionReason: row.decisionReason,
        attempt: row.attempt,
      }));

    const items = contextContract?.items ?? [];
    const body = dependencies.redactor.redactText(
      renderProofPack({
        runId: input.runId,
        workItem: input.workItem,
        pullRequestUrl: input.pullRequestUrl,
        assertions,
        checks,
        reviewVerdict: input.reviewVerdict,
        reviewPasses: input.reviewPasses,
        findings,
        contextItems: items
          .filter((item) => item.classification !== "discoverable")
          .map((item) => ({
            ref: item.reference.ref,
            authority: item.authority,
            classification: item.classification,
            sourceVersion: item.sourceVersion,
            contentSha256: item.contentSha256,
            reason: item.reason,
          })),
        discoverableItemCount: items.filter((item) => item.classification === "discoverable")
          .length,
        conflicts: (contextContract?.conflicts ?? [])
          .filter((conflict) => conflict.resolution === "resolved")
          .map((conflict) => ({
            id: conflict.id,
            subject: conflict.subject,
            winnerRef: conflict.winnerRef,
            loserRef: conflict.loserRef,
            reason: conflict.reason,
          })),
        changedFiles: input.changedFiles,
        patchByteLength: input.patchByteLength,
        previewUrl: input.previewUrl,
        baseSha: input.baseSha,
        patchSha256: input.patchSha256,
        commitSha: input.commitSha,
        repairCount: input.repairCount,
        repairLimit: input.repairLimit,
      }),
    );

    const sha256 = hashProofPack(body);
    const postedAt = new Date();

    // The durable record comes first. A Linear outage must not lose the proof that the Proof
    // Pack exists, and the activity retry then posts the identical body again.
    await dependencies.runs.setProofPack(input.tenantId, input.runId, { sha256, postedAt });
    await dependencies.agentSession.respond(input.sessionId, body);

    dependencies.logger.info("proof pack posted", {
      tenant_id: input.tenantId,
      run_id: input.runId,
      step: "proof_pack",
      proof_pack_sha256: sha256,
    });

    return {
      sha256,
      assertionCount: assertions.length,
      limitationCount: findings.filter((finding) => !finding.blocking).length,
      postedAt: postedAt.toISOString(),
    };
  },
});
```

- [ ] **Step 4: Confirm the deterministic-check metadata keys**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH grep -n "deterministic_check" -A 20 src/activities/verification.activities.ts`

Read the `metadata` object the `verify` activity writes. If a key differs from `name`, `command`, `exitCode`, `passed`, `durationMs`, `stdoutSha256`, or `stderrSha256`, change the reader above to the real key, and change the fixture in the test to match. Do not change the writer.

- [ ] **Step 5: Wire the activity**

In `src/activities/index.ts`, import `createProofPackActivities` from `./evidence.activities.js`, and add this entry to the object `createActivities` returns, directly after the publishing entry:

```ts
  ...createProofPackActivities({
    runs: dependencies.runs,
    contextContracts: dependencies.contextContracts,
    validationContracts: dependencies.validationContracts,
    validationResults: dependencies.validationResults,
    evidence: dependencies.evidence,
    reviewFindings: dependencies.reviewFindings,
    agentSession: dependencies.agentSession,
    secrets: dependencies.secrets,
    redactor: dependencies.redactor,
    logger: dependencies.logger,
  }),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/proof-pack-activity.test.ts`

Expected: PASS.

- [ ] **Step 7: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`

Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/activities tests/unit/proof-pack-activity.test.ts
git commit -m "feat(activities): post the Proof Pack as the Linear final response"
```

---

### Task 5: Report the preview URL from user validation

**Files:**
- Modify: `src/activities/validation.activities.ts`
- Test: `tests/unit/validate-activity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `UserValidateActivityOutput.previewUrl: string | null`.

- [ ] **Step 1: Write the failing test**

Append this case to `tests/unit/validate-activity.test.ts`, in the `describe` block that already covers `userValidate`. Copy the existing setup helper of that file rather than build a new one:

```ts
  it("reports the preview base URL it exposed, so the Proof Pack can name it", async () => {
    const output = await runUserValidateWithPreview();
    expect(output.previewUrl).toMatch(/^http/);
  });

  it("reports no preview URL when no assertion needed one", async () => {
    const output = await runUserValidateWithoutPreview();
    expect(output.previewUrl).toBeNull();
  });
```

Write `runUserValidateWithPreview` and `runUserValidateWithoutPreview` as thin wrappers over the setup the file already uses. One configures an enabled `preview` block and an `http` assertion. The other configures a `command` assertion and `preview: null`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/validate-activity.test.ts`

Expected: FAIL. `previewUrl` is undefined.

- [ ] **Step 3: Add the field**

In `src/activities/validation.activities.ts`, add this field to `UserValidateActivityOutput`:

```ts
  /**
   * SDD section 47. The exposed preview base URL of this pass, or null when the pass started no
   * preview. The Proof Pack names it. It is reachable only while the sandbox lives.
   */
  previewUrl: string | null;
```

The activity already computes `previewBaseUrl` for the validator prompt. Add `previewUrl: previewBaseUrl` to the `return` statement of the successful path, and `previewUrl: null` to every earlier `return` of the same activity.

- [ ] **Step 4: Run the test to verify it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/validate-activity.test.ts`

Expected: PASS.

- [ ] **Step 5: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`

Expected: both exit 0. Repair every workflow test double the compiler names by adding `previewUrl: null`.

- [ ] **Step 6: Commit**

```bash
git add src/activities/validation.activities.ts tests
git commit -m "feat(validation): report the exposed preview URL of one pass"
```

---

### Task 6: The workflow success path

**Files:**
- Modify: `src/workflows/agent-run.workflow.ts:1414-1440`
- Modify: `tests/workflow/support/harness.ts`
- Modify: `tests/workflow/at-16-deterministic-failure.test.ts`
- Modify: `tests/workflow/at-35-worker-restart.test.ts`
- Test: `tests/workflow/at-30-proof-pack.test.ts`

**Interfaces:**
- Consumes: `completionInvariantFailures` from Task 2. `PublishProofPackActivityOutput` from Task 4. `UserValidateActivityOutput.previewUrl` from Task 5.
- Produces: a Run that ends `READY_FOR_HUMAN` with no failure reason.

Read the "Read this before Phase 10" block of `docs/build/STATUS.md` before this task. The publication order is load bearing. Change nothing before the publication.

- [ ] **Step 1: Write the failing test**

Create `tests/workflow/at-30-proof-pack.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { buildHarness, waitForStatus } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 180_000);

afterAll(async () => {
  await environment.teardown();
});

/**
 * AT-30 and SDD section 68. A successful L3 Run posts exactly one Proof Pack and then, and only
 * then, ends READY_FOR_HUMAN.
 */
describe("AT-30 — the Proof Pack completes a successful Run", () => {
  it("posts one Proof Pack and ends READY_FOR_HUMAN", async () => {
    const harness = buildHarness(environment);
    await harness.runWorker(async () => {
      const handle = await harness.start();
      const result = await handle.result();
      expect(result.status).toBe("READY_FOR_HUMAN");
    });

    expect(harness.proofPackCalls).toHaveLength(1);
    expect(harness.completions).toEqual([
      expect.objectContaining({ status: "READY_FOR_HUMAN", failureReason: undefined }),
    ]);
    expect(harness.postedFinalResponses).toHaveLength(1);
  });

  it("passes the published facts to the Proof Pack", async () => {
    const harness = buildHarness(environment);
    await harness.runWorker(async () => {
      await (await harness.start()).result();
    });

    const call = harness.proofPackCalls[0];
    expect(call?.pullRequestUrl).toBe("https://github.com/acme/fixture/pull/1");
    expect(call?.patchSha256).toBe("d".repeat(64));
    expect(call?.commitSha).toBe("e".repeat(40));
    expect(call?.changedFiles.length).toBeGreaterThan(0);
    expect(call?.repairCount).toBe(0);
  });

  it("posts the Proof Pack after the publication, never before it", async () => {
    const harness = buildHarness(environment);
    await harness.runWorker(async () => {
      await (await harness.start()).result();
    });

    expect(harness.activityOrder.indexOf("publishProofPack")).toBeGreaterThan(
      harness.activityOrder.indexOf("publish"),
    );
  });

  it("fails the Run when the Proof Pack cannot be posted", async () => {
    const harness = buildHarness(environment);
    harness.proofPackOutcomes.set("run-session-1", () => {
      throw new Error("Linear is down");
    });

    await harness.runWorker(async () => {
      const result = await (await harness.start()).result();
      expect(result.status).toBe("FAILED");
    });

    expect(harness.completions[0]?.failureReason).toBe("COMPLETION_INVARIANT_UNMET");
  });

  it("ends CANCELLED when a stop arrives while the Proof Pack is built", async () => {
    const harness = buildHarness(environment);
    let release = (): void => undefined;
    harness.heldProofPacks.set(
      "run-session-1",
      new Promise<void>((resolve) => {
        release = () => resolve();
      }),
    );

    await harness.runWorker(async () => {
      const handle = await harness.start();
      await waitForStatus(handle, "PUBLISHING");
      await handle.signal("stop");
      release();
      const result = await handle.result();
      expect(result.status).toBe("CANCELLED");
    });
  });
});
```

The Run identifier the harness builds is `run-<agentSessionId>`. Read `harness.input.agentSessionId` and use the exact value rather than the literal above if the harness names a different session.

- [ ] **Step 2: Extend the harness**

In `tests/workflow/support/harness.ts`:

Add the recorders next to `publishCalls`:

```ts
  /** Every recorded `publishProofPack` call, in order. */
  const proofPackCalls: PublishProofPackActivityInput[] = [];
  /** A run id in this map replaces the `publishProofPack` result. The function can also throw. */
  const proofPackOutcomes = new Map<string, () => PublishProofPackActivityOutput>();
  /** A run id in this map holds `publishProofPack` until the promise resolves. */
  const heldProofPacks = new Map<string, Promise<void>>();
```

Add the import:

```ts
import type {
  PublishProofPackActivityInput,
  PublishProofPackActivityOutput,
} from "~/activities/evidence.activities.js";
```

Add the double directly after the `publish` double:

```ts
    publishProofPack: async (
      activityInput: PublishProofPackActivityInput,
    ): Promise<PublishProofPackActivityOutput> => {
      activityOrder.push("publishProofPack");
      proofPackCalls.push(activityInput);
      const held = heldProofPacks.get(activityInput.runId);
      if (held !== undefined) {
        // The real activity reads five stores and posts to Linear, so a stop can arrive while it
        // runs. The double heartbeats and awaits, the same way the `publish` double does.
        const heartbeat = setInterval(() => Context.current().heartbeat(), 100);
        try {
          await held;
        } finally {
          clearInterval(heartbeat);
        }
      }
      const override = proofPackOutcomes.get(activityInput.runId);
      if (override !== undefined) return override();
      return {
        sha256: "9".repeat(64),
        assertionCount: 1,
        limitationCount: 0,
        postedAt: "2026-01-01T03:00:00.000Z",
      };
    },
```

Export `proofPackCalls`, `proofPackOutcomes`, and `heldProofPacks` from the returned object.

- [ ] **Step 3: Run the test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.workflow.config.ts tests/workflow/at-30-proof-pack.test.ts`

Expected: FAIL. The Run ends `FAILED` with `RUN_TIMEOUT`, because the workflow still falls into the residual wait.

- [ ] **Step 4: Add a proxy for the new activity**

In `src/workflows/agent-run.workflow.ts`, next to `publishingActivities`, add:

```ts
/**
 * SDD section 47. The Proof Pack reads five stores and posts one Linear response. It is not a
 * fast activity, and every failure it can meet is transient, so it keeps a generous timeout and
 * the standard retry policy.
 */
const proofPackActivities = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "1 minute",
  retry: { maximumAttempts: 3, initialInterval: "1 second", backoffCoefficient: 2 },
});
```

Copy the exact option names of `publishingActivities`. Read that block first, and match it.

- [ ] **Step 5: Carry the facts the invariant needs**

The workflow already holds `refined`, `resolvedContext`, `validation`, `verification`, `userValidation`, `review`, `repairCount`, `maxRepairs`, `publication`, and `baseCheck`. Three values are loop-scoped and do not survive the `break`. Beside the existing `publishedChangedFiles`, `publishedVerificationSummary`, and `publishedWorktreeSha` declarations, add:

```ts
      // SDD section 68 and section 47 need these values after the loop ends. The successful pass
      // writes them just before it breaks, exactly as the three values above do.
      let publishedVerificationPassed = false;
      let publishedBlockingCount = 0;
      let publishedReviewVerdict: "pass" | "fail" = "fail";
      let publishedReviewPasses = 0;
      let publishedPreviewUrl: string | null = null;
```

In the `if (review.passed)` block, directly beside the three existing assignments, add:

```ts
          publishedVerificationPassed = verification.passed;
          publishedBlockingCount = review.blockingCount;
          publishedReviewVerdict = review.verdict;
          publishedReviewPasses = attempt;
          publishedPreviewUrl = userValidation.previewUrl;
```

- [ ] **Step 6: Replace the residual wait on the success path**

Replace the block that begins at the comment `// The publication succeeded.` and ends at the closing brace of the outer `if`, with:

```ts
      // The publication succeeded. A later stop message and a later timeout message read this
      // value, so neither one claims that Factoree published nothing.
      publishedPullRequestUrl = publication.pullRequestUrl;

      // SDD section 50. A stop that arrived during the publication must end the Run CANCELLED.
      // The pull request already exists, and `cancelRun` names it.
      if (stopRequested) return await cancelRun();

      // SDD section 47. One Proof Pack, built from persisted state, posted as the Linear final
      // response. SDD section 68 forbids READY_FOR_HUMAN without it.
      let proofPack: PublishProofPackActivityOutput;
      try {
        proofPack = await proofPackActivities.publishProofPack({
          runId: id,
          tenantId: input.tenantId,
          projectId: input.projectId,
          sessionId: input.agentSessionId,
          workItem: { title: input.workItem.title, url: input.workItem.url },
          pullRequestUrl: publication.pullRequestUrl,
          commitSha: publication.commitSha,
          patchSha256: publication.patchSha256,
          baseSha: publishInput.baseSha,
          changedFiles: publishedChangedFiles,
          patchByteLength: publication.patchByteLength,
          previewUrl: publishedPreviewUrl,
          repairCount,
          repairLimit: maxRepairs,
          reviewVerdict: publishedReviewVerdict,
          reviewPasses: publishedReviewPasses,
        });
      } catch (error) {
        if (isCancellation(error)) throw error;
        if (stopRequested) return await cancelRun();
        // SDD section 68. The change is published, and Factoree cannot prove it to a human. It
        // must never report a success it cannot prove, so the Run fails and names the pull
        // request.
        return await failRun(
          "COMPLETION_INVARIANT_UNMET",
          "Factoree published the verified change and could not post the Proof Pack. Review the " +
            `pull request by hand. Pull request: ${publication.pullRequestUrl}.`,
        );
      }

      if (stopRequested) return await cancelRun();

      // SDD section 68. Every clause is checked from recorded facts, immediately before the one
      // state that claims success. No agent claim reaches this check.
      const unmet = completionInvariantFailures({
        workItemReady: refined.status === "ready",
        contextContractVersion,
        unresolvedConflict: resolvedContext.unresolvedConflict !== null,
        validationContractVersion,
        validationContractFrozenAt: validation.frozenAt,
        validationPassed: userValidation.passed,
        verificationPassed: publishedVerificationPassed,
        blockingFindingCount: publishedBlockingCount,
        repairCount,
        repairLimit: maxRepairs,
        patchSha256: publication.patchSha256,
        baseUnchanged: baseCheck.fresh,
        pullRequestUrl: publication.pullRequestUrl,
        proofPackSha256: proofPack.sha256,
      });

      if (unmet.length > 0) {
        return await failRun(
          "COMPLETION_INVARIANT_UNMET",
          "Factoree published the verified change and cannot report it complete. " +
            `${unmet.join(" ")} Pull request: ${publication.pullRequestUrl}.`,
        );
      }

      // SDD section 48. The Run is complete. This is the one success terminal state.
      status = "READY_FOR_HUMAN";
      await activities.completeRun({
        tenantId: input.tenantId,
        runId: id,
        status,
        completedAt: new Date(Date.now()).toISOString(),
      });
      return { runId: id, status };
    }
```

`userValidation` is loop-scoped. Read the surrounding code first. If the compiler reports that `userValidation` or `validation` is out of scope at this point, hoist the value the same way `publishedChangedFiles` is hoisted, rather than move the check.

- [ ] **Step 7: Add the failure reason to `failRun`**

Add `| "COMPLETION_INVARIANT_UNMET"` to the union of the `failureReason` parameter of `failRun`. The reason maps to `FAILED`, which the existing conditional already produces.

- [ ] **Step 8: Add the patch byte length**

`PublishActivityOutput` has no `patchByteLength`. In `src/activities/publishing.activities.ts`, add:

```ts
  /** SDD section 47. The size of the verified patch, for the human change summary. */
  patchByteLength: number;
```

Set it from the byte length of the captured patch text the activity already holds, at the point where it already computes `patchSha256`. Add `patchByteLength: 812` to the harness `publish` double and to every unit test double the compiler names.

- [ ] **Step 9: Update the two hand-built workflow tests**

`tests/workflow/at-16-deterministic-failure.test.ts` asserts an exact activity-name list. Add `publishProofPack` to that list only if the Run of that test reaches the publication. Read the test first. A failing Run posts no Proof Pack, so the list stays unchanged in that case.

`tests/workflow/at-35-worker-restart.test.ts` builds its own activity map by hand. Add a `publishProofPack` entry that returns the same object as the harness double.

- [ ] **Step 10: Run the workflow suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.workflow.config.ts`

Expected: PASS. Every test that previously expected `FAILED` with `RUN_TIMEOUT` on a successful Run now expects `READY_FOR_HUMAN`. Repair each one. Read each failing assertion, and change only the expectation the new terminal state makes wrong.

- [ ] **Step 11: Run the workflow suite a second time**

Run the same command again. Phase 9 hit two timing-dependent failures a single run missed. A green result once proves nothing.

Expected: PASS again.

- [ ] **Step 12: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`

Expected: both exit 0.

- [ ] **Step 13: Commit**

```bash
git add src tests
git commit -m "feat(workflow): complete a proved Run READY_FOR_HUMAN"
```

---

### Task 7: AT-30 against the real stores

**Files:**
- Create: `tests/acceptance/at-30-proof-pack.test.ts`

**Interfaces:**
- Consumes: `createProofPackActivities` from Task 4, and the Prisma stores.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing test**

Create `tests/acceptance/at-30-proof-pack.test.ts`. Follow the setup of `tests/acceptance/at-25-evidence-completeness.test.ts` exactly: `startDatabase`, `createPrismaClient`, `seedTenantProjectAndRun`, and the Prisma stores. Write these cases:

```ts
/**
 * AT-30. A successful L3 Run creates one Proof Pack that carries the pull request, the
 * validation results, the evidence, the deterministic checks, the review result, the context
 * used, the context conflicts, the known limitations, the repair count, the base SHA, and the
 * patch hash. The test drives the real activity against a real database, so a missing section
 * cannot pass.
 */
```

1. Seed one Run. Save a real Context Contract with one required item, one discoverable item, and one resolved conflict. Save a real frozen Validation Contract with two assertions. Record a real `FAIL` result at attempt 1 and a real `PASS` result at attempt 2 for the first assertion, and one `PASS` at attempt 1 for the second. Record real evidence rows for both, one `deterministic_check` row, one blocking finding at attempt 1, and one non-blocking finding at attempt 2. Call `publishProofPack`. Assert the posted body contains every one of the eleven AT-30 items. Assert one assertion per row of the table.
2. Assert `Run.proofPackSha256` in the database equals the returned `sha256`.
3. Assert the body carries no `RV-1`, because the blocking finding belongs to an earlier attempt a repair closed.
4. Assert a second call posts a body with the identical hash, because the Proof Pack is a function of recorded state.
5. Assert the body is shorter than 60000 characters for a Run with 200 changed files and 40 evidence rows, because SDD section 47 forbids a raw log dump into Linear.

- [ ] **Step 2: Run the test to verify it fails, then passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/acceptance/at-30-proof-pack.test.ts`

Expected: the test drives code that already exists after Task 4, so it can pass at once. If it fails, the defect is in the code, not in the test. Repair the code.

- [ ] **Step 3: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`

Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add tests/acceptance/at-30-proof-pack.test.ts
git commit -m "test(at-30): prove the Proof Pack against a real database"
```

---

### Task 8: AT-32 redaction and the Phase 10 exit condition

**Files:**
- Modify: `tests/unit/at-32-redaction.test.ts`
- Create: `tests/acceptance/phase-10-exit.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Extend AT-32**

Append this case to `tests/unit/at-32-redaction.test.ts`:

```ts
  it("keeps a deliberately printed fixture secret out of the Proof Pack", () => {
    const redactor = new Redactor(["fixture-secret-value-12345"]);
    const body = redactor.redactText(
      renderProofPack({
        // Every free text field a Proof Pack can carry, each one holding the fixture secret.
        // A field the renderer forgets to include would let the secret escape a real Run, so
        // every one of them is loaded here.
        runId: "run-1",
        workItem: { title: "fixture-secret-value-12345", url: null },
        pullRequestUrl: "https://github.com/acme/fixture/pull/1",
        assertions: [
          {
            id: "VAL-API-001",
            requirement: "AC-1",
            statement: "fixture-secret-value-12345",
            method: "http",
            requiredEvidence: ["request-response"],
            result: "PASS",
            reason: "fixture-secret-value-12345",
            evidence: [
              {
                kind: "request-response",
                source: "fixture-secret-value-12345",
                sha256: "a".repeat(64),
                storageRef: "fixture-secret-value-12345",
              },
            ],
          },
        ],
        checks: [
          {
            name: "unit",
            command: "echo fixture-secret-value-12345",
            exitCode: 0,
            passed: true,
            durationMs: 1,
            stdoutSha256: "b".repeat(64),
            stderrSha256: "c".repeat(64),
          },
        ],
        reviewVerdict: "pass",
        reviewPasses: 1,
        findings: [
          {
            id: "RV-2",
            severity: "low",
            category: "style",
            requirement: "AC-1",
            evidence: "fixture-secret-value-12345",
            description: "fixture-secret-value-12345",
            blocking: false,
            decisionReason: "fixture-secret-value-12345",
            attempt: 1,
          },
        ],
        contextItems: [
          {
            ref: "fixture-secret-value-12345",
            authority: "repository_readme",
            classification: "required",
            sourceVersion: "fixture-secret-value-12345",
            contentSha256: null,
            reason: "fixture-secret-value-12345",
          },
        ],
        discoverableItemCount: 0,
        conflicts: [
          {
            id: "CTX-1",
            subject: "fixture-secret-value-12345",
            winnerRef: "fixture-secret-value-12345",
            loserRef: "fixture-secret-value-12345",
            reason: "fixture-secret-value-12345",
          },
        ],
        changedFiles: ["fixture-secret-value-12345.ts"],
        patchByteLength: 1,
        previewUrl: "http://localhost:1/fixture-secret-value-12345",
        baseSha: "d".repeat(40),
        patchSha256: "e".repeat(64),
        commitSha: "f".repeat(40),
        repairCount: 0,
        repairLimit: 2,
      }),
    );
    expect(body).not.toContain("fixture-secret-value-12345");
  });
```

Add the import of `renderProofPack` at the top of that file.

- [ ] **Step 2: Run it**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/at-32-redaction.test.ts`

Expected: PASS.

- [ ] **Step 3: Write the Phase 10 exit test**

Create `tests/acceptance/phase-10-exit.test.ts`. The SDD Phase 10 exit condition is: a human can decide whether to accept the change without reading the Implementer transcript. Prove it by construction:

```ts
/**
 * The Phase 10 exit condition. A human decides on the change from the Proof Pack alone. The
 * three cases below make that claim testable: the Proof Pack answers every question the
 * decision needs, it carries no Implementer transcript and no raw log, and the Run reaches
 * READY_FOR_HUMAN only after it exists.
 */
```

Case 1. Build one Proof Pack from real stores, the same way Task 7 does. Assert every decision question is answered in the body: the pull request link, one row per assertion with its result and its evidence reference, the success criterion statement of each assertion, every deterministic check with its exit code, the review outcome with the blocking count, the preloaded context items with authority and version, the resolved conflicts, the changed files with the patch size, the known limitations with a decision reason, the base SHA, the patch hash, and the repair count.

Case 2. Assert the body holds no Implementer transcript and no raw log. Record a `deterministic_check` evidence row whose metadata carries a `log` key with the text `IMPLEMENTER TRANSCRIPT LINE`. Assert the rendered body does not contain it. This proves the renderer reads named fields and never spreads metadata.

Case 3. Assert `completionInvariantFailures` reports `No Proof Pack exists.` when `proofPackSha256` is null, and reports nothing when it is set. This is the machine-checked form of "the Run is complete only when the human can decide".

- [ ] **Step 4: Run it**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/acceptance/phase-10-exit.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the whole verification**

Run `npm run verify` in stages in the background, and compute a real aggregate exit code across the stages. A naive `echo "exit=$?"` after a loop reports only the last stage. Write the transcript to `docs/build/evidence/phase-10-verify.txt`.

Expected: exit 0. The skip count stays 7.

- [ ] **Step 6: Commit**

```bash
git add tests docs/build/evidence/phase-10-verify.txt
git commit -m "test(phase-10): prove the Proof Pack closes the exit condition"
```

---

## Self-review notes

**Spec coverage.** SDD section 47 sections and the no-raw-log rule: Task 1 and Task 8 case 2. AT-30 eleven items: Task 7. AT-32 for the Proof Pack: Task 8 step 1. SDD section 68: Task 2 and Task 6. SDD section 48 `READY_FOR_HUMAN`: Task 6. SDD section 67 "Proof Pack" checklist, nine boxes: Task 7 covers all nine. SDD section 39 evidence references: Task 4. The Phase 10 exit condition: Task 8.

**Carried findings this plan closes.** "The Reviewer still cannot audit the Validation Plan's success criteria" is closed by the `Success criteria` block of Task 1, which states the frozen statement, the method, the requirement, and the outcome of every assertion. "The Proof Pack should surface a `blocker` or `high` finding that failed only one gate" is closed by the known-limitations section of Task 1, which reports every non-blocking finding with its severity and the reason it did not block.

**Carried findings this plan does not close.** The git version skew of SDD section 46 stays open for Phase 12. The worktree fingerprint gap for an ignored path stays open for Phase 12. The three routes from a real defect to a passing review stay open by design, and the known-limitations section now makes two of them visible to a human.
