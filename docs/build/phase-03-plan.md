# Factoree Phase 3 — Deterministic Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Factoree a repository-owned `.factoree/config.yaml`, a deterministic verification step that records the exact result of every configured command, and a bounded repair handoff, so that a false agent success claim cannot bypass a failing check.

**Architecture:** A strict schema in `src/domain/projects/factoree-config.ts` parses `.factoree/config.yaml` and rejects every unknown key. The file lives in the primary repository, so `SandboxManager` reads it after the primary checkout and applies the configured egress policy before the reference checkouts, the bootstrap command, and the agent. `runVerification` in `src/domain/runs/verification.ts` runs each configured command from a clean shell through `Sandbox.exec` and records name, command, start time, end time, exit code, stdout hash, and stderr hash. Only exit code 0 passes, and an agent claim never affects the result. Each record is persisted as one immutable `Evidence` row. The Temporal workflow gains the `VERIFYING` and `REPAIRING` states, and a failing check drives a bounded repair before it fails the Run.

**Tech Stack:** TypeScript (strict), Node.js 24 LTS, npm, Temporal TypeScript SDK, Prisma, PostgreSQL, `yaml`, `zod`, Vitest, Testcontainers, prom-client.

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
- Only exit code 0 passes. Agent claims do not affect the verification result (SDD §35).
- Default total repair limit is 2. No third repair may occur when the limit is two (SDD §42).
- Instruction precedence places `.factoree/config.yaml` below Factoree security policy, Action Policy, recorded human decisions, the frozen Validation Contract, and Work Item constraints (SDD §57).
- Model instructions are not a security boundary. The Action Policy MUST be enforced outside prompts (SDD §29).

## Phase 3 scope (SDD §69)

> Build `.factoree/config.yaml`, verification commands, result recording, and repair handoff.
> **Exit:** a false agent success claim cannot bypass a failing check.

**In scope:** the `.factoree/config.yaml` schema and parser; the mapping from that file to `ProjectRuntimeConfig` and to the verification command list; reading the file and the repository instructions from the primary checkout; the staged network policy of `SandboxManager`; the deterministic verification runner; the `Evidence` entity and its Prisma persistence; `verification.activities.ts`; the `VERIFYING` and `REPAIRING` workflow states; the bounded repair handoff; the `VERIFICATION_FAILED` failure reason; the `factoree_verification_duration_seconds` and `factoree_repairs_total` metrics; the delegation wiring that finally gives a Linear-started Run a sandbox; AT-14, AT-16, and the repair-limit half of AT-24.

**Out of scope (later phases, do not build):** refinement (Phase 4); Context Contract, repository discovery, and authority rules (Phase 4 and 5); Backstage and MCP (Phase 5); the Validation Contract and its assertions (Phase 6); preview startup, Playwright, HTTP validation, and Linear evidence upload (Phase 7); the Reviewer, the finding schema, and the full repair loop that includes review (Phase 8); patch capture, stale base, and publishing (Phase 9); the Proof Pack (Phase 10); `ClaudeCodeRunner` and skills (Phase 11); the live Fly Sprite proof (Phase 12).

## Decisions taken by the controller

These are recorded so a later reviewer does not treat them as drift.

1. **`.factoree/config.yaml` is read from the primary checkout inside the sandbox, not from the control plane.** SDD §15 states that each primary repository must contain the file. The control plane holds no copy of the repository, so the only honest source is the checkout. `SandboxManager` reads it through `Sandbox.exec`, so no adapter-specific file API is needed.

2. **The network policy is applied three times, and each application is tighter than the last.** SDD §32 orders `APPLY NETWORK POLICY` before `CHECKOUT PRIMARY REPOSITORY`, and the allow list lives in a file that only the primary checkout can produce. The order is therefore: apply the checkout policy, which allows the hosts of the repository URLs of the Run and nothing else; check out the primary repository; load the file; apply the checkout policy joined with the configured allow list; check out the reference repositories and run the bootstrap command; apply the configured allow list alone; take the baseline checkpoint. The agent never runs under a policy wider than the file allows, and no step ever runs under an open policy.

3. **A missing or invalid `.factoree/config.yaml` is a `RunConfigurationError`.** SDD §15 makes the file mandatory and requires unknown keys to fail validation. The workflow already maps that error class to `FAILED_CONFIGURATION` with `CONFIGURATION_INVALID`, and the retry policy already treats it as non-retryable.

4. **Every configured verification command runs, and a failing command does not stop the ones after it.** SDD §35 requires a record for each command. A record cannot exist for a command that never ran, so early exit would lose evidence an operator and a repair attempt both need.

5. **A verification command runs through `sh -c` from a clean environment.** SDD §35 says "from a clean shell". The command inherits no value from the Implementer environment. It receives `PATH`, `HOME`, `LANG`, and the Project test secrets that the operator marked for injection, and nothing else.

6. **A verification result is persisted as an `Evidence` row.** SDD §53 lists `Evidence` and lists no verification entity, and SDD §39 fixes the evidence record shape. `validationAssertionId` is nullable, because a deterministic check answers no Validation assertion. The Validation Contract arrives in Phase 6 and fills that column for its own evidence.

7. **`Evidence.sha256` is the hash of the canonical record, and the stdout and stderr hashes live in `metadata`.** SDD §35 names a stdout hash and a stderr hash. SDD §39 names one `sha256` for the artifact. Both are recorded, so neither section is weakened.

8. **A hash covers the raw output, and a retained log covers the redacted output.** A hash of redacted text would not identify the real output. A retained log reaches storage and a human, so SDD §60 applies to it.

9. **A repair attempt starts a fresh Implementer run and does not resume the earlier session.** SDD §42 says the same Implementer session *may* resume. A session reference of `OpenCodeRunner` lives in the memory of one worker process, so a resume cannot survive a worker restart, and SDD AT-35 forbids duplicated work after such a restart. The repair attempt therefore calls `run` again with the failing checks in `repairFindings`, and each attempt writes its own `AgentExecution` row.

10. **A Run whose verification passes stays in the residual wait.** The state after `VERIFYING` is `USER_VALIDATING`, and Phase 7 builds it. Phase 3 must not invent a success terminal state, because SDD §68 permits `READY_FOR_HUMAN` only when a Validation Contract, a PR, and a Proof Pack exist. The workflow posts the passing verification summary to Linear and then waits, exactly as it does today.

11. **The `preview`, `context`, and `policy.defaultAutonomy` keys are parsed and validated but not consumed by Phase 3.** SDD §15 fixes the file shape, and unknown keys must fail, so the parser must know every documented key now. Phase 5, Phase 7, and Phase 9 consume them. The parser marks each unconsumed field in a comment that names the owning phase.

12. **The autonomy level of a Run comes from the Project record, not from the file.** The level is chosen at delegation, before a sandbox exists. SDD §57 places `.factoree/config.yaml` below recorded human decisions, so the file must not raise a level a human set. Phase 9 decides how a Project may accept a lower level from the file.

13. **`Project` gains a `defaultBranch` column.** A checkout needs a ref, and the Project record holds none today, so no delegation could reach the sandbox path. The default is `main`.

14. **A repository slug becomes a clone URL through `GITHUB_BASE_URL`.** `Project.primaryRepository` holds an `owner/repo` slug. The GitHub adapter is Phase 9, so Phase 3 builds the URL from one environment value with the default `https://github.com`.

## Requirement mapping

| SDD requirement | Task |
| --- | --- |
| §15 `.factoree/config.yaml`, unknown keys fail | Task 1, Task 2, Task 3 |
| §29 network policy applied before agent execution | Task 4 |
| §32 lifecycle order | Task 4 |
| §35 deterministic verification and its record | Task 5, Task 7 |
| §39 evidence record shape, immutability | Task 6 |
| §53 `Evidence` entity | Task 6 |
| §60 redaction of a retained log | Task 5, Task 7 |
| §42 repair loop and repair limit | Task 8 |
| §48 `VERIFYING` and `REPAIRING` states, §49 workflow decisions | Task 8 |
| §55 recorded SHA of every reference repository | Task 4 |
| §62 `factoree_verification_duration_seconds`, `factoree_repairs_total` | Task 7 |
| §57 instruction precedence | Task 2, Task 9 |
| AT-14 fixture reaches verification with OpenCodeRunner | Task 10 |
| AT-16 failing command blocks publication and triggers repair | Task 10 |
| AT-24 no third repair when the maximum is two | Task 10 |
| Phase 3 exit condition | Task 10 |

## Phase 3 exit evidence

- `npm run verify` exits 0 from a clean clone.
- An acceptance test drives a Run in which the Implementer stub exits 0 and claims success, a configured verification command fails, and the Run neither publishes nor reaches a success state (exit condition).
- The same test proves the failing check is recorded with its exit code, its stdout hash, and its stderr hash.
- An acceptance test proves a failing check triggers a repair attempt while budget remains, and that the Run fails with `VERIFICATION_FAILED` once the budget is spent (AT-16, AT-24).
- An acceptance test proves the fixture implementation reaches verification with `OpenCodeRunner` (AT-14).
- A unit test proves an unknown key in `.factoree/config.yaml` fails validation.
- A unit test proves a missing `.factoree/config.yaml` produces a `RunConfigurationError`.
- A unit test proves the network policy applied before the agent runs equals the configured allow list alone.
- An integration test proves an `Evidence` row is tenant-scoped and is never updated after it is written.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/domain/projects/factoree-config.ts` | The strict schema of SDD §15, `parseFactoreeConfig`, and the `FactoreeConfig` type. |
| `src/domain/projects/repository-url.ts` | `buildRepositoryUrl`: turns an `owner/repo` slug and a base URL into a clone URL. |
| `src/domain/runs/project-runtime-config.ts` | `ProjectRuntimeConfig`, `VerificationCommand`, and `toProjectRuntimeConfig`. |
| `src/domain/runs/repository-config-source.ts` | Reads `.factoree/config.yaml` and the repository instruction file from a checkout through `Sandbox.exec`. |
| `src/domain/runs/sandbox-manager.ts` | Modified: loads the repository configuration and stages the network policy. |
| `src/domain/runs/verification.ts` | `runVerification`: runs each configured command from a clean shell and records the SDD §35 result. |
| `src/domain/evidence/evidence.ts` | The `Evidence` record of SDD §39 and the `EvidenceStore` port. |
| `src/persistence/prisma/evidence.prisma.ts` | `PrismaEvidenceStore`. |
| `src/activities/verification.activities.ts` | The `verify` Temporal activity of SDD §63. |
| `src/workflows/agent-run.workflow.ts` | Modified: `VERIFYING`, `REPAIRING`, the repair budget, and the verification decision. |
| `src/domain/runs/delegation-service.ts` | Modified: builds `AgentRunWorkflowInput.sandbox` from the Project record. |
| `tests/support/fake-evidence-store.ts` | An in-memory `EvidenceStore` for unit and workflow tests. |
| `tests/fixtures/bin/opencode-liar-stub.sh` | An Implementer stub that changes nothing and claims success. |

---

## Environment notes for every task

The shell alias `cat` on this machine points at a broken `bat`. Use `/bin/cat` in any command, and never write a file through a `cat` heredoc.

Node 24 is at `/opt/homebrew/opt/node@24/bin`. Every command below prefixes `PATH` with it.

---

### Task 1: The `.factoree/config.yaml` schema and parser

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/domain/projects/factoree-config.ts`
- Test: `tests/unit/factoree-config.test.ts`

**Interfaces:**
- Consumes: `RunConfigurationError` from `~/domain/runs/run-configuration-error.js`.
- Produces:
  - `interface FactoreeConfig` with the exact shape below.
  - `parseFactoreeConfig(text: string): FactoreeConfig` — throws `RunConfigurationError`.
  - `FACTOREE_CONFIG_PATH: string` — the value `".factoree/config.yaml"`.

```ts
export interface FactoreeConfig {
  version: 1;
  bootstrap: { command: string } | null;
  verify: { commands: Array<{ name: string; run: string }> };
  preview: { enabled: boolean; command: string; readyUrl: string; timeoutSeconds: number } | null;
  agents: { implementer: string; validator: string; reviewer: string };
  repair: { maxAttempts: number };
  sandbox: { allowedDomains: string[] };
  context: {
    backstage: { enabled: boolean };
    referenceRepositories: { automaticDiscovery: boolean };
  };
  policy: { defaultAutonomy: "L0" | "L1" | "L2" | "L3" | "L4" };
}
```

- [ ] **Step 1: Add the YAML parser dependency**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm install --save-exact yaml@2.8.1
```

Expected: `package.json` gains `"yaml": "2.8.1"` under `dependencies`, and `package-lock.json` changes.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/factoree-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseFactoreeConfig } from "~/domain/projects/factoree-config.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";

const complete = `
version: 1

bootstrap:
  command: npm ci

