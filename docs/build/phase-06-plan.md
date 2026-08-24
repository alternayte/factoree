# Factoree Phase 6 — Validation Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Factoree a Validation Contract that is built and frozen after context resolution and before sandbox preparation, so that every implementation starts after a frozen contract exists, the contract hash is persisted on the Run, and the Implementer receives the contract but cannot change it.

**Architecture:** A new `src/domain/validation/` module holds the contract type, its validation rule, its canonical hash, its rendered document, and a deterministic builder. The builder turns the acceptance criteria that Refinement proposed into observable assertions with an identifier, a source requirement, a method from the SDD section 24 list, required evidence kinds, and permitted preconditions. A new `ValidationContract` and `ValidationAssertion` pair of Prisma models stores the frozen contract once per Run, exactly as `ContextContract` does. A new `src/activities/validation.activities.ts` freezes the contract and writes its SHA-256 to `Run.validationContractVersion`. The workflow gains the `BUILDING_VALIDATION_CONTRACT` state between `RESOLVING_CONTEXT` and `PREPARING`, and it passes the rendered contract to the Implementer.

**Tech Stack:** TypeScript (strict), Node.js 24 LTS, npm, Temporal TypeScript SDK, Prisma, PostgreSQL, Vitest, Testcontainers, prom-client.

**Spec:** `docs/sdd.md` (version 2.0, SHA-256 `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`)

## Global Constraints

These hold for every task. Every value is copied from the SDD.

- Production runtime is Node.js 24 LTS. Bun MUST NOT run Temporal Worker code (SDD section 11).
- TypeScript MUST keep `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true` (SDD section 10).
- npm with a committed `package-lock.json` (SDD section 10).
- Provider SDKs and provider HTTP clients MUST stay in `src/adapters/**`. Core workflow policy MUST NOT import a provider client (SDD section 14).
- Source layout MUST follow SDD section 63. Phase 6 fills `src/domain/validation/` and `src/activities/validation.activities.ts`.
- Tenant boundary is the Linear workspace. Every tenant-owned persisted record MUST carry a tenant identifier, and every read MUST filter on it (SDD section 52).
- Factoree MUST NOT log an OAuth token, a GitHub token, a model API key, a Project secret, or an authorization header (SDD section 60).
- Factoree MUST create and freeze the Validation Contract before implementation starts (SDD section 24).
- Each assertion MUST define a unique identifier, a source requirement, an observable behavior, a validation method, required evidence, and permitted preconditions (SDD section 24).
- The allowed methods are exactly `command`, `test`, `http`, `browser`, `code_review`, `manual` (SDD section 24).
- After implementation starts, the active Validation Contract MUST NOT change. Any change creates a new version. The Implementer, the User Validator, and the Reviewer MUST NOT weaken the contract (SDD section 25).
- The Implementer receives the frozen Validation Contract and MUST NOT receive authority to change it (SDD section 34).
- Implementation can start only when the Validation Contract is valid and frozen, and only when at least one observable success assertion exists (SDD section 9).
- Run state names MUST stay exactly the names of SDD section 48. Phase 6 adds no state name; it activates `BUILDING_VALIDATION_CONTRACT`, which already exists in the list.
- Instruction precedence places the frozen Validation Contract above Work Item constraints and below recorded human decisions (SDD section 57).
- Required checks MUST NOT use `continue-on-error`. `npm run verify` MUST pass (SDD section 65).

---

## Phase 6 scope (SDD section 69)

> Build contract generation, immutable hash, and command/test/http/browser assertion types.
> **Exit:** every implementation starts after a frozen validation contract exists.

**In scope:** the `ValidationContract` and `ValidationAssertion` entities of SDD section 53, their Prisma models, one migration, and their store; the contract type, its validation rule, its canonical hash, and its rendered document; the deterministic builder that produces `command`, `test`, `http`, `browser`, `code_review`, and `manual` assertions from the proposed acceptance criteria; `Run.validationContractVersion`; the `validation.activities.ts` freeze activity; the `BUILDING_VALIDATION_CONTRACT` workflow state and the readiness gate of SDD section 9 item 5; delivery of the frozen contract to the Implementer prompt; AT-10 and AT-11; the Phase 6 exit test.

**Out of scope (later phases, do not build):** assertion execution and assertion results, `PASS`, `FAIL`, `BLOCKED`, and `MANUAL_REQUIRED` (Phase 7); preview startup, Playwright, HTTP validation, evidence capture, and Linear evidence upload (Phase 7); the User Validator role and its fresh context (Phase 7); the Reviewer, the finding schema, and the repair loop (Phase 8); patch capture and publishing (Phase 9); the Proof Pack assertion table (Phase 10); a model-driven builder and `prompts/validation-builder.md` (see controller decision 6); a success terminal state, which still does not exist after Phase 6.

---

## Decisions taken by the controller

Recorded so a later reviewer does not treat them as drift.

1. **The Validation Contract is built after the Context Contract is frozen and before the sandbox exists.** SDD section 49 places `build and freeze validation contract` between `resolve context` and `prepare sandbox`, and SDD section 48 names the state `BUILDING_VALIDATION_CONTRACT`. The builder therefore reads no repository and no sandbox. It is a pure function of the Goal, the proposed acceptance criteria, the Work Item constraints, and the recorded human decisions.

2. **The builder is deterministic, and the assertion source is the acceptance criterion.** SDD section 7 forbids Factoree to invent material product behavior. Every assertion therefore restates one acceptance criterion that Refinement already proposed or that a human already stated, and it records that criterion identifier in the `requirement` field. The builder invents no behavior; it chooses a method and an evidence set for a statement a human can read.

3. **A contract with no assertion is not valid, and it does not freeze.** SDD section 9 item 5 requires at least one observable success assertion before implementation can start. The activity therefore returns `needs_input` instead of freezing, the workflow asks one focused question through the existing `askAndWait` helper, and the human answer becomes an acceptance criterion of source `human:decision`. An unanswered question ends the Run with the new failure reason `VALIDATION_UNRESOLVED`.

4. **The default method is `manual`.** A statement that matches no method rule is still observable by a human, and SDD section 36 gives Phase 7 the result `MANUAL_REQUIRED` for exactly that case. Guessing `test` for an unrecognized statement would claim an automated proof Factoree cannot produce, which is the unsafe direction.

5. **The frozen hash is the contract version.** `Run.validationContractVersion` holds the SHA-256 of the canonical contract, exactly as `Run.contextContractVersion` holds the context hash. SDD section 25 says a change creates a new version, and a content hash is the only version identifier that cannot drift from its content.

6. **Phase 6 writes no `prompts/validation-builder.md`.** SDD section 56 requires each `AgentExecution` to record its prompt version. The Phase 6 builder starts no agent and creates no `AgentExecution`, so it has no prompt version to record. The file belongs to the phase that makes the builder model-driven. This is recorded as a carried finding, not as a silent omission.

7. **The store offers `save` and `findByRun` only.** SDD section 25 forbids a change to the active contract, so the port exposes no update and no delete. `save` is idempotent per Run, so a Temporal activity retry can never write a second contract. This mirrors `ContextContractStore`, which the same rule already governs.

8. **The Implementer receives the rendered document, not the store.** SDD section 34 gives the Implementer the frozen contract and denies it the authority to change the contract. The prompt therefore carries text, and no sandbox path and no credential reach the contract store. AT-11 tests this property against the store, not against a prompt sentence.

---

## Requirement mapping

| SDD requirement | Task |
| --- | --- |
| Section 24 — contract exists, is frozen before implementation, assertion fields, method list | Tasks 1, 2, 5, 6 |
| Section 25 — immutability, a change creates a new version | Tasks 1, 3, 7, 8 |
| Section 9 item 5 — at least one observable success assertion | Tasks 2, 6 |
| Section 9 item 9 — contract valid and frozen before implementation | Tasks 5, 6 |
| Section 34 — the Implementer receives the frozen contract, and no authority over it | Tasks 7, 8 |
| Section 48 — `BUILDING_VALIDATION_CONTRACT` | Task 6 |
| Section 49 — build and freeze between context and sandbox | Task 6 |
| Section 53 — `ValidationContract`, `ValidationAssertion`, `Run.validation_contract_version` | Tasks 3, 4 |
| Section 52 — tenant on every persisted record, and on every read | Tasks 3, 4 |
| Section 63 — `src/domain/validation/`, `src/activities/validation.activities.ts` | Tasks 1, 2, 5 |
| AT-10 — creation time and hash exist before Implementer start time | Task 8 |
| AT-11 — an Implementer cannot alter the active contract | Task 8 |
| Section 69 Phase 6 exit | Task 8 |

---

## File structure

