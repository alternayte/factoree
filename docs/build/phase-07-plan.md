# Factoree Phase 7 — User validation and evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Factoree a User Validator that runs after deterministic verification, starts the repository preview, executes every frozen Validation Contract assertion by its own method, records immutable evidence for each one, and lets no Run pass user validation unless every assertion is `PASS`.

**Architecture:** A new `UserValidator` module in `src/domain/validation/` executes the frozen contract. It never trusts an agent claim. A fresh agent session, which receives no Implementer transcript, writes one declarative Validation Plan into a scratch directory outside the primary worktree. Factoree parses that plan against the frozen contract, refuses any entry that weakens it, and then executes the entries itself: an HTTP assertion through a deterministic request executor, a browser assertion through a `BrowserDriver` port whose Playwright adapter drives a real browser against the exposed preview, and a command or test assertion through the sandbox. Factoree, not the agent, decides `PASS`, `FAIL`, `BLOCKED`, or `MANUAL_REQUIRED` from the recorded artefacts. Every artefact becomes one immutable `Evidence` row bound to its `ValidationAssertion`, with the bytes stored through an `EvidenceStorage` port whose Linear adapter uses Linear private file storage.

**Tech Stack:** TypeScript (strict), Node.js 24 LTS, npm, Temporal TypeScript SDK, Prisma, PostgreSQL, Playwright, Vitest, Testcontainers, prom-client.

**Spec:** `docs/sdd.md` (version 2.0, SHA-256 `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`)

## Global Constraints

These hold for every task. Every value is copied from the SDD.

- Production runtime is Node.js 24 LTS. Bun MUST NOT run Temporal Worker code (SDD section 11).
- TypeScript MUST keep `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true` (SDD section 10).
- npm with a committed `package-lock.json` (SDD section 10).
- Provider SDKs and provider HTTP clients MUST stay in `src/adapters/**`. Core workflow policy MUST NOT import a provider client (SDD section 14). Playwright is a provider SDK, so only `src/adapters/browser/playwright/**` may import it.
- Source layout MUST follow SDD section 63. Phase 7 fills `src/activities/evidence.activities.ts` and extends `src/domain/validation/`, `src/domain/evidence/`, and `src/adapters/`.
- Tenant boundary is the Linear workspace. Every tenant-owned persisted record MUST carry a tenant identifier, and every read MUST filter on it (SDD section 52).
- Factoree MUST NOT log an OAuth token, a GitHub token, a model API key, a Project secret, or an authorization header (SDD section 60). Sensitive values MUST be redacted before persistence (SDD section 38).
- The User Validator MUST use a fresh context, and MUST NOT receive the Implementer transcript, the Implementer success claims, or Reviewer findings (SDD section 36).
- The User Validator MUST NOT change production source files (SDD section 36).
- The User Validator MUST NOT weaken the frozen Validation Contract (SDD section 25).
- Assertion results are exactly `PASS`, `FAIL`, `BLOCKED`, `MANUAL_REQUIRED` (SDD section 36).
- L3 cannot complete unless all assertions are `PASS` (SDD section 36).
- Evidence is immutable, and each artifact records `evidence_id`, `run_id`, `validation_assertion_id`, `kind`, `source`, `created_at`, `sha256`, `storage_ref`, `metadata` (SDD section 39).
- Run state names MUST stay exactly the names of SDD section 48. Phase 7 adds no state name; it activates `USER_VALIDATING`, which already exists in the list.
- Semantic failures MUST use workflow decisions and MUST NOT consume Temporal retry policy (SDD section 49).
- Required checks MUST NOT use `continue-on-error`. `npm run verify` MUST pass (SDD section 65).

---

## Phase 7 scope (SDD section 69)

> Build preview startup, Playwright, HTTP validation, evidence storage, and Linear uploads.
> **Exit:** a UI fixture change produces independent acceptance evidence.

**In scope:** the `preview` block of `.factoree/config.yaml` carried through to the Run; preview start, readiness wait, service exposure, and stop (SDD section 37 steps 1 to 3); the declarative Validation Plan and its conformance rules against the frozen contract; the `UserValidator` module of SDD section 14; deterministic HTTP validation with sanitized request and response evidence (SDD section 38); browser validation through Playwright with the evidence kinds of SDD section 37; command and test assertion execution in the sandbox; `MANUAL_REQUIRED` for a `manual` or `code_review` assertion; assertion results persisted per assertion; evidence rows bound to their assertion, with artefact bytes stored through an `EvidenceStorage` port and a Linear private file storage adapter (SDD section 39); the `evidence.activities.ts` file of SDD section 63; the `userValidate` activity; the `USER_VALIDATING` workflow state and the all-`PASS` gate; the repair branch that SDD section 49 draws from `user validate` back to `implement`; the `factoree_validation_duration_seconds` metric of SDD section 62; AT-17, AT-18, AT-19, and the validation half of AT-25; the Phase 7 exit test.

**Out of scope (later phases, do not build):** the Reviewer, the finding schema, and blocking rules (Phase 8); patch capture, the patch hash, the stale base guard, and publishing (Phase 9); the Proof Pack (Phase 10); `ClaudeCodeRunner` (Phase 11); `READY_FOR_HUMAN`, which SDD section 68 still forbids without a PR and a Proof Pack, so Phase 7 invents no success terminal state; the cross-cutting redaction sweep of the carried Phase 6 finding, which is a Phase 12 hardening item; a Playwright browser image inside the Fly Sprite, because Phase 7 executes the browser on the worker against the exposed service, exactly as SDD section 37 orders the steps.

---

## Decisions taken by the controller

Recorded so a later reviewer does not treat them as drift.

1. **Playwright runs on the worker, against the exposed service.** SDD section 37 orders the steps `start preview`, `wait for readiness`, `expose the service`, `execute Playwright`. Exposure exists so that a client outside the sandbox can reach the preview. Placing the browser in the sandbox would make exposure pointless and would force a browser image into every Project sandbox. The `BrowserDriver` port keeps the workflow free of the Playwright SDK, as SDD section 14 requires.

2. **The fresh validator session produces a declarative Validation Plan, and Factoree executes it.** SDD section 24 states each assertion in prose, and no deterministic function can turn prose into browser steps. SDD section 36 therefore gives the work to a fresh agent context. Core principle P-01 forbids Factoree to accept an agent claim as evidence, so the agent produces steps only. Factoree parses them, executes them itself, and decides the result from the artefacts. The plan is data, never code, so no agent-authored program runs on the worker.

3. **The Validation Plan may add steps and may never change the contract.** The parser rejects a plan entry whose assertion identifier is unknown, and it ignores any statement, method, or evidence list the plan repeats. Only the frozen contract decides what an assertion means. This is how SDD section 25 is enforced against the User Validator.

4. **An assertion with no plan entry is `BLOCKED`, not `FAIL`.** `BLOCKED` says Factoree could not run the check. `FAIL` says the behavior is wrong. A missing plan entry is the first case, and reporting it as `FAIL` would send a correct implementation into repair.

5. **A `manual` or `code_review` assertion is `MANUAL_REQUIRED`.** SDD section 36 lists the result for exactly this case. Phase 8 owns the Reviewer, so Phase 7 cannot answer a `code_review` assertion with evidence, and it must not claim it passed.

6. **The validator writes only into `${workspacePath}/validation`, never into the primary worktree.** SDD section 36 forbids a change to production source files, and Phase 9 captures the patch from the primary worktree. A validator artefact inside the worktree would reach the published patch. The Action Policy of the validator session therefore denies the primary worktree write path that the Implementer holds.

7. **Preview is optional, and an absent preview does not fail a Run with no browser and no HTTP assertion.** `.factoree/config.yaml` makes `preview` nullable. A Run whose contract needs a preview and whose repository configures none reports `BLOCKED` for those assertions with a reason an operator can act on. It does not fail as an internal error, because the fault is repository configuration.

8. **Evidence bytes go through an `EvidenceStorage` port.** SDD section 39 says Version 1 SHOULD use Linear private file storage where practical. A port with a Linear adapter and a local filesystem adapter satisfies the `SHOULD` and keeps every test free of a live Linear account. The `storageRef` column holds whatever the active adapter returned, and the `sha256` column always holds the hash of the exact bytes, so a later reader can detect a substituted artefact.

9. **An assertion result is its own persisted row, not a field on the evidence row.** SDD section 39 lists the evidence columns and gives evidence no result column, and one assertion can carry several artefacts. A `ValidationAssertionResult` model therefore holds the result, the reason, and the attempt, and the evidence rows reference the assertion.

10. **A failed user validation enters the existing bounded repair loop.** SDD section 49 draws `user validate ├─ fail → repair`, and SDD section 42 bounds repairs. Phase 7 reuses the repair budget the verification loop already counts, because SDD section 42 bounds repairs per Run and not per stage. A repair after user validation re-runs the Implementer and then re-runs deterministic verification before user validation runs again, which is what AT-20 calls full reverification.

11. **`factoree_validation_duration_seconds` is the user validation metric.** SDD section 62 names it beside `factoree_verification_duration_seconds`. The existing `factoree_validation_contract_duration_seconds` measures the Phase 6 freeze and is a different measurement, so both stay.

12. **The browser evidence kinds are captured from the driver, not requested from the agent.** SDD section 37 lets the contract require a screenshot, a video, a trace, network evidence, console output, or an assertion log. The driver always collects the console log, the network log, and the assertion log, because they cost nothing, and it collects a screenshot, a video, or a trace only when the assertion requires it. Factoree persists exactly the kinds the frozen assertion requires, and reports `FAIL` when a required kind produced no artefact.

13. **`evidence.activities.ts` holds the evidence persistence function, and `userValidate` calls it in process.** SDD section 63 requires the file. A separate Temporal activity would have to carry every screenshot, video, and trace through a workflow payload, which Temporal bounds and which the workflow has no reason to see. The file therefore exports `createEvidencePersistence`, the validation activity injects it, and no workflow ever holds an artefact byte.

14. **A role control on the Action Policy denies the validator the primary worktree.** SDD section 29 permits exactly one Project override, and this is not a Project override: it is the role of the session. `buildActionPolicy({ role })` allows `writePrimaryWorktree` for `implementer` only. SDD section 36 forbids the User Validator to change production source files, and a prompt sentence is not a boundary.

---

## Requirement mapping