verify:
  commands:
    - name: typecheck
      run: npm run typecheck
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
`;

const minimum = "version: 1\nverify:\n  commands:\n    - name: test\n      run: npm test\n";

describe("parseFactoreeConfig", () => {
  it("reads every documented key of SDD section 15", () => {
    const config = parseFactoreeConfig(complete);
    expect(config.version).toBe(1);
    expect(config.bootstrap).toEqual({ command: "npm ci" });
    expect(config.verify.commands).toEqual([
      { name: "typecheck", run: "npm run typecheck" },
      { name: "test", run: "npm test" },
    ]);
    expect(config.preview).toEqual({
      enabled: true,
      command: "npm run dev -- --host 0.0.0.0 --port 8080",
      readyUrl: "http://127.0.0.1:8080/health",
      timeoutSeconds: 60,
    });
    expect(config.agents).toEqual({ implementer: "opencode", validator: "claude", reviewer: "claude" });
    expect(config.repair).toEqual({ maxAttempts: 2 });
    expect(config.sandbox).toEqual({ allowedDomains: ["registry.npmjs.org"] });
    expect(config.context.backstage.enabled).toBe(true);
    expect(config.context.referenceRepositories.automaticDiscovery).toBe(true);
    expect(config.policy.defaultAutonomy).toBe("L3");
  });

  it("accepts the minimum file", () => {
    const config = parseFactoreeConfig(minimum);
    expect(config.bootstrap).toBeNull();
    expect(config.preview).toBeNull();
    expect(config.agents.implementer).toBe("opencode");
    expect(config.repair.maxAttempts).toBe(2);
    expect(config.sandbox.allowedDomains).toEqual([]);
    expect(config.policy.defaultAutonomy).toBe("L3");
  });

  it("rejects an unknown top-level key", () => {
    expect(() => parseFactoreeConfig(`${minimum}plugins: []\n`)).toThrow(RunConfigurationError);
  });

  it("names the offending key in the message", () => {
    expect(() => parseFactoreeConfig(`${minimum}plugins: []\n`)).toThrow(/plugins/);
  });

  it("rejects an unknown nested key", () => {
    const text = "version: 1\nverify:\n  commands:\n    - name: test\n      run: npm test\n      shell: bash\n";
    expect(() => parseFactoreeConfig(text)).toThrow(RunConfigurationError);
  });

  it("rejects an unsupported version", () => {
    expect(() => parseFactoreeConfig("version: 2\nverify:\n  commands:\n    - name: t\n      run: a\n")).toThrow(
      RunConfigurationError,
    );
  });

  it("rejects a duplicate command name", () => {
    const text =
      "version: 1\nverify:\n  commands:\n    - name: test\n      run: a\n    - name: test\n      run: b\n";
    expect(() => parseFactoreeConfig(text)).toThrow(/duplicate/i);
  });

  it("rejects an empty verification command list", () => {
    expect(() => parseFactoreeConfig("version: 1\nverify:\n  commands: []\n")).toThrow(/at least one/i);
  });

  it("rejects text that is not YAML", () => {
    expect(() => parseFactoreeConfig("version: 1\n  bad: [\n")).toThrow(RunConfigurationError);
  });

  it("rejects a document that is not a mapping", () => {
    expect(() => parseFactoreeConfig("- 1\n- 2\n")).toThrow(RunConfigurationError);
  });

  it("rejects a domain that is not a host name", () => {
    const text = `${minimum}sandbox:\n  allowedDomains:\n    - https://x.test/\n`;
    expect(() => parseFactoreeConfig(text)).toThrow(RunConfigurationError);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/factoree-config.test.ts
```

Expected: FAIL. The module `~/domain/projects/factoree-config.js` does not exist.

- [ ] **Step 4: Write the implementation**

Create `src/domain/projects/factoree-config.ts`:

```ts
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";

/**
 * SDD section 15. The `.factoree/config.yaml` of the primary repository.
 *
 * The schema is strict at every level, because SDD section 15 requires that an unknown key
 * fails validation. A typo in a key must never pass silently as a default.
 *
 * SDD section 57 places this file below Factoree security policy, the Action Policy, recorded
 * human decisions, the frozen Validation Contract, and Work Item constraints. Nothing parsed
 * here may raise a control that a higher rule set.
 */

/** A host name, or a wildcard label followed by a host name. The same shape the sandbox uses. */
const HOST_NAME = /^\*?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

const commandSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "must be lower case letters, digits, dot, underscore, or hyphen"),
    run: z.string().min(1),
  })
  .strict();

const schema = z
  .object({
    version: z.literal(1),
    bootstrap: z.object({ command: z.string().min(1) }).strict().nullable().default(null),
    verify: z
      .object({ commands: z.array(commandSchema).min(1, "verify.commands must hold at least one command") })
      .strict(),
    // Phase 7 consumes `preview`. Phase 3 validates it and stores nothing.
    preview: z
      .object({
        enabled: z.boolean(),
        command: z.string().min(1),
        readyUrl: z.string().url(),
        timeoutSeconds: z.number().int().positive().max(600),
      })
      .strict()
      .nullable()
      .default(null),
    agents: z
      .object({
        implementer: z.string().min(1).default("opencode"),
        validator: z.string().min(1).default("claude"),
        reviewer: z.string().min(1).default("claude"),
      })
      .strict()
      .default({}),
    // SDD section 42. The default total repair limit is 2.
    repair: z
      .object({ maxAttempts: z.number().int().min(0).max(10).default(2) })
      .strict()
      .default({}),
    sandbox: z
      .object({
        allowedDomains: z.array(z.string().min(1).regex(HOST_NAME, "must be a host name")).default([]),
      })
      .strict()
      .default({}),
    // Phase 4 and Phase 5 consume `context`. Phase 3 validates it and stores nothing.
    context: z
      .object({
        backstage: z.object({ enabled: z.boolean().default(false) }).strict().default({}),
        referenceRepositories: z.object({ automaticDiscovery: z.boolean().default(false) }).strict().default({}),
      })
      .strict()
      .default({}),
    // Phase 9 consumes `policy`. SDD section 57 forbids this file from raising a level a human
    // set, so Phase 3 reads the level of the Run from the Project record instead.
    policy: z
      .object({ defaultAutonomy: z.enum(["L0", "L1", "L2", "L3", "L4"]).default("L3") })
      .strict()
      .default({}),
  })
  .strict();

export type FactoreeConfig = z.infer<typeof schema>;

/** The path of the file inside the primary repository. SDD section 15 fixes it. */
export const FACTOREE_CONFIG_PATH = ".factoree/config.yaml";

const describeIssue = (issue: z.core.$ZodIssue): string => {
  const path = issue.path.length === 0 ? "the document" : issue.path.join(".");
  // A strict object reports the rejected keys separately. They must reach the operator by name.
  const keys = issue.code === "unrecognized_keys" ? ` (${issue.keys.join(", ")})` : "";
  return `${path}: ${issue.message}${keys}`;
};

/**
 * Parses and validates one `.factoree/config.yaml`. Every fault is a `RunConfigurationError`,
 * because an operator must repair the repository. A retry runs the same file and fails again.
 */