- Create `src/domain/validation/validation-contract.ts` — the contract type, the method list, the evidence list, `validateValidationContract`, `hashValidationContract`, `renderValidationContract`.
- Create `src/domain/validation/validation-contract-builder.ts` — `buildValidationContract`, the method rules, the evidence map, the identifier scheme, the precondition rule.
- Create `src/domain/validation/validation-contract-store.ts` — the port and its record types.
- Create `src/persistence/prisma/validation-contract.prisma.ts` — `PrismaValidationContractStore`.
- Create `prisma/migrations/20260825120000_add_validation_contract/migration.sql`.
- Create `src/activities/validation.activities.ts` — `createValidationActivities`.
- Create `tests/unit/validation-contract.test.ts`, `tests/unit/validation-contract-builder.test.ts`, `tests/unit/validation-activity.test.ts`.
- Create `tests/integration/validation-contract-store.test.ts`.
- Create `tests/acceptance/at-10-validation-created-first.test.ts`, `tests/acceptance/at-11-validation-immutability.test.ts`, `tests/acceptance/phase-06-exit.test.ts`.
- Create `tests/workflow/validation-contract.workflow.test.ts`.
- Modify `prisma/schema.prisma` — two models, plus the `Run` back relation.
- Modify `src/domain/runs/run-status.ts` — add the failure reason `VALIDATION_UNRESOLVED`.
- Modify `src/domain/runs/run-repository.ts` and `src/persistence/prisma/run-repository.prisma.ts` — `setValidationContractVersion`.
- Modify `src/activities/index.ts` — register the validation activities.
- Modify `src/activities/refinement.activities.ts` — expose the criterion identifiers.
- Modify `src/activities/agent.activities.ts` — accept and forward `validationContract`.
- Modify `src/bin/worker.ts` — construct the store.
- Modify `src/telemetry/metrics.ts` — one histogram.
- Modify `src/workflows/agent-run.workflow.ts` — the new state, the readiness gate, the snapshot field, the Implementer input.

---

## Task 1: The Validation Contract type, its validation rule, its hash, and its document

**Files:**
- Create: `src/domain/validation/validation-contract.ts`
- Test: `tests/unit/validation-contract.test.ts`

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces: `VALIDATION_CONTRACT_VERSION`, `VALIDATION_METHODS`, `ValidationMethod`, `VALIDATION_EVIDENCE_KINDS`, `ValidationEvidenceKind`, `ValidationAssertion`, `ValidationContract`, `ValidationContractInvalidError`, `validateValidationContract(contract: ValidationContract): void`, `hashValidationContract(contract: ValidationContract): string`, `renderValidationContract(contract: ValidationContract): string`, `isValidationMethod(value: string): value is ValidationMethod`, `isValidationEvidenceKind(value: string): value is ValidationEvidenceKind`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/validation-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  hashValidationContract,
  renderValidationContract,
  validateValidationContract,
  ValidationContractInvalidError,
  type ValidationAssertion,
  type ValidationContract,
} from "~/domain/validation/validation-contract.js";

const assertion = (overrides: Partial<ValidationAssertion> = {}): ValidationAssertion => ({
  id: "VAL-API-001",
  requirement: "AC-1",
  statement: "PATCH /projects/{id} returns 403 for a user without edit permission.",
  method: "http",
  evidence: ["request-response"],
  preconditions: [],
  ...overrides,
});

const contract = (overrides: Partial<ValidationContract> = {}): ValidationContract => ({
  version: 1,
  runId: "run-1",
  workItem: "ENG-143",
  goal: "Deny an edit to a user without permission.",
  assertions: [assertion()],
  ...overrides,
});

describe("validateValidationContract", () => {
  it("accepts a contract whose assertion carries every required field", () => {
    expect(() => validateValidationContract(contract())).not.toThrow();
  });

  it("rejects a contract with no assertion, because SDD section 9 requires one", () => {
    expect(() => validateValidationContract(contract({ assertions: [] }))).toThrow(
      ValidationContractInvalidError,
    );
  });

  it("rejects a duplicate assertion identifier", () => {
    const contractValue = contract({ assertions: [assertion(), assertion()] });
    expect(() => validateValidationContract(contractValue)).toThrow(/appears twice/);
  });

  it("rejects an assertion with no source requirement", () => {
    const contractValue = contract({ assertions: [assertion({ requirement: "  " })] });
    expect(() => validateValidationContract(contractValue)).toThrow(/source requirement/);
  });

  it("rejects an assertion with no observable statement", () => {
    const contractValue = contract({ assertions: [assertion({ statement: "" })] });
    expect(() => validateValidationContract(contractValue)).toThrow(/observable behavior/);
  });

  it("rejects an unknown method", () => {
    const contractValue = contract({
      assertions: [assertion({ method: "telepathy" as ValidationAssertion["method"] })],
    });
    expect(() => validateValidationContract(contractValue)).toThrow(/method/);
  });

  it("rejects an assertion that requires no evidence", () => {
    const contractValue = contract({ assertions: [assertion({ evidence: [] })] });
    expect(() => validateValidationContract(contractValue)).toThrow(/evidence/);
  });

  it("rejects an unknown evidence kind", () => {
    const contractValue = contract({
      assertions: [
        assertion({ evidence: ["vibes" as ValidationAssertion["evidence"][number]] }),
      ],
    });
    expect(() => validateValidationContract(contractValue)).toThrow(/evidence/);
  });

  it("rejects a contract with no goal", () => {
    expect(() => validateValidationContract(contract({ goal: " " }))).toThrow(/goal/);
  });
});