| SDD requirement | Task |
| --- | --- |
| Section 15 — the `preview` block of the repository configuration | Task 1 |
| Section 36 — fresh context, denied inputs, no production source change, the four results, the all-`PASS` rule | Tasks 3, 7, 8, 9, 10 |
| Section 37 — preview start, readiness, exposure, Playwright, required evidence | Tasks 2, 5, 7, 10 |
| Section 38 — method, path, sanitized request, status, sanitized response, result, redaction | Tasks 4, 10 |
| Section 39 — immutable evidence, its columns, Linear private file storage | Tasks 6, 8, 10 |
| Section 25 — the User Validator must not weaken the contract | Task 3 |
| Section 42 and section 49 — a failed user validation enters bounded repair | Task 9 |
| Section 48 and section 49 — `USER_VALIDATING` between `VERIFYING` and review | Task 9 |
| Section 52 — tenant filter on every read | Tasks 6, 8 |
| Section 53 — the persisted assertion result | Task 6 |
| Section 56 — the validator prompt version on the `AgentExecution` row | Task 8 |
| Section 62 — `factoree_validation_duration_seconds` | Task 8 |
| Section 63 — `src/activities/evidence.activities.ts` | Task 8 |
| AT-17 — a fresh validator session with no Implementer transcript | Task 10 |
| AT-18 — a browser assertion produces the evidence its contract entry requires | Task 10 |
| AT-19 — an HTTP assertion records sanitized request and response evidence | Task 10 |
| AT-25 — every assertion is `PASS` before the Run can proceed | Tasks 9, 10 |
| Phase 7 exit — a UI fixture change produces independent acceptance evidence | Task 10 |

---

## File structure

**Created**

- `src/domain/runs/preview.ts` — the preview lifecycle: start the configured process in the sandbox, poll the readiness URL, expose the port, and stop the process. No provider SDK.
- `src/domain/validation/validation-plan.ts` — the declarative Validation Plan schema, its parser, and its conformance rules against the frozen contract.
- `src/domain/validation/validation-result.ts` — the four assertion results, the per-assertion outcome, and the Run-level outcome.
- `src/domain/validation/browser-driver.ts` — the `BrowserDriver` port, the browser step types, and the browser artefact types.
- `src/domain/validation/http-validation.ts` — the deterministic HTTP assertion executor and its sanitizer.
- `src/domain/validation/user-validator.ts` — the `UserValidator` module of SDD section 14. It orchestrates preview, plan, execution, results, and evidence descriptors.
- `src/domain/evidence/evidence-storage.ts` — the `EvidenceStorage` port and the local filesystem adapter contract.
- `src/domain/validation/validation-result-store.ts` — the assertion result store port.
- `src/adapters/browser/playwright/playwright-browser-driver.ts` — the only file that imports Playwright.
- `src/adapters/linear/linear-evidence-storage.ts` — Linear private file storage.
- `src/adapters/evidence/filesystem-evidence-storage.ts` — the local fallback used by tests and by a Project with no Linear file storage.
- `src/prompts/user-validator.ts` — the validator prompt text and its version.
- `src/activities/evidence.activities.ts` — records evidence rows and stores artefact bytes.
- `prisma/migrations/20260826120000_add_validation_results/migration.sql`
- `tests/unit/preview.test.ts`, `tests/unit/validation-plan.test.ts`, `tests/unit/http-validation.test.ts`, `tests/unit/user-validator.test.ts`, `tests/unit/user-validator-prompt.test.ts`, `tests/unit/validate-activity.test.ts`
- `tests/integration/preview-local.test.ts`, `tests/integration/playwright-browser-driver.test.ts`, `tests/integration/validation-results.test.ts`, `tests/integration/evidence-storage.test.ts`
- `tests/workflow/user-validation.workflow.test.ts`
- `tests/acceptance/at-17-fresh-user-validation.test.ts`, `tests/acceptance/at-18-ui-evidence.test.ts`, `tests/acceptance/at-19-http-evidence.test.ts`, `tests/acceptance/at-25-evidence-completeness.test.ts`, `tests/acceptance/phase-07-exit.test.ts`
- `tests/acceptance/support/preview-fixture-app.ts` — the UI fixture the exit test changes.

**Modified**

- `src/domain/runs/project-runtime-config.ts` — carries `PreviewConfig`.
- `src/domain/projects/factoree-config.ts` — the `preview` block reaches `ResolvedProjectConfig`.
- `src/activities/sandbox.activities.ts` — `PrepareSandboxActivityOutput.preview`.
- `src/domain/evidence/evidence.ts` — the widened `EvidenceKind` union and the artefact input.
- `src/persistence/prisma/evidence.prisma.ts` — unchanged behavior, widened kind.
- `src/persistence/prisma/validation-contract.prisma.ts` — returns the database row identifier of every assertion.
- `src/domain/validation/validation-contract-store.ts` — the stored assertion carries its row identifier.
- `src/persistence/prisma/validation-result.prisma.ts` — created for the new store.
- `prisma/schema.prisma` — `ValidationAssertionResult`, and the `Evidence` to `ValidationAssertion` relation.
- `src/activities/validation.activities.ts` — the `userValidate` activity.
- `src/workflows/agent-run.workflow.ts` — the `USER_VALIDATING` state, the gate, and the repair branch.
- `src/activities/index.ts`, `src/bin/worker.ts` — registration.
- `src/telemetry/metrics.ts` — `factoree_validation_duration_seconds`.
- `tests/workflow/support/harness.ts` — the `userValidate` double and its `activityOrder` marker.
- `tests/workflow/at-35-worker-restart.test.ts` — **this file hand-builds its own activity map and does not use the harness.** Phase 7 adds an activity, so this file must gain the `userValidate` double by hand. The Phase 6 status note records that a missing double here fails the Run intermittently after a worker restart.
- `package.json`, `package-lock.json` — the `playwright` dependency.

---
## Task 1: The `preview` block reaches the Run

**Files:**
- Modify: `src/domain/runs/project-runtime-config.ts`
- Modify: `src/activities/sandbox.activities.ts` (`PrepareSandboxActivityOutput`)
- Test: `tests/unit/project-runtime-config.test.ts`, `tests/unit/prepare-sandbox-activity.test.ts`

**Interfaces:**
- Consumes: `FactoreeConfig` from `src/domain/projects/factoree-config.ts`, which already parses and validates the `preview` block and stores nothing.
- Produces:

```ts
/** SDD section 15 and SDD section 37. The preview the User Validator starts. */
export interface PreviewConfig {
  enabled: boolean;
  /** The exact shell command. It runs through `sh -c` from the primary worktree. */
  command: string;
  /** The URL the readiness poll requests. Its port is the port Factoree exposes. */
  readyUrl: string;
  timeoutSeconds: number;
}

// ResolvedProjectConfig gains:
//   preview: PreviewConfig | null;
// PrepareSandboxActivityOutput gains:
//   preview: PreviewConfig | null;
```

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/project-runtime-config.test.ts`:

```ts
it("carries the preview block of the repository configuration", () => {
  const config = parseFactoreeConfig(
    [
      "version: 1",
      "verify:",
      "  commands:",
      "    - name: unit",
      "      run: npm test",
      "preview:",
      "  enabled: true",
      "  command: npm run dev -- --port 8080",
      "  readyUrl: http://127.0.0.1:8080/health",
      "  timeoutSeconds: 60",
    ].join("\n"),
  );

  const resolved = toProjectRuntimeConfig(config, DEFAULT_PROJECT_DEFAULTS);

  expect(resolved.preview).toEqual({
    enabled: true,
    command: "npm run dev -- --port 8080",
    readyUrl: "http://127.0.0.1:8080/health",
    timeoutSeconds: 60,
  });
});