export const parseFactoreeConfig = (text: string): FactoreeConfig => {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new RunConfigurationError(
      `${FACTOREE_CONFIG_PATH} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new RunConfigurationError(`${FACTOREE_CONFIG_PATH} must hold a mapping at the top level.`);
  }

  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(describeIssue).join("; ");
    throw new RunConfigurationError(`${FACTOREE_CONFIG_PATH} is invalid: ${detail}`);
  }

  const names = new Set<string>();
  for (const command of parsed.data.verify.commands) {
    if (names.has(command.name)) {
      throw new RunConfigurationError(
        `${FACTOREE_CONFIG_PATH} is invalid: verify.commands holds a duplicate name "${command.name}".`,
      );
    }
    names.add(command.name);
  }

  return parsed.data;
};
```

If the installed zod version types an issue differently, read the `unrecognized_keys` issue shape from `node_modules/zod` and adapt `describeIssue`. The requirement is that the message names the rejected key.

- [ ] **Step 5: Run the test to verify it passes**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/factoree-config.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 6: Run lint and typecheck**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/domain/projects/factoree-config.ts tests/unit/factoree-config.test.ts
git commit -m "feat(config): parse and validate .factoree/config.yaml"
```

---

### Task 2: Map the file to `ProjectRuntimeConfig` and the verification commands

**Files:**
- Modify: `src/domain/runs/project-runtime-config.ts`
- Test: `tests/unit/project-runtime-config.test.ts`

**Interfaces:**
- Consumes: `FactoreeConfig` from Task 1; `normalizeNetworkPolicy` from `~/domain/runs/sandbox.js`.
- Produces:
  - `interface VerificationCommand { name: string; run: string }`
  - `interface ProjectDefaults { stagingRead: boolean; spriteRetentionHours: number }`
  - `DEFAULT_PROJECT_DEFAULTS: ProjectDefaults`
  - `interface ResolvedProjectConfig { runtime: ProjectRuntimeConfig; verifyCommands: VerificationCommand[] }`
  - `toProjectRuntimeConfig(config: FactoreeConfig, defaults: ProjectDefaults): ResolvedProjectConfig`
  - `DEFAULT_PROJECT_RUNTIME_CONFIG` stays exported and unchanged, because Phase 2 tests use it.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/project-runtime-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseFactoreeConfig } from "~/domain/projects/factoree-config.js";
import { DEFAULT_PROJECT_DEFAULTS, toProjectRuntimeConfig } from "~/domain/runs/project-runtime-config.js";

const minimum = "version: 1\nverify:\n  commands:\n    - name: test\n      run: npm test\n";

describe("toProjectRuntimeConfig", () => {
  it("maps the repository file onto the runtime configuration", () => {
    const config = parseFactoreeConfig(
      "version: 1\n" +
        "bootstrap:\n  command: npm ci\n" +
        "verify:\n  commands:\n    - name: lint\n      run: npm run lint\n" +
        "agents:\n  implementer: claude\n  validator: opencode\n  reviewer: opencode\n" +
        "repair:\n  maxAttempts: 1\n" +
        "sandbox:\n  allowedDomains:\n    - registry.npmjs.org\n",
    );
    const resolved = toProjectRuntimeConfig(config, { stagingRead: true, spriteRetentionHours: 48 });
    expect(resolved.runtime).toEqual({
      bootstrapCommand: "npm ci",
      allowedDomains: ["registry.npmjs.org"],
      implementerRunner: "claude",
      validatorRunner: "opencode",
      reviewerRunner: "opencode",
      repairMaxAttempts: 1,
      stagingRead: true,
      spriteRetentionHours: 48,
    });
    expect(resolved.verifyCommands).toEqual([{ name: "lint", run: "npm run lint" }]);
  });

  it("keeps the Project defaults out of the repository file", () => {
    const resolved = toProjectRuntimeConfig(parseFactoreeConfig(minimum), DEFAULT_PROJECT_DEFAULTS);
    expect(resolved.runtime.stagingRead).toBe(false);
    expect(resolved.runtime.spriteRetentionHours).toBe(24);
  });

  it("carries no bootstrap command when the file names none", () => {
    const resolved = toProjectRuntimeConfig(parseFactoreeConfig(minimum), DEFAULT_PROJECT_DEFAULTS);
    expect(resolved.runtime.bootstrapCommand).toBeNull();
  });

  it("normalises the allow list to lower case and removes a duplicate", () => {
    const config = parseFactoreeConfig(
      `${minimum}sandbox:\n  allowedDomains:\n    - Registry.NPMJS.org\n    - registry.npmjs.org\n`,
    );
    expect(toProjectRuntimeConfig(config, DEFAULT_PROJECT_DEFAULTS).runtime.allowedDomains).toEqual([
      "registry.npmjs.org",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/project-runtime-config.test.ts
```

Expected: FAIL. `toProjectRuntimeConfig` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/domain/runs/project-runtime-config.ts`:

```ts
import type { FactoreeConfig } from "~/domain/projects/factoree-config.js";
import { normalizeNetworkPolicy } from "./sandbox.js";

/** SDD section 35. One configured deterministic verification command. */
export interface VerificationCommand {
  /** The name recorded with the result. It is unique inside one Run. */
  name: string;
  /** The exact shell command. It runs through `sh -c` from a clean environment. */
  run: string;
}

/**
 * The Project-level values that `.factoree/config.yaml` must not own. A repository must not be
 * able to widen a control the operator set on the Project.
 */
export interface ProjectDefaults {
  stagingRead: boolean;
  spriteRetentionHours: number;
}

export const DEFAULT_PROJECT_DEFAULTS: ProjectDefaults = {
  stagingRead: false,
  spriteRetentionHours: 24,
};

export interface ResolvedProjectConfig {
  runtime: ProjectRuntimeConfig;
  verifyCommands: VerificationCommand[];
}

/**
 * SDD section 15 and section 57. Produces the runtime configuration of one Run from the
 * repository file and the Project defaults. The repository owns the bootstrap command, the
 * verification commands, the runner names, the repair limit, and the egress allow list. The
 * Project owns staging read and the sandbox retention window.
 */
export const toProjectRuntimeConfig = (
  config: FactoreeConfig,
  defaults: ProjectDefaults,
): ResolvedProjectConfig => ({
  runtime: {
    bootstrapCommand: config.bootstrap?.command ?? null,
    // The same normalisation the sandbox applies, so the value carried on the Run and the value
    // sent to the adapter can never differ.
    allowedDomains: normalizeNetworkPolicy({ allowedDomains: config.sandbox.allowedDomains }).allowedDomains,
    implementerRunner: config.agents.implementer,
    validatorRunner: config.agents.validator,
    reviewerRunner: config.agents.reviewer,
    repairMaxAttempts: config.repair.maxAttempts,
    stagingRead: defaults.stagingRead,
    spriteRetentionHours: defaults.spriteRetentionHours,
  },
  verifyCommands: config.verify.commands.map((command) => ({ name: command.name, run: command.run })),
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/project-runtime-config.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Run lint and typecheck**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain/runs/project-runtime-config.ts tests/unit/project-runtime-config.test.ts
git commit -m "feat(config): map .factoree/config.yaml onto the runtime configuration"
```

---

### Task 3: Read the configuration and the repository instructions from the checkout

**Files:**
- Create: `src/domain/runs/repository-config-source.ts`
- Modify: `tests/support/fake-sandbox.ts`
- Test: `tests/unit/repository-config-source.test.ts`

**Interfaces:**
- Consumes: `Sandbox`, `SandboxRef` from `~/domain/runs/sandbox.js`; `parseFactoreeConfig`, `FACTOREE_CONFIG_PATH` from Task 1.
- Produces:
  - `readRepositoryConfig(sandbox: Sandbox, ref: SandboxRef, primaryPath: string): Promise<FactoreeConfig>`
  - `readRepositoryInstructions(sandbox: Sandbox, ref: SandboxRef, primaryPath: string): Promise<string>`
  - `REPOSITORY_INSTRUCTION_FILES: readonly string[]`
- Also produces, on `FakeSandbox`: `onExec`, `commands`, and `networkPolicies`.

- [ ] **Step 1: Give `FakeSandbox` the hooks the later tasks need**

Read `tests/support/fake-sandbox.ts` first and keep every existing behaviour, including the recorded call order the Phase 2 lifecycle test asserts.

Add three public members:

```ts
  /** Every command passed to `exec`, in order. */
  readonly commands: Command[] = [];
  /** Every policy passed to `applyNetworkPolicy`, in order. */
  readonly networkPolicies: NetworkPolicy[] = [];
  /**
   * A test hook. When it is set, `exec` returns what it produces instead of the default result.
   * `timedOut` and `durationMs` default to false and 0.
   */
  onExec:
    | ((command: Command) => { exitCode: number; stdout: string; stderr: string; timedOut?: boolean })
    | null = null;
```

In `exec`, record the command, then apply the hook:

```ts
    this.commands.push(command);
    if (this.onExec !== null) {
      const produced = this.onExec(command);
      return { timedOut: false, durationMs: 0, ...produced };
    }
```

In `applyNetworkPolicy`, push the received policy into `networkPolicies` before whatever it already does.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/repository-config-source.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeSandbox } from "../support/fake-sandbox.js";
import {
  REPOSITORY_INSTRUCTION_FILES,
  readRepositoryConfig,
  readRepositoryInstructions,
} from "~/domain/runs/repository-config-source.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";

const minimum = "version: 1\nverify:\n  commands:\n    - name: test\n      run: npm test\n";

const withFiles = async (files: Record<string, string>) => {
  const sandbox = new FakeSandbox();
  sandbox.onExec = (command) => {
    const path = command.args[command.args.length - 1] ?? "";
    const body = files[path];
    if (body === undefined) return { exitCode: 1, stdout: "", stderr: `cat: ${path}: No such file` };
    return { exitCode: 0, stdout: body, stderr: "" };
  };
  const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
  return { sandbox, ref };
};

describe("readRepositoryConfig", () => {
  it("reads and parses the file from the primary checkout", async () => {
    const { sandbox, ref } = await withFiles({ "/w/primary/.factoree/config.yaml": minimum });
    const config = await readRepositoryConfig(sandbox, ref, "/w/primary");
    expect(config.verify.commands).toEqual([{ name: "test", run: "npm test" }]);
  });

  it("fails with a configuration error when the file is absent", async () => {
    const { sandbox, ref } = await withFiles({});
    await expect(readRepositoryConfig(sandbox, ref, "/w/primary")).rejects.toThrow(RunConfigurationError);
    await expect(readRepositoryConfig(sandbox, ref, "/w/primary")).rejects.toThrow(/\.factoree\/config\.yaml/);
  });

  it("fails with a configuration error when the file is invalid", async () => {
    const { sandbox, ref } = await withFiles({ "/w/primary/.factoree/config.yaml": `${minimum}plugins: []\n` });
    await expect(readRepositoryConfig(sandbox, ref, "/w/primary")).rejects.toThrow(RunConfigurationError);
  });

  it("tolerates a trailing slash on the checkout path", async () => {
    const { sandbox, ref } = await withFiles({ "/w/primary/.factoree/config.yaml": minimum });
    await expect(readRepositoryConfig(sandbox, ref, "/w/primary/")).resolves.toBeDefined();
  });
});

describe("readRepositoryInstructions", () => {
  it("reads the first instruction file that exists, in order", async () => {
    expect(REPOSITORY_INSTRUCTION_FILES[0]).toBe("AGENTS.md");
    const { sandbox, ref } = await withFiles({
      "/w/primary/CLAUDE.md": "claude\n",
      "/w/primary/CONTRIBUTING.md": "contributing\n",
    });
    expect(await readRepositoryInstructions(sandbox, ref, "/w/primary")).toBe("claude\n");
  });

  it("returns an empty text when no instruction file exists", async () => {
    const { sandbox, ref } = await withFiles({});
    expect(await readRepositoryInstructions(sandbox, ref, "/w/primary")).toBe("");
  });

  it("truncates a very large instruction file", async () => {
    const big = "x".repeat(70_000);
    const { sandbox, ref } = await withFiles({ "/w/primary/AGENTS.md": big });
    const text = await readRepositoryInstructions(sandbox, ref, "/w/primary");
    expect(text.length).toBeLessThan(big.length);
    expect(text).toContain("truncated");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/repository-config-source.test.ts
```

Expected: FAIL. The module `~/domain/runs/repository-config-source.js` does not exist.

- [ ] **Step 4: Write the implementation**

Create `src/domain/runs/repository-config-source.ts`:

```ts
import type { Sandbox, SandboxRef } from "./sandbox.js";
import { RunConfigurationError } from "./run-configuration-error.js";
import type { FactoreeConfig } from "~/domain/projects/factoree-config.js";
import { FACTOREE_CONFIG_PATH, parseFactoreeConfig } from "~/domain/projects/factoree-config.js";

/**
 * SDD section 15. The primary repository owns `.factoree/config.yaml`, so the only honest source
 * of the file is the checkout inside the sandbox. Every read goes through `Sandbox.exec`, so no
 * adapter needs a file API and both adapters behave alike.
 */

/**
 * The repository instruction files of SDD section 34, in precedence order. The first one that
 * exists wins. A repository that holds two of them states its agent instructions in the first.
 */
export const REPOSITORY_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"] as const;

/** The largest instruction text Factoree places in the Implementer prompt. */
const MAX_INSTRUCTION_BYTES = 64 * 1024;

const join = (directory: string, path: string): string => `${directory.replace(/\/+$/, "")}/${path}`;

/** Reads one file. It reports null when the file does not exist or cannot be read. */
const readFile = async (sandbox: Sandbox, ref: SandboxRef, path: string): Promise<string | null> => {
  const result = await sandbox.exec(ref, { file: "cat", args: ["--", path] });
  return result.exitCode === 0 ? result.stdout : null;
};

/**
 * Reads and validates `.factoree/config.yaml` from the primary checkout. A missing file and an
 * invalid file are both configuration faults, because SDD section 15 makes the file mandatory
 * and requires that an unknown key fails validation.
 */
export const readRepositoryConfig = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primaryPath: string,
): Promise<FactoreeConfig> => {
  const text = await readFile(sandbox, ref, join(primaryPath, FACTOREE_CONFIG_PATH));
  if (text === null) {
    throw new RunConfigurationError(
      `The primary repository does not contain ${FACTOREE_CONFIG_PATH}. SDD section 15 requires it.`,
    );
  }
  return parseFactoreeConfig(text);
};

/**
 * Reads the repository instructions of SDD section 34. A repository that holds none is normal,
 * so this returns an empty text rather than a fault.
 */
export const readRepositoryInstructions = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primaryPath: string,
): Promise<string> => {
  for (const name of REPOSITORY_INSTRUCTION_FILES) {
    const text = await readFile(sandbox, ref, join(primaryPath, name));
    if (text === null) continue;
    // A very large instruction file must not push the goal out of the prompt.
    return Buffer.byteLength(text, "utf8") > MAX_INSTRUCTION_BYTES
      ? `${text.slice(0, MAX_INSTRUCTION_BYTES)}\n\n[Factoree truncated ${name} at ${MAX_INSTRUCTION_BYTES} bytes.]`
      : text;
  }
  return "";
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/repository-config-source.test.ts tests/unit/fake-sandbox.test.ts tests/unit/sandbox-manager.test.ts
```

Expected: PASS. The existing `fake-sandbox` and `sandbox-manager` suites still pass.

- [ ] **Step 6: Run lint and typecheck**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/domain/runs/repository-config-source.ts tests/unit/repository-config-source.test.ts tests/support/fake-sandbox.ts
git commit -m "feat(config): read .factoree/config.yaml and repository instructions from the checkout"
```

---

### Task 4: `SandboxManager` loads the repository configuration and stages the network policy

**Files:**
- Modify: `src/domain/runs/checkout.ts`, `src/domain/runs/sandbox-manager.ts`, `src/activities/sandbox.activities.ts`
- Modify: `tests/acceptance/support/fixture-repository.ts`
- Modify: `tests/unit/sandbox-manager.test.ts`, `tests/unit/prepare-sandbox-activity.test.ts`, `tests/acceptance/at-12-isolation.test.ts`, `tests/acceptance/at-13-action-policy.test.ts`, `tests/acceptance/phase-02-exit.test.ts`

**Interfaces:**
- Consumes: `readRepositoryConfig`, `readRepositoryInstructions` from Task 3; `toProjectRuntimeConfig`, `ProjectDefaults`, `VerificationCommand` from Task 2.
- Produces:
  - `checkout.ts` exports `checkoutPrimary(sandbox, ref, spec): Promise<CheckedOutRepository>` and `checkoutReferences(sandbox, ref, specs): Promise<CheckedOutRepository[]>`. `checkoutRepositories` stays exported and becomes a composition of the two.
  - `PrepareSandboxInput` loses `config` and gains `defaults: ProjectDefaults`.
  - `PreparedSandbox` gains `runtime: ProjectRuntimeConfig`, `verifyCommands: VerificationCommand[]`, `repositoryInstructions: string`.
  - `PrepareSandboxActivityInput` loses `config` and gains `defaults: ProjectDefaults`.
  - `PrepareSandboxActivityOutput` gains `runtime`, `verifyCommands`, `repositoryInstructions`, and `referenceBaseShas: string[]`.

- [ ] **Step 1: Give the fixture repository a `.factoree/config.yaml`**

Open `tests/acceptance/support/fixture-repository.ts` and read it fully. `createFixtureRepository` writes the fixture files before the first commit.

Export the default configuration and write it into the repository:

```ts
/**
 * The fixture configuration. The single check passes only when the Implementer really replaced
 * the contents of `target.txt`, so a false success claim fails it.
 */
export const FIXTURE_CONFIG = `version: 1

verify:
  commands:
    - name: check
      run: test "$(cat target.txt)" != "original"
`;
```

Create the `.factoree` directory inside the repository and write `config.yaml` with `FIXTURE_CONFIG` before the first commit. Give `createFixtureRepository` an optional last parameter `configYaml: string = FIXTURE_CONFIG`, so a later test can supply its own commands. Keep the existing two-parameter call sites working unchanged.

- [ ] **Step 2: Write the failing test**

Append to `tests/unit/sandbox-manager.test.ts`. Import `RunConfigurationError` if the file does not already.

```ts
describe("repository configuration and staged network policy", () => {
  const configYaml =
    "version: 1\nverify:\n  commands:\n    - name: test\n      run: npm test\n" +
    "sandbox:\n  allowedDomains:\n    - registry.npmjs.org\n";

  const sandboxServing = (yaml: string | null): FakeSandbox => {
    const sandbox = new FakeSandbox();
    sandbox.onExec = (command) => {
      const last = command.args[command.args.length - 1] ?? "";
      if (command.file === "cat" && last.endsWith(".factoree/config.yaml")) {
        return yaml === null
          ? { exitCode: 1, stdout: "", stderr: "no such file" }
          : { exitCode: 0, stdout: yaml, stderr: "" };
      }
      if (command.file === "cat") return { exitCode: 1, stdout: "", stderr: "no such file" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return sandbox;
  };

  const prepare = (sandbox: FakeSandbox) =>
    new SandboxManager({ sandbox }).prepare({
      runId: "run-1",
      tenantId: "tenant-1",
      projectId: "project-1",
      primary: { url: "https://git.test/owner/app.git", ref: "main" },
      references: [],
      defaults: { stagingRead: false, spriteRetentionHours: 24 },
    });

  it("applies three policies and never runs the agent under a wider one", async () => {
    const sandbox = sandboxServing(configYaml);
    const prepared = await prepare(sandbox);
    expect(sandbox.networkPolicies).toEqual([
      { allowedDomains: ["git.test"] },
      { allowedDomains: ["git.test", "registry.npmjs.org"] },
      { allowedDomains: ["registry.npmjs.org"] },
    ]);
    expect(prepared.runtime.allowedDomains).toEqual(["registry.npmjs.org"]);
    expect(prepared.verifyCommands).toEqual([{ name: "test", run: "npm test" }]);
  });

  it("applies the last policy immediately before the baseline checkpoint", async () => {
    const sandbox = sandboxServing(configYaml);
    await prepare(sandbox);
    const ordered = sandbox.calls.filter((call) => call === "applyNetworkPolicy" || call === "checkpoint");
    expect(ordered.at(-1)).toBe("checkpoint");
    expect(ordered.at(-2)).toBe("applyNetworkPolicy");
  });

  it("fails with a configuration error when the repository has no config file", async () => {
    await expect(prepare(sandboxServing(null))).rejects.toThrow(RunConfigurationError);
  });

  it("destroys the sandbox when the configuration is missing", async () => {
    const sandbox = sandboxServing(null);
    await expect(prepare(sandbox)).rejects.toThrow(RunConfigurationError);
    expect(sandbox.calls).toContain("destroy");
  });

  it("returns the repository instructions it found", async () => {
    const sandbox = new FakeSandbox();
    sandbox.onExec = (command) => {
      const last = command.args[command.args.length - 1] ?? "";
      if (command.file !== "cat") return { exitCode: 0, stdout: "", stderr: "" };
      if (last.endsWith(".factoree/config.yaml")) return { exitCode: 0, stdout: configYaml, stderr: "" };
      if (last.endsWith("AGENTS.md")) return { exitCode: 0, stdout: "house rules\n", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "no such file" };
    };
    expect((await prepare(sandbox)).repositoryInstructions).toBe("house rules\n");
  });
});
```

`FakeSandbox.calls` must already record every method name. If it records only a subset, extend it and keep the Phase 2 assertions valid.

- [ ] **Step 3: Run the test to verify it fails**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/sandbox-manager.test.ts
```

Expected: FAIL. `prepare` still requires `config` and applies one policy.

- [ ] **Step 4: Split the checkout helpers**

In `src/domain/runs/checkout.ts`, split `checkoutRepositories` into two exported functions without changing what either does to a clone. The private `run`, `clone`, and read-only helpers stay shared.

```ts
/** SDD section 32. Checks out the primary repository. The worktree is writable. */
export const checkoutPrimary = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  spec: RepositorySpec,
): Promise<CheckedOutRepository> => { /* the primary half of the existing body */ };

/**
 * SDD section 32. Checks out every reference repository and makes it read-only. SDD section 29
 * denies writing a reference repository and denies git remote write from an agent.
 */
export const checkoutReferences = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  specs: RepositorySpec[],
): Promise<CheckedOutRepository[]> => { /* the reference half of the existing body */ };

/** The whole SDD section 32 checkout, for a caller that needs no step between the two halves. */
export const checkoutRepositories = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  input: CheckoutInput,
): Promise<CheckoutResult> => ({
  primary: await checkoutPrimary(sandbox, ref, input.primary),
  references: await checkoutReferences(sandbox, ref, input.references),
});
```

Run `npx vitest run --config vitest.config.ts tests/unit/checkout.test.ts` and confirm it still passes with no change to the test.

- [ ] **Step 5: Rewrite `SandboxManager.prepare`**

In `src/domain/runs/sandbox-manager.ts`, replace `config: ProjectRuntimeConfig` in `PrepareSandboxInput` with `defaults: ProjectDefaults`, and extend `PreparedSandbox`:

```ts
export interface PreparedSandbox {
  ref: SandboxRef;
  checkout: CheckoutResult;
  baselineCheckpoint: CheckpointRef | null;
  /** Built from `.factoree/config.yaml` and the Project defaults. SDD sections 15 and 57. */
  runtime: ProjectRuntimeConfig;
  /** SDD section 35. The deterministic verification commands of this Run. */
  verifyCommands: VerificationCommand[];
  /** SDD section 34. The repository instructions found in the primary checkout. */
  repositoryInstructions: string;
}
```

Add the host helper above the class:

```ts
/**
 * The hosts a checkout needs. SDD section 32 applies the network policy before the first
 * checkout, and the allow list of the Run lives in a file only the checkout can produce, so the
 * first policy allows exactly the repository hosts and nothing else. A local path carries no
 * host and adds nothing.
 */
const checkoutHosts = (specs: RepositorySpec[]): string[] => {
  const hosts = new Set<string>();
  for (const spec of specs) {
    try {
      const host = new URL(spec.url).hostname.toLowerCase();
      if (host !== "") hosts.add(host);
    } catch {
      // A local path, or an scp-style address. Neither needs egress through the policy.
    }
  }
  return [...hosts].sort();
};
```

Rewrite the body of the `try` block. The `mkdir` block and the destroy-on-failure `catch` stay exactly as they are.

```ts
      const repositoryHosts = checkoutHosts([input.primary, ...input.references]);

      // Policy one. Only the repository hosts. The file that names the real allow list does not
      // exist yet, so nothing wider may be permitted here.
      await sandbox.applyNetworkPolicy(ref, { allowedDomains: repositoryHosts });

      // ... the existing mkdir block, unchanged ...

      const primary = await checkoutPrimary(sandbox, ref, input.primary);

      // SDD section 15. The primary repository owns the configuration of the Run.
      const file = await readRepositoryConfig(sandbox, ref, primary.path);
      const { runtime, verifyCommands } = toProjectRuntimeConfig(file, input.defaults);

      // Policy two. The configured allow list joined with the repository hosts, so the reference
      // checkouts and the bootstrap command both work.
      await sandbox.applyNetworkPolicy(ref, {
        allowedDomains: [...new Set([...repositoryHosts, ...runtime.allowedDomains])].sort(),
      });

      const references = await checkoutReferences(sandbox, ref, input.references);
      const checkout: CheckoutResult = { primary, references };

      if (runtime.bootstrapCommand !== null) {
        const result = await sandbox.exec(ref, {
          file: "sh",
          args: ["-c", runtime.bootstrapCommand],
          cwd: primary.path,
        });
        if (result.exitCode !== 0) {
          // The bootstrap command comes from the repository configuration, so a failure of it is
          // a configuration fault. A retry runs the same command and fails again.
          throw new RunConfigurationError(
            `the bootstrap command failed with exit code ${result.exitCode}: ` +
              withoutUrlCredentials(result.stderr.trim()),
          );
        }
      }

      const repositoryInstructions = await readRepositoryInstructions(sandbox, ref, primary.path);

      // Policy three. The configured allow list alone. Every later step, the Implementer and the
      // verification commands included, runs under exactly what the repository declared.
      // SDD section 29.
      await sandbox.applyNetworkPolicy(ref, { allowedDomains: runtime.allowedDomains });

      const baselineCheckpoint = sandbox.capabilities.supportsCheckpoints
        ? await sandbox.checkpoint(ref, "baseline")
        : null;

      return { ref, checkout, baselineCheckpoint, runtime, verifyCommands, repositoryInstructions };
```

- [ ] **Step 6: Carry the new fields through the activity**

In `src/activities/sandbox.activities.ts`:

- Replace `config: ProjectRuntimeConfig` in `PrepareSandboxActivityInput` with `defaults: ProjectDefaults`.
- Extend `PrepareSandboxActivityOutput` with `runtime: ProjectRuntimeConfig`, `verifyCommands: VerificationCommand[]`, `repositoryInstructions: string`, and `referenceBaseShas: string[]`.
- In `prepare`, read `prepared.runtime.spriteRetentionHours` and `prepared.runtime.implementerRunner` where the code reads `input.config.*` today.
- Return the new fields:

```ts
    referencePaths: prepared.checkout.references.map((entry) => entry.path),
    // SDD section 55 requires the recorded SHA of every reference repository, not only the
    // primary one. This closes the Phase 2 carried finding.
    referenceBaseShas: prepared.checkout.references.map((entry) => entry.baseSha),
    baselineCheckpointId: prepared.baselineCheckpoint?.id ?? null,
    runtime: prepared.runtime,
    verifyCommands: prepared.verifyCommands,
    repositoryInstructions: prepared.repositoryInstructions,
```

- [ ] **Step 7: Update every existing call site**

Each of these passed `config: DEFAULT_PROJECT_RUNTIME_CONFIG`. Each now passes `defaults: DEFAULT_PROJECT_DEFAULTS`, and each needs a fixture repository that holds `.factoree/config.yaml`:

- `tests/unit/sandbox-manager.test.ts`
- `tests/unit/prepare-sandbox-activity.test.ts`
- `tests/acceptance/at-12-isolation.test.ts`
- `tests/acceptance/at-13-action-policy.test.ts`
- `tests/acceptance/phase-02-exit.test.ts`
- `tests/integration/opencode-runner-local.test.ts`, if it prepares a sandbox

Do not weaken an existing assertion. Where a test read `DEFAULT_PROJECT_RUNTIME_CONFIG.implementerRunner`, read `prepared.runtime.implementerRunner` instead. `tests/acceptance/phase-02-exit.test.ts` reads `CONTRIBUTING.md` for the repository instructions; read `prepared.repositoryInstructions` instead.

- [ ] **Step 8: Run the unit and integration suites**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck && npm test && npm run test:integration
```

Expected: exit 0. Docker must be running for the integration suite. The skipped-test count must not rise above the 7 that Phase 2 recorded.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(sandbox): load the repository configuration and stage the network policy"
```

---

### Task 5: The deterministic verification runner

**Files:**
- Create: `src/domain/runs/verification.ts`
- Test: `tests/unit/verification.test.ts`

**Interfaces:**
- Consumes: `Sandbox`, `SandboxRef` from `~/domain/runs/sandbox.js`; `VerificationCommand` from Task 2; `Redactor` from `~/telemetry/redaction.js`.
- Produces: `VerificationCheckResult`, `VerificationOutcome`, `RunVerificationOptions`, `runVerification`, `MAX_RETAINED_LOG_BYTES`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/verification.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { Redactor } from "~/telemetry/redaction.js";
import { MAX_RETAINED_LOG_BYTES, runVerification } from "~/domain/runs/verification.js";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const prepare = async (results: Record<string, { exitCode: number; stdout: string; stderr: string }>) => {
  const sandbox = new FakeSandbox();
  sandbox.onExec = (command) =>
    results[command.args[command.args.length - 1] ?? ""] ?? { exitCode: 0, stdout: "", stderr: "" };
  const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
  return { sandbox, ref };
};

const base = { workingDirectory: "/w/primary", environment: {}, timeoutMs: 60_000 };

describe("runVerification", () => {
  it("records the SDD section 35 fields for each command", async () => {
    const { sandbox, ref } = await prepare({ "npm test": { exitCode: 0, stdout: "ok\n", stderr: "" } });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      redactor: new Redactor(),
    });
    expect(outcome.passed).toBe(true);
    const check = outcome.checks[0];
    expect(check?.name).toBe("test");
    expect(check?.command).toBe("npm test");
    expect(check?.exitCode).toBe(0);
    expect(check?.stdoutSha256).toBe(sha("ok\n"));
    expect(check?.stderrSha256).toBe(sha(""));
    expect(check?.passed).toBe(true);
    expect(Date.parse(check?.startedAt ?? "")).not.toBeNaN();
    expect(Date.parse(check?.endedAt ?? "")).not.toBeNaN();
  });

  it("passes only on exit code 0", async () => {
    const { sandbox, ref } = await prepare({ "npm test": { exitCode: 1, stdout: "", stderr: "boom\n" } });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      redactor: new Redactor(),
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.checks[0]?.passed).toBe(false);
    expect(outcome.checks[0]?.exitCode).toBe(1);
  });

  it("runs every command even after one fails", async () => {
    const { sandbox, ref } = await prepare({
      a: { exitCode: 1, stdout: "", stderr: "" },
      b: { exitCode: 0, stdout: "", stderr: "" },
    });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [
        { name: "first", run: "a" },
        { name: "second", run: "b" },
      ],
      redactor: new Redactor(),
    });
    expect(outcome.checks.map((check) => check.name)).toEqual(["first", "second"]);
    expect(outcome.passed).toBe(false);
  });

  it("runs each command from a clean shell in the primary worktree", async () => {
    const { sandbox, ref } = await prepare({});
    await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      environment: { FIXTURE_TOKEN: "value-1234" },
      timeoutMs: 42_000,
      redactor: new Redactor(),
    });
    const command = sandbox.commands.at(-1);
    expect(command?.file).toBe("sh");
    expect(command?.args).toEqual(["-c", "npm test"]);
    expect(command?.cwd).toBe("/w/primary");
    expect(command?.timeoutMs).toBe(42_000);
    expect(Object.keys(command?.env ?? {}).sort()).toEqual(["FIXTURE_TOKEN", "HOME", "LANG", "PATH"]);
  });

  it("hashes the raw output and redacts the retained log", async () => {
    const { sandbox, ref } = await prepare({
      "npm test": { exitCode: 1, stdout: "token=value-1234\n", stderr: "" },
    });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      redactor: new Redactor(["value-1234"]),
    });
    expect(outcome.checks[0]?.stdoutSha256).toBe(sha("token=value-1234\n"));
    expect(outcome.checks[0]?.log).not.toContain("value-1234");
    expect(outcome.checks[0]?.log).toContain("[REDACTED]");
  });

  it("retains a log only for a failing command", async () => {
    const { sandbox, ref } = await prepare({ "npm test": { exitCode: 0, stdout: "lots\n", stderr: "" } });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      redactor: new Redactor(),
    });
    expect(outcome.checks[0]?.log).toBeNull();
  });

  it("truncates a very large retained log but still hashes the whole output", async () => {
    const big = "x".repeat(MAX_RETAINED_LOG_BYTES + 1_000);
    const { sandbox, ref } = await prepare({ "npm test": { exitCode: 1, stdout: big, stderr: "" } });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      redactor: new Redactor(),
    });
    const log = outcome.checks[0]?.log ?? "";
    expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(MAX_RETAINED_LOG_BYTES + 200);
    expect(log).toContain("truncated");
    expect(outcome.checks[0]?.stdoutSha256).toBe(sha(big));
  });

  it("records a command the sandbox could not run as a failure", async () => {
    const sandbox = new FakeSandbox();
    sandbox.onExec = () => {
      throw new Error("the sandbox is gone");
    };
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      redactor: new Redactor(),
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.checks[0]?.exitCode).toBe(-1);
    expect(outcome.checks[0]?.log).toContain("the sandbox is gone");
  });

  it("reports a timeout as a failure", async () => {
    const sandbox = new FakeSandbox();
    sandbox.onExec = () => ({ exitCode: 124, stdout: "", stderr: "", timedOut: true });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const outcome = await runVerification({
      ...base,
      sandbox,
      ref,
      commands: [{ name: "test", run: "npm test" }],
      timeoutMs: 1_000,
      redactor: new Redactor(),
    });
    expect(outcome.checks[0]?.timedOut).toBe(true);
    expect(outcome.checks[0]?.passed).toBe(false);
  });

  it("stays total on an empty command list", async () => {
    const { sandbox, ref } = await prepare({});
    const outcome = await runVerification({ ...base, sandbox, ref, commands: [], redactor: new Redactor() });
    // The schema of Task 1 already refuses an empty list, so this case cannot come from a
    // repository. The function returns rather than throwing.
    expect(outcome.checks).toEqual([]);
    expect(outcome.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/verification.test.ts
```

Expected: FAIL. The module `~/domain/runs/verification.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/domain/runs/verification.ts`:

```ts
import { createHash } from "node:crypto";
import type { Sandbox, SandboxRef } from "./sandbox.js";
import type { VerificationCommand } from "./project-runtime-config.js";
import type { Redactor } from "~/telemetry/redaction.js";

/**
 * SDD section 35. After implementation, Factoree runs the configured commands from a clean
 * shell and records the exact result of each one. Only exit code 0 passes, and an agent claim
 * never affects the result.
 */

/** The largest retained log Factoree keeps for one failing command. */
export const MAX_RETAINED_LOG_BYTES = 32 * 1024;

/**
 * The environment of a clean shell. SDD section 35 says "clean shell", so a verification
 * command inherits nothing from the Implementer. `PATH` is needed to find an executable, `HOME`
 * is needed by most toolchains, and `LANG` keeps output deterministic.
 */
const CLEAN_SHELL_ENV: Record<string, string> = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/root",
  LANG: "C.UTF-8",
};

export interface VerificationCheckResult {
  name: string;
  /** The exact command, as SDD section 35 requires. */
  command: string;
  startedAt: string;
  endedAt: string;
  exitCode: number;
  stdoutSha256: string;
  stderrSha256: string;
  /** The retained, redacted log. Null when nothing was retained. */
  log: string | null;
  timedOut: boolean;
  durationMs: number;
  /** Only exit code 0 passes. SDD section 35. */
  passed: boolean;
}

export interface VerificationOutcome {
  passed: boolean;
  checks: VerificationCheckResult[];
}

export interface RunVerificationOptions {
  sandbox: Sandbox;
  ref: SandboxRef;
  workingDirectory: string;
  commands: VerificationCommand[];
  /** Project test secrets the operator marked for injection. SDD section 30. */
  environment: Record<string, string>;
  timeoutMs: number;
  redactor: Redactor;
  now?: () => Date;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Keeps the tail of a text, because a failure appears at the end of a build log. */
const tail = (text: string): string => {
  if (Buffer.byteLength(text, "utf8") <= MAX_RETAINED_LOG_BYTES) return text;
  const kept = Buffer.from(text, "utf8").subarray(-MAX_RETAINED_LOG_BYTES).toString("utf8");
  return `[Factoree truncated this log to the last ${MAX_RETAINED_LOG_BYTES} bytes.]\n${kept}`;
};

/**
 * Builds the retained log of a failing command. SDD section 60 requires redaction before any
 * text leaves the sandbox. The hashes cover the raw output, so the redaction here cannot weaken
 * the record of what really ran.
 */
const buildLog = (redactor: Redactor, stdout: string, stderr: string): string =>
  redactor.redactText(tail(`--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`));

export const runVerification = async (options: RunVerificationOptions): Promise<VerificationOutcome> => {
  const now = options.now ?? (() => new Date());
  const checks: VerificationCheckResult[] = [];

  for (const command of options.commands) {
    const startedAt = now();
    let exitCode = -1;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let durationMs = 0;

    try {
      const result = await options.sandbox.exec(options.ref, {
        file: "sh",
        args: ["-c", command.run],
        cwd: options.workingDirectory,
        // SDD section 30. Only a Project test secret the operator marked for injection may
        // appear here. Nothing of the Implementer environment survives into this shell.
        env: { ...CLEAN_SHELL_ENV, ...options.environment },
        timeoutMs: options.timeoutMs,
      });
      exitCode = result.exitCode;
      stdout = result.stdout;
      stderr = result.stderr;
      timedOut = result.timedOut;
      durationMs = result.durationMs;
    } catch (error) {
      // A sandbox that cannot run a command has proved nothing. The check fails, and the fault
      // is recorded rather than thrown, so every other command still produces a record.
      stderr = error instanceof Error ? error.message : String(error);
      exitCode = -1;
    }

    const endedAt = now();
    // SDD section 35. Only exit code 0 passes.
    const passed = exitCode === 0 && !timedOut;
    checks.push({
      name: command.name,
      command: command.run,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      exitCode,
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr),
      // A passing command produces no log. A failing command must explain itself to a human and
      // to the repair attempt.
      log: passed ? null : buildLog(options.redactor, stdout, stderr),
      timedOut,
      durationMs: durationMs === 0 ? endedAt.getTime() - startedAt.getTime() : durationMs,
      passed,
    });
  }

  return { passed: checks.every((check) => check.passed), checks };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/verification.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Run lint and typecheck**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain/runs/verification.ts tests/unit/verification.test.ts
git commit -m "feat(verification): run configured commands from a clean shell and record each result"
```

---

### Task 6: The `Evidence` entity and its persistence

**Files:**
- Create: `src/domain/evidence/evidence.ts`
- Create: `src/persistence/prisma/evidence.prisma.ts`
- Create: `tests/support/fake-evidence-store.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_evidence/migration.sql`
- Test: `tests/integration/evidence.test.ts`

**Interfaces:**
- Produces: `EvidenceKind`, `EvidenceRecord`, `RecordEvidenceInput`, `EvidenceStore`, `canonicalEvidenceHash`, `PrismaEvidenceStore`, `FakeEvidenceStore`.

- [ ] **Step 1: Add the Prisma model**

In `prisma/schema.prisma`, add after `model AgentExecution`:

```prisma
model Evidence {
  id                    String   @id @default(uuid())
  tenantId              String
  runId                 String
  run                   Run      @relation(fields: [runId], references: [id], onDelete: Cascade)
  // Null for a deterministic check. SDD section 35 records a check that answers no assertion.
  // Phase 6 fills this column for Validation Contract evidence.
  validationAssertionId String?
  kind                  String
  source                String
  sha256                String
  storageRef            String?
  metadata              Json
  // A Temporal retry of one activity must not write a second row.
  idempotencyKey        String
  createdAt             DateTime @default(now())

  @@unique([runId, idempotencyKey])
  @@index([tenantId, runId])
}
```

Add `evidence Evidence[]` to `model Run`.

- [ ] **Step 2: Create the migration and regenerate the client**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
DATABASE_URL="postgresql://placeholder/placeholder" npx prisma migrate dev --name add_evidence --create-only
DATABASE_URL="postgresql://placeholder/placeholder" npx prisma generate
```

If `migrate dev --create-only` needs a reachable database on this machine, write the migration SQL by hand under `prisma/migrations/<timestamp>_add_evidence/migration.sql`. The table is new and holds no existing rows, so a hand-written `CREATE TABLE` plus the unique index and the lookup index is safe and needs no backfill. Match the column names Prisma generates exactly. Compare against an existing migration file for the naming and quoting style.

- [ ] **Step 3: Write the failing integration test**

Read `tests/integration/agent-execution.test.ts` and `tests/integration/support/database.ts` first, and reuse their setup exactly.

Create `tests/integration/evidence.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Import the database helper the sibling integration tests use.
import { PrismaEvidenceStore } from "~/persistence/prisma/evidence.prisma.js";
import { canonicalEvidenceHash } from "~/domain/evidence/evidence.js";

describe("PrismaEvidenceStore", () => {
  // Start the database and seed a tenant, a project, and a run with the same helper the sibling
  // integration tests use. If no seed helper exists, add one there rather than inlining a second
  // path here.
  let store: PrismaEvidenceStore;
  let tenantId: string;
  let runId: string;

  it("writes an evidence row with every SDD section 39 field", async () => {
    const record = await store.record({
      tenantId,
      runId,
      kind: "deterministic_check",
      source: "verify:test",
      sha256: canonicalEvidenceHash({ name: "test", exitCode: 0 }),
      metadata: { name: "test", exitCode: 0 },
      idempotencyKey: `run:${runId}:verify:1:test`,
    });
    expect(record.id).toMatch(/[0-9a-f-]{36}/);
    expect(record.tenantId).toBe(tenantId);
    expect(record.validationAssertionId).toBeNull();
    expect(record.storageRef).toBeNull();
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  it("is idempotent for one Temporal retry", async () => {
    const input = {
      tenantId,
      runId,
      kind: "deterministic_check" as const,
      source: "verify:lint",
      sha256: canonicalEvidenceHash({ name: "lint" }),
      metadata: { name: "lint" },
      idempotencyKey: `run:${runId}:verify:1:lint`,
    };
    const first = await store.record(input);
    const second = await store.record(input);
    expect(second.id).toBe(first.id);
    const all = await store.listForRun(tenantId, runId);
    expect(all.filter((entry) => entry.source === "verify:lint")).toHaveLength(1);
  });

  it("never changes a row that already exists", async () => {
    const key = `run:${runId}:verify:1:immutable`;
    const first = await store.record({
      tenantId,
      runId,
      kind: "deterministic_check",
      source: "verify:immutable",
      sha256: "a".repeat(64),
      metadata: { exitCode: 1 },
      idempotencyKey: key,
    });
    const second = await store.record({
      tenantId,
      runId,
      kind: "deterministic_check",
      source: "verify:immutable",
      sha256: "b".repeat(64),
      metadata: { exitCode: 0 },
      idempotencyKey: key,
    });
    // SDD section 39: evidence is immutable. A second write with the same key returns the first
    // row and changes nothing.
    expect(second.sha256).toBe(first.sha256);
    expect(second.metadata).toEqual({ exitCode: 1 });
  });

  it("does not return the evidence of another tenant", async () => {
    expect(await store.listForRun("00000000-0000-0000-0000-000000000000", runId)).toEqual([]);
  });
});
```

Fill the `beforeAll` and `afterAll` bodies from the sibling test.

- [ ] **Step 4: Run the test to verify it fails**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run test:integration
```

Expected: FAIL. The module `~/persistence/prisma/evidence.prisma.js` does not exist.

- [ ] **Step 5: Write the domain module**

Create `src/domain/evidence/evidence.ts`:

```ts
import { createHash } from "node:crypto";

/**
 * SDD section 39. Evidence is immutable. Each artifact records an identifier, the Run, the
 * Validation assertion it answers, its kind, its source, the moment it was created, its hash,
 * a storage reference, and metadata.
 *
 * A deterministic verification check answers no Validation assertion, so
 * `validationAssertionId` is null for it. Phase 6 introduces the assertions that fill it.
 */
export type EvidenceKind = "deterministic_check";

export interface EvidenceRecord {
  id: string;
  tenantId: string;
  runId: string;
  validationAssertionId: string | null;
  kind: EvidenceKind;
  /** What produced the artifact, for example `verify:typecheck`. */
  source: string;
  createdAt: Date;
  sha256: string;
  storageRef: string | null;
  metadata: Record<string, unknown>;
}

export interface RecordEvidenceInput {
  tenantId: string;
  runId: string;
  validationAssertionId?: string | null;
  kind: EvidenceKind;
  source: string;
  sha256: string;
  storageRef?: string | null;
  metadata: Record<string, unknown>;
  /** A Temporal retry of one activity must not write a second row. */
  idempotencyKey: string;
}

export interface EvidenceStore {
  /**
   * Writes one evidence row. A second call with the same idempotency key returns the row that
   * already exists and changes nothing, because SDD section 39 makes evidence immutable.
   */
  record(input: RecordEvidenceInput): Promise<EvidenceRecord>;
  listForRun(tenantId: string, runId: string): Promise<EvidenceRecord[]>;
}

/** Sorts the keys of every object, so one value always produces one text. */
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
};

/**
 * The hash of one evidence record. SDD section 39 requires a `sha256` for the artifact, and
 * SDD section 35 requires a separate stdout hash and stderr hash. The row holds all three: this
 * value covers the whole record, and the two output hashes live in its metadata.
 */
export const canonicalEvidenceHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
```

- [ ] **Step 6: Write the Prisma adapter**

Read `src/persistence/prisma/agent-execution.prisma.ts` first and follow the same shape, including how it maps a `Json` column.

Create `src/persistence/prisma/evidence.prisma.ts`:

```ts
import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  EvidenceKind,
  EvidenceRecord,
  EvidenceStore,
  RecordEvidenceInput,
} from "~/domain/evidence/evidence.js";

type Row = Prisma.EvidenceGetPayload<Record<string, never>>;

const toRecord = (row: Row): EvidenceRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  runId: row.runId,
  validationAssertionId: row.validationAssertionId,
  kind: row.kind as EvidenceKind,
  source: row.source,
  createdAt: row.createdAt,
  sha256: row.sha256,
  storageRef: row.storageRef,
  metadata: (row.metadata ?? {}) as Record<string, unknown>,
});