describe("hashValidationContract", () => {
  it("gives one contract one hash, whatever the key order was", () => {
    const left = hashValidationContract(contract());
    const right = hashValidationContract(
      JSON.parse(
        JSON.stringify({
          assertions: contract().assertions,
          goal: contract().goal,
          runId: "run-1",
          version: 1,
          workItem: "ENG-143",
        }),
      ) as ValidationContract,
    );
    expect(left).toBe(right);
  });

  it("changes when an assertion changes", () => {
    const weakened = contract({ assertions: [assertion({ evidence: ["human-confirmation"] })] });
    expect(hashValidationContract(weakened)).not.toBe(hashValidationContract(contract()));
  });

  it("is a SHA-256 hexadecimal digest", () => {
    expect(hashValidationContract(contract())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("renderValidationContract", () => {
  it("names the Work Item, every assertion identifier, its method, and its evidence", () => {
    const document = renderValidationContract(contract());
    expect(document).toContain("ENG-143");
    expect(document).toContain("VAL-API-001");
    expect(document).toContain("AC-1");
    expect(document).toContain("http");
    expect(document).toContain("request-response");
  });

  it("states the immutability rule of SDD section 25", () => {
    expect(renderValidationContract(contract())).toContain("must not");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/validation-contract.test.ts`
Expected: FAIL, because `src/domain/validation/validation-contract.ts` does not resolve.

- [ ] **Step 3: Write minimal implementation**

Create `src/domain/validation/validation-contract.ts`:

```ts
import { createHash } from "node:crypto";

/** SDD section 24 fixes the document schema version. */
export const VALIDATION_CONTRACT_VERSION = 1 as const;

/** SDD section 24 lists exactly these methods. No other value is allowed. */
export const VALIDATION_METHODS = [
  "command",
  "test",
  "http",
  "browser",
  "code_review",
  "manual",
] as const;

export type ValidationMethod = (typeof VALIDATION_METHODS)[number];

/**
 * SDD section 24 requires each assertion to name its required evidence. SDD section 37 lists the
 * browser evidence kinds, and SDD section 38 lists what an HTTP assertion records. The remaining
 * kinds name the artefact each other method produces. Phase 7 captures these artefacts. Phase 6
 * only requires them.
 */
export const VALIDATION_EVIDENCE_KINDS = [
  "screenshot",
  "video",
  "trace",
  "network",
  "console",
  "assertion-log",
  "request-response",
  "command-output",
  "test-report",
  "diff-review",
  "human-confirmation",
] as const;

export type ValidationEvidenceKind = (typeof VALIDATION_EVIDENCE_KINDS)[number];

/** SDD section 24. One frozen observable assertion. */
export interface ValidationAssertion {
  id: string;
  /** The acceptance criterion this assertion proves. SDD section 24 calls it the requirement. */
  requirement: string;
  statement: string;
  method: ValidationMethod;
  evidence: ValidationEvidenceKind[];
  /** SDD section 24. The state a validator is permitted to establish before the assertion runs. */
  preconditions: string[];
}

/** SDD section 24. The frozen definition of success for one Run. */
export interface ValidationContract {
  version: typeof VALIDATION_CONTRACT_VERSION;
  runId: string;
  /** The Work Item identifier, or the Run identifier when the Work Item has none. */
  workItem: string;
  goal: string;
  assertions: ValidationAssertion[];
}

export class ValidationContractInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationContractInvalidError";
  }
}

const METHODS = new Set<string>(VALIDATION_METHODS);
const EVIDENCE = new Set<string>(VALIDATION_EVIDENCE_KINDS);

export const isValidationMethod = (value: string): value is ValidationMethod => METHODS.has(value);

export const isValidationEvidenceKind = (value: string): value is ValidationEvidenceKind =>
  EVIDENCE.has(value);

const present = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.trim() !== "";

/**
 * SDD section 9 item 5 requires at least one observable success assertion, and SDD section 9 item
 * 9 requires a valid contract before implementation starts. SDD section 24 fixes the required
 * fields. A contract that fails this rule must never freeze.
 */
export const validateValidationContract = (contract: ValidationContract): void => {
  const fail = (message: string): never => {
    throw new ValidationContractInvalidError(message);
  };

  if (!present(contract.goal)) fail("The Validation Contract records no goal.");
  if (!present(contract.workItem)) fail("The Validation Contract names no Work Item.");
  if (contract.assertions.length === 0) {
    fail(
      "The Validation Contract holds no assertion. SDD section 9 requires at least one " +
        "observable success assertion before implementation can start.",
    );
  }

  const seen = new Set<string>();
  for (const assertion of contract.assertions) {
    const name = present(assertion.id) ? assertion.id : "an assertion with no identifier";
    if (!present(assertion.id)) fail("A validation assertion records no identifier.");
    if (!present(assertion.requirement)) {
      fail(`Validation assertion "${name}" records no source requirement.`);
    }
    if (!present(assertion.statement)) {
      fail(`Validation assertion "${name}" records no observable behavior.`);
    }
    if (!isValidationMethod(assertion.method)) {
      fail(`Validation assertion "${name}" records the unknown method "${assertion.method}".`);
    }
    if (assertion.evidence.length === 0) {
      fail(`Validation assertion "${name}" requires no evidence.`);
    }
    for (const kind of assertion.evidence) {
      if (!isValidationEvidenceKind(kind)) {
        fail(`Validation assertion "${name}" requires the unknown evidence kind "${kind}".`);
      }
    }
    if (seen.has(assertion.id)) fail(`Validation assertion "${name}" appears twice.`);
    seen.add(assertion.id);
  }
};

/** A JSON text whose object keys are sorted, so one contract always hashes the same. */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
  return `{${entries.join(",")}}`;
};

/** SDD section 25. The contract is immutable, and the hash is its identity and its version. */
export const hashValidationContract = (contract: ValidationContract): string =>
  createHash("sha256").update(canonical(contract)).digest("hex");

const assertionBlock = (assertion: ValidationAssertion): string[] => [
  `### ${assertion.id}`,
  "",
  `- requirement: ${assertion.requirement}`,
  `- statement: ${assertion.statement}`,
  `- method: ${assertion.method}`,
  `- evidence: ${assertion.evidence.join(", ")}`,
  `- preconditions: ${assertion.preconditions.length === 0 ? "none" : assertion.preconditions.join("; ")}`,
  "",
];

/**
 * The human-readable Validation Contract. It reaches the Implementer prompt, the User Validator
 * of Phase 7, the Reviewer of Phase 8, and the Proof Pack of Phase 10. It holds no credential and
 * no file body.
 */
export const renderValidationContract = (contract: ValidationContract): string =>
  [
    "# Validation Contract",
    "",
    `version: ${contract.version}`,
    `runId: ${contract.runId}`,
    `workItem: ${contract.workItem}`,
    "",
    "## Goal",
    "",
    contract.goal,
    "",
    "## Assertions",
    "",
    ...contract.assertions.flatMap(assertionBlock),
    "## Rule",
    "",
    "This contract is frozen. You must not change it, and you must not weaken an assertion. " +
      "A change to the required behavior needs a human decision and a new contract version.",
    "",
  ].join("\n");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/validation-contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: exit 0 for both.

- [ ] **Step 6: Commit**

```bash
git add src/domain/validation/validation-contract.ts tests/unit/validation-contract.test.ts
git commit -m "feat(validation): add the Validation Contract type, its rule, and its hash"
```

---

## Task 2: The deterministic Validation Contract builder

**Files:**
- Create: `src/domain/validation/validation-contract-builder.ts`
- Test: `tests/unit/validation-contract-builder.test.ts`

**Interfaces:**
- Consumes: `ValidationAssertion`, `ValidationContract`, `ValidationMethod`, `hashValidationContract`, `renderValidationContract`, `validateValidationContract` from Task 1.
- Produces: `ValidationCriterion { id: string; statement: string; source: string }`, `BuildValidationContractInput { runId: string; workItem: string; goal: string; acceptanceCriteria: ValidationCriterion[]; humanAssertions: string[] }`, `BuiltValidationContract { contract: ValidationContract; sha256: string; document: string }`, `buildValidationContract(input: BuildValidationContractInput): BuiltValidationContract`, `methodFor(statement: string): ValidationMethod`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/validation-contract-builder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildValidationContract,
  methodFor,
  type BuildValidationContractInput,
} from "~/domain/validation/validation-contract-builder.js";
import { validateValidationContract } from "~/domain/validation/validation-contract.js";

const input = (overrides: Partial<BuildValidationContractInput> = {}): BuildValidationContractInput => ({
  runId: "run-1",
  workItem: "ENG-143",
  goal: "A signed-in editor can rename a project.",
  acceptanceCriteria: [
    { id: "AC-1", statement: "A signed-in editor can change the project name and the new name remains visible after reload.", source: "work-item" },
    { id: "AC-2", statement: "PATCH /projects/{id} returns 403 for a user without edit permission.", source: "work-item" },
  ],
  humanAssertions: [],
  ...overrides,
});

describe("methodFor", () => {
  it("chooses http for a statement that names an HTTP method and a path", () => {
    expect(methodFor("PATCH /projects/{id} returns 403 for a user without edit permission.")).toBe("http");
  });

  it("chooses browser for a statement about a page a person uses", () => {
    expect(methodFor("A signed-in editor can click Save and the new name remains visible after reload.")).toBe("browser");
  });

  it("chooses test for a statement about the test suite", () => {
    expect(methodFor("The unit tests for the rename service pass.")).toBe("test");
  });

  it("chooses command for a statement about a command and its exit code", () => {
    expect(methodFor("The command npm run build exits with code 0.")).toBe("command");
  });

  it("chooses code_review for a statement about a review of the source", () => {
    expect(methodFor("A code review confirms that no production file imports the fixture module.")).toBe("code_review");
  });

  it("chooses manual when no rule matches, because Factoree must not claim an automated proof", () => {
    expect(methodFor("The product feels faster.")).toBe("manual");
  });

  it("prefers http over browser when the statement names both", () => {
    expect(methodFor("The page calls POST /projects and shows the result.")).toBe("http");
  });
});

describe("buildValidationContract", () => {
  it("produces one assertion for each acceptance criterion, and records the criterion identifier", () => {
    const built = buildValidationContract(input());
    expect(built.contract.assertions).toHaveLength(2);
    expect(built.contract.assertions.map((assertion) => assertion.requirement)).toEqual(["AC-1", "AC-2"]);
  });

  it("names each assertion by its method, and numbers it inside that method", () => {
    const built = buildValidationContract(input());
    expect(built.contract.assertions[0]?.id).toBe("VAL-UI-001");
    expect(built.contract.assertions[1]?.id).toBe("VAL-API-001");
  });

  it("requires the SDD section 37 browser evidence for a browser assertion", () => {
    const built = buildValidationContract(input());
    expect(built.contract.assertions[0]?.evidence).toEqual(["screenshot", "network", "assertion-log"]);
  });

  it("requires the SDD section 38 request and response evidence for an HTTP assertion", () => {
    const built = buildValidationContract(input());
    expect(built.contract.assertions[1]?.evidence).toEqual(["request-response"]);
  });

  it("reads a leading Given clause as a permitted precondition", () => {
    const built = buildValidationContract(
      input({
        acceptanceCriteria: [
          { id: "AC-1", statement: "Given a project named Old, the editor can rename it on the project page.", source: "work-item" },
        ],
      }),
    );
    expect(built.contract.assertions[0]?.preconditions).toEqual(["a project named Old"]);
    expect(built.contract.assertions[0]?.statement).toBe("the editor can rename it on the project page.");
  });

  it("turns a recorded human answer into an assertion of its own", () => {
    const built = buildValidationContract(
      input({ acceptanceCriteria: [], humanAssertions: ["The rename button is disabled for a viewer."] }),
    );
    expect(built.contract.assertions).toHaveLength(1);
    expect(built.contract.assertions[0]?.requirement).toBe("AC-H1");
  });

  it("produces no assertion when nothing observable was stated", () => {
    const built = buildValidationContract(input({ acceptanceCriteria: [], humanAssertions: [] }));
    expect(built.contract.assertions).toEqual([]);
  });

  it("produces a valid contract, its hash, and its document when at least one assertion exists", () => {
    const built = buildValidationContract(input());
    expect(() => validateValidationContract(built.contract)).not.toThrow();
    expect(built.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(built.document).toContain("VAL-UI-001");
  });

  it("is deterministic, so the same input always freezes to the same hash", () => {
    expect(buildValidationContract(input()).sha256).toBe(buildValidationContract(input()).sha256);
  });

  it("skips a criterion whose statement is empty", () => {
    const built = buildValidationContract(
      input({ acceptanceCriteria: [{ id: "AC-1", statement: "   ", source: "work-item" }], humanAssertions: [] }),
    );
    expect(built.contract.assertions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/validation-contract-builder.test.ts`
Expected: FAIL, because the builder module does not resolve.

- [ ] **Step 3: Write minimal implementation**

Create `src/domain/validation/validation-contract-builder.ts`:

```ts
import {
  hashValidationContract,
  renderValidationContract,
  VALIDATION_CONTRACT_VERSION,
  type ValidationAssertion,
  type ValidationContract,
  type ValidationEvidenceKind,
  type ValidationMethod,
} from "./validation-contract.js";

/** One acceptance criterion Refinement proposed, or one a human stated. */
export interface ValidationCriterion {
  id: string;
  statement: string;
  source: string;
}

export interface BuildValidationContractInput {
  runId: string;
  workItem: string;
  goal: string;
  acceptanceCriteria: ValidationCriterion[];
  /**
   * SDD section 9 item 5. A Work Item that states no observable outcome blocks the Run. The
   * workflow asks one focused question, and the human answer arrives here as a stated assertion.
   */
  humanAssertions: string[];
}

export interface BuiltValidationContract {
  contract: ValidationContract;
  sha256: string;
  document: string;
}

/** An explicit HTTP method followed by a path. This is the strongest signal a statement carries. */
const HTTP_CALL = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b\s+\/\S*/;

const containsWord = (statement: string, words: readonly string[]): boolean => {
  const lower = statement.toLowerCase();
  return words.some((word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, "i").test(lower));
};

const HTTP_WORDS = ["endpoint", "http status", "returns 200", "returns 401", "returns 403", "returns 404", "returns 500"] as const;

const BROWSER_WORDS = [
  "page", "screen", "click", "clicks", "button", "reload", "browser", "form", "visible",
  "navigate", "navigates", "signed-in", "sign in", "signs in", "modal", "dialog", "menu",
] as const;

const TEST_WORDS = ["test", "tests", "unit test", "integration test", "test suite", "coverage"] as const;

const COMMAND_WORDS = ["command", "cli", "exit code", "exits with", "build", "lint", "script", "npm run"] as const;

const REVIEW_WORDS = ["code review", "reviewed", "review confirms", "no production file"] as const;

/**
 * The rule order is the confidence order. An explicit HTTP call beats every other signal, because
 * it names the observable exactly. Controller decision 4 makes `manual` the default: an
 * unrecognized statement is still observable by a human, and Factoree must not claim an automated
 * proof it cannot produce.
 */
export const methodFor = (statement: string): ValidationMethod => {
  if (HTTP_CALL.test(statement)) return "http";
  if (containsWord(statement, REVIEW_WORDS)) return "code_review";
  if (containsWord(statement, HTTP_WORDS)) return "http";
  if (containsWord(statement, BROWSER_WORDS)) return "browser";
  if (containsWord(statement, TEST_WORDS)) return "test";
  if (containsWord(statement, COMMAND_WORDS)) return "command";
  return "manual";
};

/**
 * SDD section 37 lists the browser evidence kinds, and SDD section 38 fixes what an HTTP
 * assertion records. Each other method names the one artefact that proves it.
 */
const EVIDENCE_FOR: Record<ValidationMethod, readonly ValidationEvidenceKind[]> = {
  browser: ["screenshot", "network", "assertion-log"],
  http: ["request-response"],
  command: ["command-output"],
  test: ["test-report"],
  code_review: ["diff-review"],
  manual: ["human-confirmation"],
};

/** SDD section 24 names an assertion by its kind, for example `VAL-UI-001` and `VAL-API-001`. */
const PREFIX_FOR: Record<ValidationMethod, string> = {
  browser: "UI",
  http: "API",
  command: "CMD",
  test: "TEST",
  code_review: "REV",
  manual: "MAN",
};

const GIVEN = /^given\s+(.+?),\s*(.+)$/i;

/**
 * A statement that starts with "Given X, Y" states the permitted precondition X and the
 * observable behavior Y. SDD section 24 requires both fields, and this split invents neither.
 */
const splitPrecondition = (statement: string): { statement: string; preconditions: string[] } => {
  const match = GIVEN.exec(statement);
  if (match === null) return { statement, preconditions: [] };
  const precondition = match[1] ?? "";
  const behavior = match[2] ?? "";
  if (precondition.trim() === "" || behavior.trim() === "") return { statement, preconditions: [] };
  return { statement: behavior.trim(), preconditions: [precondition.trim()] };
};

const assertionsOf = (criteria: ValidationCriterion[]): ValidationAssertion[] => {
  const counters = new Map<ValidationMethod, number>();
  const assertions: ValidationAssertion[] = [];

  for (const criterion of criteria) {
    const raw = criterion.statement.trim();
    if (raw === "") continue;
    const split = splitPrecondition(raw);
    const method = methodFor(split.statement);
    const next = (counters.get(method) ?? 0) + 1;
    counters.set(method, next);
    assertions.push({
      id: `VAL-${PREFIX_FOR[method]}-${String(next).padStart(3, "0")}`,
      requirement: criterion.id,
      statement: split.statement,
      method,
      evidence: [...EVIDENCE_FOR[method]],
      preconditions: split.preconditions,
    });
  }

  return assertions;
};

/**
 * SDD section 24. The builder is deterministic, so one input always freezes to one hash. It
 * invents no behavior: every assertion restates one acceptance criterion, and it records that
 * criterion identifier. See controller decision 2.
 */
export const buildValidationContract = (
  input: BuildValidationContractInput,
): BuiltValidationContract => {
  const stated: ValidationCriterion[] = input.humanAssertions
    .map((statement, index) => ({
      id: `AC-H${index + 1}`,
      statement,
      source: "human:decision",
    }))
    .filter((criterion) => criterion.statement.trim() !== "");

  const contract: ValidationContract = {
    version: VALIDATION_CONTRACT_VERSION,
    runId: input.runId,
    workItem: input.workItem,
    goal: input.goal,
    assertions: assertionsOf([...input.acceptanceCriteria, ...stated]),
  };

  return {
    contract,
    sha256: hashValidationContract(contract),
    document: renderValidationContract(contract),
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/validation-contract-builder.test.ts`
Expected: PASS.

- [ ] **Step 5: Run lint and typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: exit 0 for both.

- [ ] **Step 6: Commit**

```bash
git add src/domain/validation/validation-contract-builder.ts tests/unit/validation-contract-builder.test.ts
git commit -m "feat(validation): build assertions from the proposed acceptance criteria"
```

---

## Task 3: The store port, the Prisma models, the migration, and the store

**Files:**
- Create: `src/domain/validation/validation-contract-store.ts`
- Create: `src/persistence/prisma/validation-contract.prisma.ts`
- Create: `prisma/migrations/20260825120000_add_validation_contract/migration.sql`
- Modify: `prisma/schema.prisma`
- Test: `tests/integration/validation-contract-store.test.ts`

**Interfaces:**
- Consumes: `ValidationAssertion`, `ValidationContract` from Task 1.
- Produces: `StoredValidationContract`, `SaveValidationContractInput`, `ValidationContractStore` with `save(input): Promise<StoredValidationContract>` and `findByRun(tenantId: string, runId: string): Promise<StoredValidationContract | null>`, `PrismaValidationContractStore`, `ValidationContractRowInvalidError`.

- [ ] **Step 1: Write the port**

Create `src/domain/validation/validation-contract-store.ts`:

```ts
import type { ValidationAssertion, ValidationContract } from "./validation-contract.js";

export interface StoredValidationContract {
  id: string;
  tenantId: string;
  runId: string;
  version: number;
  sha256: string;
  workItem: string;
  goal: string;
  document: string;
  assertions: ValidationAssertion[];
  createdAt: Date;
}

export interface SaveValidationContractInput {
  tenantId: string;
  runId: string;
  contract: ValidationContract;
  sha256: string;
  document: string;
}

/**
 * SDD section 25 forbids a change to the active Validation Contract, so the port offers no update
 * and no delete. `save` is idempotent. A second call for the same Run returns the contract already
 * stored, so a Temporal activity retry can never write a second version. See controller decision 7.
 */
export interface ValidationContractStore {
  save(input: SaveValidationContractInput): Promise<StoredValidationContract>;
  findByRun(tenantId: string, runId: string): Promise<StoredValidationContract | null>;
}
```

- [ ] **Step 2: Add the Prisma models**

Modify `prisma/schema.prisma`. Add the two models after `ContextConflict`, and add the back relation `validationContract ValidationContract?` to `model Run` beside the existing `contextContract` relation. Read the existing `ContextContract` model first and copy its shape.

```prisma
model ValidationContract {
  id          String   @id @default(uuid())
  tenantId    String
  runId       String   @unique
  run         Run      @relation(fields: [runId], references: [id], onDelete: Cascade)
  // SDD section 24 fixes the document schema version. `Run.validationContractVersion` holds the
  // SHA-256 below, because that value identifies the exact frozen contract. See controller
  // decision 5.
  version     Int
  sha256      String
  workItem    String
  goal        String
  // The rendered contract. It reaches the Implementer, the User Validator, and the Proof Pack.
  document    String
  createdAt   DateTime @default(now())
  assertions  ValidationAssertion[]

  @@index([tenantId])
}

model ValidationAssertion {
  id                   String             @id @default(uuid())
  tenantId             String
  validationContractId String
  validationContract   ValidationContract @relation(fields: [validationContractId], references: [id], onDelete: Cascade)
  // SDD section 24 requires a unique identifier, a source requirement, an observable behavior, a
  // method, required evidence, and permitted preconditions on every assertion.
  assertionKey         String
  requirement          String
  statement            String
  method               String
  evidence             String[]
  preconditions        String[]

  @@unique([validationContractId, assertionKey])
  @@index([tenantId])
}
```

- [ ] **Step 3: Write the migration by hand**

Create `prisma/migrations/20260825120000_add_validation_contract/migration.sql`. The environment notes say every migration so far was written by hand and applied through the Testcontainers database. This migration creates two new tables only, so it is safe against a populated database.

```sql
-- SDD section 53. The frozen Validation Contract of one Run, and its assertions.
CREATE TABLE "ValidationContract" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "workItem" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationContract_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ValidationContract_runId_key" ON "ValidationContract"("runId");
CREATE INDEX "ValidationContract_tenantId_idx" ON "ValidationContract"("tenantId");

ALTER TABLE "ValidationContract"
    ADD CONSTRAINT "ValidationContract_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ValidationAssertion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "validationContractId" TEXT NOT NULL,
    "assertionKey" TEXT NOT NULL,
    "requirement" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "evidence" TEXT[],
    "preconditions" TEXT[],

    CONSTRAINT "ValidationAssertion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ValidationAssertion_validationContractId_assertionKey_key"
    ON "ValidationAssertion"("validationContractId", "assertionKey");
CREATE INDEX "ValidationAssertion_tenantId_idx" ON "ValidationAssertion"("tenantId");

ALTER TABLE "ValidationAssertion"
    ADD CONSTRAINT "ValidationAssertion_validationContractId_fkey"
    FOREIGN KEY ("validationContractId") REFERENCES "ValidationContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 4: Regenerate the Prisma client**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH DATABASE_URL=postgresql://factoree:factoree@localhost:5432/factoree npx prisma generate`
Expected: exit 0. The `DATABASE_URL` value is required because the Prisma CLI resolves it eagerly. No database is contacted by `generate`.

- [ ] **Step 5: Write the failing integration test**

Create `tests/integration/validation-contract-store.test.ts`. Read an existing integration test, for example `tests/integration/context-contract-store.test.ts` if it exists, or the nearest Prisma store test, and copy its Testcontainers setup exactly. The test body:

```ts
import { describe, expect, it } from "vitest";
import { PrismaValidationContractStore } from "~/persistence/prisma/validation-contract.prisma.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
// The database fixture, the tenant fixture, the project fixture, and the Run fixture come from the
// existing integration support module. Use the same import the neighbouring store test uses.

const contractOf = (runId: string): ValidationContract => ({
  version: 1,
  runId,
  workItem: "ENG-143",
  goal: "A signed-in editor can rename a project.",
  assertions: [
    {
      id: "VAL-API-001",
      requirement: "AC-2",
      statement: "PATCH /projects/{id} returns 403 for a user without edit permission.",
      method: "http",
      evidence: ["request-response"],
      preconditions: ["a project the user cannot edit"],
    },
  ],
});

describe("PrismaValidationContractStore", () => {
  it("stores a contract with every assertion field and reads it back", async () => {
    // save, then findByRun, then expect the assertion, the method, the evidence array, and the
    // preconditions array to survive the round trip unchanged.
  });

  it("is idempotent, so a retry returns the contract already frozen", async () => {
    // save twice with a different document, then expect the same id and the first document.
  });

  it("answers null for another tenant, because SDD section 52 scopes every read", async () => {
    // findByRun("other-tenant", runId) must be null even though the row exists.
  });

  it("rejects a row whose method column holds a value the SDD does not allow", async () => {
    // Update the row through the raw Prisma client to method "telepathy", then expect findByRun
    // to reject with ValidationContractRowInvalidError.
  });
});
```

Fill each body with real code from the neighbouring store test. Do not leave a comment in place of an assertion.

- [ ] **Step 6: Run the test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/validation-contract-store.test.ts`
Expected: FAIL, because `PrismaValidationContractStore` does not resolve. Docker must be running.

- [ ] **Step 7: Write the store**

Create `src/persistence/prisma/validation-contract.prisma.ts`. Copy the shape of `src/persistence/prisma/context-contract.prisma.ts`. It guards each column value it reads back and never casts one.

```ts
import type { PrismaClient } from "@prisma/client";
import type {
  SaveValidationContractInput,
  StoredValidationContract,
  ValidationContractStore,
} from "~/domain/validation/validation-contract-store.js";
import type {
  ValidationAssertion,
  ValidationEvidenceKind,
  ValidationMethod,
} from "~/domain/validation/validation-contract.js";
import {
  isValidationEvidenceKind,
  isValidationMethod,
} from "~/domain/validation/validation-contract.js";

/** The store throws this error when a column holds a value no domain list allows. */
export class ValidationContractRowInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationContractRowInvalidError";
  }
}

const toMethod = (value: string, key: string): ValidationMethod => {
  if (!isValidationMethod(value)) {
    throw new ValidationContractRowInvalidError(
      `Validation assertion "${key}" holds the unknown method "${value}".`,
    );
  }
  return value;
};

const toEvidence = (values: string[], key: string): ValidationEvidenceKind[] =>
  values.map((value) => {
    if (!isValidationEvidenceKind(value)) {
      throw new ValidationContractRowInvalidError(
        `Validation assertion "${key}" holds the unknown evidence kind "${value}".`,
      );
    }
    return value;
  });

interface AssertionRow {
  assertionKey: string;
  requirement: string;
  statement: string;
  method: string;
  evidence: string[];
  preconditions: string[];
}

interface ContractRow {
  id: string;
  tenantId: string;
  runId: string;
  version: number;
  sha256: string;
  workItem: string;
  goal: string;
  document: string;
  createdAt: Date;
  assertions: AssertionRow[];
}

const toAssertion = (row: AssertionRow): ValidationAssertion => ({
  id: row.assertionKey,
  requirement: row.requirement,
  statement: row.statement,
  method: toMethod(row.method, row.assertionKey),
  evidence: toEvidence(row.evidence, row.assertionKey),
  preconditions: row.preconditions,
});

const toStored = (row: ContractRow): StoredValidationContract => ({
  id: row.id,
  tenantId: row.tenantId,
  runId: row.runId,
  version: row.version,
  sha256: row.sha256,
  workItem: row.workItem,
  goal: row.goal,
  document: row.document,
  assertions: row.assertions.map(toAssertion),
  createdAt: row.createdAt,
});

export class PrismaValidationContractStore implements ValidationContractStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * SDD section 25. The contract is immutable, so an existing contract wins and the store writes
   * nothing. A Temporal activity retry therefore cannot produce a second version. Prisma writes
   * the contract and every assertion in one nested create, which runs in one transaction.
   */
  async save(input: SaveValidationContractInput): Promise<StoredValidationContract> {
    const existing = await this.findByRun(input.tenantId, input.runId);
    if (existing !== null) return existing;

    try {
      const row = await this.prisma.validationContract.create({
        data: {
          tenantId: input.tenantId,
          runId: input.runId,
          version: input.contract.version,
          sha256: input.sha256,
          workItem: input.contract.workItem,
          goal: input.contract.goal,
          document: input.document,
          assertions: {
            create: input.contract.assertions.map((assertion) => ({
              tenantId: input.tenantId,
              assertionKey: assertion.id,
              requirement: assertion.requirement,
              statement: assertion.statement,
              method: assertion.method,
              evidence: assertion.evidence,
              preconditions: assertion.preconditions,
            })),
          },
        },
        include: { assertions: true },
      });
      return toStored(row);
    } catch (error) {
      // Two concurrent attempts can both miss the read above. The unique index on `runId` decides
      // the race. The loser reads the contract the winner wrote, and does not fail the Run.
      const row = await this.findByRun(input.tenantId, input.runId);
      if (row !== null) return row;
      throw error;
    }
  }

  async findByRun(tenantId: string, runId: string): Promise<StoredValidationContract | null> {
    const row = await this.prisma.validationContract.findUnique({
      where: { runId },
      include: { assertions: true },
    });
    // SDD section 52. The read applies the tenant boundary as well as the write.
    if (row === null || row.tenantId !== tenantId) return null;
    return toStored(row);
  }
}
```

- [ ] **Step 8: Run the whole integration suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts`
Expected: PASS. Run the whole suite, not one file. The new migration must apply cleanly for every other integration test as well.

- [ ] **Step 9: Commit**

```bash
git add prisma src/domain/validation/validation-contract-store.ts src/persistence/prisma/validation-contract.prisma.ts tests/integration/validation-contract-store.test.ts
git commit -m "feat(validation): persist the frozen contract and its assertions"
```

---

## Task 4: `Run.validationContractVersion`

**Files:**
- Modify: `src/domain/runs/run-repository.ts`
- Modify: `src/persistence/prisma/run-repository.prisma.ts`
- Modify: `src/domain/runs/run-status.ts`
- Test: `tests/integration/run-repository.test.ts` (extend the existing file; find it first with `ls tests/integration`)

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces: `RunRepository.setValidationContractVersion(tenantId: string, runId: string, version: string): Promise<void>`, the failure reason `VALIDATION_UNRESOLVED`.

The `Run` row already holds the column, and `run-repository.prisma.ts` already maps it. Only the setter is missing.

- [ ] **Step 1: Write the failing test**

Extend the existing Run repository integration test with:

```ts
it("writes the frozen Validation Contract hash to the Run", async () => {
  await runs.setValidationContractVersion(tenantId, run.id, "a".repeat(64));
  const reloaded = await runs.findById(tenantId, run.id);
  expect(reloaded?.validationContractVersion).toBe("a".repeat(64));
});

it("throws when it reaches no Run of that tenant, because a silent success hides a caller defect", async () => {
  await expect(runs.setValidationContractVersion("other-tenant", run.id, "b".repeat(64))).rejects.toThrow();
});
```

Copy the surrounding fixture setup from the test that already covers `setContextContractVersion`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/run-repository.test.ts`
Expected: FAIL, because `setValidationContractVersion` is not a function.

- [ ] **Step 3: Add the port method**

In `src/domain/runs/run-repository.ts`, beside `setContextContractVersion`:

```ts
  /**
   * SDD section 53. `Run.validationContractVersion` holds the SHA-256 of the frozen Validation
   * Contract, because that value names the exact contract the Run must satisfy. See controller
   * decision 5. The method throws when it reaches no Run of that tenant, because a silent success
   * hides a caller defect.
   */
  setValidationContractVersion(tenantId: string, runId: string, version: string): Promise<void>;
```

- [ ] **Step 4: Implement it**

In `src/persistence/prisma/run-repository.prisma.ts`, copy the body of `setContextContractVersion` and change the column to `validationContractVersion`. Keep the same tenant guard and the same throw.

- [ ] **Step 5: Add the failure reason**

In `src/domain/runs/run-status.ts`, add to `RUN_FAILURE_REASONS`:

```ts
  // SDD section 9 item 5. The Work Item states no observable success assertion, and the bounded
  // question rounds ended with no human answer. Implementation must not start.
  "VALIDATION_UNRESOLVED",
```

- [ ] **Step 6: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/run-repository.test.ts && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit`
Expected: PASS for both.

- [ ] **Step 7: Commit**

```bash
git add src/domain/runs src/persistence/prisma/run-repository.prisma.ts tests/integration/run-repository.test.ts
git commit -m "feat(runs): record the frozen Validation Contract hash on the Run"
```

---

## Task 5: The `buildValidationContract` activity

**Files:**
- Create: `src/activities/validation.activities.ts`
- Modify: `src/activities/index.ts`
- Modify: `src/activities/refinement.activities.ts`
- Modify: `src/telemetry/metrics.ts`
- Modify: `src/bin/worker.ts`
- Test: `tests/unit/validation-activity.test.ts`

**Interfaces:**
- Consumes: `buildValidationContract` from Task 2, `ValidationContractStore` from Task 3, `RunRepository.setValidationContractVersion` from Task 4.
- Produces: `BuildValidationContractActivityInput { runId, tenantId, projectId, workItem, goal, acceptanceCriteria: ValidationCriterion[], humanAssertions: string[] }`, `BuildValidationContractActivityOutput { status: "ready" | "needs_input"; sha256: string | null; document: string; assertionCount: number; frozenAt: string | null; question: { id: string; question: string } | null; summary: string }`, `createValidationActivities(dependencies)`. `RefineActivityOutput.criteria: Array<{ id: string; statement: string; source: string }>`.

- [ ] **Step 1: Expose the criterion identifiers from Refinement**

In `src/activities/refinement.activities.ts`, add to `RefineActivityOutput`:

```ts
  /**
   * The proposed acceptance criteria with their identifiers. SDD section 24 requires each
   * validation assertion to name its source requirement, and the identifier is that name.
   * `acceptanceCriteria` above stays a list of statements, because the context topics need the
   * statements only.
   */
  criteria: Array<{ id: string; statement: string; source: string }>;
```

and to the returned object:

```ts
      criteria: output.proposedAcceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        statement: criterion.statement,
        source: criterion.source,
      })),
```

- [ ] **Step 2: Add the metric**

In `src/telemetry/metrics.ts`, beside `contextResolutionDuration`:

```ts
  validationContractDuration: new Histogram({
    name: "factoree_validation_contract_duration_seconds",
    help: "Validation Contract build and freeze duration in seconds",
    labelNames,
    buckets: [0.01, 0.1, 1, 5, 30],
    registers: [registry],
  }),
```

- [ ] **Step 3: Write the failing test**

Create `tests/unit/validation-activity.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createValidationActivities } from "~/activities/validation.activities.js";
import type { ValidationContractStore } from "~/domain/validation/validation-contract-store.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const storeStub = (): ValidationContractStore & { saved: unknown[] } => {
  const saved: unknown[] = [];
  let stored: Awaited<ReturnType<ValidationContractStore["save"]>> | null = null;
  return {
    saved,
    async save(input) {
      if (stored !== null) return stored;
      saved.push(input);
      stored = {
        id: "vc-1",
        tenantId: input.tenantId,
        runId: input.runId,
        version: input.contract.version,
        sha256: input.sha256,
        workItem: input.contract.workItem,
        goal: input.contract.goal,
        document: input.document,
        assertions: input.contract.assertions,
        createdAt: new Date("2026-08-25T10:00:00.000Z"),
      };
      return stored;
    },
    async findByRun() {
      return stored;
    },
  };
};

const runsStub = () => ({
  setValidationContractVersion: vi.fn(async () => undefined),
});

const input = () => ({
  runId: "run-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  workItem: "ENG-143",
  goal: "A signed-in editor can rename a project.",
  acceptanceCriteria: [
    { id: "AC-1", statement: "PATCH /projects/{id} returns 403 for a user without edit permission.", source: "work-item" },
  ],
  humanAssertions: [],
});

describe("buildValidationContract activity", () => {
  it("freezes the contract, records its hash on the Run, and reports it ready", async () => {
    const contracts = storeStub();
    const runs = runsStub();
    const activities = createValidationActivities({ contracts, runs: runs as never, logger: logger as never });

    const output = await activities.buildValidationContract(input());

    expect(output.status).toBe("ready");
    expect(output.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(output.assertionCount).toBe(1);
    expect(output.frozenAt).toBe("2026-08-25T10:00:00.000Z");
    expect(runs.setValidationContractVersion).toHaveBeenCalledWith("tenant-1", "run-1", output.sha256);
    expect(contracts.saved).toHaveLength(1);
  });

  it("writes no second contract on a retry, because SDD section 25 forbids a change", async () => {
    const contracts = storeStub();
    const runs = runsStub();
    const activities = createValidationActivities({ contracts, runs: runs as never, logger: logger as never });

    const first = await activities.buildValidationContract(input());
    const second = await activities.buildValidationContract(input());

    expect(second.sha256).toBe(first.sha256);
    expect(contracts.saved).toHaveLength(1);
  });

  it("returns the frozen contract, not a freshly built one, when the two would differ", async () => {
    const contracts = storeStub();
    const runs = runsStub();
    const activities = createValidationActivities({ contracts, runs: runs as never, logger: logger as never });

    const first = await activities.buildValidationContract(input());
    const second = await activities.buildValidationContract({
      ...input(),
      acceptanceCriteria: [
        ...input().acceptanceCriteria,
        { id: "AC-2", statement: "The rename button is visible on the project page.", source: "work-item" },
      ],
    });

    expect(second.sha256).toBe(first.sha256);
    expect(second.assertionCount).toBe(1);
  });

  it("asks one focused question and freezes nothing when no observable assertion exists", async () => {
    const contracts = storeStub();
    const runs = runsStub();
    const activities = createValidationActivities({ contracts, runs: runs as never, logger: logger as never });

    const output = await activities.buildValidationContract({ ...input(), acceptanceCriteria: [] });

    expect(output.status).toBe("needs_input");
    expect(output.sha256).toBeNull();
    expect(output.question?.id).toBe("VAL-Q-1");
    expect(contracts.saved).toHaveLength(0);
    expect(runs.setValidationContractVersion).not.toHaveBeenCalled();
  });

  it("freezes a contract built from a human answer", async () => {
    const contracts = storeStub();
    const runs = runsStub();
    const activities = createValidationActivities({ contracts, runs: runs as never, logger: logger as never });

    const output = await activities.buildValidationContract({
      ...input(),
      acceptanceCriteria: [],
      humanAssertions: ["The rename button is disabled for a viewer."],
    });

    expect(output.status).toBe("ready");
    expect(output.assertionCount).toBe(1);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/validation-activity.test.ts`
Expected: FAIL, because `src/activities/validation.activities.ts` does not resolve.

- [ ] **Step 5: Write the activity**

Create `src/activities/validation.activities.ts`:

```ts
import type { Logger } from "~/telemetry/logger.js";
import { metrics } from "~/telemetry/metrics.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { ValidationContractStore } from "~/domain/validation/validation-contract-store.js";
import type { ValidationCriterion } from "~/domain/validation/validation-contract-builder.js";
import { buildValidationContract } from "~/domain/validation/validation-contract-builder.js";
import { validateValidationContract } from "~/domain/validation/validation-contract.js";

export interface BuildValidationContractActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  workItem: string;
  goal: string;
  acceptanceCriteria: ValidationCriterion[];
  humanAssertions: string[];
}

export interface BuildValidationContractActivityOutput {
  /** `needs_input` means SDD section 9 item 5 is not met, and implementation must not start. */
  status: "ready" | "needs_input";
  /** The frozen contract hash, or null when nothing froze. */
  sha256: string | null;
  document: string;
  assertionCount: number;
  /** AT-10. The moment the contract froze, so a test can compare it with the Implementer start. */
  frozenAt: string | null;
  question: { id: string; question: string } | null;
  /** The line Factoree posts to Linear. */
  summary: string;
}

export interface ValidationActivityDependencies {
  contracts: ValidationContractStore;
  runs: RunRepository;
  logger: Logger;
}

const QUESTION_ID = "VAL-Q-1";

const QUESTION =
  "What observable behavior proves this work is done? Factoree needs at least one assertion a " +
  "person or a machine can check, for example a page state, an HTTP response, or a command exit " +
  "code. Factoree must not invent product behavior, so it cannot state this itself.";

/** SDD section 63 names this file. */
export const createValidationActivities = (dependencies: ValidationActivityDependencies) => ({
  async buildValidationContract(
    input: BuildValidationContractActivityInput,
  ): Promise<BuildValidationContractActivityOutput> {
    const started = Date.now();
    const labels = { tenant_id: input.tenantId, project_id: input.projectId };

    const observe = (): void => {
      metrics.validationContractDuration.observe(labels, (Date.now() - started) / 1000);
    };

    // SDD section 25. A frozen contract is the contract of this Run. A retry, and any later call,
    // must return that contract and must never rebuild it. See controller decision 7.
    const existing = await dependencies.contracts.findByRun(input.tenantId, input.runId);
    if (existing !== null) {
      observe();
      dependencies.logger.info("validation contract already frozen", {
        tenant_id: input.tenantId,
        project_id: input.projectId,
        run_id: input.runId,
        step: "build_validation_contract",
        status: "ready",
      });
      return {
        status: "ready",
        sha256: existing.sha256,
        document: existing.document,
        assertionCount: existing.assertions.length,
        frozenAt: existing.createdAt.toISOString(),
        question: null,
        summary: summaryOf(existing.assertions.length, existing.sha256),
      };
    }

    const built = buildValidationContract({
      runId: input.runId,
      workItem: input.workItem,
      goal: input.goal,
      acceptanceCriteria: input.acceptanceCriteria,
      humanAssertions: input.humanAssertions,
    });

    // SDD section 9 item 5. No observable success assertion exists, so the readiness gate fails
    // and nothing freezes. See controller decision 3.
    if (built.contract.assertions.length === 0) {
      observe();
      dependencies.logger.info("validation contract needs input", {
        tenant_id: input.tenantId,
        project_id: input.projectId,
        run_id: input.runId,
        step: "build_validation_contract",
        status: "needs_input",
      });
      return {
        status: "needs_input",
        sha256: null,
        document: built.document,
        assertionCount: 0,
        frozenAt: null,
        question: { id: QUESTION_ID, question: QUESTION },
        summary:
          "Factoree cannot define success for this Work Item. It needs one observable assertion " +
          "before it can start implementation.",
      };
    }

    // SDD section 9 item 9. Only a valid contract freezes. A defect in the builder must fail the
    // activity here, not reach the store.
    validateValidationContract(built.contract);

    const stored = await dependencies.contracts.save({
      tenantId: input.tenantId,
      runId: input.runId,
      contract: built.contract,
      sha256: built.sha256,
      document: built.document,
    });

    await dependencies.runs.setValidationContractVersion(
      input.tenantId,
      input.runId,
      stored.sha256,
    );

    observe();
    dependencies.logger.info("validation contract frozen", {
      tenant_id: input.tenantId,
      project_id: input.projectId,
      run_id: input.runId,
      step: "build_validation_contract",
      status: "ready",
      assertion_count: stored.assertions.length,
      validation_contract_version: stored.sha256,
    });

    return {
      status: "ready",
      sha256: stored.sha256,
      document: stored.document,
      assertionCount: stored.assertions.length,
      frozenAt: stored.createdAt.toISOString(),
      question: null,
      summary: summaryOf(stored.assertions.length, stored.sha256),
    };
  },
});

const summaryOf = (assertions: number, sha256: string): string =>
  `Factoree froze the Validation Contract with ${assertions} ` +
  `${assertions === 1 ? "assertion" : "assertions"}. Version ${sha256.slice(0, 12)}. ` +
  "It cannot change while this Run implements the work.";
```

Move `summaryOf` above `createValidationActivities` if the lint rule forbids use before definition.

- [ ] **Step 6: Register the activity**

In `src/activities/index.ts`, add `validationContracts: ValidationContractStore;` to `ActivityDependencies`, import `createValidationActivities`, and spread it:

```ts
  ...createValidationActivities({
    contracts: dependencies.validationContracts,
    runs: dependencies.runs,
    logger: dependencies.logger,
  }),
```

In `src/bin/worker.ts`, construct `new PrismaValidationContractStore(prisma)` beside the existing `PrismaContextContractStore` and pass it as `validationContracts`.

- [ ] **Step 7: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck`
Expected: PASS, exit 0, exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/activities src/telemetry/metrics.ts src/bin/worker.ts tests/unit/validation-activity.test.ts
git commit -m "feat(validation): freeze the contract in an activity and record its version"
```

---

## Task 6: The `BUILDING_VALIDATION_CONTRACT` workflow state and the readiness gate

**Files:**
- Modify: `src/workflows/agent-run.workflow.ts`
- Test: `tests/workflow/validation-contract.workflow.test.ts`

**Interfaces:**
- Consumes: `buildValidationContract` activity from Task 5.
- Produces: `RunSnapshot.validationContractVersion: string | null`; the workflow passes `validationContract: string` into the implement activity, which Task 7 accepts.

- [ ] **Step 1: Write the failing workflow test**

Create `tests/workflow/validation-contract.workflow.test.ts`. Read an existing workflow test, for example the one that covers the context conflict question, and copy its `TestWorkflowEnvironment` setup, its activity stubs, and its helpers exactly. The test body asserts:

```ts
it("freezes the Validation Contract after context resolution and before sandbox preparation", async () => {
  // Record the order of the activity calls in an array. Expect
  // ["resolveContext", "buildValidationContract", "prepareSandbox"] in that order.
});

it("reports BUILDING_VALIDATION_CONTRACT to setRunStatus", async () => {
  // Expect the recorded status list to contain "BUILDING_VALIDATION_CONTRACT" between
  // "RESOLVING_CONTEXT" and "PREPARING".
});

it("reports the frozen hash in the run status query", async () => {
  // Query runStatus after the Run ends and expect validationContractVersion to equal the stub hash.
});

it("gives the frozen contract document to the Implementer", async () => {
  // Expect the recorded implement input to carry validationContract equal to the stub document.
});

it("asks the human one question when the contract needs input, and freezes after the answer", async () => {
  // First buildValidationContract call answers needs_input, the second answers ready.
  // Expect postElicitation to have been called once, and the Run to reach PREPARING.
});

it("fails with VALIDATION_UNRESOLVED when the question stays unanswered", async () => {
  // buildValidationContract always answers needs_input, no human input arrives, the budget ends.
  // Expect completeRun with failureReason "VALIDATION_UNRESOLVED" and status "FAILED".
});

it("prepares no sandbox when a stop arrives while the contract is being built", async () => {
  // Signal stop during buildValidationContract. Expect prepareSandbox never called and the Run
  // to end CANCELLED.
});
```

Fill each body with real code from the neighbouring workflow test. Do not leave a comment in place of an assertion.

- [ ] **Step 2: Run the test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.workflow.config.ts tests/workflow/validation-contract.workflow.test.ts`
Expected: FAIL. Docker must be running.

- [ ] **Step 3: Add the snapshot field and the state variable**

In `src/workflows/agent-run.workflow.ts`, add to `RunSnapshot`, beside `contextContractVersion`:

```ts
  /**
   * SDD section 53. The SHA-256 of the frozen Validation Contract of this Run, or null while no
   * contract is frozen. SDD section 25 makes this value stable once it is set.
   */
  validationContractVersion: string | null;
```

Declare `let validationContractVersion: string | null = null;` beside `contextContractVersion`, and return it from the `runStatusQuery` handler.

- [ ] **Step 4: Add the failure reason to `failRun`**

Extend the `failureReason` union of the `failRun` helper with `| "VALIDATION_UNRESOLVED"`.

- [ ] **Step 5: Add the activity proxy**

Beside `refineActivities`:

```ts
/**
 * The Validation Contract build is a pure computation plus one database write, so it is fast and
 * a retry costs nothing. One minute is ample for it.
 */
const validationActivities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, initialInterval: "1 second", backoffCoefficient: 2 },
});
```

- [ ] **Step 6: Add the build loop**

Insert this block after the context resolution loop and its stop check, and before the `const sandbox = {` block:

```ts
      // SDD section 49 places the Validation Contract between context resolution and sandbox
      // preparation. SDD section 24 requires the contract to freeze before implementation starts.
      // The loop ends because `askAndWait` is bounded by the question rounds and by the budget.
      const validationAnswers: string[] = [];
      let validation;
      for (;;) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "BUILDING_VALIDATION_CONTRACT";
        await activities.setRunStatus({ runId: id, status });

        validation = await validationActivities.buildValidationContract({
          runId: id,
          tenantId: input.tenantId,
          projectId: input.projectId,
          workItem: input.workItem.issueId ?? id,
          goal: refined.goal,
          acceptanceCriteria: refined.criteria,
          humanAssertions: validationAnswers,
        });

        if (validation.status === "ready") {
          validationContractVersion = validation.sha256;
          break;
        }

        await notify(() =>
          activities.postProgress({
            sessionId: input.agentSessionId,
            message: validation.summary,
          }),
        );

        // SDD section 9 item 5. No observable success assertion exists, so implementation must
        // not start. The human states one, and it becomes an assertion of the contract.
        const question = validation.question;
        if (question === null) {
          return await failRun(
            "VALIDATION_UNRESOLVED",
            "Factoree could not define success for this Work Item, and it published nothing.",
          );
        }
        const proceeded = await askAndWait(question.id, question.question);
        if (stopRequested) return await cancelRun();
        if (!proceeded) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          return await failRun(
            "VALIDATION_UNRESOLVED",
            "Factoree could not start, because this Work Item states no observable success " +
              "assertion. Factoree must not invent product behavior, so it published nothing.",
          );
        }
        const answer = decisions[decisions.length - 1]?.answer ?? "";
        if (answer.trim() !== "") validationAnswers.push(answer);
      }

      await notify(() =>
        activities.postProgress({ sessionId: input.agentSessionId, message: validation.summary }),
      );

      // A stop that arrived while the contract was built must prevent preparation.
      if (stopRequested) return await cancelRun();
      if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
```

Give `validation` an explicit type annotation if the compiler cannot infer it across the loop: `let validation: Awaited<ReturnType<Activities["buildValidationContract"]>>;`.

- [ ] **Step 7: Give the contract to the Implementer**

In the `runImplementer` helper signature, add beside `contextContract`:

```ts
    /**
     * SDD section 34. The Implementer receives the frozen Validation Contract. SDD section 25
     * denies it the authority to change the contract, which the store enforces, not this prompt.
     */
    validationContract: string;
```

Pass `validationContract: attemptInput.validationContract` into `implementActivities.implement`, and pass `validationContract: validation.document` at the call site inside the implement loop.

- [ ] **Step 8: Run the workflow suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.workflow.config.ts`
Expected: PASS. Run the whole workflow suite, because every existing workflow test now passes through the new state.

- [ ] **Step 9: Commit**

```bash
git add src/workflows/agent-run.workflow.ts tests/workflow/validation-contract.workflow.test.ts
git commit -m "feat(workflow): freeze the Validation Contract before the sandbox exists"
```

---

## Task 7: The Implementer receives the frozen contract

**Files:**
- Modify: `src/activities/agent.activities.ts`
- Test: `tests/unit/implementer-input.test.ts`, `tests/unit/implementer-prompt.test.ts`

**Interfaces:**
- Consumes: the workflow field from Task 6.
- Produces: `ImplementActivityInput.validationContract: string`.

`buildImplementerInput` and `renderImplementerPrompt` already accept `validationContract: string | null`. Only the activity passes a hard-coded `null` today.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/implementer-input.test.ts`:

```ts
it("carries the frozen Validation Contract into the prompt", () => {
  const input = buildImplementerInput({
    ...base,
    validationContract: "# Validation Contract\n\nVAL-API-001 returns 403.",
  });
  expect(input.prompt).toContain("VAL-API-001");
});

it("states that the Implementer must not change the Validation Contract", () => {
  const input = buildImplementerInput({ ...base, validationContract: "VAL-API-001" });
  expect(input.prompt).toContain("must not change the Validation Contract");
});
```

Use the `base` fixture the file already defines.

- [ ] **Step 2: Run the test to verify it fails or passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit/implementer-input.test.ts`
Expected: the second test may already pass, because the prompt already carries that sentence. The first proves the field travels. If both pass, keep them: they lock the SDD section 34 behavior against a later change.

- [ ] **Step 3: Thread the field through the activity**

In `src/activities/agent.activities.ts`, add `validationContract: string;` to `ImplementActivityInput` beside `contextContract`, and replace `validationContract: null,` in the `buildImplementerInput` call with `validationContract: input.validationContract,`.

- [ ] **Step 4: Repair every caller**

`npm run typecheck` names each acceptance test and unit test that builds an `ImplementActivityInput`. Add a real contract text to each one rather than an empty string, so the fixture keeps meaning. For the Phase 2 and Phase 3 fixtures, use:

```ts
validationContract: "# Validation Contract\n\n### VAL-CMD-001\n\n- method: command\n",
```

- [ ] **Step 5: Run the unit suite and the typecheck**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/unit`
Expected: exit 0 and PASS.

- [ ] **Step 6: Commit**

```bash
git add src/activities/agent.activities.ts tests
git commit -m "feat(agent): give the Implementer the frozen Validation Contract"
```

---

## Task 8: AT-10, AT-11, and the Phase 6 exit test

**Files:**
- Create: `tests/acceptance/at-10-validation-created-first.test.ts`
- Create: `tests/acceptance/at-11-validation-immutability.test.ts`
- Create: `tests/acceptance/phase-06-exit.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 7.
- Produces: nothing a later task consumes.

The acceptance tests run under `vitest.integration.config.ts`. Read `tests/acceptance/phase-05-exit.test.ts` and `tests/acceptance/support` first, and reuse the existing fixtures.

- [ ] **Step 1: Write AT-10**

Create `tests/acceptance/at-10-validation-created-first.test.ts`. SDD section 66 states AT-10 as: Validation Contract creation time and hash exist before Implementer start time.

```ts
describe("AT-10 — validation created first", () => {
  it("freezes the contract, with a hash and a creation time, before the Implementer starts", async () => {
    // 1. Freeze a contract through the real activity against the Testcontainers database.
    // 2. Read the stored contract and keep createdAt and sha256.
    // 3. Start an AgentExecution through the existing AgentExecutionRepository for the same Run.
    // 4. Expect the stored contract sha256 to match /^[0-9a-f]{64}$/.
    // 5. Expect stored.createdAt.getTime() to be less than or equal to the execution startedAt.
    // 6. Expect the Run row validationContractVersion to equal stored.sha256.
  });
});
```

Fill each body with real code. The Run row and the `AgentExecution` fixtures already exist in the integration support module.

- [ ] **Step 2: Write AT-11**

Create `tests/acceptance/at-11-validation-immutability.test.ts`. SDD section 66 states AT-11 as: an Implementer cannot alter the active Validation Contract.

```ts
describe("AT-11 — validation immutability", () => {
  it("keeps the frozen contract when a second save arrives with weaker assertions", async () => {
    // 1. Freeze a contract with one browser assertion that requires a screenshot.
    // 2. Call save again for the same Run with an assertion that requires human-confirmation only.
    // 3. Expect the returned record to be the first one: the same id, the same sha256, and the
    //    same evidence list.
    // 4. Expect findByRun to answer the first contract as well.
  });

  it("keeps Run.validationContractVersion at the frozen hash", async () => {
    // Expect the Run row to still hold the first hash after the second save.
  });

  it("gives the Implementer no port that can change the contract", () => {
    // The implement activity input is a plain string. Assert the shape at the type level with a
    // runtime check: build an implementer input and expect it to expose no store, no client, and
    // no function value.
    const built = buildImplementerInput({ ...base, validationContract: "VAL-API-001" });
    expect(Object.values(built).every((value) => typeof value !== "function")).toBe(true);
    expect(JSON.stringify(built)).not.toContain("save");
  });
});
```

Fill each body with real code.

- [ ] **Step 3: Write the Phase 6 exit test**

Create `tests/acceptance/phase-06-exit.test.ts`. The SDD section 69 exit condition is: every implementation starts after a frozen validation contract exists.

```ts
describe("Phase 6 exit — every implementation starts after a frozen Validation Contract", () => {
  it("runs the whole path from a Work Item to a frozen contract the Implementer receives", async () => {
    // 1. Refine a Work Item that states two acceptance criteria: one HTTP and one browser.
    // 2. Call the real buildValidationContract activity with refined.criteria.
    // 3. Expect status "ready", two assertions, the methods ["http", "browser"] in some order,
    //    and the SDD section 37 and 38 evidence lists.
    // 4. Expect the stored contract to hold the same hash the Run row now holds.
    // 5. Build the Implementer input with that document and expect the prompt to name every
    //    assertion identifier.
    // 6. Expect the prompt to state that the Implementer must not change the contract.
  });

  it("starts no implementation when the Work Item states no observable assertion", async () => {
    // Refine a Work Item with a goal but no acceptance criterion whose statement is observable,
    // then expect status "needs_input", no stored contract, and a null Run
    // validationContractVersion.
  });
});
```

Fill each body with real code.

- [ ] **Step 4: Run the whole integration and acceptance suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts`
Expected: PASS, with no new skip.

- [ ] **Step 5: Commit**

```bash
git add tests/acceptance
git commit -m "test(validation): add AT-10, AT-11, and the Phase 6 exit test"
```

---

## Final verification

- [ ] **Step 1: Run every stage of `npm run verify`**

The environment notes say `npm run verify` takes longer than a two-minute foreground call, so run it in stages and record each exit code:

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm run lint; echo "lint=$?"
npm run typecheck; echo "typecheck=$?"
npx vitest run tests/unit; echo "unit=$?"
npx vitest run --config vitest.integration.config.ts; echo "integration=$?"
npx vitest run --config vitest.workflow.config.ts; echo "workflow=$?"
npm run build; echo "build=$?"
```

Expected: every exit code 0. The skip count must stay at 7, the Phase 2 baseline.

- [ ] **Step 2: Write the evidence file**

Write the combined output to `docs/build/evidence/phase-06-verify.txt`, ending with a line `exit=0`. Use a redirect, not a `cat` heredoc.

- [ ] **Step 3: Confirm the exit condition with evidence**

State plainly, with the test names and the exit codes, that the Phase 6 exit condition holds: every implementation starts after a frozen validation contract exists.

---

## Self-review notes

- Every SDD section 24 assertion field is produced by Task 2 and enforced by Task 1.
- Every SDD section 24 method appears in `VALIDATION_METHODS`, and each one has an evidence set and an identifier prefix, so no method is unreachable by construction.
- SDD section 25 immutability is enforced in three places: the port has no update, the store returns the existing row, and the activity reads before it builds.
- SDD section 9 item 5 is enforced by the activity and by the workflow loop, and it is proved by the second Phase 6 exit test.
- The types used in Task 5 and Task 6 match the names Task 1, Task 2, and Task 3 define: `ValidationCriterion`, `BuiltValidationContract`, `StoredValidationContract`, `setValidationContractVersion`.