it("reports no preview when the repository configures none", () => {
  const config = parseFactoreeConfig(
    ["version: 1", "verify:", "  commands:", "    - name: unit", "      run: npm test"].join("\n"),
  );

  expect(toProjectRuntimeConfig(config, DEFAULT_PROJECT_DEFAULTS).preview).toBeNull();
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/project-runtime-config.test.ts`
Expected: FAIL, because `ResolvedProjectConfig` has no `preview` property.

- [ ] **Step 3: Add `PreviewConfig` and carry it**

In `src/domain/runs/project-runtime-config.ts`, export the `PreviewConfig` interface exactly as written above, add `preview: PreviewConfig | null` to `ResolvedProjectConfig`, and set it inside `toProjectRuntimeConfig`:

```ts
preview:
  config.preview === null
    ? null
    : {
        enabled: config.preview.enabled,
        command: config.preview.command,
        readyUrl: config.preview.readyUrl,
        timeoutSeconds: config.preview.timeoutSeconds,
      },
```

Keep `preview` outside `ProjectRuntimeConfig`, beside `verifyCommands`. `ProjectRuntimeConfig` holds the values the sandbox and the runners need. The preview belongs to the same class of value as a verification command: it comes from the repository file and it is used by one stage.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/project-runtime-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Carry the value on the prepared sandbox**

Add `preview: PreviewConfig | null` to `PrepareSandboxActivityOutput` in `src/activities/sandbox.activities.ts`, and return `resolved.preview` from `prepareSandbox` at the point that already returns `verifyCommands`. Add to `tests/unit/prepare-sandbox-activity.test.ts`:

```ts
it("returns the preview configuration of the repository", async () => {
  // Use the existing fixture builder of this file and give its `.factoree/config.yaml`
  // a preview block, then assert:
  expect(output.preview).toEqual({
    enabled: true,
    command: "npm run dev -- --port 8080",
    readyUrl: "http://127.0.0.1:8080/health",
    timeoutSeconds: 60,
  });
});
```

- [ ] **Step 6: Run the whole unit suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test`
Expected: PASS. `tests/workflow/support/harness.ts` also builds a `prepareSandbox` result, so add `preview: null` there in the same step to keep the type sound.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(preview): carry the repository preview configuration onto the Run"
```

---

## Task 2: The preview lifecycle

**Files:**
- Create: `src/domain/runs/preview.ts`
- Test: `tests/unit/preview.test.ts`, `tests/integration/preview-local.test.ts`

**Interfaces:**
- Consumes: `Sandbox`, `SandboxRef`, `ProcessRef`, `ServiceRef` from `src/domain/runs/sandbox.js`; `PreviewConfig` from Task 1.
- Produces:

```ts
/** Reports the HTTP status of one readiness request, or null when nothing answered. */
export type ReadinessProbe = (url: string) => Promise<{ status: number } | null>;

export interface PreviewHandle {
  process: ProcessRef;
  /** The URL a client outside the sandbox uses. SDD section 37 step 3. */
  baseUrl: string;
  port: number;
  readyUrl: string;
  startedAt: string;
  /** The redacted output the preview produced while it started. */
  startupLog: string;
}

export type PreviewFailureReason = "not_ready" | "exited" | "no_port";

export class PreviewStartError extends Error {
  constructor(message: string, readonly reason: PreviewFailureReason, readonly log: string) {
    super(message);
    this.name = "PreviewStartError";
  }
}

export interface StartPreviewInput {
  sandbox: Sandbox;
  ref: SandboxRef;
  /** The primary worktree. The preview command runs from there. */
  workingDirectory: string;
  preview: PreviewConfig;
  environment: Record<string, string>;
  probe: ReadinessProbe;
  redactor: Redactor;
  /** Injected so a unit test needs no real delay. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const startPreview: (input: StartPreviewInput) => Promise<PreviewHandle>;

export const stopPreview: (
  sandbox: Sandbox,
  ref: SandboxRef,
  handle: PreviewHandle,
) => Promise<void>;
```

Rules the implementation must hold:

1. The port is `Number(new URL(preview.readyUrl).port)`. An empty port raises `PreviewStartError` with reason `no_port`, because Factoree cannot expose a port it cannot name. The message must tell the operator to state an explicit port in `preview.readyUrl`.
2. The command starts through `sandbox.startProcess(ref, { file: "sh", args: ["-c", preview.command], cwd: workingDirectory, env: environment })`. `startProcess` ignores `timeoutMs`, so this function owns the deadline.
3. The poll interval is 250 ms. The deadline is `preview.timeoutSeconds * 1000` from the first poll.
4. Before every poll, read `sandbox.readProcess`. A process that has exited raises `PreviewStartError` with reason `exited` and carries the redacted output, because polling a dead server until the timeout wastes the Run budget.
5. Ready means the probe returned a status from 200 to 399. Any other status, and a null answer, means keep polling.
6. On the deadline, raise `PreviewStartError` with reason `not_ready` and the redacted output of the process.
7. After readiness, call `sandbox.exposeService(ref, port)` and use its `url` as `baseUrl`.
8. Every log text passes through `redactor.redactText` before it leaves this module. SDD section 60.
9. `stopPreview` calls `sandbox.cancelProcess`. It must not throw when the process has already exited; the caller runs it in a `finally`.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/preview.test.ts`. Use the existing fake sandbox of `tests/unit/fake-sandbox.test.ts` if it exports one; otherwise write a small local fake in the test file that records `startProcess`, answers `readProcess`, and answers `exposeService` with `{ port, url: 'http://sandbox.invalid:' + port }`.

```ts
const config = {
  enabled: true,
  command: "npm run dev -- --port 8080",
  readyUrl: "http://127.0.0.1:8080/health",
  timeoutSeconds: 5,
};

it("starts the command, waits for readiness, and exposes the port", async () => {
  let polls = 0;
  const handle = await startPreview({
    sandbox,
    ref,
    workingDirectory: "/workspace/primary",
    preview: config,
    environment: {},
    probe: async () => (++polls < 3 ? null : { status: 200 }),
    redactor: new Redactor(),
    sleep: async () => undefined,
  });

  expect(sandbox.started[0]).toMatchObject({ file: "sh", args: ["-c", config.command] });
  expect(handle.port).toBe(8080);
  expect(handle.baseUrl).toBe("http://sandbox.invalid:8080");
  expect(polls).toBe(3);
});

it("fails with `exited` when the preview process dies before it answers", async () => {
  sandbox.snapshot = { running: false, exitCode: 1, stdout: "", stderr: "port 8080 is in use" };

  await expect(
    startPreview({ ...base, probe: async () => null }),
  ).rejects.toMatchObject({ name: "PreviewStartError", reason: "exited" });
});

it("fails with `not_ready` when the deadline passes", async () => {
  let clock = 0;
  await expect(
    startPreview({ ...base, probe: async () => null, now: () => (clock += 1_000) }),
  ).rejects.toMatchObject({ name: "PreviewStartError", reason: "not_ready" });
});

it("refuses a readiness URL with no explicit port", async () => {
  await expect(
    startPreview({ ...base, preview: { ...config, readyUrl: "http://127.0.0.1/health" } }),
  ).rejects.toMatchObject({ reason: "no_port" });
});

it("redacts a Project secret out of the startup log", async () => {
  const redactor = new Redactor(["super-secret-value"]);
  sandbox.snapshot = { running: false, exitCode: 1, stdout: "token=super-secret-value", stderr: "" };

  const error = await startPreview({ ...base, redactor, probe: async () => null }).catch((e) => e);

  expect(error.log).not.toContain("super-secret-value");
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/preview.test.ts`
Expected: FAIL with "Cannot find module '~/domain/runs/preview.js'".

- [ ] **Step 3: Write `src/domain/runs/preview.ts`**

Implement the nine rules above. Keep the file free of every provider SDK and of `node:http`; the readiness probe is injected.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/preview.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the integration test against a real process**

Create `tests/integration/preview-local.test.ts`. Use `LocalProcessSandbox` on a temporary directory, write a tiny Node server into the sandbox worktree, and start it as the preview. The probe is a real `fetch` wrapped so that a connection error answers `null`:

```ts
const probe = async (url: string) => {
  try {
    const response = await fetch(url);
    return { status: response.status };
  } catch {
    return null;
  }
};

it("starts a real preview process and reaches it on the exposed URL", async () => {
  const handle = await startPreview({
    sandbox,
    ref,
    workingDirectory: worktree,
    preview: {
      enabled: true,
      command: `node server.cjs`,
      readyUrl: `http://127.0.0.1:${port}/health`,
      timeoutSeconds: 30,
    },
    environment: { PORT: String(port) },
    probe,
    redactor: new Redactor(),
  });

  try {
    const response = await fetch(`${handle.baseUrl}/health`);
    expect(response.status).toBe(200);
  } finally {
    await stopPreview(sandbox, ref, handle);
  }

  // The stopped preview no longer answers.
  await expect(fetch(`${handle.baseUrl}/health`)).rejects.toThrow();
});
```

Choose the port with a helper that opens an ephemeral listener, reads its port, and closes it, so two suites never collide. Do not hard code 8080.

- [ ] **Step 6: Run the whole integration suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test:integration`
Expected: PASS. Docker must be running.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(preview): start, wait for, expose, and stop the repository preview"
```

---

## Task 3: The Validation Plan and the assertion result types

**Files:**
- Create: `src/domain/validation/validation-result.ts`
- Create: `src/domain/validation/validation-plan.ts`
- Test: `tests/unit/validation-plan.test.ts`

**Interfaces:**
- Consumes: `ValidationContract`, `ValidationAssertion`, `ValidationMethod`, `ValidationEvidenceKind` from `src/domain/validation/validation-contract.js`.
- Produces:

```ts
// validation-result.ts
/** SDD section 36 lists exactly these results. */
export const ASSERTION_RESULTS = ["PASS", "FAIL", "BLOCKED", "MANUAL_REQUIRED"] as const;
export type AssertionResult = (typeof ASSERTION_RESULTS)[number];

/** One artefact SDD section 39 turns into one immutable Evidence row. */
export interface EvidenceArtifact {
  kind: ValidationEvidenceKind;
  /** What produced the artefact, for example `browser:VAL-UI-001:screenshot`. */
  source: string;
  contentType: string;
  bytes: Uint8Array;
  /** Already redacted. Nothing in this object may hold a secret. */
  metadata: Record<string, unknown>;
}

export interface AssertionOutcome {
  assertionId: string;
  method: ValidationMethod;
  result: AssertionResult;
  /** One readable sentence. It reaches Linear, the repair prompt, and the operator log. */
  reason: string;
  artifacts: EvidenceArtifact[];
}

export interface UserValidationOutcome {
  /** True only when every assertion is PASS. SDD section 36. */
  passed: boolean;
  outcomes: AssertionOutcome[];
  summary: string;
  /** The failing assertions, formatted for `ImplementActivityInput.repairFindings`. */
  failures: string[];
}

export const summarizeUserValidation: (outcomes: AssertionOutcome[]) => UserValidationOutcome;

// validation-plan.ts
export type PlanEntryKind = "http" | "browser" | "command";

export interface HttpPlanRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  /** Begins with `/`. It is joined to the exposed preview base URL. */
  path: string;
  headers: Record<string, string>;
  body: string | null;
  expectStatus: number;
  expectBodyContains: string | null;
}

export type BrowserStep =
  | { action: "goto"; path: string }
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; value: string }
  | { action: "reload" }
  | { action: "expectText"; selector: string; text: string }
  | { action: "expectVisible"; selector: string }
  | { action: "screenshot"; name: string };

export interface CommandPlanEntry {
  run: string;
  expectExitCode: number;
}

export type ValidationPlanEntry =
  | { assertionId: string; kind: "http"; request: HttpPlanRequest }
  | { assertionId: string; kind: "browser"; steps: BrowserStep[] }
  | { assertionId: string; kind: "command"; command: CommandPlanEntry };

export interface ValidationPlan {
  version: 1;
  entries: ValidationPlanEntry[];
}

export class ValidationPlanInvalidError extends Error {
  constructor(message: string) { super(message); this.name = "ValidationPlanInvalidError"; }
}

/**
 * Parses the plan text the fresh validator session wrote and checks it against the frozen
 * contract. SDD section 25: the plan may add steps and may never change the contract.
 */
export const parseValidationPlan: (text: string, contract: ValidationContract) => ValidationPlan;

/** The plan entry kind one frozen method needs, or null when the method needs none. */
export const planKindForMethod: (method: ValidationMethod) => PlanEntryKind | null;
```

`planKindForMethod` maps `http` to `"http"`, `browser` to `"browser"`, `command` and `test` to `"command"`, and `code_review` and `manual` to `null`.

Conformance rules `parseValidationPlan` must enforce. Every one raises `ValidationPlanInvalidError` with a message that names the offending assertion:

1. The text must be JSON. A parse error names the position.
2. The document must match the zod schema, strict at every level, with `version` exactly `1`.
3. Every `assertionId` must name an assertion of the frozen contract.
4. No `assertionId` may appear twice.
5. An entry whose `kind` does not equal `planKindForMethod(assertion.method)` is rejected. The plan cannot turn a `browser` assertion into an `http` check.
6. An entry for an assertion whose `planKindForMethod` is `null` is rejected. The plan cannot claim to automate a `manual` or a `code_review` assertion.
7. A `browser` entry must hold at least one step and at least one step whose action begins with `expect`. A scenario that asserts nothing would pass every implementation, which weakens the contract.
8. A `browser` entry must hold at least one `goto` step, and its first step must be `goto`.
9. An `http` entry path must begin with `/`.
10. A missing entry is not an error here. Task 7 reports `BLOCKED` for it.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/validation-plan.test.ts` with one test per rule above, plus the happy path. Example shape:

```ts
const contract: ValidationContract = {
  version: 1,
  runId: "run-1",
  workItem: "ENG-143",
  goal: "Let an editor rename a project.",
  assertions: [
    { id: "VAL-UI-001", requirement: "AC-1", statement: "The new name stays visible after reload.",
      method: "browser", evidence: ["screenshot", "assertion-log"], preconditions: [] },
    { id: "VAL-API-001", requirement: "AC-2", statement: "PATCH /projects/{id} returns 403.",
      method: "http", evidence: ["request-response"], preconditions: [] },
    { id: "VAL-MAN-001", requirement: "AC-3", statement: "A designer confirms the spacing.",
      method: "manual", evidence: ["human-confirmation"], preconditions: [] },
  ],
};

it("accepts a plan that covers the automated assertions", () => {
  const plan = parseValidationPlan(JSON.stringify({
    version: 1,
    entries: [
      { assertionId: "VAL-UI-001", kind: "browser", steps: [
        { action: "goto", path: "/projects/1" },
        { action: "fill", selector: "#name", value: "Renamed" },
        { action: "click", selector: "#save" },
        { action: "reload" },
        { action: "expectText", selector: "#name", text: "Renamed" },
        { action: "screenshot", name: "after-reload" },
      ] },
      { assertionId: "VAL-API-001", kind: "http", request: {
        method: "PATCH", path: "/projects/1", headers: {}, body: "{}",
        expectStatus: 403, expectBodyContains: null } },
    ],
  }), contract);

  expect(plan.entries).toHaveLength(2);
});

it("rejects a plan entry for an unknown assertion", () => {
  expect(() => parseValidationPlan(JSON.stringify({
    version: 1,
    entries: [{ assertionId: "VAL-UI-999", kind: "browser", steps: [
      { action: "goto", path: "/" }, { action: "expectVisible", selector: "#x" }] }],
  }), contract)).toThrow(/VAL-UI-999/);
});

it("rejects a browser scenario that asserts nothing", () => { /* steps hold only goto and click */ });
it("rejects an entry whose kind contradicts the frozen method", () => { /* VAL-UI-001 as http */ });
it("rejects an entry for a manual assertion", () => { /* VAL-MAN-001 as command */ });
it("rejects a duplicate assertion identifier", () => { /* two entries for VAL-API-001 */ });
it("rejects an unknown key", () => { /* entries[0].comment = "hi" */ });
it("rejects text that is not JSON", () => { expect(() => parseValidationPlan("not json", contract)).toThrow(ValidationPlanInvalidError); });
```

Also write `tests/unit/validation-plan.test.ts` cases for `summarizeUserValidation`:

```ts
it("passes only when every assertion is PASS", () => {
  expect(summarizeUserValidation([pass("A"), pass("B")]).passed).toBe(true);
  expect(summarizeUserValidation([pass("A"), manual("B")]).passed).toBe(false);
  expect(summarizeUserValidation([]).passed).toBe(false);
});
```

An empty outcome list is not a pass. A Run with no assertion cannot exist after Phase 6, and a validator that produced no outcome has proved nothing.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/validation-plan.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the two modules**

Use `zod` with `.strict()` at every object level and a discriminated union on `kind` and on `action`, mirroring the style of `src/domain/projects/factoree-config.ts`. Turn every zod issue into one `ValidationPlanInvalidError` whose message lists the paths.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/validation-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(validation): add the declarative Validation Plan and the assertion result types"
```

---

## Task 4: Deterministic HTTP validation

**Files:**
- Create: `src/domain/validation/http-validation.ts`
- Test: `tests/unit/http-validation.test.ts`

**Interfaces:**
- Consumes: `HttpPlanRequest` from Task 3, `AssertionOutcome` and `EvidenceArtifact` from Task 3, `ValidationAssertion` from the contract module, `Redactor` from `src/telemetry/redaction.js`.
- Produces:

```ts
export interface HttpValidationResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The injected transport. The domain module must not import `node:http` or a provider client. */
export type HttpValidationFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string | null },
) => Promise<HttpValidationResponse>;