export class PrismaEvidenceStore implements EvidenceStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * SDD section 39. Evidence is immutable, so this never updates. A Temporal retry presents the
   * same idempotency key and receives the row that already exists.
   */
  async record(input: RecordEvidenceInput): Promise<EvidenceRecord> {
    const key = { runId_idempotencyKey: { runId: input.runId, idempotencyKey: input.idempotencyKey } };
    const existing = await this.prisma.evidence.findUnique({ where: key });
    if (existing) return toRecord(existing);

    try {
      const created = await this.prisma.evidence.create({
        data: {
          tenantId: input.tenantId,
          runId: input.runId,
          validationAssertionId: input.validationAssertionId ?? null,
          kind: input.kind,
          source: input.source,
          sha256: input.sha256,
          storageRef: input.storageRef ?? null,
          metadata: input.metadata as Prisma.InputJsonValue,
          idempotencyKey: input.idempotencyKey,
        },
      });
      return toRecord(created);
    } catch (error) {
      // Two concurrent attempts can both miss the read above. The unique index decides, and the
      // loser reads the winner rather than failing the Run.
      const row = await this.prisma.evidence.findUnique({ where: key });
      if (row) return toRecord(row);
      throw error;
    }
  }

  async listForRun(tenantId: string, runId: string): Promise<EvidenceRecord[]> {
    const rows = await this.prisma.evidence.findMany({
      where: { tenantId, runId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toRecord);
  }
}
```

- [ ] **Step 7: Write the in-memory store**

Create `tests/support/fake-evidence-store.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { EvidenceRecord, EvidenceStore, RecordEvidenceInput } from "~/domain/evidence/evidence.js";

/** An in-memory `EvidenceStore` with the same immutability rule as the Prisma one. */
export class FakeEvidenceStore implements EvidenceStore {
  readonly rows: EvidenceRecord[] = [];
  private readonly keys = new Map<string, EvidenceRecord>();

  async record(input: RecordEvidenceInput): Promise<EvidenceRecord> {
    const key = `${input.runId}:${input.idempotencyKey}`;
    const existing = this.keys.get(key);
    if (existing) return existing;
    const row: EvidenceRecord = {
      id: randomUUID(),
      tenantId: input.tenantId,
      runId: input.runId,
      validationAssertionId: input.validationAssertionId ?? null,
      kind: input.kind,
      source: input.source,
      createdAt: new Date(),
      sha256: input.sha256,
      storageRef: input.storageRef ?? null,
      metadata: input.metadata,
    };
    this.rows.push(row);
    this.keys.set(key, row);
    return row;
  }

  async listForRun(tenantId: string, runId: string): Promise<EvidenceRecord[]> {
    return this.rows.filter((row) => row.tenantId === tenantId && row.runId === runId);
  }
}
```

- [ ] **Step 8: Run the integration test to verify it passes**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run test:integration
```

Expected: PASS. Docker must be running.

- [ ] **Step 9: Run lint, typecheck, and the unit suite**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck && npm test
```

Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(evidence): persist immutable evidence rows"
```

---

### Task 7: The verification activity and its metrics

**Files:**
- Create: `src/activities/verification.activities.ts`
- Modify: `src/activities/index.ts`, `src/bin/worker.ts`, `src/telemetry/metrics.ts`
- Test: `tests/unit/verify-activity.test.ts`

**Interfaces:**
- Consumes: `runVerification` and `VerificationCheckResult` from Task 5; `EvidenceStore` and `canonicalEvidenceHash` from Task 6; `VerificationCommand` from Task 2.
- Produces: `createVerificationActivities`, `VerifyActivityInput`, `VerifyActivityOutput`, `metrics.verificationDuration`, `metrics.repairs`.

- [ ] **Step 1: Add the required metrics**

In `src/telemetry/metrics.ts`, add to the `metrics` object. SDD §62 fixes both names.

```ts
  verificationDuration: new Histogram({
    name: "factoree_verification_duration_seconds",
    help: "Deterministic verification duration in seconds",
    labelNames,
    buckets: [5, 15, 60, 180, 600, 1800],
    registers: [registry],
  }),
  repairs: new Counter({
    name: "factoree_repairs_total",
    help: "Repair attempts started",
    labelNames: [...labelNames, "reason"],
    registers: [registry],
  }),
```

- [ ] **Step 2: Write the failing test**

Read `tests/support/memory-secret-store.ts` first and follow its seeding API.

Create `tests/unit/verify-activity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { FakeEvidenceStore } from "../support/fake-evidence-store.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createVerificationActivities } from "~/activities/verification.activities.js";

const build = (
  results: Record<string, { exitCode: number; stdout: string; stderr: string }>,
  secrets = new MemorySecretStore(),
) => {
  const sandbox = new FakeSandbox();
  sandbox.onExec = (command) =>
    results[command.args[command.args.length - 1] ?? ""] ?? { exitCode: 0, stdout: "", stderr: "" };
  const evidence = new FakeEvidenceStore();
  const redactor = new Redactor();
  const activities = createVerificationActivities({
    sandbox,
    evidence,
    secrets,
    redactor,
    logger: createLogger({ level: "error", redactor }),
  });
  return { activities, evidence, sandbox };
};

const input = {
  runId: "run-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  spriteId: "sprite-1",
  adapter: "fake",
  workspacePath: "/w",
  primaryPath: "/w/primary",
  timeoutMs: 60_000,
  attempt: 1,
};

describe("verify activity", () => {
  it("passes when every command exits zero", async () => {
    const { activities } = build({ "npm test": { exitCode: 0, stdout: "", stderr: "" } });
    const output = await activities.verify({ ...input, commands: [{ name: "test", run: "npm test" }] });
    expect(output.passed).toBe(true);
    expect(output.failures).toEqual([]);
    expect(output.summary).toContain("passed");
  });

  it("fails and reports the failing check when a command exits non-zero", async () => {
    const { activities } = build({ "npm test": { exitCode: 2, stdout: "", stderr: "boom\n" } });
    const output = await activities.verify({ ...input, commands: [{ name: "test", run: "npm test" }] });
    expect(output.passed).toBe(false);
    expect(output.failures).toHaveLength(1);
    expect(output.failures[0]).toContain("test");
    expect(output.failures[0]).toContain("exit code 2");
    expect(output.failures[0]).toContain("npm test");
    expect(output.summary).toContain("1 of 1");
  });

  it("writes one evidence row for each command", async () => {
    const { activities, evidence } = build({
      a: { exitCode: 0, stdout: "", stderr: "" },
      b: { exitCode: 1, stdout: "", stderr: "" },
    });
    await activities.verify({
      ...input,
      commands: [
        { name: "first", run: "a" },
        { name: "second", run: "b" },
      ],
    });
    expect(evidence.rows).toHaveLength(2);
    expect(evidence.rows.map((row) => row.source)).toEqual(["verify:first", "verify:second"]);
    expect(evidence.rows[0]?.kind).toBe("deterministic_check");
    expect(evidence.rows[0]?.metadata["exitCode"]).toBe(0);
    expect(evidence.rows[0]?.metadata["stdoutSha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.rows[0]?.metadata["stderrSha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.rows[0]?.metadata["attempt"]).toBe(1);
    expect(evidence.rows[0]?.validationAssertionId).toBeNull();
    expect(evidence.rows[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes one row per attempt, so a repair pass does not overwrite the first", async () => {
    const { activities, evidence } = build({ a: { exitCode: 1, stdout: "", stderr: "" } });
    await activities.verify({ ...input, commands: [{ name: "first", run: "a" }], attempt: 1 });
    await activities.verify({ ...input, commands: [{ name: "first", run: "a" }], attempt: 2 });
    expect(evidence.rows).toHaveLength(2);
  });

  it("is idempotent inside one attempt, so a Temporal retry writes no second row", async () => {
    const { activities, evidence } = build({ a: { exitCode: 0, stdout: "", stderr: "" } });
    await activities.verify({ ...input, commands: [{ name: "first", run: "a" }] });
    await activities.verify({ ...input, commands: [{ name: "first", run: "a" }] });
    expect(evidence.rows).toHaveLength(1);
  });

  it("injects a marked Project secret and no other", async () => {
    const secrets = new MemorySecretStore();
    // Seed one marked secret and one unmarked secret with the API this store exposes.
    const { activities, sandbox } = build({}, secrets);
    await activities.verify({ ...input, commands: [{ name: "first", run: "a" }] });
    const env = sandbox.commands.at(-1)?.env ?? {};
    expect(env).toHaveProperty("MARKED_SECRET");
    expect(env).not.toHaveProperty("UNMARKED_SECRET");
  });
});
```

Fill the seeding of the last test from the store API. If the store cannot mark a secret, extend it in the same way `PrismaSecretStore` marks one, and keep the Phase 2 tests passing.

- [ ] **Step 3: Run the test to verify it fails**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/verify-activity.test.ts
```

Expected: FAIL. The module `~/activities/verification.activities.js` does not exist.

- [ ] **Step 4: Write the implementation**

Create `src/activities/verification.activities.ts`:

```ts
import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";
import type { EvidenceStore } from "~/domain/evidence/evidence.js";
import { canonicalEvidenceHash } from "~/domain/evidence/evidence.js";
import type { VerificationCommand } from "~/domain/runs/project-runtime-config.js";
import type { VerificationCheckResult } from "~/domain/runs/verification.js";
import { runVerification } from "~/domain/runs/verification.js";
import { registerProjectSecrets } from "~/domain/projects/redaction-loader.js";
import { metrics } from "~/telemetry/metrics.js";

export interface VerificationActivityDependencies {
  sandbox: Sandbox;
  evidence: EvidenceStore;
  secrets: SecretStore;
  redactor: Redactor;
  logger: Logger;
}

export interface VerifyActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  commands: VerificationCommand[];
  timeoutMs: number;
  /** The ordinal of this verification pass. The first pass is 1, and a repair raises it. */
  attempt: number;
}

export interface VerifyActivityOutput {
  passed: boolean;
  checks: VerificationCheckResult[];
  /** A short text an operator and a repair attempt can both read. */
  summary: string;
  /** The failing checks, formatted for `ImplementActivityInput.repairFindings`. */
  failures: string[];
}

/**
 * The text one failing check contributes to the repair attempt. It carries the name, the exact
 * command, the exit code, and the retained log, so the Implementer acts on evidence rather than
 * on a claim.
 */
const describeFailure = (check: VerificationCheckResult): string =>
  [
    `Verification check "${check.name}" failed with exit code ${check.exitCode}.`,
    `Command: ${check.command}`,
    check.timedOut ? "The command reached its timeout." : "",
    check.log ?? "",
  ]
    .filter((line) => line !== "")
    .join("\n");

export const createVerificationActivities = (dependencies: VerificationActivityDependencies) => ({
  /**
   * SDD section 35. Runs every configured command from a clean shell, records the exact result
   * of each one, and reports whether the implementation passed. No agent claim reaches this
   * function, so a false claim cannot change the outcome.
   */
  async verify(input: VerifyActivityInput): Promise<VerifyActivityOutput> {
    // SDD section 60: every Project secret must reach the redactor before any output is
    // captured. A verification command prints build output, which can hold one.
    await registerProjectSecrets(
      dependencies.redactor,
      dependencies.secrets,
      input.tenantId,
      input.projectId,
      dependencies.logger,
    );

    // SDD section 30: a non-production test secret reaches a command only when the operator
    // marked it. Every other Project secret stays out of the shell.
    const descriptors = await dependencies.secrets.list(input.tenantId, input.projectId);
    const environment: Record<string, string> = {};
    for (const descriptor of descriptors) {
      if (!descriptor.injectIntoImplementer) continue;
      const value = await dependencies.secrets.get(input.tenantId, input.projectId, descriptor.name);
      if (value !== null) environment[descriptor.name] = value;
    }

    const startedAt = Date.now();
    const outcome = await runVerification({
      sandbox: dependencies.sandbox,
      ref: { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath },
      workingDirectory: input.primaryPath,
      commands: input.commands,
      environment,
      timeoutMs: input.timeoutMs,
      redactor: dependencies.redactor,
    });

    // SDD section 39. One immutable row per check. The idempotency key carries the attempt, so
    // a Temporal retry of this activity writes nothing new and a repair pass writes its own row.
    for (const check of outcome.checks) {
      await dependencies.evidence.record({
        tenantId: input.tenantId,
        runId: input.runId,
        validationAssertionId: null,
        kind: "deterministic_check",
        source: `verify:${check.name}`,
        sha256: canonicalEvidenceHash({
          name: check.name,
          command: check.command,
          exitCode: check.exitCode,
          stdoutSha256: check.stdoutSha256,
          stderrSha256: check.stderrSha256,
        }),
        // SDD section 35 requires the stdout hash and the stderr hash separately, and SDD
        // section 39 requires one artifact hash. Both live on the row.
        metadata: {
          name: check.name,
          command: check.command,
          startedAt: check.startedAt,
          endedAt: check.endedAt,
          exitCode: check.exitCode,
          stdoutSha256: check.stdoutSha256,
          stderrSha256: check.stderrSha256,
          timedOut: check.timedOut,
          durationMs: check.durationMs,
          passed: check.passed,
          attempt: input.attempt,
          // The retained, redacted log of SDD section 35. A passing check retains none.
          log: check.log,
        },
        idempotencyKey: `run:${input.runId}:verify:${input.attempt}:${check.name}`,
      });
    }

    metrics.verificationDuration.observe(
      { tenant_id: input.tenantId, project_id: input.projectId },
      (Date.now() - startedAt) / 1000,
    );

    const failed = outcome.checks.filter((check) => !check.passed);
    const summary = outcome.passed
      ? `Deterministic verification passed. ${outcome.checks.length} of ${outcome.checks.length} checks exited 0.`
      : `Deterministic verification failed. ${failed.length} of ${outcome.checks.length} checks did not exit 0: ` +
        `${failed.map((check) => check.name).join(", ")}.`;

    dependencies.logger.info("verification finished", {
      tenant_id: input.tenantId,
      project_id: input.projectId,
      run_id: input.runId,
      passed: outcome.passed,
      checks: outcome.checks.length,
      failed: failed.length,
      attempt: input.attempt,
      step: "verify",
    });

    return { passed: outcome.passed, checks: outcome.checks, summary, failures: failed.map(describeFailure) };
  },
});
```

- [ ] **Step 5: Register the activity**

In `src/activities/index.ts`, add `evidence: EvidenceStore` to `ActivityDependencies`, import `createVerificationActivities`, and spread it into `createActivities`:

```ts
  ...createVerificationActivities({
    sandbox: dependencies.sandbox,
    evidence: dependencies.evidence,
    secrets: dependencies.secrets,
    redactor: dependencies.redactor,
    logger: dependencies.logger,
  }),