export interface ExecuteHttpAssertionInput {
  assertion: ValidationAssertion;
  request: HttpPlanRequest;
  /** The exposed preview URL. SDD section 37 step 3. */
  baseUrl: string;
  fetchImpl: HttpValidationFetch;
  redactor: Redactor;
}

export const executeHttpAssertion: (input: ExecuteHttpAssertionInput) => Promise<AssertionOutcome>;

/** The header names that never reach persistence. SDD section 38 and section 60. */
export const SENSITIVE_HEADERS: readonly string[];
```

Rules:

1. The URL is `new URL(request.path, baseUrl).toString()`.
2. `SENSITIVE_HEADERS` is `["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]`, compared lower case. A sensitive header is recorded with the value `[redacted]`, never with its real value, and never dropped, because SDD section 38 requires the sanitized request and the reader must see that the header was present.
3. Every other header value, the request body, and the response body pass through `redactor.redactText`.
4. A body longer than 8192 characters is truncated, and the metadata records `bodyTruncated: true` with the original length. Evidence must stay a record, not a data dump.
5. The artefact kind is `request-response`, the source is `http:${assertion.id}`, the content type is `application/json`, and the bytes are the UTF-8 encoding of the canonical JSON of the metadata. `sha256` is computed by the caller from these bytes, so the artefact and its hash cannot disagree.
6. `PASS` when the status equals `expectStatus`, and, when `expectBodyContains` is not null, when the redacted response body holds it. Otherwise `FAIL` with a reason naming the expected and the observed value.
7. A transport error is `BLOCKED`, not `FAIL`. Factoree could not reach the service, so it observed nothing about the behavior. The reason carries the redacted error message.

- [ ] **Step 1: Write the failing tests**

```ts
const assertion: ValidationAssertion = {
  id: "VAL-API-001", requirement: "AC-2",
  statement: "PATCH /projects/{id} returns 403 for a user without edit permission.",
  method: "http", evidence: ["request-response"], preconditions: [],
};

it("records the method, the path, the status, and the result", async () => {
  const outcome = await executeHttpAssertion({
    assertion,
    request: { method: "PATCH", path: "/projects/1", headers: {}, body: '{"name":"x"}',
      expectStatus: 403, expectBodyContains: null },
    baseUrl: "http://preview.invalid:8080",
    fetchImpl: async () => ({ status: 403, headers: { "content-type": "application/json" }, body: '{"error":"forbidden"}' }),
    redactor: new Redactor(),
  });

  expect(outcome.result).toBe("PASS");
  const artifact = outcome.artifacts[0]!;
  expect(artifact.kind).toBe("request-response");
  expect(artifact.metadata).toMatchObject({
    method: "PATCH", path: "/projects/1", status: 403, expectStatus: 403, passed: true,
  });
});

it("redacts a sensitive header and a Project secret", async () => {
  const outcome = await executeHttpAssertion({
    assertion,
    request: { method: "GET", path: "/me", headers: { Authorization: "Bearer abc123xyz" },
      body: null, expectStatus: 200, expectBodyContains: null },
    baseUrl: "http://preview.invalid:8080",
    fetchImpl: async () => ({ status: 200, headers: {}, body: "token super-secret-value" }),
    redactor: new Redactor(["super-secret-value"]),
  });

  const text = JSON.stringify(outcome.artifacts[0]!.metadata);
  expect(text).not.toContain("abc123xyz");
  expect(text).not.toContain("super-secret-value");
  expect(text).toContain("[redacted]");
  expect(text).toContain("authorization");
});

it("fails when the status differs from the expected status", async () => { /* 200 against expectStatus 403 → FAIL, reason names both */ });
it("fails when the expected body text is absent", async () => { /* expectBodyContains "forbidden" against body "{}" */ });
it("blocks when the transport throws", async () => {
  const outcome = await executeHttpAssertion({ ...base, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  expect(outcome.result).toBe("BLOCKED");
});
it("truncates a long body and records that it did", async () => { /* 20000 character body */ });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/http-validation.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/domain/validation/http-validation.ts`**

Implement the seven rules. Reuse `canonicalEvidenceHash` only in the caller; this module produces bytes and metadata.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/http-validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(validation): execute an HTTP assertion and record sanitized evidence"
```

---

## Task 5: The browser driver port and its Playwright adapter

**Files:**
- Create: `src/domain/validation/browser-driver.ts`
- Create: `src/adapters/browser/playwright/playwright-browser-driver.ts`
- Modify: `package.json`, `package-lock.json`
- Test: `tests/integration/playwright-browser-driver.test.ts`

**Interfaces:**
- Consumes: `BrowserStep` from Task 3.
- Produces:

```ts
export interface BrowserScenario {
  /** The exposed preview URL. Every `goto` path is resolved against it. */
  baseUrl: string;
  steps: BrowserStep[];
  /** SDD section 37. The driver records these only when the frozen assertion requires them. */
  captureVideo: boolean;
  captureTrace: boolean;
  timeoutMs: number;
}

export interface BrowserStepResult {
  index: number;
  action: string;
  passed: boolean;
  /** One readable line. It becomes the assertion log. */
  detail: string;
}

export interface BrowserArtifact {
  kind: "screenshot" | "video" | "trace";
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface BrowserNetworkEntry {
  method: string;
  url: string;
  status: number | null;
}

export interface BrowserRunResult {
  passed: boolean;
  steps: BrowserStepResult[];
  consoleLines: string[];
  network: BrowserNetworkEntry[];
  artifacts: BrowserArtifact[];
  /** Null when every step passed. */
  failureReason: string | null;
}

export interface BrowserDriver {
  readonly name: string;
  run(scenario: BrowserScenario): Promise<BrowserRunResult>;
}
```

Adapter rules:

1. `PlaywrightBrowserDriver` is the only file in the repository that imports `playwright`. `name` is `"playwright"`.
2. It launches Chromium headless, creates one context per scenario, and closes both in a `finally`.
3. It always collects console messages as `"<type>: <text>"` and network responses as `{ method, url, status }`. These cost nothing and answer the `console` and `network` evidence kinds of SDD section 37.
4. It records a video only when `captureVideo` is true, and a trace only when `captureTrace` is true. Both are read from disk into bytes and their temporary directory is removed.
5. A step that throws stops the scenario. Every later step is reported with `passed: false` and the detail `"not run"`. `failureReason` carries the redacted Playwright message.
6. `expectText` passes when the trimmed text content of the selector equals the trimmed expected text. `expectVisible` passes when the locator is visible. Both use `scenario.timeoutMs` divided by the step count as the per-step timeout, with a 1000 ms floor.
7. A `screenshot` step produces one artefact named by the step. The driver also takes one final screenshot named `final`, so a failure always carries a picture.
8. The adapter never accepts a URL outside `baseUrl`. A `goto` path must begin with `/`; the adapter resolves it with `new URL(path, baseUrl)`. Task 3 already rejects any other form, and this is the second control.

- [ ] **Step 1: Add the dependency**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm install --save-exact playwright@1.62.1
```

The machine already holds the matching Chromium build in `~/Library/Caches/ms-playwright`. If `chromium.executablePath()` names a directory that does not exist, run `npx playwright install chromium`.

- [ ] **Step 2: Write the failing integration test**

Create `tests/integration/playwright-browser-driver.test.ts`. Serve a two-page fixture from `node:http` on an ephemeral port, with a form whose submit updates the text and whose value survives a reload.

```ts
it("runs a scenario, asserts the page state, and returns a screenshot", async () => {
  const result = await driver.run({
    baseUrl,
    steps: [
      { action: "goto", path: "/" },
      { action: "fill", selector: "#name", value: "Renamed" },
      { action: "click", selector: "#save" },
      { action: "reload" },
      { action: "expectText", selector: "#current", text: "Renamed" },
      { action: "screenshot", name: "after-reload" },
    ],
    captureVideo: false, captureTrace: false, timeoutMs: 30_000,
  });

  expect(result.passed).toBe(true);
  expect(result.steps.every((step) => step.passed)).toBe(true);
  const screenshot = result.artifacts.find((a) => a.name === "after-reload");
  expect(screenshot?.kind).toBe("screenshot");
  expect(screenshot!.bytes.byteLength).toBeGreaterThan(1_000);
  expect(result.network.some((entry) => entry.status === 200)).toBe(true);
});

it("fails the scenario when the expected text is absent, and still returns a screenshot", async () => {
  const result = await driver.run({ ...scenario, steps: [
    { action: "goto", path: "/" },
    { action: "expectText", selector: "#current", text: "Never" },
  ] });

  expect(result.passed).toBe(false);
  expect(result.failureReason).toBeTruthy();
  expect(result.artifacts.some((a) => a.name === "final")).toBe(true);
});

it("captures a trace when the scenario asks for one", async () => {
  const result = await driver.run({ ...scenario, captureTrace: true });
  const trace = result.artifacts.find((a) => a.kind === "trace");
  expect(trace!.bytes.byteLength).toBeGreaterThan(0);
});

it("reports console output from the page", async () => { /* the fixture page logs one line */ });
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/playwright-browser-driver.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Write the port and the adapter**

Give the integration test a generous per-test timeout. A first browser launch on a cold cache takes several seconds.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/playwright-browser-driver.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the lint rule that keeps the SDK in the adapter**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH grep -rn "from \"playwright\"" src | grep -v "src/adapters/browser/playwright/"`
Expected: no output. SDD section 14.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(validation): drive a real browser through the BrowserDriver port"
```

---
## Task 6: Evidence artefact storage and the persisted assertion result

**Files:**
- Modify: `src/domain/evidence/evidence.ts`
- Create: `src/domain/evidence/evidence-storage.ts`
- Create: `src/adapters/evidence/filesystem-evidence-storage.ts`
- Create: `src/adapters/linear/linear-evidence-storage.ts`
- Create: `src/domain/validation/validation-result-store.ts`
- Create: `src/persistence/prisma/validation-result.prisma.ts`
- Modify: `src/domain/validation/validation-contract-store.ts`, `src/persistence/prisma/validation-contract.prisma.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260826120000_add_validation_results/migration.sql`
- Test: `tests/integration/evidence-storage.test.ts`, `tests/integration/validation-results.test.ts`, `tests/integration/validation-contract-store.test.ts` (extend)

**Interfaces:**
- Produces:

```ts
// evidence.ts — the widened kind. SDD section 39 gives no closed list; SDD section 37 and
// section 38 name the artefacts a validation produces.
export type EvidenceKind = "deterministic_check" | ValidationEvidenceKind;

// evidence-storage.ts
export interface StoredArtifact {
  /** What the active adapter returned. It is opaque to the domain. */
  storageRef: string;
  /** The SHA-256 of the exact bytes that were stored. */
  sha256: string;
  byteLength: number;
}

export interface PutArtifactInput {
  tenantId: string;
  runId: string;
  /** A stable, readable file name, for example `VAL-UI-001-after-reload.png`. */
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * SDD section 39. Version 1 SHOULD store user-facing evidence through Linear private file
 * storage where practical. The port keeps that choice out of the domain, and it keeps every
 * test free of a live Linear account. See controller decision 8.
 */
export interface EvidenceStorage {
  readonly name: string;
  put(input: PutArtifactInput): Promise<StoredArtifact>;
}

export const hashArtifactBytes: (bytes: Uint8Array) => string;

// validation-result-store.ts
export interface ValidationAssertionResultRecord {
  id: string;
  tenantId: string;
  runId: string;
  /** The database identifier of the `ValidationAssertion` row. */
  validationAssertionId: string;
  /** The contract-level identifier, for example `VAL-UI-001`. */
  assertionKey: string;
  result: AssertionResult;
  reason: string;
  /** The user validation pass this result belongs to. The first pass is 1. */
  attempt: number;
  createdAt: Date;
}

export interface RecordAssertionResultInput {
  tenantId: string;
  runId: string;
  validationAssertionId: string;
  assertionKey: string;
  result: AssertionResult;
  reason: string;
  attempt: number;
}

export interface ValidationResultStore {
  /** Idempotent on `(runId, validationAssertionId, attempt)`. A Temporal retry writes nothing new. */
  record(input: RecordAssertionResultInput): Promise<ValidationAssertionResultRecord>;
  listForRun(tenantId: string, runId: string): Promise<ValidationAssertionResultRecord[]>;
}

// validation-contract-store.ts — the stored assertion gains its row identifier, because
// `Evidence.validationAssertionId` and `ValidationAssertionResult.validationAssertionId` are
// foreign keys onto the row and not onto the contract-level identifier.
export interface StoredValidationAssertion extends ValidationAssertion {
  /** The database identifier of this assertion row. */
  rowId: string;
}
// StoredValidationContract.assertions becomes StoredValidationAssertion[].
```

Prisma changes:

```prisma
model ValidationAssertion {
  // existing fields stay unchanged, and two back relations are added:
  evidence Evidence[]
  results  ValidationAssertionResult[]
}

model Evidence {
  // the existing nullable column gains its relation. The comment that says Phase 6 fills it is
  // replaced by one that says the validation assertion this artifact answers.
  validationAssertionId String?
  validationAssertion   ValidationAssertion? @relation(fields: [validationAssertionId], references: [id], onDelete: SetNull)
}

model ValidationAssertionResult {
  id                    String              @id @default(uuid())
  tenantId              String
  runId                 String
  run                   Run                 @relation(fields: [runId], references: [id], onDelete: Cascade)
  validationAssertionId String
  assertion             ValidationAssertion @relation(fields: [validationAssertionId], references: [id], onDelete: Cascade)
  assertionKey          String
  /** PASS, FAIL, BLOCKED, or MANUAL_REQUIRED. SDD section 36. */
  result                String
  reason                String
  attempt               Int
  createdAt             DateTime            @default(now())

  @@unique([runId, validationAssertionId, attempt])
  @@index([tenantId, runId])
}
```

`Run` gains `validationResults ValidationAssertionResult[]`.

- [ ] **Step 1: Write the failing integration test for the result store**

Create `tests/integration/validation-results.test.ts` on the Testcontainers database, following `tests/integration/validation-contract-store.test.ts`.

```ts
it("records one result per assertion and per attempt", async () => {
  const first = await results.record({ ...input, result: "FAIL", reason: "the text did not match", attempt: 1 });
  const repeat = await results.record({ ...input, result: "PASS", reason: "a later claim", attempt: 1 });

  // SDD section 39. The row is immutable. The second call returns the first row unchanged.
  expect(repeat.id).toBe(first.id);
  expect(repeat.result).toBe("FAIL");

  const second = await results.record({ ...input, result: "PASS", reason: "the repair worked", attempt: 2 });
  expect(second.id).not.toBe(first.id);

  const all = await results.listForRun(tenantId, runId);
  expect(all.map((row) => row.attempt)).toEqual([1, 2]);
});

it("reports no result to another tenant", async () => {
  expect(await results.listForRun("other-tenant", runId)).toEqual([]);
});
```

- [ ] **Step 2: Write the failing integration test for artefact storage**

Create `tests/integration/evidence-storage.test.ts`.

```ts
it("stores the bytes and returns a reference and their hash", async () => {
  const storage = new FilesystemEvidenceStorage({ rootDirectory: root });
  const bytes = new TextEncoder().encode("hello");

  const stored = await storage.put({ tenantId: "t", runId: "r", name: "a.txt", contentType: "text/plain", bytes });

  expect(stored.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(stored.byteLength).toBe(5);
  expect(await readFile(stored.storageRef.replace("file://", ""), "utf8")).toBe("hello");
});

it("keeps one tenant's artefacts out of another tenant's directory", async () => { /* two tenants, two paths */ });

it("uploads through Linear when the Linear adapter is active", async () => {
  // A fake `LinearFileUploadApi` records the call and answers an asset URL. The adapter must
  // request an upload, send the bytes, and return the asset URL as the storage reference.
  const storage = new LinearEvidenceStorage(fakeApi);
  const stored = await storage.put({ ...input });
  expect(stored.storageRef).toBe("https://uploads.linear.app/asset-1");
  expect(fakeApi.calls[0]).toMatchObject({ contentType: "image/png", size: bytes.byteLength });
});

it("reports a Linear upload failure as an error the caller can survive", async () => {
  await expect(new LinearEvidenceStorage(failingApi).put(input)).rejects.toThrow(EvidenceStorageError);
});
```

`LinearEvidenceStorage` takes a narrow port, in the style of `LinearApi` in `src/adapters/linear/linear-agent-client.ts`:

```ts
export interface LinearFileUploadApi {
  fileUpload(contentType: string, filename: string, size: number): Promise<{
    success: boolean;
    uploadFile: { uploadUrl: string; assetUrl: string; headers: Array<{ key: string; value: string }> } | null;
  }>;
}
```

The adapter requests the upload, PUTs the bytes to `uploadUrl` with the returned headers through an injected `fetch`, and returns `assetUrl`. A failed request raises `EvidenceStorageError`, which the adapter file exports.

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/evidence-storage.test.ts tests/integration/validation-results.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write the migration by hand**

Create `prisma/migrations/20260826120000_add_validation_results/migration.sql`. It creates `ValidationAssertionResult` with its unique index and its two foreign keys, and it adds the foreign key from `Evidence.validationAssertionId` to `ValidationAssertion.id` with `ON DELETE SET NULL`. It adds no column to `Evidence`, because the column already exists.

**Warn:** an existing `Evidence` row from Phase 3 carries `validationAssertionId = NULL`, which satisfies the new foreign key. Confirm this against a populated database before you call the task complete:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH DATABASE_URL=postgres://ignored npx prisma migrate diff \
  --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_URL" --exit-code
```

Expected: exit code 0 and "No difference detected". The Phase 6 status note records that the previous phase verified its migration this way.

- [ ] **Step 5: Write the modules and the stores**

Write `evidence-storage.ts`, `FilesystemEvidenceStorage`, `LinearEvidenceStorage`, `validation-result-store.ts`, and `PrismaValidationResultStore`. Follow `PrismaEvidenceStore` for the idempotent write: read first, create, and on a unique-constraint error read the winner. Add the tenant guard exactly as `PrismaEvidenceStore.assertOwnedByTenant` does.

Widen `EvidenceKind` in `src/domain/evidence/evidence.ts` and import `ValidationEvidenceKind` from the validation module. Extend `PrismaValidationContractStore` so that every returned assertion carries `rowId`.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test:integration`
Expected: PASS, whole suite. Run the whole suite, not one file.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(evidence): store validation artefacts and persist one result per assertion"
```

---

## Task 7: The `UserValidator` module

**Files:**
- Create: `src/domain/validation/user-validator.ts`
- Test: `tests/unit/user-validator.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2, 3, 4, and 5, plus `Sandbox`, `SandboxRef`, `Redactor`, `Logger`.
- Produces:

```ts
export interface UserValidatorDependencies {
  sandbox: Sandbox;
  browser: BrowserDriver;
  fetchImpl: HttpValidationFetch;
  probe: ReadinessProbe;
  redactor: Redactor;
  logger: Logger;
}

export interface UserValidationInput {
  runId: string;
  tenantId: string;
  ref: SandboxRef;
  primaryPath: string;
  contract: ValidationContract;
  preview: PreviewConfig | null;
  /** The plan text the fresh validator session wrote, or null when it wrote none. */
  planText: string | null;
  /** Project test secrets only. SDD section 30. */
  environment: Record<string, string>;
  timeoutMs: number;
}

export const runUserValidation: (
  dependencies: UserValidatorDependencies,
  input: UserValidationInput,
) => Promise<UserValidationOutcome>;
```

The order of work, and the rule at each point:

1. **Classify every assertion.** A `manual` or `code_review` assertion is `MANUAL_REQUIRED` at once, with the reason `"SDD section 36: this assertion needs a human. Factoree cannot prove it."` It runs nothing and produces no artefact. Controller decision 5.
2. **Parse the plan.** `planText === null`, or a `ValidationPlanInvalidError`, makes every remaining assertion `BLOCKED` with the redacted parse message as the reason. Nothing else runs. Controller decision 4.
3. **An assertion with no plan entry is `BLOCKED`,** with the reason `"The validator produced no check for this assertion."`
4. **Decide whether a preview is needed.** It is needed when at least one plan entry is `http` or `browser`. When it is needed and `preview` is null or `preview.enabled` is false, every `http` and `browser` assertion is `BLOCKED` with a reason that names `.factoree/config.yaml` and the `preview` block. Controller decision 7.
5. **Start the preview once, for the whole pass.** A `PreviewStartError` makes every `http` and `browser` assertion `BLOCKED` with the redacted reason and the redacted startup log in the artefact metadata. The startup log becomes one `console` artefact on the first such assertion, so an operator can read why.
6. **Execute the entries in contract order,** not in plan order, so the result list always matches the frozen document.
7. **`http`** calls `executeHttpAssertion` with the exposed base URL.
8. **`browser`** calls `dependencies.browser.run` with `captureVideo` and `captureTrace` set from `assertion.evidence.includes("video")` and `assertion.evidence.includes("trace")`. It then turns the run result into artefacts: every `BrowserArtifact` becomes one artefact of its own kind; the console lines become one `console` artefact; the network entries become one `network` artefact; the step results become one `assertion-log` artefact. The metadata of each artefact holds the assertion identifier and the redacted content.
9. **`command`** runs `sandbox.exec(ref, { file: "sh", args: ["-c", entry.command.run], cwd: primaryPath, env: environment, timeoutMs })`. `PASS` when the exit code equals `expectExitCode`. The artefact kind is `command-output` for a `command` assertion and `test-report` for a `test` assertion, with metadata holding the command, the exit code, the stdout hash, the stderr hash, and the redacted log.
10. **Enforce the required evidence of SDD section 37.** After an otherwise passing assertion, compare `assertion.evidence` with the kinds actually produced. A missing required kind turns the result into `FAIL` with a reason naming the missing kind, because the contract required proof that does not exist. Controller decision 12.
11. **Stop the preview in a `finally`,** whatever happened.
12. **Summarize** through `summarizeUserValidation`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/user-validator.test.ts` with doubles for every dependency: a fake sandbox that records `exec`, a fake browser driver that answers a scripted `BrowserRunResult`, a fake fetch, and a probe that answers ready at once.

```ts
it("passes a Run whose browser and HTTP assertions both hold", async () => {
  const outcome = await runUserValidation(deps, input);
  expect(outcome.passed).toBe(true);
  expect(outcome.outcomes.map((entry) => entry.result)).toEqual(["PASS", "PASS"]);
});

it("produces the evidence kinds the frozen assertion requires", async () => {
  const browser = outcome.outcomes.find((entry) => entry.assertionId === "VAL-UI-001")!;
  expect(browser.artifacts.map((a) => a.kind).sort())
    .toEqual(["assertion-log", "console", "network", "screenshot"]);
});

it("fails a passing scenario that produced no required screenshot", async () => {
  // The driver answers `passed: true` and no artefact, and the assertion requires `screenshot`.
  expect(outcome.outcomes[0]!.result).toBe("FAIL");
  expect(outcome.outcomes[0]!.reason).toContain("screenshot");
});

it("reports MANUAL_REQUIRED for a manual assertion and runs nothing", async () => {
  expect(outcome.outcomes.find((e) => e.assertionId === "VAL-MAN-001")!.result).toBe("MANUAL_REQUIRED");
  expect(deps.browser.calls).toHaveLength(0);
  expect(outcome.passed).toBe(false);
});

it("blocks every automated assertion when the plan is absent", async () => {
  const outcome = await runUserValidation(deps, { ...input, planText: null });
  expect(outcome.outcomes.map((e) => e.result)).toEqual(["BLOCKED", "BLOCKED", "MANUAL_REQUIRED"]);
});

it("blocks every automated assertion when the plan is not valid", async () => { /* planText: "{" */ });

it("blocks a browser assertion when the repository configures no preview", async () => {
  const outcome = await runUserValidation(deps, { ...input, preview: null });
  expect(outcome.outcomes[0]!.result).toBe("BLOCKED");
  expect(outcome.outcomes[0]!.reason).toContain(".factoree/config.yaml");
});

it("blocks the browser and HTTP assertions when the preview never becomes ready", async () => {
  // The probe never answers a ready status. The startup log reaches one console artefact.
  expect(outcome.outcomes[0]!.result).toBe("BLOCKED");
  expect(outcome.outcomes[0]!.artifacts.some((a) => a.kind === "console")).toBe(true);
});

it("stops the preview even when a step throws", async () => {
  expect(sandbox.cancelled).toHaveLength(1);
});

it("returns the results in the order of the frozen contract", async () => { /* plan entries reversed */ });

it("reports a failing assertion as a repair finding", async () => {
  expect(outcome.failures[0]).toContain("VAL-UI-001");
  expect(outcome.failures[0]).toContain(contract.assertions[0]!.statement);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/user-validator.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/domain/validation/user-validator.ts`**

Implement the twelve rules. The module imports no provider SDK and no Prisma client. It returns artefacts in memory; Task 8 stores them.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/user-validator.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole unit suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(validation): add the UserValidator that executes the frozen contract"
```

---

## Task 8: The validator prompt, the `userValidate` activity, and evidence persistence

**Files:**
- Create: `src/prompts/user-validator.ts`
- Create: `src/domain/validation/user-validator-input.ts`
- Create: `src/activities/evidence.activities.ts`
- Modify: `src/activities/validation.activities.ts`
- Modify: `src/domain/policy/action-policy.ts`
- Modify: `src/telemetry/metrics.ts`
- Modify: `src/activities/index.ts`, `src/bin/worker.ts`
- Test: `tests/unit/user-validator-prompt.test.ts`, `tests/unit/validate-activity.test.ts`

**Interfaces:**
- Produces:

```ts
// prompts/user-validator.ts
export const USER_VALIDATOR_PROMPT_VERSION = "user-validator@1";
export const renderUserValidatorPrompt: (input: {
  goal: string;
  validationContract: string;
  primaryRepositoryPath: string;
  planPath: string;
  previewBaseUrl: string | null;
  actionPolicy: string[];
  planSchema: string;
}) => string;

// domain/validation/user-validator-input.ts — mirrors `buildImplementerInput`.
export interface BuildUserValidatorInput {
  goal: string;
  validationContract: string;
  primaryRepositoryPath: string;
  planPath: string;
  previewBaseUrl: string | null;
  actionPolicy: ActionPolicy;
  projectTestSecrets: Record<string, string>;
}
export interface UserValidatorInput { prompt: string; promptVersion: string; environment: Record<string, string>; }
export const buildUserValidatorInput: (input: BuildUserValidatorInput) => UserValidatorInput;

// action-policy.ts — a role control, not a Project override. SDD section 29 permits one
// Project override, and this is not one: it is the role of the session. See controller
// decision 14.
export interface ActionPolicyOverrides {
  stagingRead?: boolean;
  mcpAllowedTools?: string[];
  /** The session role. `implementer` writes the primary worktree; no other role does. */
  role?: AgentRole;
}

// activities/evidence.activities.ts
export interface EvidencePersistenceDependencies {
  evidence: EvidenceStore;
  results: ValidationResultStore;
  storage: EvidenceStorage;
  logger: Logger;
}
export interface PersistAssertionOutcomeInput {
  tenantId: string;
  runId: string;
  /** The database identifier of the assertion row, from the contract store. */
  validationAssertionId: string;
  outcome: AssertionOutcome;
  attempt: number;
}
export const createEvidencePersistence: (
  dependencies: EvidencePersistenceDependencies,
) => { persistAssertionOutcome(input: PersistAssertionOutcomeInput): Promise<void> };

// activities/validation.activities.ts — the new activity.
export interface UserValidateActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  runnerName: string;
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  goal: string;
  preview: PreviewConfig | null;
  timeoutMs: number;
  /** The user validation pass. The first pass is 1, and a repair raises it. */
  attempt: number;
}

export interface UserValidateActivityOutput {
  passed: boolean;
  results: Array<{ assertionId: string; result: AssertionResult; reason: string }>;
  /** True when at least one assertion is FAIL. Only then can a repair help. */
  hasFailure: boolean;
  /** True when at least one assertion is MANUAL_REQUIRED. */
  hasManual: boolean;
  /** True when at least one assertion is BLOCKED. */
  hasBlocked: boolean;
  summary: string;
  /** The failing assertions, formatted for `ImplementActivityInput.repairFindings`. */
  failures: string[];
  /** AT-17. The runner session identifier of this validator pass. */
  sessionId: string;
}
```

The activity, in order:

1. Registers Project secrets with the redactor, exactly as `verify` does. SDD section 60.
2. Reads the frozen contract with `contracts.findByRun`. A Run with no frozen contract cannot reach this activity, so an absent contract raises, and Temporal reports the fault.
3. Builds the Action Policy with `role: "validator"`, so `writePrimaryWorktree` is denied. Controller decision 6.
4. Creates the scratch directory `${workspacePath}/validation` through `sandbox.exec`, with `mkdir -p`.
5. Starts the preview when the contract holds a `browser` or `http` assertion and the repository configures one, so that the validator prompt can state the exposed base URL. The same handle serves the execution, and it is stopped once, in a `finally`.
6. Runs the fresh validator session through `runners.get(input.runnerName)` with `role: "validator"`, the prompt from `buildUserValidatorInput`, and the working directory `${workspacePath}/validation`. SDD section 36: the input holds the goal, the frozen contract, the repository path, the plan path, and the preview URL, and it holds no Implementer transcript, no Implementer summary, and no Reviewer finding. The activity never receives those values, which is the strongest form of that guarantee.
7. Records one `AgentExecution` row with `role: "validator"`, the runner, `USER_VALIDATOR_PROMPT_VERSION`, and the idempotency key `run:${runId}:validator:${attempt}`. SDD section 56.
8. Reads `${workspacePath}/validation/plan.json` through `sandbox.exec` with `cat`. A non-zero exit gives `planText = null`.
9. Calls `runUserValidation`.
10. Persists every outcome through `createEvidencePersistence`, using the `rowId` of the matching stored assertion.
11. Observes `metrics.validationDuration`, the new `factoree_validation_duration_seconds` histogram of SDD section 62.
12. Heartbeats every 30 seconds and cancels the live validator session on cancellation, exactly as `implement` does.

`persistAssertionOutcome` stores each artefact through `EvidenceStorage.put`, then writes one `Evidence` row per artefact with `kind` from the artefact, `source` from the artefact, `sha256` from the stored bytes, `storageRef` from the adapter, the artefact metadata, and the idempotency key `run:${runId}:validation:${attempt}:${assertionKey}:${artifact.source}`. It then writes the `ValidationAssertionResult` row.

- [ ] **Step 1: Write the failing prompt tests**

Create `tests/unit/user-validator-prompt.test.ts`, in the style of `tests/unit/implementer-prompt.test.ts` and `tests/unit/implementer-input.test.ts`.

```ts
it("gives the validator the goal, the frozen contract, and the plan path", () => {
  const built = buildUserValidatorInput({ ...base });
  expect(built.prompt).toContain("Add the health endpoint");
  expect(built.prompt).toContain("# Validation Contract");
  expect(built.prompt).toContain("/workspace/validation/plan.json");
  expect(built.promptVersion).toBe("user-validator@1");
});

it("tells the validator it must not change a production source file", () => {
  expect(buildUserValidatorInput(base).prompt).toMatch(/must not (change|edit|write)[^.]*source file/i);
});

it("tells the validator it must not weaken the contract", () => {
  expect(buildUserValidatorInput(base).prompt).toContain("weaken");
});

it("states the exposed preview URL when one exists", () => { /* previewBaseUrl */ });
it("states that no preview exists when the repository configures none", () => { /* previewBaseUrl: null */ });

it("rejects a forbidden credential in the test secrets", () => {
  expect(() => buildUserValidatorInput({ ...base, projectTestSecrets: { GITHUB_TOKEN: "x" } }))
    .toThrow(ForbiddenImplementerMaterialError);
});
```

Reuse the existing credential guard of `src/domain/runs/implementer-input.ts` rather than writing a second one. Export the guard from that module and call it from both builders.

- [ ] **Step 2: Write the failing activity tests**

Create `tests/unit/validate-activity.test.ts`, in the style of `tests/unit/implement-activity.test.ts`. Use a fake runner, a fake sandbox, an in-memory evidence store, an in-memory result store, an in-memory storage adapter, and a fake browser driver.

```ts
it("runs a fresh validator session and records its prompt version", async () => {
  const output = await activities.userValidate(input);
  expect(runner.calls[0]!.role).toBe("validator");
  expect(executions.rows[0]).toMatchObject({ role: "validator", promptVersion: "user-validator@1" });
  expect(output.sessionId).toBe(runner.calls[0]!.sessionId);
});

it("never gives the validator an Implementer transcript", () => {
  // AT-17 proves this from the activity input type as well as from the prompt.
  expect(runner.calls[0]!.prompt).not.toContain("The change is applied.");
});

it("denies the validator the primary worktree", async () => {
  expect(runner.calls[0]!.actionPolicy.decide("writePrimaryWorktree")).toBe("deny");
});

it("writes one evidence row per artefact and one result row per assertion", async () => {
  expect(evidence.rows.filter((row) => row.validationAssertionId !== null)).toHaveLength(4);
  expect(results.rows).toHaveLength(2);
  expect(results.rows[0]).toMatchObject({ result: "PASS", attempt: 1 });
});

it("reports hasFailure only when an assertion is FAIL", async () => { /* FAIL, then MANUAL only */ });

it("writes nothing new on a second call with the same attempt", async () => {
  await activities.userValidate(input);
  await activities.userValidate(input);
  expect(results.rows).toHaveLength(2);
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/user-validator-prompt.test.ts tests/unit/validate-activity.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write the prompt, the input builder, the persistence, the metric, and the activity**

Add to `src/telemetry/metrics.ts`:

```ts
validationDuration: new Histogram({
  name: "factoree_validation_duration_seconds",
  help: "User validation duration in seconds",
  labelNames,
  buckets: [0.1, 1, 5, 30, 120, 600],
  registers: [registry],
}),
```

Register `userValidate` in `src/activities/index.ts` and wire the new dependencies in `src/bin/worker.ts`: the `PlaywrightBrowserDriver`, the chosen `EvidenceStorage`, the `PrismaValidationResultStore`, and a readiness probe and a validation fetch built on the platform `fetch`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/user-validator-prompt.test.ts tests/unit/validate-activity.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole unit suite and the type check**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(validation): add the fresh User Validator session and its evidence persistence"
```

---

## Task 9: `USER_VALIDATING` in the workflow

**Files:**
- Modify: `src/workflows/agent-run.workflow.ts`
- Modify: `src/domain/runs/run-status.ts`
- Modify: `tests/workflow/support/harness.ts`
- Modify: `tests/workflow/at-35-worker-restart.test.ts`
- Test: `tests/workflow/user-validation.workflow.test.ts`

**Interfaces:**
- Consumes: `UserValidateActivityInput` and `UserValidateActivityOutput` from Task 8.
- Produces: three new entries in `RUN_FAILURE_REASONS`:

```ts
// SDD section 36. At least one assertion is FAIL and the repair budget of SDD section 42 is spent.
"VALIDATION_FAILED",
// SDD section 36. Factoree could not run a check, so it proved nothing. A repair cannot help.
"VALIDATION_BLOCKED",
// SDD section 36. An assertion needs a human, so an L3 Run cannot complete on its own.
"VALIDATION_MANUAL_REQUIRED",
```

Workflow rules:

1. After `verification.passed` breaks the deterministic loop, the Run enters `USER_VALIDATING` and calls `userValidate` inside the same bounded loop, with `attempt` equal to the current implementation attempt.
2. The activity is built with the same long-activity options `implement` uses, so a stop cancels the live validator session. A stop that arrived during the pass ends the Run through `cancelRun`.
3. `passed` leaves the loop. The Run then reaches the residual wait exactly as it did after Phase 6, because SDD section 68 still forbids `READY_FOR_HUMAN` without a PR and a Proof Pack.
4. `hasFailure` and a remaining repair budget raise `repairCount` and `attempt`, set `repairFindings` to `validation.failures`, set `REPAIRING`, and continue the loop. The next pass re-runs the Implementer and then re-runs deterministic verification before user validation runs again. SDD section 49 and AT-20.
5. `hasFailure` with no remaining budget fails the Run with `VALIDATION_FAILED`.
6. No failure and at least one `BLOCKED` fails the Run with `VALIDATION_BLOCKED`. A repair cannot fix a check Factoree could not run. Controller decision 4.
7. No failure, nothing blocked, and at least one `MANUAL_REQUIRED` fails the Run with `VALIDATION_MANUAL_REQUIRED`. SDD section 36 forbids completion, and Factoree must say so rather than wait for a timeout.
8. The summary is posted to Linear through the existing `notify(postProgress)` helper.
9. Every deadline check follows the pattern the verification stage already uses: `if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);`, and a throw with a spent budget becomes `RUN_TIMEOUT` rather than an internal fault.

- [ ] **Step 1: Extend the harness**

Add to `tests/workflow/support/harness.ts`:
- `userValidateCalls: UserValidateActivityInput[]`
- `userValidationOutcomes: Map<string, (attempt: number) => UserValidateActivityOutput>`
- `heldUserValidations: Map<string, Promise<void>>`
- a `userValidate` double that pushes `"userValidate"` onto `activityOrder` and answers a passing result by default
- an `"implement"` marker on `activityOrder`, which the Phase 6 carried finding asked for
- `preview: null` on the `prepareSandbox` result, if Task 1 did not already add it

- [ ] **Step 2: Write the failing workflow tests**

Create `tests/workflow/user-validation.workflow.test.ts`.

```ts
it("validates after verification and before the residual wait", async () => {
  await runWorker(...);
  expect(harness.statusesOf(runId)).toContain("USER_VALIDATING");
  const order = harness.activityOrder;
  expect(order.indexOf("verify")).toBeLessThan(order.indexOf("userValidate"));
});

it("repairs once when an assertion fails, then reverifies and revalidates", async () => {
  harness.userValidationOutcomes.set(runId, (attempt) => (attempt === 1 ? failing : passing));

  await runWorker(...);

  expect(harness.statusesOf(runId)).toEqual([
    "REFINING", "RESOLVING_CONTEXT", "BUILDING_VALIDATION_CONTRACT", "PREPARING",
    "IMPLEMENTING", "VERIFYING", "USER_VALIDATING", "REPAIRING",
    "IMPLEMENTING", "VERIFYING", "USER_VALIDATING",
  ]);
  expect(harness.implementCalls[1]!.repairFindings[0]).toContain("VAL-UI-001");
});

it("fails with VALIDATION_FAILED when the repair budget is spent", async () => {
  harness.runtimeOverrides.set(runId, { repairMaxAttempts: 1 });
  harness.userValidationOutcomes.set(runId, () => failing);

  expect(harness.completions.at(-1)).toMatchObject({ status: "FAILED", failureReason: "VALIDATION_FAILED" });
});

it("fails with VALIDATION_MANUAL_REQUIRED and starts no repair", async () => {
  harness.userValidationOutcomes.set(runId, () => manualOnly);
  expect(harness.statusesOf(runId)).not.toContain("REPAIRING");
  expect(harness.completions.at(-1)).toMatchObject({ failureReason: "VALIDATION_MANUAL_REQUIRED" });
});

it("fails with VALIDATION_BLOCKED and starts no repair", async () => { /* blockedOnly */ });

it("cancels the Run when a stop arrives during user validation", async () => {
  // Hold the pass open, send the stop signal, and expect CANCELLED and no further activity.
});

it("posts the validation summary to Linear", async () => {
  expect(harness.postedProgress).toContain(passing.summary);
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.workflow.config.ts tests/workflow/user-validation.workflow.test.ts`
Expected: FAIL, `USER_VALIDATING` never appears.

- [ ] **Step 4: Write the workflow change**

Implement the nine rules in `src/workflows/agent-run.workflow.ts`. Add the three failure reasons to `src/domain/runs/run-status.ts` and to the failure-reason union inside the workflow file.

- [ ] **Step 5: Repair the hand-built activity map of AT-35**

**Warn:** `tests/workflow/at-35-worker-restart.test.ts` does not use the harness. Add the `userValidate` double to its own map by hand. `npm run typecheck` cannot catch a missing entry there, and the Phase 6 note records that the same omission failed a Run intermittently after a restart.

- [ ] **Step 6: Run the whole workflow suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test:workflow`
Expected: PASS, every file. Run it twice, because the restart test is order sensitive.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(workflow): add USER_VALIDATING, the all-PASS gate, and the validation repair branch"
```

---

## Task 10: AT-17, AT-18, AT-19, AT-25, and the Phase 7 exit test

**Files:**
- Create: `tests/acceptance/support/preview-fixture-app.ts`
- Create: `tests/acceptance/at-17-fresh-user-validation.test.ts`
- Create: `tests/acceptance/at-18-ui-evidence.test.ts`
- Create: `tests/acceptance/at-19-http-evidence.test.ts`
- Create: `tests/acceptance/at-25-evidence-completeness.test.ts`
- Create: `tests/acceptance/phase-07-exit.test.ts`

The acceptance tests run under `vitest.integration.config.ts`, not under a config of their own.

**The fixture.** `preview-fixture-app.ts` writes a tiny repository into a directory: a `package.json`, a `.factoree/config.yaml` with a `verify` command and a `preview` block, and a `server.cjs` that serves one page. The page shows a project name, a text field, and a save button, and it keeps the name in a file so that the value survives a reload. It also answers `GET /health` with 200 and `PATCH /projects/1` with 403 for a request that carries no `x-editor` header. This one fixture serves the browser assertion, the HTTP assertion, and the exit test.

- [ ] **Step 1: Write AT-19 — an HTTP assertion records sanitized request and response evidence**

```ts
it("AT-19: records the method, the path, the sanitized request, the status, and the result", async () => {
  const outcome = await runUserValidation(deps, input);  // one http assertion against the real fixture

  const artifact = outcome.outcomes[0]!.artifacts.find((a) => a.kind === "request-response")!;
  expect(artifact.metadata).toMatchObject({
    method: "PATCH", path: "/projects/1", status: 403, expectStatus: 403, passed: true,
  });
  // SDD section 38. A sensitive value never reaches persistence.
  const text = new TextDecoder().decode(artifact.bytes);
  expect(text).not.toContain("super-secret-value");
  expect(text).toContain("[redacted]");
});
```

The request carries an `Authorization` header and a Project secret in its body, and the redactor holds that secret.

- [ ] **Step 2: Write AT-18 — a browser assertion produces the evidence its contract entry requires**

```ts
it("AT-18: produces exactly the evidence kinds the frozen assertion requires", async () => {
  // The frozen assertion requires screenshot, network, and assertion-log.
  const kinds = new Set(outcome.outcomes[0]!.artifacts.map((a) => a.kind));
  for (const required of contract.assertions[0]!.evidence) expect(kinds.has(required)).toBe(true);

  const screenshot = outcome.outcomes[0]!.artifacts.find((a) => a.kind === "screenshot")!;
  // A real PNG, from a real browser, against the real preview.
  expect(Array.from(screenshot.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(outcome.outcomes[0]!.result).toBe("PASS");
});

it("AT-18: an assertion whose required evidence is missing does not pass", async () => {
  // A driver double that answers `passed: true` with no artefact, against the same contract.
  expect(outcome.outcomes[0]!.result).toBe("FAIL");
});
```

- [ ] **Step 3: Write AT-17 — the validator session is fresh**

```ts
it("AT-17: the validator session differs from the Implementer session", async () => {
  expect(validation.sessionId).not.toBe(implementation.sessionId);
  const rows = await executions.listForRun(tenantId, runId);
  expect(rows.map((row) => row.role).sort()).toEqual(["implementer", "validator"]);
  expect(new Set(rows.map((row) => row.sessionRef)).size).toBe(2);
});

it("AT-17: the validator prompt holds no Implementer transcript and no success claim", async () => {
  const prompt = runner.calls.find((call) => call.role === "validator")!.prompt;
  expect(prompt).not.toContain(IMPLEMENTER_SUMMARY);
  expect(prompt).not.toContain("The change is applied");
  // The stronger statement: the activity input type carries no field that could hold one.
  const input: UserValidateActivityInput = base;
  expect(Object.keys(input)).not.toContain("implementerSummary");
});
```

- [ ] **Step 4: Write AT-25 — every assertion is PASS before the Run can proceed**

```ts
it("AT-25: a Run with one FAIL does not pass user validation", () => { ... });
it("AT-25: a Run with one MANUAL_REQUIRED does not pass user validation", () => { ... });
it("AT-25: a Run with one BLOCKED does not pass user validation", () => { ... });
it("AT-25: a Run passes only when every assertion is PASS", () => { ... });
it("AT-25: the persisted result rows match the reported results", async () => {
  const rows = await results.listForRun(tenantId, runId);
  expect(rows.map((row) => `${row.assertionKey}:${row.result}`)).toEqual([
    "VAL-UI-001:PASS", "VAL-API-001:PASS",
  ]);
});
```

The last case runs against the real database, so the gate and the record cannot disagree.

- [ ] **Step 5: Write the Phase 7 exit test**

`tests/acceptance/phase-07-exit.test.ts` proves the SDD section 69 exit condition: **a UI fixture change produces independent acceptance evidence.**

```ts
it("Phase 7 exit: a UI fixture change produces independent acceptance evidence", async () => {
  // 1. The fixture repository serves the old name. The frozen contract requires the new one.
  // 2. Apply the UI fixture change, exactly as an Implementer would: the page now renders the
  //    saved name after a reload.
  // 3. Run the real User Validator: real preview process, real exposed URL, real Chromium,
  //    real HTTP request, real evidence rows in the real database.
  const outcome = await runUserValidation(deps, input);

  expect(outcome.passed).toBe(true);

  const rows = await evidence.listForRun(tenantId, runId);
  const validationRows = rows.filter((row) => row.validationAssertionId !== null);
  expect(validationRows.length).toBeGreaterThanOrEqual(4);
  // SDD section 39. Every artifact records the assertion it answers and the hash of its bytes.
  for (const row of validationRows) {
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.storageRef).not.toBeNull();
  }
  // The evidence is independent: it was produced by a browser and an HTTP client, and not by
  // the agent that wrote the change. SDD core principle P-01.
  expect(validationRows.some((row) => row.kind === "screenshot")).toBe(true);
  expect(validationRows.some((row) => row.kind === "request-response")).toBe(true);
});

it("Phase 7 exit: the same validator fails the same contract before the UI change", async () => {
  // The negative half. Without the fixture change, the browser assertion is FAIL and the
  // screenshot still exists, so a reader can see what the page showed.
  expect(outcome.passed).toBe(false);
  expect(outcome.outcomes[0]!.result).toBe("FAIL");
  expect(outcome.outcomes[0]!.artifacts.some((a) => a.kind === "screenshot")).toBe(true);
});
```

A test that only proves the happy path cannot express a regression. The negative half is mandatory.

- [ ] **Step 6: Run the whole integration suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test:integration`
Expected: PASS. Docker must be running.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "test: prove AT-17, AT-18, AT-19, AT-25, and the Phase 7 exit condition"
```

---

## Final verification

Run every stage separately. `npm run verify` takes longer than a two-minute foreground tool call, so a single foreground call reports nothing useful.

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:workflow
npm run build
```

Every stage must exit 0. Record the output in `docs/build/evidence/phase-07-verify.txt`, with the last line `exit=0`.

Then confirm the exit condition and the acceptance tests by name:

```bash
npx vitest run --config vitest.integration.config.ts tests/acceptance/phase-07-exit.test.ts \
  tests/acceptance/at-17-fresh-user-validation.test.ts tests/acceptance/at-18-ui-evidence.test.ts \
  tests/acceptance/at-19-http-evidence.test.ts tests/acceptance/at-25-evidence-completeness.test.ts
```

Compare the unit skip count with the Phase 6 baseline of 7. A higher number means Phase 7 skipped a test, which is not acceptable without a recorded reason.

---

## Self-review notes

- **Spec coverage.** Section 15 preview, section 36 all six rules, section 37 all five steps and all six evidence kinds, section 38 all six recorded fields plus redaction, section 39 all nine columns plus Linear storage, section 25 against the validator, sections 42 and 49 for the repair branch, section 48 for `USER_VALIDATING`, section 52 tenant filters, section 53 for the result rows, section 56 for the prompt version, section 62 for the metric, section 63 for the activities file, and AT-17, AT-18, AT-19, and AT-25. Every one maps to a task in the table above.
- **`READY_FOR_HUMAN` stays unreachable.** SDD section 68 forbids it without a PR and a Proof Pack, so a Run whose validation passes still falls into the residual wait and ends `FAILED` with `RUN_TIMEOUT`. This is unchanged from Phase 6 and is deliberate. Phase 9 and Phase 10 close it.
- **AT-20 is not fully claimed here.** Phase 7 builds the validation-to-repair branch and proves it in the workflow suite. AT-20 also needs the Reviewer of Phase 8 before it can be claimed as a whole system test. Phase 8 owns it.
- **Type consistency.** `AssertionResult`, `AssertionOutcome`, `EvidenceArtifact`, and `UserValidationOutcome` are defined once, in Task 3, and every later task imports them. `PreviewConfig` is defined once, in Task 1. `BrowserStep` is defined once, in Task 3, and the driver port of Task 5 consumes it rather than redefining it.
- **The `at-35` hand-built activity map is a known trap.** Task 9 step 5 exists only for it.