```

In `src/bin/worker.ts`, import `PrismaEvidenceStore` and pass `evidence: new PrismaEvidenceStore(prisma)`.

- [ ] **Step 6: Run the test to verify it passes**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/verify-activity.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run lint, typecheck, and the unit suite**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck && npm test
```

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(verification): add the verify activity and its metrics"
```

---

### Task 8: The `VERIFYING` and `REPAIRING` workflow states and the repair budget

**Files:**
- Modify: `src/domain/runs/run-status.ts`, `src/activities/run.activities.ts`, `src/workflows/agent-run.workflow.ts`
- Modify: `tests/unit/run-status.test.ts`
- Test: `tests/workflow/verification.workflow.test.ts`

**Interfaces:**
- Consumes: `VerifyActivityInput` and `VerifyActivityOutput` from Task 7; the extended `PrepareSandboxActivityOutput` from Task 4.
- Produces: `RUN_FAILURE_REASONS` gains `"VERIFICATION_FAILED"`. `AgentRunSandboxInput` loses `config` and `repositoryInstructions` and gains `defaults`.

- [ ] **Step 1: Add the failure reason**

In `src/domain/runs/run-status.ts`, add to `RUN_FAILURE_REASONS`:

```ts
  // SDD section 35. Deterministic verification did not pass, and the repair budget of SDD
  // section 42 is spent. SDD section 48 fixes the state names, not the failure reasons.
  "VERIFICATION_FAILED",
```

Update `tests/unit/run-status.test.ts` if it asserts the exact list, and add a case proving the new reason is present.

- [ ] **Step 2: Let `setRunStatus` carry the repair count**

Read `src/activities/run.activities.ts`. Add an optional `repairCount?: number` to the `setRunStatus` input, pass it into `RunStatusPatch`, and count the repair there, because a workflow must stay deterministic:

```ts
    if (input.status === "REPAIRING") {
      // SDD section 62. The counter belongs in the activity, not in the workflow.
      metrics.repairs.inc({ tenant_id: run.tenantId, project_id: run.projectId, reason: "VERIFICATION" });
    }
```

Read how the function already resolves the Run record before writing the increment. If it does not hold `projectId`, read it from the updated record the repository returns.

- [ ] **Step 3: Write the failing workflow test**

Read `tests/workflow/agent-run.workflow.test.ts` fully first. Reuse its `TestWorkflowEnvironment` setup, its activity stubs, and its helper for starting a workflow. Do not build a second harness. If the harness is local to that file, extract it into `tests/workflow/support/harness.ts` and have both files import it.

Create `tests/workflow/verification.workflow.test.ts` with these cases. Each body uses the shared harness and asserts exactly what its comment names.

```ts
describe("deterministic verification in the workflow", () => {
  it("moves the Run through VERIFYING after a completed implementation", async () => {
    // Arrange: prepareSandbox returns one verification command and a runtime whose
    // repairMaxAttempts is 2. implement reports completed true. verify reports passed true.
    // Assert: the recorded status sequence holds "IMPLEMENTING" then "VERIFYING".
    // Assert: verify received the commands prepareSandbox returned, and attempt 1.
  });

  it("does not accept a false agent success claim", async () => {
    // Arrange: implement reports completed true with a summary claiming success. verify reports
    // passed false. repairMaxAttempts is 0.
    // Assert: completeRun received status FAILED and failureReason VERIFICATION_FAILED.
    // Assert: implement ran exactly once, so no repair started.
  });

  it("repairs once and re-verifies when budget remains", async () => {
    // Arrange: repairMaxAttempts is 2. verify fails on attempt 1 and passes on attempt 2.
    // Assert: the status sequence holds VERIFYING, REPAIRING, IMPLEMENTING, VERIFYING.
    // Assert: implement ran twice, and the second call received the failing check text in
    // repairFindings and attempt 2.
    // Assert: the second verify call received attempt 2.
    // Assert: completeRun was never called with VERIFICATION_FAILED.
  });

  it("starts no third repair when the maximum is two", async () => {
    // Arrange: repairMaxAttempts is 2, and verify fails on every attempt.
    // Assert: implement ran exactly three times, one first attempt plus two repairs.
    // Assert: completeRun received VERIFICATION_FAILED.
  });

  it("records the repair count on the Run", async () => {
    // Assert: setRunStatus received REPAIRING with repairCount 1, then with repairCount 2.
  });

  it("cancels the Run on a stop signal received during verification", async () => {
    // Arrange: send the stop signal while verify is in flight.
    // Assert: the Run ends CANCELLED with STOPPED_BY_HUMAN and no repair started.
  });

  it("ends the Run with RUN_TIMEOUT when the budget runs out before a repair", async () => {
    // Arrange: maxRunMinutes is small enough that the budget is spent when verify returns a
    // failure, and repairMaxAttempts is 2.
    // Assert: completeRun received RUN_TIMEOUT rather than VERIFICATION_FAILED.
  });

  it("fails with FAILED_CONFIGURATION when the repository has no config file", async () => {
    // Arrange: prepareSandbox throws a RunConfigurationError.
    // Assert: the Run ends FAILED_CONFIGURATION with CONFIGURATION_INVALID, and verify never ran.
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run test:workflow
```

Expected: FAIL. The workflow has no `VERIFYING` state.

- [ ] **Step 5: Write the implementation**

In `src/workflows/agent-run.workflow.ts`:

Change `AgentRunSandboxInput`:

```ts
export interface AgentRunSandboxInput {
  primary: { url: string; ref: string };
  references: Array<{ url: string; ref: string }>;
  /**
   * SDD section 15. The runtime configuration comes from `.factoree/config.yaml` in the primary
   * repository. Only the values a repository must not own travel from the control plane.
   */
  defaults: { stagingRead: boolean; spriteRetentionHours: number };
  goal: string;
}
```

Add the verification proxy near the other proxies:

```ts
/** The longest one verification pass can take. A retry gets its own attempt of this length. */
const VERIFY_ATTEMPT_TIMEOUT_MS = 60 * 60_000;

/**
 * Verification runs the project build and test commands, so it takes minutes. It is bounded by
 * the remaining Run budget. SDD section 49: a semantic failure must not consume the
 * infrastructure retry policy. A failing check is a semantic outcome, and the activity returns
 * it as a result, so a retry here covers only a transport fault.
 */
const buildVerifyActivities = (budgetMs: number) =>
  proxyActivities<Activities>({
    startToCloseTimeout: `${Math.min(VERIFY_ATTEMPT_TIMEOUT_MS, budgetMs)} milliseconds`,
    scheduleToCloseTimeout: `${budgetMs} milliseconds`,
    retry: { maximumAttempts: 3, initialInterval: "5 seconds", backoffCoefficient: 2 },
  });
```

Extract the existing implement block into a local function inside `agentRunWorkflow`, above the sandbox block, so the loop does not duplicate it. It keeps the cancellation scope, the watcher, the session bookkeeping, and the result handling exactly as they are today, and it takes the values that change per attempt:

```ts
  /**
   * One Implementer attempt. The cancellation scope, the stop watcher, and the session
   * bookkeeping are unchanged from Phase 2. It returns null when the activity was cancelled.
   */
  const runImplementer = async (attemptInput: {
    prepared: PrepareSandboxActivityOutput;
    goal: string;
    attempt: number;
    repairFindings: string[];
  }): Promise<ImplementActivityOutput | null> => {
    /* the Phase 2 body, reading attemptInput.prepared.runtime.implementerRunner,
       attemptInput.prepared.runtime.stagingRead, attemptInput.prepared.repositoryInstructions,
       attemptInput.repairFindings, and attemptInput.attempt */
  };
```

Replace the single implement block with the loop:

```ts
      // One Implementer attempt plus its verification. SDD section 42 bounds the number of
      // repairs, so the loop can never run without end.
      let attempt = FIRST_IMPLEMENTER_ATTEMPT;
      let repairFindings: string[] = [];
      let repairCount = 0;
      const maxRepairs = preparedSandbox.runtime.repairMaxAttempts;

      for (;;) {
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "IMPLEMENTING";
        await activities.setRunStatus({ runId: id, status });

        const implementation = await runImplementer({
          prepared: preparedSandbox,
          goal: sandbox.goal,
          attempt,
          repairFindings,
        });

        // A stop that arrived while the Implementer ran must end the Run here.
        if (stopRequested) return await cancelRun();

        // SDD section 49: a semantic outcome drives a workflow decision.
        if (implementation === null || !implementation.completed) {
          if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
          return await failRun(
            "IMPLEMENTATION_FAILED",
            "The Implementer did not complete the change. Factoree ended the Run.",
          );
        }

        // SDD section 35. The agent has now claimed success. The claim does not decide what
        // follows. Only the configured commands do.
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        status = "VERIFYING";
        await activities.setRunStatus({ runId: id, status });

        const verifyActivities = buildVerifyActivities(remainingMs());
        const verification = await verifyActivities.verify({
          runId: id,
          tenantId: input.tenantId,
          projectId: input.projectId,
          spriteId: preparedSandbox.spriteId,
          adapter: preparedSandbox.adapter,
          workspacePath: preparedSandbox.workspacePath,
          primaryPath: preparedSandbox.primaryPath,
          commands: preparedSandbox.verifyCommands,
          timeoutMs: remainingMs(),
          attempt,
        });

        await notify(() =>
          activities.postProgress({ sessionId: input.agentSessionId, message: verification.summary }),
        );

        if (stopRequested) return await cancelRun();
        if (verification.passed) break;

        // SDD section 42. A failing check enters repair while budget remains. No third repair
        // occurs when the limit is two.
        if (repairCount >= maxRepairs) {
          return await failRun(
            "VERIFICATION_FAILED",
            "Deterministic verification did not pass, and the repair budget is spent. " +
              `${verification.summary} Factoree published nothing.`,
          );
        }
        if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);

        repairCount += 1;
        attempt += 1;
        repairFindings = verification.failures;
        status = "REPAIRING";
        await activities.setRunStatus({ runId: id, status, repairCount });
      }
```

`activities.postProgress` must be the name `linear.activities.ts` already exports for a progress post. Use the existing name and do not add a second activity.

Add a comment above the residual wait that follows the loop:

```ts
    // Deterministic verification passed. The next state of SDD section 49 is USER_VALIDATING,
    // and Phase 7 builds it. Until then the Run stays open for a stop signal, for human input,
    // or until the Run budget ends it. SDD section 68 forbids READY_FOR_HUMAN without a
    // Validation Contract, a PR, and a Proof Pack, so Phase 3 invents no success terminal state.
```

- [ ] **Step 6: Run the workflow suite**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run test:workflow
```

Expected: PASS. The Phase 2 workflow tests and `at-35-worker-restart` still pass.

- [ ] **Step 7: Run lint, typecheck, and the unit suite**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint && npm run typecheck && npm test
```

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(workflow): verify the implementation and repair a failing check"
```

---

### Task 9: Wire the sandbox into a Linear delegation

**Files:**
- Create: `src/domain/projects/repository-url.ts`
- Modify: `prisma/schema.prisma`, `src/domain/projects/project-registry.ts`, `src/persistence/prisma/project-registry.prisma.ts`, `src/http/admin/projects.routes.ts`, `src/domain/runs/delegation-service.ts`, `src/config/env.ts`, `src/bin/api.ts`
- Create: `prisma/migrations/<timestamp>_add_project_default_branch/migration.sql`
- Test: `tests/unit/repository-url.test.ts`; modify `tests/unit/delegation-service.test.ts`, `tests/unit/env.test.ts`, `tests/integration/project-registry.test.ts`, `tests/integration/admin-api.test.ts`

**Interfaces:**
- Produces:
  - `buildRepositoryUrl(baseUrl: string, slug: string): string`
  - `ProjectRecord` gains `defaultBranch: string`; `CreateProjectInput` gains `defaultBranch?: string`.
  - `DelegationDependencies` gains `repositoryBaseUrl: string`.

This task closes the first Phase 2 carried finding. Until it lands, no Run started by a Linear delegation reaches `PREPARING`.

- [ ] **Step 1: Write the failing URL test**

Create `tests/unit/repository-url.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildRepositoryUrl } from "~/domain/projects/repository-url.js";

describe("buildRepositoryUrl", () => {
  it("builds a clone URL from a slug", () => {
    expect(buildRepositoryUrl("https://github.com", "acme/app")).toBe("https://github.com/acme/app.git");
  });

  it("tolerates a trailing slash on the base URL", () => {
    expect(buildRepositoryUrl("https://github.com/", "acme/app")).toBe("https://github.com/acme/app.git");
  });

  it("does not double the .git suffix", () => {
    expect(buildRepositoryUrl("https://github.com", "acme/app.git")).toBe("https://github.com/acme/app.git");
  });

  it("rejects a slug that is not owner/repo", () => {
    expect(() => buildRepositoryUrl("https://github.com", "acme")).toThrow(/owner\/repo/);
    expect(() => buildRepositoryUrl("https://github.com", "a/b/c")).toThrow(/owner\/repo/);
  });

  it("rejects a slug that tries to escape the base URL", () => {
    expect(() => buildRepositoryUrl("https://github.com", "../etc")).toThrow();
    expect(() => buildRepositoryUrl("https://github.com", "a/..")).toThrow();
  });
});
```

- [ ] **Step 2: Write the URL implementation**

Create `src/domain/projects/repository-url.ts`:

```ts
/**
 * `Project.primaryRepository` holds an `owner/repo` slug. A checkout needs a clone URL. The
 * GitHub adapter arrives in Phase 9, so the base URL comes from one environment value here.
 */
const SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export const buildRepositoryUrl = (baseUrl: string, slug: string): string => {
  const trimmed = slug.replace(/\.git$/, "");
  if (!SLUG.test(trimmed) || trimmed.includes("..")) {
    throw new Error(`A repository must be named "owner/repo". Received "${slug}".`);
  }
  return `${baseUrl.replace(/\/+$/, "")}/${trimmed}.git`;
};
```

- [ ] **Step 3: Run the URL test to verify it passes**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --config vitest.config.ts tests/unit/repository-url.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 4: Add `defaultBranch` to the Project**

In `prisma/schema.prisma`, add to `model Project`:

```prisma
  defaultBranch      String          @default("main")
```

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
DATABASE_URL="postgresql://placeholder/placeholder" npx prisma migrate dev --name add_project_default_branch --create-only
DATABASE_URL="postgresql://placeholder/placeholder" npx prisma generate
```

The column has a default, so it applies to a table that already holds rows. Record that in the migration file as a comment.

Add `defaultBranch: string` to `ProjectRecord`, `defaultBranch?: string` to `CreateProjectInput`, carry it through `PrismaProjectRegistry.create`, `update`, and the row mapper, and add it to `createSchema` in `projects.routes.ts`:

```ts
  defaultBranch: z.string().min(1).max(255).default("main"),
```

Carry it in the `update` object exactly as `maxRunMinutes` is carried. Add an assertion for the new field to `tests/integration/project-registry.test.ts` and `tests/integration/admin-api.test.ts`.

- [ ] **Step 5: Add the base URL to the environment**

In `src/config/env.ts`, add:

```ts
  GITHUB_BASE_URL: z.string().url().default("https://github.com"),
```

Add two cases to `tests/unit/env.test.ts`: the default value, and a rejection of a value that is not a URL.

- [ ] **Step 6: Write the failing delegation test**

Read `tests/unit/delegation-service.test.ts` and use its existing harness. Add:

```ts
it("gives the workflow a sandbox built from the Project record", async () => {
  // Arrange a project whose primaryRepository is "acme/app", referenceRepositories is
  // ["acme/lib"], and defaultBranch is "release". Deliver an agent session created event whose
  // issue holds the title "Fix the header" and the description "The header overlaps the logo."
  const started = starter.started[0];
  expect(started?.args[0]?.sandbox).toEqual({
    primary: { url: "https://github.com/acme/app.git", ref: "release" },
    references: [{ url: "https://github.com/acme/lib.git", ref: "HEAD" }],
    defaults: { stagingRead: false, spriteRetentionHours: 24 },
    goal: "Fix the header\n\nThe header overlaps the logo.",
  });
});

it("uses the issue title alone when the issue holds no description", async () => {
  // Assert: goal equals "Fix the header" with no trailing blank line.
});

it("does not start a workflow when the repository slug is unusable", async () => {
  // Arrange a project whose primaryRepository is "not-a-slug".
  // Assert: the outcome kind is "unconfigured", the webhook marker was released, and the
  // starter recorded no start.
});
```

- [ ] **Step 7: Write the delegation implementation**

In `src/domain/runs/delegation-service.ts`, add `repositoryBaseUrl: string` to `DelegationDependencies`, import `buildRepositoryUrl` and `DEFAULT_PROJECT_DEFAULTS`, and build the sandbox input inside `dispatch` before the `start` call:

```ts
    // SDD section 15 and section 32. A Run needs a primary repository and a ref before a
    // sandbox can exist. The rest of the configuration lives in `.factoree/config.yaml` inside
    // that repository, so nothing here reads it.
    let sandbox: AgentRunSandboxInput;
    try {
      sandbox = {
        primary: {
          url: buildRepositoryUrl(this.dependencies.repositoryBaseUrl, project.primaryRepository),
          ref: project.defaultBranch,
        },
        // A reference repository has no configured ref yet. Phase 4 discovers one and pins it.
        references: project.referenceRepositories.map((slug) => ({
          url: buildRepositoryUrl(this.dependencies.repositoryBaseUrl, slug),
          ref: "HEAD",
        })),
        defaults: DEFAULT_PROJECT_DEFAULTS,
        // Phase 4 replaces this with the refined Work Item. Until then the issue is the goal.
        goal: buildGoal(event),
      };
    } catch (error) {
      await this.dependencies.webhookLog.remove(deliveryId);
      return {
        kind: "unconfigured",
        reason: `project ${project.key} has an unusable repository: ${String(error)}`,
      };
    }
```

Pass `sandbox` in the workflow argument, and add the helper below the class:

```ts
/** The Work Item text the Implementer receives. Phase 4 replaces it with a refined Work Item. */
const buildGoal = (event: AgentSessionEvent): string => {
  const title = event.agentSession.issue?.title ?? "";
  const description = event.agentSession.issue?.description ?? "";
  return description === "" ? title : `${title}\n\n${description}`;
};
```

In `src/bin/api.ts`, pass `repositoryBaseUrl: env.GITHUB_BASE_URL` where `DelegationService` is constructed.

- [ ] **Step 8: Run every suite**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run verify
```

Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(delegation): give a Linear-started Run a sandbox"
```

---

### Task 10: Acceptance tests for the exit condition, AT-14, AT-16, and AT-24

**Files:**
- Create: `tests/fixtures/bin/opencode-liar-stub.sh`
- Create: `tests/acceptance/phase-03-exit.test.ts`
- Create: `tests/workflow/at-16-deterministic-failure.test.ts`

**Interfaces:**
- Consumes: everything built in Tasks 1 to 9.

- [ ] **Step 1: Write the lying Implementer stub**

Read `tests/fixtures/bin/opencode-stub.sh` first and match its event shape exactly, because `output-parser.ts` must accept the new stub unchanged.

Create `tests/fixtures/bin/opencode-liar-stub.sh` with the same event sequence as the honest stub, minus the file write, and with a final message that claims success. Then run:

```bash
chmod +x tests/fixtures/bin/opencode-liar-stub.sh
```

- [ ] **Step 2: Write the exit condition test**

Create `tests/acceptance/phase-03-exit.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { OpenCodeRunner } from "~/adapters/runners/opencode/opencode-runner.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { DEFAULT_PROJECT_DEFAULTS } from "~/domain/runs/project-runtime-config.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { buildImplementerInput } from "~/domain/runs/implementer-input.js";
import { runVerification } from "~/domain/runs/verification.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createFixtureRepository, git, listRefs } from "./support/fixture-repository.js";

const liar = resolve("tests/fixtures/bin/opencode-liar-stub.sh");
const honest = resolve("tests/fixtures/bin/opencode-stub.sh");

describe("Phase 3 exit condition — a false agent success claim cannot bypass a failing check", () => {
  let root: string;
  let sandboxRoot: string;
  let repository: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-p3-repos-"));
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-p3-sandboxes-"));
    // The fixture config declares a check that passes only when target.txt really changed.
    repository = await createFixtureRepository(root, "app");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  const prepare = async (runId: string) => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const prepared = await manager.prepare({
      runId,
      tenantId: "tenant-1",
      projectId: "project-1",
      primary: { url: repository, ref: "main" },
      references: [],
      defaults: DEFAULT_PROJECT_DEFAULTS,
    });
    return { sandbox, manager, prepared };
  };

  it("fails verification when the Implementer claims success and changes nothing", async () => {
    const originHeadBefore = (await git(repository, ["rev-parse", "HEAD"])).trim();
    const originRefsBefore = await listRefs(repository);
    const { sandbox, manager, prepared } = await prepare("run-p3-liar");

    // The configuration really came from the repository.
    expect(prepared.verifyCommands).toHaveLength(1);
    expect(prepared.verifyCommands[0]?.name).toBe("check");

    const runners = new AgentRunnerRegistry([
      new OpenCodeRunner({ executable: liar, redactor: new Redactor(), pollIntervalMs: 20 }),
    ]);
    const implementerInput = buildImplementerInput({
      goal: "Replace the contents of target.txt.",
      humanDecisions: [],
      validationContract: null,
      contextContract: null,
      requiredContext: [],
      primaryRepositoryPath: prepared.checkout.primary.path,
      referenceRepositoryPaths: [],
      repositoryInstructions: prepared.repositoryInstructions,
      skills: [],
      actionPolicy: buildActionPolicy(),
      repairFindings: [],
      projectTestSecrets: {},
    });

    const result = await runners.get(prepared.runtime.implementerRunner).run({
      runId: "run-p3-liar",
      tenantId: "tenant-1",
      role: "implementer",
      sandbox,
      ref: prepared.ref,
      workingDirectory: prepared.checkout.primary.path,
      prompt: implementerInput.prompt,
      promptVersion: implementerInput.promptVersion,
      environment: implementerInput.environment,
      actionPolicy: buildActionPolicy(),
      timeoutMs: 30_000,
    });

    // The agent claims success. SDD section 35 says the claim does not decide.
    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);

    const outcome = await runVerification({
      sandbox,
      ref: prepared.ref,
      workingDirectory: prepared.checkout.primary.path,
      commands: prepared.verifyCommands,
      environment: {},
      timeoutMs: 30_000,
      redactor: new Redactor(),
    });

    expect(outcome.passed).toBe(false);
    const check = outcome.checks[0];
    expect(check?.name).toBe("check");
    expect(check?.exitCode).not.toBe(0);
    expect(check?.stdoutSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(check?.stderrSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(check?.log).not.toBeNull();

    // Nothing was published. The origin is untouched.
    expect((await readFile(join(repository, "target.txt"), "utf8")).trim()).toBe("original");
    expect((await git(repository, ["rev-parse", "HEAD"])).trim()).toBe(originHeadBefore);
    expect(await listRefs(repository)).toEqual(originRefsBefore);

    await manager.release(prepared);
  });

  it("passes verification when the Implementer really made the change (AT-14)", async () => {
    const { sandbox, manager, prepared } = await prepare("run-p3-ok");
    const runners = new AgentRunnerRegistry([
      new OpenCodeRunner({ executable: honest, redactor: new Redactor(), pollIntervalMs: 20 }),
    ]);

    await runners.get(prepared.runtime.implementerRunner).run({
      runId: "run-p3-ok",
      tenantId: "tenant-1",
      role: "implementer",
      sandbox,
      ref: prepared.ref,
      workingDirectory: prepared.checkout.primary.path,
      prompt: "Replace the contents of target.txt.",
      promptVersion: "test",
      environment: { FACTOREE_STUB_TARGET: "target.txt" },
      actionPolicy: buildActionPolicy(),
      timeoutMs: 30_000,
    });

    const outcome = await runVerification({
      sandbox,
      ref: prepared.ref,
      workingDirectory: prepared.checkout.primary.path,
      commands: prepared.verifyCommands,
      environment: {},
      timeoutMs: 30_000,
      redactor: new Redactor(),
    });

    expect(outcome.passed).toBe(true);
    expect(outcome.checks[0]?.exitCode).toBe(0);
    expect(outcome.checks[0]?.log).toBeNull();

    await manager.release(prepared);
  });

  it("runs the agent under the configured allow list alone", async () => {
    // LocalProcessSandbox cannot enforce a policy, so this asserts what the manager applied, not
    // what a kernel denied. The live proof stays in Phase 12.
    // Wrap LocalProcessSandbox in a recording proxy that captures every applyNetworkPolicy call,
    // prepare with it, and assert that the last recorded policy equals
    // prepared.runtime.allowedDomains. Do not change the adapter for this test.
  });
});
```

- [ ] **Step 3: Write the AT-16 and AT-24 test**

AT-16 requires that the failure "blocks publication and triggers repair", which is a workflow property. Create `tests/workflow/at-16-deterministic-failure.test.ts` using the shared harness of Task 8.

```ts
describe("AT-16 — a failing deterministic command blocks publication and triggers repair", () => {
  it("enters repair while budget remains", async () => {
    // Arrange: repairMaxAttempts 2, verify fails on attempt 1 and passes on attempt 2.
    // Assert: the status sequence holds REPAIRING.
    // Assert: the second implement call received the failing check text in repairFindings.
    // Assert: no publishing activity name appears in the recorded activity calls.
  });

  it("blocks the Run when the repair budget is spent (AT-24)", async () => {
    // Arrange: repairMaxAttempts 2, verify fails on every attempt.
    // Assert: implement ran exactly three times.
    // Assert: completeRun received FAILED with VERIFICATION_FAILED.
    // Assert: no publishing activity name appears in the recorded activity calls.
  });
});
```

- [ ] **Step 4: Run every suite**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run verify
```

Expected: exit 0.

- [ ] **Step 5: Record the evidence**

Run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run verify > docs/build/evidence/phase-03-verify.txt 2>&1; echo "exit=$?" >> docs/build/evidence/phase-03-verify.txt
tail -1 docs/build/evidence/phase-03-verify.txt
```

Expected: the last line reads `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: prove the Phase 3 exit condition, AT-14, AT-16, and AT-24"
```

---

## Self-review notes

**Spec coverage.** SDD §15 is Task 1, Task 2, and Task 3. §29 enforcement before the agent is Task 4. §32 lifecycle order is Task 4. §34 repository instructions are Task 3 and Task 4. §35 is Task 5 and Task 7. §39 and §53 `Evidence` are Task 6. §42 repair loop and limit are Task 8. §48 `VERIFYING` and `REPAIRING` are Task 8. §49 semantic decision against infrastructure retry is Task 7 and Task 8. §55 reference SHAs are Task 4, Step 6. §57 precedence is Task 2 and Task 9. §60 redaction of a retained log is Task 5. §62 metrics are Task 7. AT-14, AT-16, and AT-24 are Task 10.

**Deliberately not in Phase 3.** SDD §36 to §38 user validation, §40 and §41 review, §44 to §47 publishing, and §66 live proof all belong to later phases and appear in no task.

**Type consistency.** `VerificationCommand` is defined once in Task 2 and used in Tasks 4, 5, 7, and 8. `VerificationCheckResult` is defined once in Task 5 and used in Tasks 7 and 8. `ProjectDefaults` is defined once in Task 2 and used in Tasks 4, 8, and 9. `PreparedSandbox` and `PrepareSandboxActivityOutput` gain the same three fields in Task 4, and Task 8 reads them under the same names. `EvidenceStore` is defined once in Task 6 and used in Tasks 6 and 7.

**Known limits carried out of Phase 3.**

- The local sandbox adapter enforces no network policy, so the staged policy is proved by what the manager applied, not by a kernel denial. The live proof stays in Phase 12.
- `CLEAN_SHELL_ENV` fixes `PATH` and `HOME` for a Linux sandbox image. A repository that needs a different toolchain path must state it inside its verification command until a later phase makes the shell environment configurable.
- The workflow reads `preparedSandbox.runtime` on every loop pass. A repair never re-reads `.factoree/config.yaml`, so an Implementer that edits the file cannot change the checks that judge it. That is deliberate and matches SDD §57.
