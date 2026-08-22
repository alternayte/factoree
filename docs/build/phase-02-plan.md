# Factoree Phase 2 — Sandbox and First Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Factoree an isolated, policy-controlled sandbox and a first agent runner, so that a Run can make a fixture change inside a unique sandbox and publish nothing.

**Architecture:** A `Sandbox` port (SDD §31) sits in the domain. Two adapters implement it. `FlySpriteSandbox` wraps the official `@fly/sprites` SDK and is the required production implementation. `LocalProcessSandbox` runs commands in a per-Run temporary directory and gives the test suite a deterministic sandbox that needs no credentials. One shared contract test suite runs against both adapters, which proves the adapter is replaceable (SDD §12). A `SandboxManager` drives the lifecycle of SDD §32 in the exact order: create, apply network policy, checkout primary, checkout reference repositories, bootstrap, checkpoint baseline. An `AgentRunner` port (SDD §33) sits in the domain, `AgentRunnerRegistry` selects an adapter from Project configuration, and `OpenCodeRunner` drives the `opencode` CLI inside the sandbox through `startProcess`. The Temporal workflow gains the `PREPARING` and `IMPLEMENTING` states and depends only on the two ports.

**Tech Stack:** TypeScript (strict), Node.js 24 LTS, npm, Temporal TypeScript SDK, Prisma, PostgreSQL, `@fly/sprites`, Vitest, Testcontainers, prom-client.

**Spec:** `docs/sdd.md` (version 2.0, SHA-256 `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`)

## Global Constraints

- Production runtime is Node.js 24 LTS. Bun MUST NOT run Temporal Worker code (SDD §11).
- TypeScript compiler options MUST include `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true` (SDD §10).
- npm with a committed `package-lock.json` (SDD §10).
- Provider SDKs MUST stay in `src/adapters/**`. Core workflow policy MUST NOT import provider-specific SDKs (SDD §14). `@fly/sprites` is a provider SDK.
- Temporal workflows MUST depend only on the `AgentRunner` interface (SDD §33). In practice the workflow depends on activities, and the activities depend on the port.
- Tenant boundary is the Linear workspace. Tenant ID MUST be present on tenant-owned persisted records (SDD §52).
- Factoree MUST NOT log raw OAuth tokens, GitHub tokens, model API keys, Project secrets, or authorization headers (SDD §60).
- Full agent transcripts MUST NOT be persisted by default (SDD §61).
- Required checks MUST NOT use `continue-on-error`. CI MUST run `npm run verify` (SDD §65).
- Source layout MUST follow SDD §63.
- Run states MUST use the exact names in SDD §48.
- Default maximum Run duration is 90 minutes. The timeout failure reason is `RUN_TIMEOUT` (SDD §50).
- Default Sprite retention is 24 hours (SDD §51).
- Model instructions are not a security boundary. The Action Policy MUST be enforced outside prompts (SDD §29).

## Phase 2 scope (SDD §69)

> Build Fly Sprite adapter, process control, checkout, network policy, checkpoint, OpenCodeRunner, and cancellation.
> **Exit:** Factoree can make an isolated fixture change without publishing.

**In scope:** the `Sandbox` port and its types; `FlySpriteSandbox`; `LocalProcessSandbox`; the shared sandbox contract suite; the Action Policy engine; repository checkout with captured SHAs and read-only reference repositories; the `SandboxManager` lifecycle; baseline checkpoint; the `AgentRunner` port; `AgentRunnerRegistry`; the Implementer input assembler; `OpenCodeRunner`; agent process cancellation; `AgentExecution` persistence; the Redactor to SecretStore wiring; the `PREPARING` and `IMPLEMENTING` workflow states; sandbox retention cleanup; Phase 2 metrics.

**Out of scope (later phases, do not build):** `.factoree/config.yaml` parsing and deterministic verification commands (Phase 3); refinement (Phase 4); Context Contract (Phase 4 and 5); Backstage and MCP (Phase 5); Validation Contract (Phase 6); user validation, browser evidence, and HTTP evidence (Phase 7); independent review and repair (Phase 8); patch capture, stale base, and publishing (Phase 9); Proof Pack (Phase 10); `ClaudeCodeRunner` and skills (Phase 11); the live Fly Sprite proof (Phase 12).

## Decisions taken by the controller

These are recorded so a later reviewer does not treat them as drift.

1. **`Sandbox` and `AgentRunner` ports live in `src/domain/runs/`.** SDD §63 lists `adapters/sandbox/` and `adapters/runners/` but names no domain folder for their ports. Both concepts are Run-scoped. Phase 1 already placed `AgentSessionPort` in `src/domain/runs/ports.ts`. Placing these ports in the same folder adds no folder outside the SDD §63 tree.
2. **`FlySpriteSandbox` uses the official `@fly/sprites` SDK, version 0.2.0.** SDD §10 names Fly Sprites in the stack. The SDK is the vendor client for that product. It exposes create, exec, spawn, sessions, session kill, checkpoints, network policy, services, and delete, which covers every method of SDD §31.
3. **`LocalProcessSandbox` is a second adapter, not a replacement.** SDD §31 requires `FlySpriteSandbox`; it does not forbid another adapter, and SDD §12 requires that the Sandbox adapter be replaceable. The local adapter gives `npm run verify` a deterministic sandbox with no credentials. SDD §66 places the real Sprite proof in Phase 12.
4. **A sandbox declares whether it enforces network policy.** `LocalProcessSandbox` cannot enforce egress. It reports `capabilities.enforcesNetworkPolicy: false`. `SandboxManager` refuses to run an agent in such a sandbox unless the caller passes `allowUnenforcedNetwork: true`. Only tests pass it. This keeps SDD §29 honest instead of pretending.
5. **Network policy is deny by default.** `FlySpriteSandbox` sends `{ rules: [...allow rules, { domain: "*", action: "deny" }] }`, never an empty policy.
6. **Phase 2 does not read `.factoree/config.yaml`.** The sandbox and runner take a typed `ProjectRuntimeConfig` object. Phase 3 builds the YAML loader that produces it.
7. **The `Sandbox` port adds two methods beyond the SDD §31 listing: `applyNetworkPolicy` and `readProcess`.** SDD §32 makes `APPLY NETWORK POLICY` a required lifecycle step, and the §31 listing offers no method for it. `startProcess` and `cancelProcess` are useless without a way to read what the process produced. Every method of the §31 listing is present with the §31 signature.
8. **`OpenCodeRunner` is proved against a stub `opencode` executable in the sandbox.** The runner contract is spawn, stream, session reference, resume, and cancel. A live model call is not deterministic and is not needed to prove the contract. SDD AT-14 completes at Phase 3, when verification exists.

## Requirement mapping

| SDD requirement | Task |
| --- | --- |
| §31 Sandbox abstraction | Task 1, Task 3, Task 4, Task 5 |
| §29 Action Policy, §30 credentials | Task 2, Task 8, Task 12 |
| §12 adapter replaceability | Task 3 |
| §31 required `FlySpriteSandbox`, network policy | Task 5 |
| §32 checkout, reference repositories read-only | Task 6 |
| §32 lifecycle order, checkpoint baseline, one unique Sprite per Run | Task 7 |
| §33 AgentRunner interface, §34 Implementer input | Task 8 |
| §33 required `OpenCodeRunner`, process control, cancellation | Task 9 |
| §60 redaction of Project secrets, §61 transcript policy, §53 `AgentExecution` | Task 10 |
| §48 states, §49 workflow, §50 cancellation, §51 retention, §62 metrics | Task 11 |
| AT-12, AT-13, AT-26, AT-31 (sandbox part), AT-34 (retention part) | Task 12 |

## Phase 2 exit evidence

- `npm run verify` exits 0 from a clean clone.
- An acceptance test drives a Run through `PREPARING` and `IMPLEMENTING` in a `LocalProcessSandbox`, the fixture repository file changes, and no push, no PR, and no Proof Pack occur (exit condition).
- An acceptance test starts three concurrent Runs and proves three distinct sandbox identifiers and no cross-modification (AT-12).
- An acceptance test proves the Implementer writes the primary worktree, cannot write a reference repository, and cannot push to a git remote (AT-13, sandbox part).
- A unit test proves the Implementer prompt and environment contain no Linear token and no GitHub write credential (AT-26).
- A workflow test proves a stop signal cancels the agent process and drives the Run to `CANCELLED` (AT-31, sandbox part).
- A unit test proves `FlySpriteSandbox` sends a deny-by-default network policy before any command runs.
- A unit test proves both adapters pass the same sandbox contract suite.
- A unit test proves a Project secret registered from `SecretStore` is redacted from agent output.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/domain/runs/sandbox.ts` | The `Sandbox` port of SDD §31, its input and reference types, network policy type, sandbox capabilities, and sandbox errors. |
| `src/domain/policy/action-policy.ts` | The Action Policy table of SDD §29, project overrides, and `assertActionAllowed`. |
| `src/domain/runs/checkout.ts` | `RepositoryCheckout`: clone the primary repository at a captured SHA, clone reference repositories read-only, remove push capability. Works only through `Sandbox.exec`. |
| `src/domain/runs/sandbox-manager.ts` | `SandboxManager`: drives the SDD §32 lifecycle in order and returns a `PreparedSandbox`. |
| `src/domain/runs/agent-runner.ts` | The `AgentRunner` port of SDD §33, `AgentRunInput`, `AgentRunResult`, `AgentSessionRef`, and `AgentRunnerRegistry`. |
| `src/domain/runs/implementer-input.ts` | `buildImplementerInput`: assembles the SDD §34 Implementer input and rejects forbidden material. |
| `src/domain/runs/project-runtime-config.ts` | `ProjectRuntimeConfig`: the typed sandbox and runner configuration Phase 3 will load from `.factoree/config.yaml`. |
| `src/domain/runs/sprite-reaper.ts` | `SpriteReaper`: destroys sandboxes past the SDD §51 retention window. |
| `src/prompts/implementer.ts` | The versioned Implementer prompt template of SDD §56. |
| `src/adapters/sandbox/local/local-process-sandbox.ts` | `LocalProcessSandbox`: a per-Run temporary directory driven by `node:child_process`. |
| `src/adapters/sandbox/fly-sprites/fly-sprite-sandbox.ts` | `FlySpriteSandbox`: the required implementation, built on `@fly/sprites`. |
| `src/adapters/sandbox/fly-sprites/network-policy.ts` | Translation from the domain network policy to the Sprites policy document. |
| `src/adapters/runners/opencode/opencode-runner.ts` | `OpenCodeRunner`: drives the `opencode` CLI inside a sandbox. |
| `src/adapters/runners/opencode/output-parser.ts` | Parses the OpenCode JSON event stream into a session reference and a result. |
| `src/activities/sandbox.activities.ts` | Temporal activities for prepare, destroy, and reap. |
| `src/activities/agent.activities.ts` | Temporal activities for implement and cancel. |
| `src/persistence/prisma/agent-execution.prisma.ts` | Persists `AgentExecution` rows. |
| `src/persistence/prisma/sandbox-lease.prisma.ts` | Persists the sandbox identifier and retention deadline on the Run. |
| `tests/support/sandbox-contract.ts` | The shared contract suite every `Sandbox` adapter must pass. |
| `tests/support/fake-sandbox.ts` | An in-memory `Sandbox` that records call order, for lifecycle tests. |
| `tests/support/fake-runner.ts` | An in-memory `AgentRunner` for workflow tests. |
| `tests/fixtures/repos/` | The fixture primary repository and reference repository used by the acceptance tests. |

---

### Task 1: Sandbox port and types

**Files:**
- Create: `src/domain/runs/sandbox.ts`
- Test: `tests/unit/sandbox-types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Sandbox`, `SandboxRef`, `SandboxCreateInput`, `Command`, `CommandResult`, `ProcessRef`, `CheckpointRef`, `ServiceRef`, `NetworkPolicy`, `SandboxCapabilities`, `SandboxError`, `NetworkPolicyNotEnforcedError`, `normalizeNetworkPolicy`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/sandbox-types.test.ts
import { describe, expect, it } from "vitest";
import { NetworkPolicyNotEnforcedError, normalizeNetworkPolicy } from "~/domain/runs/sandbox.js";

describe("normalizeNetworkPolicy", () => {
  it("lowercases and deduplicates allowed domains", () => {
    const policy = normalizeNetworkPolicy({ allowedDomains: ["Registry.NPMJS.org", "registry.npmjs.org"] });
    expect(policy.allowedDomains).toEqual(["registry.npmjs.org"]);
  });

  it("keeps an empty allow list, which denies all egress", () => {
    expect(normalizeNetworkPolicy({ allowedDomains: [] }).allowedDomains).toEqual([]);
  });

  it("rejects a domain that carries a scheme or a path", () => {
    expect(() => normalizeNetworkPolicy({ allowedDomains: ["https://registry.npmjs.org/x"] })).toThrow(
      /domain must be a host name/,
    );
  });

  it("sorts domains so the policy document is stable", () => {
    const policy = normalizeNetworkPolicy({ allowedDomains: ["b.example.com", "a.example.com"] });
    expect(policy.allowedDomains).toEqual(["a.example.com", "b.example.com"]);
  });
});

describe("NetworkPolicyNotEnforcedError", () => {
  it("names the adapter that cannot enforce egress", () => {
    const error = new NetworkPolicyNotEnforcedError("LocalProcessSandbox");
    expect(error.message).toContain("LocalProcessSandbox");
    expect(error.name).toBe("NetworkPolicyNotEnforcedError");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/sandbox-types.test.ts`
Expected: FAIL, because `~/domain/runs/sandbox.js` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/runs/sandbox.ts

/** SDD section 31. A reference to one live sandbox. One Run uses one unique sandbox. */
export interface SandboxRef {
  /** Adapter-scoped identifier. This value is stored as `Run.spriteId`. */
  id: string;
  /** The adapter that owns this sandbox, for example `fly-sprites` or `local`. */
  adapter: string;
  /** The absolute path inside the sandbox that holds every checkout. */
  workspacePath: string;
}

export interface SandboxCreateInput {
  /** The Run that owns the sandbox. One Run owns exactly one sandbox. */
  runId: string;
  tenantId: string;
  projectId: string;
  /** Memory in megabytes. The adapter chooses a default when this is absent. */
  memoryMb?: number;
  cpus?: number;
  region?: string;
  /** Environment values available to every command. Never place a secret here unless it is a Project test secret. */
  environment?: Record<string, string>;
}

export interface Command {
  /** The executable. This is not a shell string. */
  file: string;
  args: string[];
  /** Absolute path, or a path relative to `SandboxRef.workspacePath`. */
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the command was stopped by its timeout rather than by exiting. */
  timedOut: boolean;
  durationMs: number;
}

export interface ProcessRef {
  id: string;
}

export interface CheckpointRef {
  id: string;
  name: string;
}

export interface ServiceRef {
  port: number;
  url: string;
}

/** SDD section 29. The sandbox egress allow list. An empty list denies all egress. */
export interface NetworkPolicy {
  allowedDomains: string[];
}

export interface SandboxCapabilities {
  /**
   * True only when the adapter denies egress to a domain outside the allow list at the
   * network layer. A model instruction is not a security boundary (SDD section 29).
   */
  enforcesNetworkPolicy: boolean;
  /** True when the adapter can create a restorable checkpoint. */
  supportsCheckpoints: boolean;
  /** True when the adapter can publish a port to a reachable URL. */
  supportsExposedServices: boolean;
}

/** SDD section 31. */
export interface Sandbox {
  /** The adapter name. It appears in `SandboxRef.adapter` and in logs. */
  readonly name: string;
  readonly capabilities: SandboxCapabilities;

  create(input: SandboxCreateInput): Promise<SandboxRef>;
  /** Applies the egress policy. `SandboxManager` calls this before any checkout. */
  applyNetworkPolicy(ref: SandboxRef, policy: NetworkPolicy): Promise<void>;
  exec(ref: SandboxRef, command: Command): Promise<CommandResult>;
  startProcess(ref: SandboxRef, command: Command): Promise<ProcessRef>;
  /** Reads whatever the process has written so far and reports whether it has exited. */
  readProcess(ref: SandboxRef, process: ProcessRef): Promise<ProcessSnapshot>;
  cancelProcess(ref: SandboxRef, process: ProcessRef): Promise<void>;
  checkpoint(ref: SandboxRef, name: string): Promise<CheckpointRef>;
  exposeService(ref: SandboxRef, port: number): Promise<ServiceRef>;
  destroy(ref: SandboxRef): Promise<void>;
}

export interface ProcessSnapshot {
  running: boolean;
  /** Null while the process is still running. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly adapter: string,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = "SandboxError";
  }
}

export class NetworkPolicyNotEnforcedError extends Error {
  constructor(readonly adapter: string) {
    super(
      `Sandbox adapter ${adapter} cannot enforce a network policy. ` +
        "Refusing to run an agent, because SDD section 29 denies arbitrary outbound network access.",
    );
    this.name = "NetworkPolicyNotEnforcedError";
  }
}

const HOST_NAME = /^\*?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Produces a stable, comparable policy. Two equal policies always produce one document. */
export const normalizeNetworkPolicy = (policy: NetworkPolicy): NetworkPolicy => {
  const domains = new Set<string>();
  for (const raw of policy.allowedDomains) {
    const domain = raw.trim().toLowerCase();
    if (!HOST_NAME.test(domain)) {
      throw new Error(`domain must be a host name, received "${raw}"`);
    }
    domains.add(domain);
  }
  return { allowedDomains: [...domains].sort() };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/unit/sandbox-types.test.ts`
Expected: PASS, 5 assertions.

- [ ] **Step 5: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain/runs/sandbox.ts tests/unit/sandbox-types.test.ts
git commit -m "feat(sandbox): add the Sandbox port and its types (SDD section 31)"
```

---

### Task 2: Action Policy engine

**Files:**
- Create: `src/domain/policy/action-policy.ts`
- Test: `tests/unit/action-policy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentAction`, `ActionDecision`, `ActionPolicy`, `buildActionPolicy`, `ActionDeniedError`. `buildActionPolicy(overrides?: { stagingRead?: boolean }): ActionPolicy`. `ActionPolicy.decide(action: AgentAction): ActionDecision`. `ActionPolicy.assertAllowed(action: AgentAction): void`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/action-policy.test.ts
import { describe, expect, it } from "vitest";
import { ActionDeniedError, buildActionPolicy } from "~/domain/policy/action-policy.js";

describe("buildActionPolicy", () => {
  it("uses the SDD section 29 default table", () => {
    const policy = buildActionPolicy();
    expect(policy.decide("readPrimaryRepository")).toBe("allow");
    expect(policy.decide("writePrimaryWorktree")).toBe("allow");
    expect(policy.decide("readReferenceRepository")).toBe("allow");
    expect(policy.decide("writeReferenceRepository")).toBe("deny");
    expect(policy.decide("runProjectCommands")).toBe("allow");
    expect(policy.decide("installApprovedDependencies")).toBe("allow");
    expect(policy.decide("arbitraryOutboundNetwork")).toBe("deny");
    expect(policy.decide("approvedRegistries")).toBe("allow");
    expect(policy.decide("approvedTestServices")).toBe("allow");
    expect(policy.decide("stagingRead")).toBe("deny");
    expect(policy.decide("stagingWrite")).toBe("deny");
    expect(policy.decide("gitRemoteWriteFromAgent")).toBe("deny");
    expect(policy.decide("productionAccess")).toBe("deny");
    expect(policy.decide("merge")).toBe("deny");
  });

  it("allows staging read only when the Project configures it", () => {
    expect(buildActionPolicy({ stagingRead: true }).decide("stagingRead")).toBe("allow");
  });

  it("never allows an override of a denied action other than staging read", () => {
    const policy = buildActionPolicy({ stagingRead: true });
    expect(policy.decide("productionAccess")).toBe("deny");
    expect(policy.decide("merge")).toBe("deny");
    expect(policy.decide("gitRemoteWriteFromAgent")).toBe("deny");
  });

  it("throws ActionDeniedError from assertAllowed for a denied action", () => {
    expect(() => buildActionPolicy().assertAllowed("gitRemoteWriteFromAgent")).toThrow(ActionDeniedError);
  });

  it("returns without throwing from assertAllowed for an allowed action", () => {
    expect(() => buildActionPolicy().assertAllowed("writePrimaryWorktree")).not.toThrow();
  });

  it("exposes a human readable table for the Implementer prompt", () => {
    const lines = buildActionPolicy().describe();
    expect(lines).toContain("deny: write a reference repository");
    expect(lines).toContain("allow: write the primary worktree");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/action-policy.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/policy/action-policy.ts

/** SDD section 29. The complete set of actions the policy governs. */
export const AGENT_ACTIONS = [
  "readPrimaryRepository",
  "writePrimaryWorktree",
  "readReferenceRepository",
  "writeReferenceRepository",
  "runProjectCommands",
  "installApprovedDependencies",
  "arbitraryOutboundNetwork",
  "approvedRegistries",
  "approvedTestServices",
  "stagingRead",
  "stagingWrite",
  "gitRemoteWriteFromAgent",
  "productionAccess",
  "merge",
] as const;

export type AgentAction = (typeof AGENT_ACTIONS)[number];
export type ActionDecision = "allow" | "deny";

const DEFAULTS: Record<AgentAction, ActionDecision> = {
  readPrimaryRepository: "allow",
  writePrimaryWorktree: "allow",
  readReferenceRepository: "allow",
  writeReferenceRepository: "deny",
  runProjectCommands: "allow",
  installApprovedDependencies: "allow",
  arbitraryOutboundNetwork: "deny",
  approvedRegistries: "allow",
  approvedTestServices: "allow",
  stagingRead: "deny",
  stagingWrite: "deny",
  gitRemoteWriteFromAgent: "deny",
  productionAccess: "deny",
  merge: "deny",
};

const LABELS: Record<AgentAction, string> = {
  readPrimaryRepository: "read the primary repository",
  writePrimaryWorktree: "write the primary worktree",
  readReferenceRepository: "read a reference repository",
  writeReferenceRepository: "write a reference repository",
  runProjectCommands: "run project commands",
  installApprovedDependencies: "install approved dependencies",
  arbitraryOutboundNetwork: "reach an arbitrary outbound network address",
  approvedRegistries: "reach an approved registry",
  approvedTestServices: "reach an approved test service",
  stagingRead: "read staging",
  stagingWrite: "write staging",
  gitRemoteWriteFromAgent: "write to a git remote",
  productionAccess: "reach production",
  merge: "merge",
};

/** SDD section 29 permits exactly one Project override: staging read. */
export interface ActionPolicyOverrides {
  stagingRead?: boolean;
}

export class ActionDeniedError extends Error {
  constructor(readonly action: AgentAction) {
    super(`The Action Policy denies this action: ${LABELS[action]}.`);
    this.name = "ActionDeniedError";
  }
}

export interface ActionPolicy {
  decide(action: AgentAction): ActionDecision;
  assertAllowed(action: AgentAction): void;
  /** One line per action, for the Implementer prompt. The prompt is not the boundary. */
  describe(): string[];
}

export const buildActionPolicy = (overrides: ActionPolicyOverrides = {}): ActionPolicy => {
  const table: Record<AgentAction, ActionDecision> = {
    ...DEFAULTS,
    stagingRead: overrides.stagingRead === true ? "allow" : "deny",
  };

  return {
    decide: (action) => table[action],
    assertAllowed: (action) => {
      if (table[action] === "deny") throw new ActionDeniedError(action);
    },
    describe: () => AGENT_ACTIONS.map((action) => `${table[action]}: ${LABELS[action]}`),
  };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/unit/action-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/policy/action-policy.ts tests/unit/action-policy.test.ts
git commit -m "feat(policy): add the Action Policy engine (SDD section 29)"
```

---

### Task 3: Sandbox contract suite and the fake sandbox

**Files:**
- Create: `tests/support/sandbox-contract.ts`
- Create: `tests/support/fake-sandbox.ts`
- Test: `tests/unit/fake-sandbox.test.ts`

**Interfaces:**
- Consumes: every type of Task 1.
- Produces: `runSandboxContract(name: string, factory: () => Promise<{ sandbox: Sandbox; dispose: () => Promise<void> }>): void`, and `FakeSandbox` with `calls: string[]`, `files: Map<string, string>`, `scriptExec(matcher: RegExp, result: Partial<CommandResult>): void`.

The contract suite is the proof of SDD §12 adapter replaceability. Task 4 and Task 5 both call it.

- [ ] **Step 1: Write the contract suite**

```ts
// tests/support/sandbox-contract.ts
import { describe, expect, it } from "vitest";
import type { Sandbox } from "~/domain/runs/sandbox.js";

export interface SandboxUnderTest {
  sandbox: Sandbox;
  dispose: () => Promise<void>;
}

/**
 * Every Sandbox adapter must pass this suite. SDD section 12 requires that the Fly Sprites
 * adapter be replaceable, so the behaviour the rest of Factoree depends on lives here and
 * not in one adapter's own test file.
 */
export const runSandboxContract = (name: string, create: () => Promise<SandboxUnderTest>): void => {
  describe(`Sandbox contract: ${name}`, () => {
    const withSandbox = async (body: (subject: SandboxUnderTest) => Promise<void>): Promise<void> => {
      const subject = await create();
      try {
        await body(subject);
      } finally {
        await subject.dispose();
      }
    };

    it("creates a sandbox with a unique identifier and a workspace path", async () => {
      await withSandbox(async ({ sandbox }) => {
        const first = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
        const second = await sandbox.create({ runId: "run-b", tenantId: "t", projectId: "p" });
        expect(first.id).not.toBe(second.id);
        expect(first.adapter).toBe(sandbox.name);
        expect(first.workspacePath.startsWith("/")).toBe(true);
        await sandbox.destroy(first);
        await sandbox.destroy(second);
      });
    });

    it("runs a command and reports stdout and a zero exit code", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
        const result = await sandbox.exec(ref, { file: "sh", args: ["-c", "printf hello"] });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hello");
        expect(result.timedOut).toBe(false);
        await sandbox.destroy(ref);
      });
    });

    it("reports a non-zero exit code and stderr without throwing", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-2", tenantId: "t", projectId: "p" });
        const result = await sandbox.exec(ref, { file: "sh", args: ["-c", "printf oops >&2; exit 3"] });
        expect(result.exitCode).toBe(3);
        expect(result.stderr).toBe("oops");
        await sandbox.destroy(ref);
      });
    });

    it("runs a command in the workspace by default and honours cwd and env", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-3", tenantId: "t", projectId: "p" });
        await sandbox.exec(ref, { file: "sh", args: ["-c", "mkdir -p sub && printf x > sub/f"] });
        const inSub = await sandbox.exec(ref, { file: "sh", args: ["-c", "cat f"], cwd: "sub" });
        expect(inSub.stdout).toBe("x");
        const withEnv = await sandbox.exec(ref, {
          file: "sh",
          args: ["-c", "printf %s \"$FACTOREE_TEST\""],
          env: { FACTOREE_TEST: "value" },
        });
        expect(withEnv.stdout).toBe("value");
        await sandbox.destroy(ref);
      });
    });

    it("stops a command at its timeout and reports timedOut", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-4", tenantId: "t", projectId: "p" });
        const result = await sandbox.exec(ref, { file: "sh", args: ["-c", "sleep 30"], timeoutMs: 500 });
        expect(result.timedOut).toBe(true);
        expect(result.exitCode).not.toBe(0);
        await sandbox.destroy(ref);
      });
    });

    it("starts a process, reads its output, and reports it as finished", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-5", tenantId: "t", projectId: "p" });
        const process = await sandbox.startProcess(ref, { file: "sh", args: ["-c", "printf started; exit 0"] });
        const snapshot = await pollUntil(async () => sandbox.readProcess(ref, process), (s) => !s.running);
        expect(snapshot.exitCode).toBe(0);
        expect(snapshot.stdout).toBe("started");
        await sandbox.destroy(ref);
      });
    });

    it("cancels a running process", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-6", tenantId: "t", projectId: "p" });
        const process = await sandbox.startProcess(ref, { file: "sh", args: ["-c", "sleep 60"] });
        await sandbox.cancelProcess(ref, process);
        const snapshot = await pollUntil(async () => sandbox.readProcess(ref, process), (s) => !s.running);
        expect(snapshot.running).toBe(false);
        expect(snapshot.exitCode).not.toBe(0);
        await sandbox.destroy(ref);
      });
    });

    it("cancelling an already finished process does not throw", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-7", tenantId: "t", projectId: "p" });
        const process = await sandbox.startProcess(ref, { file: "sh", args: ["-c", "exit 0"] });
        await pollUntil(async () => sandbox.readProcess(ref, process), (s) => !s.running);
        await expect(sandbox.cancelProcess(ref, process)).resolves.toBeUndefined();
        await sandbox.destroy(ref);
      });
    });

    it("creates a named checkpoint when the adapter supports checkpoints", async () => {
      await withSandbox(async ({ sandbox }) => {
        if (!sandbox.capabilities.supportsCheckpoints) return;
        const ref = await sandbox.create({ runId: "run-8", tenantId: "t", projectId: "p" });
        const checkpoint = await sandbox.checkpoint(ref, "baseline");
        expect(checkpoint.name).toBe("baseline");
        expect(checkpoint.id.length).toBeGreaterThan(0);
        await sandbox.destroy(ref);
      });
    });

    it("applies a network policy without throwing", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-9", tenantId: "t", projectId: "p" });
        await expect(
          sandbox.applyNetworkPolicy(ref, { allowedDomains: ["registry.npmjs.org"] }),
        ).resolves.toBeUndefined();
        await sandbox.destroy(ref);
      });
    });

    it("destroying a sandbox twice does not throw", async () => {
      await withSandbox(async ({ sandbox }) => {
        const ref = await sandbox.create({ runId: "run-10", tenantId: "t", projectId: "p" });
        await sandbox.destroy(ref);
        await expect(sandbox.destroy(ref)).resolves.toBeUndefined();
      });
    });

    it("isolates two sandboxes from one another", async () => {
      await withSandbox(async ({ sandbox }) => {
        const first = await sandbox.create({ runId: "run-11", tenantId: "t", projectId: "p" });
        const second = await sandbox.create({ runId: "run-12", tenantId: "t", projectId: "p" });
        await sandbox.exec(first, { file: "sh", args: ["-c", "printf one > marker"] });
        const read = await sandbox.exec(second, { file: "sh", args: ["-c", "cat marker 2>/dev/null; printf END"] });
        expect(read.stdout).toBe("END");
        await sandbox.destroy(first);
        await sandbox.destroy(second);
      });
    });
  });
};

const pollUntil = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error("the sandbox contract poll timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
```

- [ ] **Step 2: Write the fake sandbox**

```ts
// tests/support/fake-sandbox.ts
import type {
  Command,
  CommandResult,
  CheckpointRef,
  NetworkPolicy,
  ProcessRef,
  ProcessSnapshot,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateInput,
  SandboxRef,
  ServiceRef,
} from "~/domain/runs/sandbox.js";

interface ScriptedResult {
  matcher: RegExp;
  result: Partial<CommandResult>;
}

/**
 * An in-memory Sandbox. Lifecycle tests assert on `calls`, which records the order of every
 * port method. It records commands; it does not run them.
 */
export class FakeSandbox implements Sandbox {
  readonly name = "fake";
  readonly calls: string[] = [];
  readonly commands: Command[] = [];
  readonly policies: NetworkPolicy[] = [];
  readonly checkpoints: string[] = [];
  readonly destroyed: string[] = [];
  private readonly scripted: ScriptedResult[] = [];
  private counter = 0;
  private readonly processes = new Map<string, ProcessSnapshot>();

  constructor(readonly capabilities: SandboxCapabilities = {
    enforcesNetworkPolicy: true,
    supportsCheckpoints: true,
    supportsExposedServices: true,
  }) {}

  /** The first matcher whose pattern matches `file` plus its arguments wins. */
  scriptExec(matcher: RegExp, result: Partial<CommandResult>): void {
    this.scripted.push({ matcher, result });
  }

  finishProcess(id: string, snapshot: Partial<ProcessSnapshot>): void {
    const current = this.processes.get(id);
    if (current === undefined) throw new Error(`unknown process ${id}`);
    this.processes.set(id, { ...current, running: false, exitCode: 0, ...snapshot });
  }

  create(input: SandboxCreateInput): Promise<SandboxRef> {
    this.calls.push("create");
    this.counter += 1;
    return Promise.resolve({
      id: `fake-${input.runId}-${this.counter}`,
      adapter: this.name,
      workspacePath: "/workspace",
    });
  }

  applyNetworkPolicy(_ref: SandboxRef, policy: NetworkPolicy): Promise<void> {
    this.calls.push("applyNetworkPolicy");
    this.policies.push(policy);
    return Promise.resolve();
  }

  exec(_ref: SandboxRef, command: Command): Promise<CommandResult> {
    this.calls.push(`exec:${command.file}`);
    this.commands.push(command);
    const line = [command.file, ...command.args].join(" ");
    const scripted = this.scripted.find((entry) => entry.matcher.test(line));
    return Promise.resolve({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 1,
      ...scripted?.result,
    });
  }

  startProcess(_ref: SandboxRef, command: Command): Promise<ProcessRef> {
    this.calls.push(`startProcess:${command.file}`);
    this.commands.push(command);
    this.counter += 1;
    const id = `process-${this.counter}`;
    this.processes.set(id, { running: true, exitCode: null, stdout: "", stderr: "" });
    return Promise.resolve({ id });
  }

  readProcess(_ref: SandboxRef, process: ProcessRef): Promise<ProcessSnapshot> {
    const snapshot = this.processes.get(process.id);
    if (snapshot === undefined) throw new Error(`unknown process ${process.id}`);
    return Promise.resolve(snapshot);
  }

  cancelProcess(_ref: SandboxRef, process: ProcessRef): Promise<void> {
    this.calls.push("cancelProcess");
    const snapshot = this.processes.get(process.id);
    if (snapshot !== undefined) {
      this.processes.set(process.id, { ...snapshot, running: false, exitCode: 143 });
    }
    return Promise.resolve();
  }

  checkpoint(_ref: SandboxRef, name: string): Promise<CheckpointRef> {
    this.calls.push(`checkpoint:${name}`);
    this.checkpoints.push(name);
    return Promise.resolve({ id: `checkpoint-${this.checkpoints.length}`, name });
  }

  exposeService(_ref: SandboxRef, port: number): Promise<ServiceRef> {
    this.calls.push(`exposeService:${port}`);
    return Promise.resolve({ port, url: `http://fake.invalid:${port}` });
  }

  destroy(ref: SandboxRef): Promise<void> {
    this.calls.push("destroy");
    this.destroyed.push(ref.id);
    return Promise.resolve();
  }
}
```

- [ ] **Step 3: Write the test for the fake**

```ts
// tests/unit/fake-sandbox.test.ts
import { describe, expect, it } from "vitest";
import { FakeSandbox } from "../support/fake-sandbox.js";

describe("FakeSandbox", () => {
  it("records the order of the port calls", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await sandbox.applyNetworkPolicy(ref, { allowedDomains: [] });
    await sandbox.checkpoint(ref, "baseline");
    await sandbox.destroy(ref);
    expect(sandbox.calls).toEqual(["create", "applyNetworkPolicy", "checkpoint:baseline", "destroy"]);
  });

  it("returns a scripted result for a matching command", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/git rev-parse/, { stdout: "abc123\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const result = await sandbox.exec(ref, { file: "git", args: ["rev-parse", "HEAD"] });
    expect(result.stdout).toBe("abc123\n");
  });

  it("gives every sandbox a distinct identifier", async () => {
    const sandbox = new FakeSandbox();
    const first = await sandbox.create({ runId: "a", tenantId: "t", projectId: "p" });
    const second = await sandbox.create({ runId: "b", tenantId: "t", projectId: "p" });
    expect(first.id).not.toBe(second.id);
  });
});
```

- [ ] **Step 4: Run the test**

Run: `npm test -- tests/unit/fake-sandbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/support/sandbox-contract.ts tests/support/fake-sandbox.ts tests/unit/fake-sandbox.test.ts
git commit -m "test(sandbox): add the shared Sandbox contract suite and the fake sandbox"
```

---

### Task 4: LocalProcessSandbox

**Files:**
- Create: `src/adapters/sandbox/local/local-process-sandbox.ts`
- Test: `tests/unit/local-process-sandbox.test.ts`

**Interfaces:**
- Consumes: every type of Task 1, `runSandboxContract` of Task 3.
- Produces: `LocalProcessSandbox`, constructed as `new LocalProcessSandbox({ rootDirectory: string })`, and `createLocalProcessSandbox(): Promise<{ sandbox: LocalProcessSandbox; dispose: () => Promise<void> }>`.

This adapter is for local development and for the deterministic test suite. It reports `enforcesNetworkPolicy: false`, so `SandboxManager` refuses to run an agent in it unless the caller opts in.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/local-process-sandbox.test.ts
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { runSandboxContract } from "../support/sandbox-contract.js";

runSandboxContract("LocalProcessSandbox", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "factoree-contract-"));
  const sandbox = new LocalProcessSandbox({ rootDirectory });
  return { sandbox, dispose: async () => rm(rootDirectory, { recursive: true, force: true }) };
});

describe("LocalProcessSandbox", () => {
  it("declares that it cannot enforce a network policy", () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: tmpdir() });
    expect(sandbox.capabilities.enforcesNetworkPolicy).toBe(false);
    expect(sandbox.name).toBe("local");
  });

  it("removes the workspace directory on destroy", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "factoree-destroy-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await sandbox.exec(ref, { file: "sh", args: ["-c", "printf x > marker"] });
    await sandbox.destroy(ref);
    const listing = await sandbox.exec.call(sandbox, ref, { file: "sh", args: ["-c", "true"] }).catch(() => null);
    expect(listing).toBeNull();
    await rm(rootDirectory, { recursive: true, force: true });
  });

  it("copies the workspace into a checkpoint directory", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "factoree-checkpoint-"));
    const sandbox = new LocalProcessSandbox({ rootDirectory });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await sandbox.exec(ref, { file: "sh", args: ["-c", "printf baseline > marker"] });
    const checkpoint = await sandbox.checkpoint(ref, "baseline");
    await sandbox.exec(ref, { file: "sh", args: ["-c", "printf changed > marker"] });
    const saved = await readFile(join(rootDirectory, ref.id, "checkpoints", checkpoint.id, "marker"), "utf8");
    expect(saved).toBe("baseline");
    await rm(rootDirectory, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/local-process-sandbox.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/adapters/sandbox/local/local-process-sandbox.ts
import { spawn } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type {
  CheckpointRef,
  Command,
  CommandResult,
  NetworkPolicy,
  ProcessRef,
  ProcessSnapshot,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateInput,
  SandboxRef,
  ServiceRef,
} from "~/domain/runs/sandbox.js";
import { SandboxError } from "~/domain/runs/sandbox.js";

export interface LocalProcessSandboxOptions {
  /** Every sandbox becomes one directory below this path. */
  rootDirectory: string;
}

interface RunningProcess {
  stdout: string;
  stderr: string;
  running: boolean;
  exitCode: number | null;
  kill: () => void;
}

/**
 * A Sandbox that runs commands as child processes in a per-Run directory.
 *
 * It gives the test suite and local development a sandbox that needs no credentials. It cannot
 * enforce an egress policy, so it reports `enforcesNetworkPolicy: false` and `SandboxManager`
 * refuses to run an agent in it unless the caller opts in. Production uses `FlySpriteSandbox`.
 */
export class LocalProcessSandbox implements Sandbox {
  readonly name = "local";
  readonly capabilities: SandboxCapabilities = {
    enforcesNetworkPolicy: false,
    supportsCheckpoints: true,
    supportsExposedServices: false,
  };

  private readonly live = new Set<string>();
  private readonly processes = new Map<string, RunningProcess>();

  constructor(private readonly options: LocalProcessSandboxOptions) {}

  async create(input: SandboxCreateInput): Promise<SandboxRef> {
    const id = `local-${input.runId}-${randomUUID().slice(0, 8)}`;
    const workspacePath = join(this.options.rootDirectory, id, "workspace");
    await mkdir(workspacePath, { recursive: true });
    this.live.add(id);
    return { id, adapter: this.name, workspacePath };
  }

  applyNetworkPolicy(ref: SandboxRef, _policy: NetworkPolicy): Promise<void> {
    // This adapter records nothing. `SandboxManager` never lets an agent run here in production,
    // because `capabilities.enforcesNetworkPolicy` is false.
    this.assertLive(ref);
    return Promise.resolve();
  }

  async exec(ref: SandboxRef, command: Command): Promise<CommandResult> {
    this.assertLive(ref);
    const startedAt = Date.now();
    return await new Promise<CommandResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(command.file, command.args, {
        cwd: this.resolveCwd(ref, command.cwd),
        env: { ...process.env, ...command.env },
      });
      const timer =
        command.timeoutMs === undefined
          ? null
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, command.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      const finish = (exitCode: number): void => {
        if (timer !== null) clearTimeout(timer);
        resolve({ exitCode, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
      };
      child.on("error", (error) => {
        stderr += error.message;
        finish(127);
      });
      child.on("close", (code, signal) => finish(code ?? (signal === null ? 1 : 128)));
    });
  }

  startProcess(ref: SandboxRef, command: Command): Promise<ProcessRef> {
    this.assertLive(ref);
    const id = `process-${randomUUID().slice(0, 8)}`;
    const child = spawn(command.file, command.args, {
      cwd: this.resolveCwd(ref, command.cwd),
      env: { ...process.env, ...command.env },
    });
    const record: RunningProcess = {
      stdout: "",
      stderr: "",
      running: true,
      exitCode: null,
      kill: () => child.kill("SIGKILL"),
    };
    child.stdout.on("data", (chunk: Buffer) => (record.stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (record.stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      record.stderr += error.message;
      record.running = false;
      record.exitCode = 127;
    });
    child.on("close", (code, signal) => {
      record.running = false;
      record.exitCode = code ?? (signal === null ? 1 : 137);
    });
    this.processes.set(id, record);
    return Promise.resolve({ id });
  }

  readProcess(ref: SandboxRef, process: ProcessRef): Promise<ProcessSnapshot> {
    this.assertLive(ref);
    const record = this.processes.get(process.id);
    if (record === undefined) throw new SandboxError(`unknown process ${process.id}`, this.name);
    return Promise.resolve({
      running: record.running,
      exitCode: record.exitCode,
      stdout: record.stdout,
      stderr: record.stderr,
    });
  }

  cancelProcess(_ref: SandboxRef, process: ProcessRef): Promise<void> {
    const record = this.processes.get(process.id);
    // Cancelling a finished or unknown process is not an error. Cancellation is idempotent.
    if (record !== undefined && record.running) record.kill();
    return Promise.resolve();
  }

  async checkpoint(ref: SandboxRef, name: string): Promise<CheckpointRef> {
    this.assertLive(ref);
    const id = `${name}-${randomUUID().slice(0, 8)}`;
    const target = join(this.options.rootDirectory, ref.id, "checkpoints", id);
    await cp(ref.workspacePath, target, { recursive: true });
    return { id, name };
  }

  exposeService(ref: SandboxRef, port: number): Promise<ServiceRef> {
    this.assertLive(ref);
    // A local process already listens on the host loopback interface.
    return Promise.resolve({ port, url: `http://127.0.0.1:${port}` });
  }

  async destroy(ref: SandboxRef): Promise<void> {
    // Destroying an unknown sandbox is not an error. Destruction is idempotent.
    this.live.delete(ref.id);
    await rm(join(this.options.rootDirectory, ref.id), { recursive: true, force: true });
  }

  private resolveCwd(ref: SandboxRef, cwd: string | undefined): string {
    if (cwd === undefined) return ref.workspacePath;
    return isAbsolute(cwd) ? cwd : join(ref.workspacePath, cwd);
  }

  private assertLive(ref: SandboxRef): void {
    if (!this.live.has(ref.id)) throw new SandboxError(`sandbox ${ref.id} is destroyed`, this.name);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/unit/local-process-sandbox.test.ts`
Expected: PASS, contract suite plus three adapter tests.

- [ ] **Step 5: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/sandbox/local tests/unit/local-process-sandbox.test.ts
git commit -m "feat(sandbox): add LocalProcessSandbox and pass the contract suite"
```

---

### Task 5: FlySpriteSandbox

**Files:**
- Modify: `package.json` (add `@fly/sprites`)
- Create: `src/adapters/sandbox/fly-sprites/network-policy.ts`
- Create: `src/adapters/sandbox/fly-sprites/fly-sprite-sandbox.ts`
- Create: `src/adapters/sandbox/fly-sprites/sprites-client.ts`
- Modify: `src/config/env.ts`
- Test: `tests/unit/fly-sprite-network-policy.test.ts`
- Test: `tests/unit/fly-sprite-sandbox.test.ts`

**Interfaces:**
- Consumes: every type of Task 1.
- Produces: `toSpritesNetworkPolicy(policy: NetworkPolicy): { rules: Array<{ domain: string; action: "allow" | "deny" }> }`, `FlySpriteSandbox`, and `SpritesGateway`. `FlySpriteSandbox` is constructed as `new FlySpriteSandbox({ gateway: SpritesGateway, workspacePath?: string, config?: { ramMB?: number; cpus?: number; region?: string } })`.

`SpritesGateway` is the narrow seam over `@fly/sprites`. It exists so the unit tests can drive `FlySpriteSandbox` without a live token, and so the SDK stays behind one file.

- [ ] **Step 1: Add the dependency**

```bash
npm install @fly/sprites@0.2.0
```

Expected: `package.json` and `package-lock.json` change. Run `npm run typecheck` to confirm the SDK types resolve.

- [ ] **Step 2: Write the failing network policy test**

```ts
// tests/unit/fly-sprite-network-policy.test.ts
import { describe, expect, it } from "vitest";
import { toSpritesNetworkPolicy } from "~/adapters/sandbox/fly-sprites/network-policy.js";

describe("toSpritesNetworkPolicy", () => {
  it("denies every domain when nothing is allowed", () => {
    expect(toSpritesNetworkPolicy({ allowedDomains: [] })).toEqual({
      rules: [{ domain: "*", action: "deny" }],
    });
  });

  it("places the deny-all rule last so it cannot shadow an allow rule", () => {
    const document = toSpritesNetworkPolicy({ allowedDomains: ["registry.npmjs.org", "api.github.com"] });
    expect(document.rules).toEqual([
      { domain: "api.github.com", action: "allow" },
      { domain: "registry.npmjs.org", action: "allow" },
      { domain: "*", action: "deny" },
    ]);
  });

  it("normalizes the domains before it builds the document", () => {
    const document = toSpritesNetworkPolicy({ allowedDomains: ["Registry.NPMJS.org", "registry.npmjs.org"] });
    expect(document.rules).toEqual([
      { domain: "registry.npmjs.org", action: "allow" },
      { domain: "*", action: "deny" },
    ]);
  });
});
```

- [ ] **Step 3: Write the network policy translation**

```ts
// src/adapters/sandbox/fly-sprites/network-policy.ts
import type { NetworkPolicy } from "~/domain/runs/sandbox.js";
import { normalizeNetworkPolicy } from "~/domain/runs/sandbox.js";

export interface SpritesPolicyRule {
  domain: string;
  action: "allow" | "deny";
}

export interface SpritesNetworkPolicy {
  rules: SpritesPolicyRule[];
}

/**
 * SDD section 29 denies arbitrary outbound network access. The document therefore always ends
 * with a deny-all rule, and Factoree never sends an empty policy.
 */
export const toSpritesNetworkPolicy = (policy: NetworkPolicy): SpritesNetworkPolicy => {
  const normalized = normalizeNetworkPolicy(policy);
  return {
    rules: [
      ...normalized.allowedDomains.map((domain): SpritesPolicyRule => ({ domain, action: "allow" })),
      { domain: "*", action: "deny" },
    ],
  };
};
```

- [ ] **Step 4: Run the network policy test**

Run: `npm test -- tests/unit/fly-sprite-network-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing adapter test**

```ts
// tests/unit/fly-sprite-sandbox.test.ts
import { describe, expect, it, vi } from "vitest";
import { FlySpriteSandbox } from "~/adapters/sandbox/fly-sprites/fly-sprite-sandbox.js";
import type { SpritesGateway, SpritesSpriteHandle } from "~/adapters/sandbox/fly-sprites/sprites-client.js";

const handle = (overrides: Partial<SpritesSpriteHandle> = {}): SpritesSpriteHandle => ({
  execFile: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
  createSession: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
  readSession: vi.fn().mockResolvedValue({ running: false, exitCode: 0, stdout: "", stderr: "" }),
  killSession: vi.fn().mockResolvedValue(undefined),
  createCheckpoint: vi.fn().mockResolvedValue({ id: "v1" }),
  updateNetworkPolicy: vi.fn().mockResolvedValue(undefined),
  createService: vi.fn().mockResolvedValue({ url: "https://sprite.example/8080" }),
  delete: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

const gateway = (sprite: SpritesSpriteHandle): SpritesGateway => ({
  createSprite: vi.fn().mockResolvedValue({ name: "factoree-run-1", handle: sprite }),
  sprite: vi.fn().mockReturnValue(sprite),
});

describe("FlySpriteSandbox", () => {
  it("names the adapter fly-sprites and declares that it enforces the network policy", () => {
    const sandbox = new FlySpriteSandbox({ gateway: gateway(handle()) });
    expect(sandbox.name).toBe("fly-sprites");
    expect(sandbox.capabilities.enforcesNetworkPolicy).toBe(true);
    expect(sandbox.capabilities.supportsCheckpoints).toBe(true);
  });

  it("creates one uniquely named sprite per Run", async () => {
    const sprite = handle();
    const api = gateway(sprite);
    const sandbox = new FlySpriteSandbox({ gateway: api });
    const first = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    const second = await sandbox.create({ runId: "run-b", tenantId: "t", projectId: "p" });
    expect(first.id).not.toBe(second.id);
    expect(first.id).toContain("run-a");
    expect(api.createSprite).toHaveBeenCalledTimes(2);
  });

  it("sends a deny-by-default network policy", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    await sandbox.applyNetworkPolicy(ref, { allowedDomains: ["registry.npmjs.org"] });
    expect(sprite.updateNetworkPolicy).toHaveBeenCalledWith({
      rules: [
        { domain: "registry.npmjs.org", action: "allow" },
        { domain: "*", action: "deny" },
      ],
    });
  });

  it("returns a command result instead of throwing on a non-zero exit code", async () => {
    const sprite = handle({
      execFile: vi.fn().mockRejectedValue(
        Object.assign(new Error("command failed"), { exitCode: 2, stdout: "out", stderr: "err" }),
      ),
    });
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    const result = await sandbox.exec(ref, { file: "sh", args: ["-c", "exit 2"] });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it("runs a command in the workspace path by default", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    await sandbox.exec(ref, { file: "git", args: ["status"] });
    expect(sprite.execFile).toHaveBeenCalledWith(
      "git",
      ["status"],
      expect.objectContaining({ cwd: ref.workspacePath }),
    );
  });

  it("starts a detachable session for a process and cancels it by session identifier", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    const started = await sandbox.startProcess(ref, { file: "opencode", args: ["run"] });
    expect(started.id).toBe("session-1");
    await sandbox.cancelProcess(ref, started);
    expect(sprite.killSession).toHaveBeenCalledWith("session-1");
  });

  it("does not throw when it cancels a session that has already gone", async () => {
    const sprite = handle({ killSession: vi.fn().mockRejectedValue(new Error("not found")) });
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    await expect(sandbox.cancelProcess(ref, { id: "gone" })).resolves.toBeUndefined();
  });

  it("does not throw when it destroys a sprite that has already gone", async () => {
    const sprite = handle({ delete: vi.fn().mockRejectedValue(new Error("404 not found")) });
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    await expect(sandbox.destroy(ref)).resolves.toBeUndefined();
  });

  it("creates a named checkpoint", async () => {
    const sprite = handle();
    const sandbox = new FlySpriteSandbox({ gateway: gateway(sprite) });
    const ref = await sandbox.create({ runId: "run-a", tenantId: "t", projectId: "p" });
    const checkpoint = await sandbox.checkpoint(ref, "baseline");
    expect(sprite.createCheckpoint).toHaveBeenCalledWith("baseline");
    expect(checkpoint).toEqual({ id: "v1", name: "baseline" });
  });
});
```

- [ ] **Step 6: Write the gateway**

```ts
// src/adapters/sandbox/fly-sprites/sprites-client.ts
import { SpritesClient } from "@fly/sprites";

/**
 * The narrow seam over `@fly/sprites`. Only this file knows the SDK. The adapter above it, the
 * domain, and the tests depend on these types instead. SDD section 12 requires that Fly Sprites
 * be replaceable; this seam keeps the replacement local.
 */
export interface SpritesExecOptions {
  cwd: string;
  env: Record<string, string>;
  timeout?: number;
}

export interface SpritesExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpritesSessionSnapshot {
  running: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface SpritesSpriteHandle {
  execFile(file: string, args: string[], options: SpritesExecOptions): Promise<SpritesExecResult>;
  createSession(file: string, args: string[], options: SpritesExecOptions): Promise<{ sessionId: string }>;
  readSession(sessionId: string): Promise<SpritesSessionSnapshot>;
  killSession(sessionId: string): Promise<void>;
  createCheckpoint(comment: string): Promise<{ id: string }>;
  updateNetworkPolicy(policy: { rules: Array<{ domain: string; action: "allow" | "deny" }> }): Promise<void>;
  createService(port: number): Promise<{ url: string }>;
  delete(): Promise<void>;
}

export interface SpritesCreateOptions {
  ramMB?: number;
  cpus?: number;
  region?: string;
  environment?: Record<string, string>;
}

export interface SpritesGateway {
  createSprite(name: string, options: SpritesCreateOptions): Promise<{ name: string; handle: SpritesSpriteHandle }>;
  sprite(name: string): SpritesSpriteHandle;
}

export interface SpritesGatewayOptions {
  token: string;
  baseUrl?: string;
}

export const createSpritesGateway = (options: SpritesGatewayOptions): SpritesGateway => {
  const client = new SpritesClient(options.token, {
    ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
  });

  const wrap = (sprite: ReturnType<SpritesClient["sprite"]>): SpritesSpriteHandle => ({
    execFile: async (file, args, execOptions) => {
      const result = await sprite.execFile(file, args, {
        cwd: execOptions.cwd,
        env: execOptions.env,
        ...(execOptions.timeout === undefined ? {} : { timeout: execOptions.timeout }),
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    },
    createSession: async (file, args, execOptions) => {
      const command = sprite.createSession(file, args, {
        cwd: execOptions.cwd,
        env: execOptions.env,
        detachable: true,
      });
      const sessions = await sprite.listSessions();
      const latest = sessions.at(-1);
      command.close();
      if (latest === undefined) throw new Error("the sprite reported no session after createSession");
      return { sessionId: latest.id };
    },
    readSession: async (sessionId) => {
      const sessions = await sprite.listSessions();
      const session = sessions.find((entry) => entry.id === sessionId);
      if (session === undefined) return { running: false, exitCode: 0, stdout: "", stderr: "" };
      return { running: session.isActive, exitCode: session.isActive ? null : 0, stdout: "", stderr: "" };
    },
    killSession: async (sessionId) => {
      const stream = await sprite.killSession(sessionId);
      for await (const _ of stream) {
        // Drain the progress stream so the kill completes before the promise resolves.
      }
    },
    createCheckpoint: async (comment) => {
      const stream = await sprite.createCheckpoint(comment);
      let id = comment;
      for (;;) {
        const message = await stream.next();
        if (message === null) break;
        if (message.type === "error") throw new Error(message.data ?? "the checkpoint failed");
        if (message.type === "complete" && typeof message.data === "string") id = message.data;
      }
      return { id };
    },
    updateNetworkPolicy: (policy) => sprite.updateNetworkPolicy(policy),
    createService: async (port) => {
      await sprite.createService({ name: `port-${port}`, cmd: "", port });
      const service = await sprite.getService(`port-${port}`);
      return { url: service.url ?? `https://${sprite.name}.sprites.dev:${port}` };
    },
    delete: () => sprite.delete(),
  });

  return {
    createSprite: async (name, createOptions) => {
      const sprite = await client.createSprite(name, {
        config: {
          ...(createOptions.ramMB === undefined ? {} : { ramMB: createOptions.ramMB }),
          ...(createOptions.cpus === undefined ? {} : { cpus: createOptions.cpus }),
          ...(createOptions.region === undefined ? {} : { region: createOptions.region }),
        },
        ...(createOptions.environment === undefined ? {} : { environment: createOptions.environment }),
        waitForCapacity: true,
      });
      return { name: sprite.name, handle: wrap(sprite) };
    },
    sprite: (name) => wrap(client.sprite(name)),
  };
};
```

> **Note for the implementer.** The exact `@fly/sprites` call shapes above are taken from the
> published SDK types of version 0.2.0. Read `node_modules/@fly/sprites/dist/index.d.ts` before
> you write this file, and match the real signatures. If a signature differs, change this file
> only. Nothing above `SpritesGateway` may change. Record any difference in
> `docs/build/evidence/phase-02-sprites-sdk.md`. Live reconciliation happens in Phase 12
> (SDD §66).

- [ ] **Step 7: Write the adapter**

```ts
// src/adapters/sandbox/fly-sprites/fly-sprite-sandbox.ts
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type {
  CheckpointRef,
  Command,
  CommandResult,
  NetworkPolicy,
  ProcessRef,
  ProcessSnapshot,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateInput,
  SandboxRef,
  ServiceRef,
} from "~/domain/runs/sandbox.js";
import type { SpritesGateway } from "./sprites-client.js";
import { toSpritesNetworkPolicy } from "./network-policy.js";

export interface FlySpriteSandboxOptions {
  gateway: SpritesGateway;
  /** The directory inside the sprite that holds every checkout. */
  workspacePath?: string;
  config?: { ramMB?: number; cpus?: number; region?: string };
}

const DEFAULT_WORKSPACE = "/workspace";

/** SDD section 31. The required Sandbox implementation. */
export class FlySpriteSandbox implements Sandbox {
  readonly name = "fly-sprites";
  readonly capabilities: SandboxCapabilities = {
    enforcesNetworkPolicy: true,
    supportsCheckpoints: true,
    supportsExposedServices: true,
  };

  private readonly workspacePath: string;

  constructor(private readonly options: FlySpriteSandboxOptions) {
    this.workspacePath = options.workspacePath ?? DEFAULT_WORKSPACE;
  }

  async create(input: SandboxCreateInput): Promise<SandboxRef> {
    // SDD section 32: one Run uses one unique mutable Sprite. The random suffix keeps the name
    // unique even when a Run is retried after a create that partly succeeded.
    const name = `factoree-${input.runId}-${randomUUID().slice(0, 8)}`.toLowerCase();
    const created = await this.options.gateway.createSprite(name, {
      ...(this.options.config?.ramMB === undefined ? {} : { ramMB: this.options.config.ramMB }),
      ...(this.options.config?.cpus === undefined ? {} : { cpus: this.options.config.cpus }),
      ...(this.options.config?.region === undefined ? {} : { region: this.options.config.region }),
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    });
    await created.handle.execFile("mkdir", ["-p", this.workspacePath], { cwd: "/", env: {} });
    return { id: created.name, adapter: this.name, workspacePath: this.workspacePath };
  }

  async applyNetworkPolicy(ref: SandboxRef, policy: NetworkPolicy): Promise<void> {
    await this.options.gateway.sprite(ref.id).updateNetworkPolicy(toSpritesNetworkPolicy(policy));
  }

  async exec(ref: SandboxRef, command: Command): Promise<CommandResult> {
    const startedAt = Date.now();
    try {
      const result = await this.options.gateway.sprite(ref.id).execFile(command.file, command.args, {
        cwd: this.resolveCwd(ref, command.cwd),
        env: command.env ?? {},
        ...(command.timeoutMs === undefined ? {} : { timeout: command.timeoutMs }),
      });
      return { ...result, timedOut: false, durationMs: Date.now() - startedAt };
    } catch (error) {
      // A non-zero exit code is a result, not a fault. Only an infrastructure fault throws.
      const failure = asExecFailure(error);
      if (failure === null) throw error;
      return { ...failure, durationMs: Date.now() - startedAt };
    }
  }

  async startProcess(ref: SandboxRef, command: Command): Promise<ProcessRef> {
    const session = await this.options.gateway.sprite(ref.id).createSession(command.file, command.args, {
      cwd: this.resolveCwd(ref, command.cwd),
      env: command.env ?? {},
    });
    return { id: session.sessionId };
  }

  async readProcess(ref: SandboxRef, process: ProcessRef): Promise<ProcessSnapshot> {
    return await this.options.gateway.sprite(ref.id).readSession(process.id);
  }

  async cancelProcess(ref: SandboxRef, process: ProcessRef): Promise<void> {
    try {
      await this.options.gateway.sprite(ref.id).killSession(process.id);
    } catch {
      // Cancellation is idempotent. A session that has already gone is cancelled.
    }
  }

  async checkpoint(ref: SandboxRef, name: string): Promise<CheckpointRef> {
    const created = await this.options.gateway.sprite(ref.id).createCheckpoint(name);
    return { id: created.id, name };
  }

  async exposeService(ref: SandboxRef, port: number): Promise<ServiceRef> {
    const service = await this.options.gateway.sprite(ref.id).createService(port);
    return { port, url: service.url };
  }

  async destroy(ref: SandboxRef): Promise<void> {
    try {
      await this.options.gateway.sprite(ref.id).delete();
    } catch {
      // Destruction is idempotent. A sprite that has already gone is destroyed.
    }
  }

  private resolveCwd(ref: SandboxRef, cwd: string | undefined): string {
    if (cwd === undefined) return ref.workspacePath;
    return isAbsolute(cwd) ? cwd : join(ref.workspacePath, cwd);
  }
}

interface ExecFailure {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const asExecFailure = (error: unknown): ExecFailure | null => {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { exitCode?: unknown; stdout?: unknown; stderr?: unknown; name?: unknown };
  if (typeof candidate.exitCode !== "number") {
    // An abort or a timeout carries no exit code but is still a command outcome.
    if (candidate.name === "AbortError" || candidate.name === "TimeoutError") {
      return { exitCode: 124, stdout: "", stderr: "the command reached its timeout", timedOut: true };
    }
    return null;
  }
  return {
    exitCode: candidate.exitCode,
    stdout: typeof candidate.stdout === "string" ? candidate.stdout : "",
    stderr: typeof candidate.stderr === "string" ? candidate.stderr : "",
    timedOut: false,
  };
};
```

- [ ] **Step 8: Add the environment values**

Add to the Zod schema in `src/config/env.ts`:

```ts
  SPRITES_TOKEN: z.string().min(1).optional(),
  SPRITES_BASE_URL: z.string().url().optional(),
  SANDBOX_ADAPTER: z.enum(["fly-sprites", "local"]).default("fly-sprites"),
  SANDBOX_LOCAL_ROOT: z.string().min(1).default("/tmp/factoree-sandboxes"),
```

Add a test case to `tests/unit/env.test.ts`:

```ts
  it("defaults the sandbox adapter to fly-sprites", () => {
    const env = loadEnv(validEnvironment());
    expect(env.SANDBOX_ADAPTER).toBe("fly-sprites");
  });
```

(`validEnvironment()` is the existing helper in that file. Reuse it; do not write a second one.)

- [ ] **Step 9: Run the tests**

Run: `npm test -- tests/unit/fly-sprite-sandbox.test.ts tests/unit/fly-sprite-network-policy.test.ts tests/unit/env.test.ts`
Expected: PASS.

- [ ] **Step 10: Run lint, typecheck, and the full unit suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json src/adapters/sandbox/fly-sprites src/config/env.ts tests/unit
git commit -m "feat(sandbox): add FlySpriteSandbox with a deny-by-default network policy (SDD section 31)"
```

---

### Task 6: Repository checkout

**Files:**
- Create: `src/domain/runs/project-runtime-config.ts`
- Create: `src/domain/runs/checkout.ts`
- Test: `tests/unit/checkout.test.ts`
- Test: `tests/integration/checkout-local.test.ts`

**Interfaces:**
- Consumes: `Sandbox`, `SandboxRef`, `Command` of Task 1; `ActionPolicy` of Task 2; `FakeSandbox` of Task 3; `LocalProcessSandbox` of Task 4.
- Produces: `ProjectRuntimeConfig`, `RepositorySpec`, `CheckoutResult`, `CheckedOutRepository`, `checkoutRepositories(sandbox, ref, input): Promise<CheckoutResult>`.

- [ ] **Step 1: Write the runtime configuration type**

```ts
// src/domain/runs/project-runtime-config.ts

/**
 * The typed sandbox and runner configuration for one Project. Phase 3 builds the
 * `.factoree/config.yaml` loader that produces this value (SDD section 15). Phase 2 receives it
 * already built, so nothing here parses YAML.
 */
export interface ProjectRuntimeConfig {
  bootstrapCommand: string | null;
  /** SDD section 29. An empty list denies all egress. */
  allowedDomains: string[];
  implementerRunner: string;
  validatorRunner: string;
  reviewerRunner: string;
  repairMaxAttempts: number;
  stagingRead: boolean;
  /** SDD section 51. */
  spriteRetentionHours: number;
}

export const DEFAULT_PROJECT_RUNTIME_CONFIG: ProjectRuntimeConfig = {
  bootstrapCommand: null,
  allowedDomains: [],
  implementerRunner: "opencode",
  validatorRunner: "claude",
  reviewerRunner: "claude",
  repairMaxAttempts: 2,
  stagingRead: false,
  spriteRetentionHours: 24,
};
```

- [ ] **Step 2: Write the failing unit test**

```ts
// tests/unit/checkout.test.ts
import { describe, expect, it } from "vitest";
import { checkoutRepositories } from "~/domain/runs/checkout.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const input = {
  primary: { url: "https://github.com/acme/app.git", ref: "main" },
  references: [{ url: "https://github.com/acme/design.git", ref: "main" }],
};

describe("checkoutRepositories", () => {
  it("clones the primary repository and captures its base SHA", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const result = await checkoutRepositories(sandbox, ref, input);
    expect(result.primary.baseSha).toBe("aaaabbbbccccddddeeeeffff0000111122223333");
    expect(result.primary.path).toBe("/workspace/primary");
  });

  it("clones every reference repository under its own directory", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const result = await checkoutRepositories(sandbox, ref, input);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]?.path).toBe("/workspace/reference/design");
  });

  it("removes the push URL of the primary repository, because SDD section 29 denies git remote write", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await checkoutRepositories(sandbox, ref, input);
    const lines = sandbox.commands.map((command) => [command.file, ...command.args].join(" "));
    expect(lines).toContain("git remote set-url --push origin DISABLED_BY_FACTOREE");
  });

  it("makes every reference repository read-only", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await checkoutRepositories(sandbox, ref, input);
    const lines = sandbox.commands.map((command) => [command.file, ...command.args].join(" "));
    expect(lines).toContain("chmod -R a-w /workspace/reference/design");
  });

  it("clones the primary repository before it clones a reference repository", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await checkoutRepositories(sandbox, ref, input);
    const lines = sandbox.commands.map((command) => [command.file, ...command.args].join(" "));
    const primaryIndex = lines.findIndex((line) => line.includes("acme/app.git"));
    const referenceIndex = lines.findIndex((line) => line.includes("acme/design.git"));
    expect(primaryIndex).toBeGreaterThanOrEqual(0);
    expect(primaryIndex).toBeLessThan(referenceIndex);
  });

  it("fails when the clone of the primary repository fails", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/clone/, { exitCode: 128, stderr: "repository not found" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await expect(checkoutRepositories(sandbox, ref, input)).rejects.toThrow(/repository not found/);
  });

  it("rejects a base SHA that is not forty hexadecimal characters", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "not-a-sha\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await expect(checkoutRepositories(sandbox, ref, input)).rejects.toThrow(/base SHA/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/unit/checkout.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Write the implementation**

```ts
// src/domain/runs/checkout.ts
import type { Command, CommandResult, Sandbox, SandboxRef } from "./sandbox.js";

export interface RepositorySpec {
  url: string;
  /** A branch, a tag, or a commit SHA. */
  ref: string;
}

export interface CheckedOutRepository {
  url: string;
  /** The absolute path inside the sandbox. */
  path: string;
  /** The commit the checkout landed on. SDD section 55 requires the recorded SHA. */
  baseSha: string;
  readOnly: boolean;
}

export interface CheckoutInput {
  primary: RepositorySpec;
  references: RepositorySpec[];
}

export interface CheckoutResult {
  primary: CheckedOutRepository;
  references: CheckedOutRepository[];
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * SDD section 32. Checks out the primary repository, then the reference repositories.
 *
 * The primary worktree is writable. Every reference repository is made read-only, because SDD
 * section 29 denies writing a reference repository. The push URL of every checkout is removed,
 * because SDD section 29 denies git remote write from an agent. Neither control is a prompt.
 */
export const checkoutRepositories = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  input: CheckoutInput,
): Promise<CheckoutResult> => {
  const run = async (command: Command): Promise<CommandResult> => {
    const result = await sandbox.exec(ref, command);
    if (result.exitCode !== 0) {
      throw new Error(
        `the command "${[command.file, ...command.args].join(" ")}" failed with exit code ` +
          `${result.exitCode}: ${result.stderr.trim()}`,
      );
    }
    return result;
  };

  const clone = async (spec: RepositorySpec, path: string): Promise<string> => {
    await run({ file: "git", args: ["clone", "--no-tags", spec.url, path] });
    await run({ file: "git", args: ["-C", path, "checkout", "--detach", spec.ref] });
    // SDD section 29: git remote write from an agent is denied.
    await run({ file: "git", args: ["-C", path, "remote", "set-url", "--push", "origin", "DISABLED_BY_FACTOREE"] });
    const head = await run({ file: "git", args: ["-C", path, "rev-parse", "HEAD"] });
    const baseSha = head.stdout.trim();
    if (!SHA.test(baseSha)) {
      throw new Error(`the base SHA of ${spec.url} is not forty hexadecimal characters: "${baseSha}"`);
    }
    return baseSha;
  };

  const primaryPath = `${ref.workspacePath}/primary`;
  const primaryBaseSha = await clone(input.primary, primaryPath);

  const references: CheckedOutRepository[] = [];
  for (const spec of input.references) {
    const name = repositoryName(spec.url);
    const path = `${ref.workspacePath}/reference/${name}`;
    const baseSha = await clone(spec, path);
    // SDD section 29: writing a reference repository is denied. This is a file mode, not a prompt.
    await run({ file: "chmod", args: ["-R", "a-w", path] });
    references.push({ url: spec.url, path, baseSha, readOnly: true });
  }

  return {
    primary: { url: input.primary.url, path: primaryPath, baseSha: primaryBaseSha, readOnly: false },
    references,
  };
};

const repositoryName = (url: string): string => {
  const last = url.split("/").at(-1) ?? url;
  const name = last.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`the repository URL "${url}" does not end in a usable directory name`);
  }
  return name;
};
```

- [ ] **Step 5: Run the unit test**

Run: `npm test -- tests/unit/checkout.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the integration test against a real git repository**

```ts
// tests/integration/checkout-local.test.ts
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { checkoutRepositories } from "~/domain/runs/checkout.js";

const run = promisify(execFile);

/** Creates a bare-backed git repository on disk that a clone can reach through a file URL. */
const createRepository = async (root: string, name: string, fileName: string): Promise<string> => {
  const path = join(root, name);
  await run("git", ["init", "--initial-branch=main", path]);
  await writeFile(join(path, fileName), "original\n", "utf8");
  await run("git", ["-C", path, "add", "."]);
  await run("git", ["-C", path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "initial"]);
  return path;
};

describe("checkoutRepositories against real git repositories", () => {
  let root: string;
  let sandboxRoot: string;
  let primaryUrl: string;
  let referenceUrl: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-repos-"));
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-sandbox-"));
    primaryUrl = await createRepository(root, "app", "index.txt");
    referenceUrl = await createRepository(root, "design", "notes.txt");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("captures the real base SHA, writes the primary worktree, and denies the reference worktree", async () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const result = await checkoutRepositories(sandbox, ref, {
      primary: { url: primaryUrl, ref: "main" },
      references: [{ url: referenceUrl, ref: "main" }],
    });

    expect(result.primary.baseSha).toMatch(/^[0-9a-f]{40}$/);

    const writePrimary = await sandbox.exec(ref, {
      file: "sh",
      args: ["-c", `printf changed > ${result.primary.path}/index.txt && printf OK`],
    });
    expect(writePrimary.stdout).toBe("OK");

    const referencePath = result.references[0]?.path ?? "";
    const writeReference = await sandbox.exec(ref, {
      file: "sh",
      args: ["-c", `printf changed > ${referencePath}/notes.txt 2>/dev/null; printf %s $?`],
    });
    expect(writeReference.stdout).not.toBe("0");

    const push = await sandbox.exec(ref, {
      file: "sh",
      args: ["-c", `git -C ${result.primary.path} push origin HEAD 2>&1; printf "|%s" $?`],
    });
    expect(push.stdout).not.toContain("|0");

    await sandbox.destroy(ref);
  });
});
```

Add `tests/integration/checkout-local.test.ts` to the include list of `vitest.integration.config.ts` if that file lists files explicitly. If it uses a glob, no change is needed.

- [ ] **Step 7: Run the integration test**

Run: `npm run test:integration -- tests/integration/checkout-local.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/domain/runs/checkout.ts src/domain/runs/project-runtime-config.ts tests/unit/checkout.test.ts tests/integration/checkout-local.test.ts
git commit -m "feat(sandbox): check out the primary and reference repositories with captured SHAs (SDD section 32)"
```

---

### Task 7: SandboxManager lifecycle

**Files:**
- Create: `src/domain/runs/sandbox-manager.ts`
- Test: `tests/unit/sandbox-manager.test.ts`

**Interfaces:**
- Consumes: `Sandbox`, `SandboxRef`, `NetworkPolicyNotEnforcedError` of Task 1; `ProjectRuntimeConfig` of Task 6; `checkoutRepositories` of Task 6; `FakeSandbox` of Task 3.
- Produces: `SandboxManager`, `PrepareSandboxInput`, `PreparedSandbox`. `new SandboxManager({ sandbox: Sandbox, allowUnenforcedNetwork?: boolean })`. `prepare(input: PrepareSandboxInput): Promise<PreparedSandbox>`. `release(prepared: PreparedSandbox): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/sandbox-manager.test.ts
import { describe, expect, it } from "vitest";
import { NetworkPolicyNotEnforcedError } from "~/domain/runs/sandbox.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { DEFAULT_PROJECT_RUNTIME_CONFIG } from "~/domain/runs/project-runtime-config.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const input = {
  runId: "run-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  primary: { url: "https://github.com/acme/app.git", ref: "main" },
  references: [],
  config: { ...DEFAULT_PROJECT_RUNTIME_CONFIG, allowedDomains: ["registry.npmjs.org"] },
};

const withSha = (): FakeSandbox => {
  const sandbox = new FakeSandbox();
  sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
  return sandbox;
};

describe("SandboxManager.prepare", () => {
  it("follows the SDD section 32 order: create, network policy, checkout, bootstrap, checkpoint", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    await manager.prepare({ ...input, config: { ...input.config, bootstrapCommand: "npm ci" } });
    const order = sandbox.calls.filter(
      (call) => call === "create" || call === "applyNetworkPolicy" || call.startsWith("checkpoint"),
    );
    expect(order).toEqual(["create", "applyNetworkPolicy", "checkpoint:baseline"]);
  });

  it("applies the network policy before it runs any command", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    await manager.prepare(input);
    const policyIndex = sandbox.calls.indexOf("applyNetworkPolicy");
    const firstExec = sandbox.calls.findIndex((call) => call.startsWith("exec:"));
    expect(policyIndex).toBeGreaterThanOrEqual(0);
    expect(policyIndex).toBeLessThan(firstExec);
  });

  it("passes the Project allow list to the network policy", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    await manager.prepare(input);
    expect(sandbox.policies[0]).toEqual({ allowedDomains: ["registry.npmjs.org"] });
  });

  it("runs the bootstrap command in the primary worktree after the checkout", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    await manager.prepare({ ...input, config: { ...input.config, bootstrapCommand: "npm ci" } });
    const bootstrap = sandbox.commands.find((command) => command.args.includes("npm ci"));
    expect(bootstrap?.cwd).toBe("/workspace/primary");
  });

  it("skips bootstrap when the Project configures no bootstrap command", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    await manager.prepare(input);
    expect(sandbox.commands.some((command) => command.args.includes("npm ci"))).toBe(false);
  });

  it("fails the preparation when the bootstrap command fails", async () => {
    const sandbox = withSha();
    sandbox.scriptExec(/npm ci/, { exitCode: 1, stderr: "install failed" });
    const manager = new SandboxManager({ sandbox });
    await expect(
      manager.prepare({ ...input, config: { ...input.config, bootstrapCommand: "npm ci" } }),
    ).rejects.toThrow(/install failed/);
  });

  it("destroys the sandbox when preparation fails, so no sandbox leaks", async () => {
    const sandbox = withSha();
    sandbox.scriptExec(/clone/, { exitCode: 128, stderr: "clone failed" });
    const manager = new SandboxManager({ sandbox });
    await expect(manager.prepare(input)).rejects.toThrow(/clone failed/);
    expect(sandbox.destroyed).toHaveLength(1);
  });

  it("returns the sandbox reference, the base SHA, and the baseline checkpoint", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    const prepared = await manager.prepare(input);
    expect(prepared.ref.id).toContain("run-1");
    expect(prepared.checkout.primary.baseSha).toBe("aaaabbbbccccddddeeeeffff0000111122223333");
    expect(prepared.baselineCheckpoint?.name).toBe("baseline");
  });

  it("refuses a sandbox that cannot enforce the network policy", async () => {
    const sandbox = new FakeSandbox({
      enforcesNetworkPolicy: false,
      supportsCheckpoints: true,
      supportsExposedServices: false,
    });
    const manager = new SandboxManager({ sandbox });
    await expect(manager.prepare(input)).rejects.toThrow(NetworkPolicyNotEnforcedError);
  });

  it("accepts an unenforced sandbox only when the caller opts in", async () => {
    const sandbox = new FakeSandbox({
      enforcesNetworkPolicy: false,
      supportsCheckpoints: true,
      supportsExposedServices: false,
    });
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    await expect(manager.prepare(input)).resolves.toBeDefined();
  });

  it("skips the checkpoint when the adapter does not support checkpoints", async () => {
    const sandbox = new FakeSandbox({
      enforcesNetworkPolicy: true,
      supportsCheckpoints: false,
      supportsExposedServices: false,
    });
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const manager = new SandboxManager({ sandbox });
    const prepared = await manager.prepare(input);
    expect(prepared.baselineCheckpoint).toBeNull();
    expect(sandbox.checkpoints).toHaveLength(0);
  });

  it("gives two Runs two different sandbox identifiers", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    const first = await manager.prepare(input);
    const second = await manager.prepare({ ...input, runId: "run-2" });
    expect(first.ref.id).not.toBe(second.ref.id);
  });

  it("destroys the sandbox on release", async () => {
    const sandbox = withSha();
    const manager = new SandboxManager({ sandbox });
    const prepared = await manager.prepare(input);
    await manager.release(prepared);
    expect(sandbox.destroyed).toContain(prepared.ref.id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/sandbox-manager.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/runs/sandbox-manager.ts
import type { CheckoutResult, RepositorySpec } from "./checkout.js";
import { checkoutRepositories } from "./checkout.js";
import type { ProjectRuntimeConfig } from "./project-runtime-config.js";
import type { CheckpointRef, Sandbox, SandboxRef } from "./sandbox.js";
import { NetworkPolicyNotEnforcedError } from "./sandbox.js";

export interface PrepareSandboxInput {
  runId: string;
  tenantId: string;
  projectId: string;
  primary: RepositorySpec;
  references: RepositorySpec[];
  config: ProjectRuntimeConfig;
  /** Project test secrets only. SDD section 30 forbids every other credential here. */
  environment?: Record<string, string>;
}

export interface PreparedSandbox {
  ref: SandboxRef;
  checkout: CheckoutResult;
  baselineCheckpoint: CheckpointRef | null;
}

export interface SandboxManagerOptions {
  sandbox: Sandbox;
  /**
   * Permits an adapter that cannot enforce an egress policy. Only the test suite and local
   * development set this. Production must leave it false, because SDD section 29 denies
   * arbitrary outbound network access and a prompt is not a boundary.
   */
  allowUnenforcedNetwork?: boolean;
}

/**
 * SDD section 32. Drives the sandbox lifecycle in the required order:
 * create, apply network policy, checkout primary, checkout references, bootstrap,
 * checkpoint baseline.
 */
export class SandboxManager {
  constructor(private readonly options: SandboxManagerOptions) {}

  async prepare(input: PrepareSandboxInput): Promise<PreparedSandbox> {
    if (!this.options.sandbox.capabilities.enforcesNetworkPolicy && this.options.allowUnenforcedNetwork !== true) {
      throw new NetworkPolicyNotEnforcedError(this.options.sandbox.name);
    }

    const sandbox = this.options.sandbox;
    const ref = await sandbox.create({
      runId: input.runId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    });

    try {
      // The policy comes before every command, so no checkout and no bootstrap can reach a
      // domain outside the allow list.
      await sandbox.applyNetworkPolicy(ref, { allowedDomains: input.config.allowedDomains });

      const checkout = await checkoutRepositories(sandbox, ref, {
        primary: input.primary,
        references: input.references,
      });

      if (input.config.bootstrapCommand !== null) {
        const result = await sandbox.exec(ref, {
          file: "sh",
          args: ["-c", input.config.bootstrapCommand],
          cwd: checkout.primary.path,
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `the bootstrap command failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
          );
        }
      }

      const baselineCheckpoint = sandbox.capabilities.supportsCheckpoints
        ? await sandbox.checkpoint(ref, "baseline")
        : null;

      return { ref, checkout, baselineCheckpoint };
    } catch (error) {
      // A half-prepared sandbox must not leak. Destruction is idempotent.
      await sandbox.destroy(ref).catch(() => undefined);
      throw error;
    }
  }

  async release(prepared: PreparedSandbox): Promise<void> {
    await this.options.sandbox.destroy(prepared.ref);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/unit/sandbox-manager.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain/runs/sandbox-manager.ts tests/unit/sandbox-manager.test.ts
git commit -m "feat(sandbox): add the SandboxManager lifecycle (SDD section 32)"
```

---

### Task 8: AgentRunner port, registry, and Implementer input

**Files:**
- Create: `src/domain/runs/agent-runner.ts`
- Create: `src/domain/runs/implementer-input.ts`
- Create: `src/prompts/implementer.ts`
- Test: `tests/unit/agent-runner-registry.test.ts`
- Test: `tests/unit/implementer-input.test.ts`

**Interfaces:**
- Consumes: `Sandbox`, `SandboxRef` of Task 1; `ActionPolicy` of Task 2; `CheckoutResult` of Task 6.
- Produces: `AgentRunner`, `AgentRunInput`, `AgentResumeInput`, `AgentRunResult`, `AgentSessionRef`, `AgentRole`, `AgentRunnerRegistry`, `ForbiddenImplementerMaterialError`, `buildImplementerInput`, `IMPLEMENTER_PROMPT_VERSION`, `renderImplementerPrompt`.

- [ ] **Step 1: Write the AgentRunner port**

```ts
// src/domain/runs/agent-runner.ts
import type { ActionPolicy } from "~/domain/policy/action-policy.js";
import type { Sandbox, SandboxRef } from "./sandbox.js";

export type AgentRole = "implementer" | "validator" | "reviewer";

export interface AgentSessionRef {
  /** The runner-scoped session identifier, used to resume and to cancel. */
  sessionId: string;
  /** The sandbox process that carries the session. */
  processId: string;
  runner: string;
}

export interface AgentRunInput {
  runId: string;
  tenantId: string;
  role: AgentRole;
  sandbox: Sandbox;
  ref: SandboxRef;
  /** The absolute path of the primary worktree inside the sandbox. */
  workingDirectory: string;
  /** The complete instruction text. It must never carry a forbidden credential. */
  prompt: string;
  promptVersion: string;
  /** Values placed in the process environment. Project test secrets only (SDD section 30). */
  environment: Record<string, string>;
  actionPolicy: ActionPolicy;
  timeoutMs: number;
}

export interface AgentResumeInput {
  prompt: string;
  timeoutMs: number;
}

export interface AgentRunResult {
  session: AgentSessionRef;
  /** True only when the runner process exited zero. It is a claim, not evidence (SDD section P-01). */
  completed: boolean;
  exitCode: number;
  /** The redacted final message. Full transcripts are not persisted (SDD section 61). */
  summary: string;
  durationMs: number;
  /** True when Factoree cancelled the session. */
  cancelled: boolean;
}

/** SDD section 33. Temporal workflows depend only on this interface. */
export interface AgentRunner {
  readonly name: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
  resume(session: AgentSessionRef, input: AgentResumeInput): Promise<AgentRunResult>;
  cancel(session: AgentSessionRef): Promise<void>;
}

export class UnknownAgentRunnerError extends Error {
  constructor(name: string, known: string[]) {
    super(`No agent runner is registered under "${name}". Registered runners: ${known.join(", ")}.`);
    this.name = "UnknownAgentRunnerError";
  }
}

/** SDD section 14. Runner selection is configuration-driven, never hard coded at a call site. */
export class AgentRunnerRegistry {
  private readonly runners = new Map<string, AgentRunner>();

  constructor(runners: AgentRunner[] = []) {
    for (const runner of runners) this.register(runner);
  }

  register(runner: AgentRunner): void {
    if (this.runners.has(runner.name)) {
      throw new Error(`An agent runner named "${runner.name}" is already registered.`);
    }
    this.runners.set(runner.name, runner);
  }

  get(name: string): AgentRunner {
    const runner = this.runners.get(name);
    if (runner === undefined) throw new UnknownAgentRunnerError(name, [...this.runners.keys()]);
    return runner;
  }

  names(): string[] {
    return [...this.runners.keys()].sort();
  }
}
```

- [ ] **Step 2: Write the registry test**

```ts
// tests/unit/agent-runner-registry.test.ts
import { describe, expect, it } from "vitest";
import { AgentRunnerRegistry, UnknownAgentRunnerError } from "~/domain/runs/agent-runner.js";
import type { AgentRunner } from "~/domain/runs/agent-runner.js";

const stub = (name: string): AgentRunner => ({
  name,
  run: () => Promise.reject(new Error("not used")),
  resume: () => Promise.reject(new Error("not used")),
  cancel: () => Promise.resolve(),
});

describe("AgentRunnerRegistry", () => {
  it("returns the runner registered under a name", () => {
    const registry = new AgentRunnerRegistry([stub("opencode")]);
    expect(registry.get("opencode").name).toBe("opencode");
  });

  it("throws UnknownAgentRunnerError and names the registered runners", () => {
    const registry = new AgentRunnerRegistry([stub("opencode")]);
    expect(() => registry.get("claude")).toThrow(UnknownAgentRunnerError);
    expect(() => registry.get("claude")).toThrow(/opencode/);
  });

  it("refuses to register two runners under one name", () => {
    const registry = new AgentRunnerRegistry([stub("opencode")]);
    expect(() => registry.register(stub("opencode"))).toThrow(/already registered/);
  });

  it("lists the registered names in a stable order", () => {
    const registry = new AgentRunnerRegistry([stub("opencode"), stub("claude")]);
    expect(registry.names()).toEqual(["claude", "opencode"]);
  });
});
```

- [ ] **Step 3: Run the registry test**

Run: `npm test -- tests/unit/agent-runner-registry.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing Implementer input test**

```ts
// tests/unit/implementer-input.test.ts
import { describe, expect, it } from "vitest";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import {
  ForbiddenImplementerMaterialError,
  buildImplementerInput,
} from "~/domain/runs/implementer-input.js";
import { IMPLEMENTER_PROMPT_VERSION } from "~/prompts/implementer.js";

const base = {
  goal: "Add a health endpoint that returns 200.",
  humanDecisions: ["Use the existing Fastify server."],
  validationContract: null,
  contextContract: null,
  requiredContext: [],
  primaryRepositoryPath: "/workspace/primary",
  referenceRepositoryPaths: ["/workspace/reference/design"],
  repositoryInstructions: "Follow the house style in CONTRIBUTING.md.",
  skills: [],
  actionPolicy: buildActionPolicy(),
  repairFindings: [],
  projectTestSecrets: { TEST_API_KEY: "value-from-the-project-secret-store" },
};

describe("buildImplementerInput", () => {
  it("includes the goal, the human decisions, and the repository instructions", () => {
    const input = buildImplementerInput(base);
    expect(input.prompt).toContain("Add a health endpoint that returns 200.");
    expect(input.prompt).toContain("Use the existing Fastify server.");
    expect(input.prompt).toContain("Follow the house style in CONTRIBUTING.md.");
  });

  it("includes the primary repository path and the reference repository paths", () => {
    const input = buildImplementerInput(base);
    expect(input.prompt).toContain("/workspace/primary");
    expect(input.prompt).toContain("/workspace/reference/design");
  });

  it("states the Action Policy in the prompt as information, not as the boundary", () => {
    const input = buildImplementerInput(base);
    expect(input.prompt).toContain("deny: write a reference repository");
    expect(input.prompt).toContain("Factoree enforces these rules outside this prompt.");
  });

  it("stamps the prompt version, because SDD section 56 requires prompt versioning", () => {
    expect(buildImplementerInput(base).promptVersion).toBe(IMPLEMENTER_PROMPT_VERSION);
  });

  it("includes the repair findings when they are present", () => {
    const input = buildImplementerInput({ ...base, repairFindings: ["The lint check failed on src/a.ts."] });
    expect(input.prompt).toContain("The lint check failed on src/a.ts.");
  });

  it("places the Project test secrets in the environment and never in the prompt", () => {
    const input = buildImplementerInput(base);
    expect(input.environment.TEST_API_KEY).toBe("value-from-the-project-secret-store");
    expect(input.prompt).not.toContain("value-from-the-project-secret-store");
  });

  it("rejects a Linear token in the environment (SDD section 30, AT-26)", () => {
    expect(() =>
      buildImplementerInput({ ...base, projectTestSecrets: { LINEAR_API_KEY: "lin_api_x" } }),
    ).toThrow(ForbiddenImplementerMaterialError);
  });

  it("rejects a GitHub write credential in the environment (SDD section 30, AT-26)", () => {
    expect(() =>
      buildImplementerInput({ ...base, projectTestSecrets: { GITHUB_TOKEN: "ghp_x" } }),
    ).toThrow(ForbiddenImplementerMaterialError);
  });

  it("rejects the Factoree admin token and the encryption key in the environment", () => {
    expect(() =>
      buildImplementerInput({ ...base, projectTestSecrets: { ADMIN_API_TOKEN: "x" } }),
    ).toThrow(ForbiddenImplementerMaterialError);
    expect(() =>
      buildImplementerInput({ ...base, projectTestSecrets: { FACTOREE_SECRET_KEY: "x" } }),
    ).toThrow(ForbiddenImplementerMaterialError);
  });

  it("never includes a Reviewer conversation, because SDD section 34 forbids it", () => {
    const input = buildImplementerInput(base);
    expect(input.prompt).not.toContain("Reviewer");
  });

  it("tells the Implementer that it may not change the Validation Contract", () => {
    const input = buildImplementerInput(base);
    expect(input.prompt).toContain("You must not change the Validation Contract.");
  });
});
```

- [ ] **Step 5: Write the prompt template**

```ts
// src/prompts/implementer.ts

/** SDD section 56. Change this value whenever the template below changes. */
export const IMPLEMENTER_PROMPT_VERSION = "implementer/1";

export interface ImplementerPromptFields {
  goal: string;
  humanDecisions: string[];
  validationContract: string | null;
  contextContract: string | null;
  requiredContext: string[];
  primaryRepositoryPath: string;
  referenceRepositoryPaths: string[];
  repositoryInstructions: string;
  skills: string[];
  actionPolicyLines: string[];
  repairFindings: string[];
}

const section = (title: string, body: string): string => `## ${title}\n\n${body}\n`;

const list = (items: string[], empty: string): string =>
  items.length === 0 ? empty : items.map((item) => `- ${item}`).join("\n");

/** SDD section 34. The Implementer receives exactly these fields and nothing else. */
export const renderImplementerPrompt = (fields: ImplementerPromptFields): string =>
  [
    "# Implementer instructions",
    "",
    "You are the Implementer. You change the primary worktree only.",
    "",
    section("Goal", fields.goal),
    section("Recorded human decisions", list(fields.humanDecisions, "None recorded.")),
    section("Validation Contract", fields.validationContract ?? "No Validation Contract exists yet."),
    section("Context Contract", fields.contextContract ?? "No Context Contract exists yet."),
    section("Required context", list(fields.requiredContext, "None supplied.")),
    section("Primary repository", `The writable worktree is at ${fields.primaryRepositoryPath}.`),
    section(
      "Reference repositories",
      list(
        fields.referenceRepositoryPaths.map((path) => `${path} (read only)`),
        "None supplied.",
      ),
    ),
    section("Repository instructions", fields.repositoryInstructions),
    section("Applicable skills", list(fields.skills, "None supplied.")),
    section(
      "Action Policy",
      `${list(fields.actionPolicyLines, "None supplied.")}\n\n` +
        "Factoree enforces these rules outside this prompt. A rule you cannot see still applies.",
    ),
    section("Repair findings", list(fields.repairFindings, "None. This is the first attempt.")),
    section(
      "Rules",
      [
        "You must not change the Validation Contract.",
        "You must not push to a git remote.",
        "You must not write a reference repository.",
        "You must state plainly what you did not do.",
      ].join("\n"),
    ),
  ].join("\n");
```

- [ ] **Step 6: Write the Implementer input assembler**

```ts
// src/domain/runs/implementer-input.ts
import type { ActionPolicy } from "~/domain/policy/action-policy.js";
import { IMPLEMENTER_PROMPT_VERSION, renderImplementerPrompt } from "~/prompts/implementer.js";

export interface BuildImplementerInput {
  goal: string;
  humanDecisions: string[];
  validationContract: string | null;
  contextContract: string | null;
  requiredContext: string[];
  primaryRepositoryPath: string;
  referenceRepositoryPaths: string[];
  repositoryInstructions: string;
  skills: string[];
  actionPolicy: ActionPolicy;
  repairFindings: string[];
  /** Non-production Project test secrets only. SDD section 30. */
  projectTestSecrets: Record<string, string>;
}

export interface ImplementerInput {
  prompt: string;
  promptVersion: string;
  environment: Record<string, string>;
}

export class ForbiddenImplementerMaterialError extends Error {
  constructor(readonly key: string) {
    super(
      `The Implementer must not receive "${key}". SDD section 30 forbids Linear tokens, GitHub ` +
        "write credentials, production secrets, and Factoree admin credentials.",
    );
    this.name = "ForbiddenImplementerMaterialError";
  }
}

/** Names that must never reach the Implementer process. The check is on the name, not the value. */
const FORBIDDEN_NAME = /(linear|github|gh_token|admin_api_token|factoree_secret|production|prod_)/i;

/** SDD section 34. Assembles the Implementer input and rejects forbidden material. */
export const buildImplementerInput = (input: BuildImplementerInput): ImplementerInput => {
  for (const key of Object.keys(input.projectTestSecrets)) {
    if (FORBIDDEN_NAME.test(key)) throw new ForbiddenImplementerMaterialError(key);
  }

  return {
    prompt: renderImplementerPrompt({
      goal: input.goal,
      humanDecisions: input.humanDecisions,
      validationContract: input.validationContract,
      contextContract: input.contextContract,
      requiredContext: input.requiredContext,
      primaryRepositoryPath: input.primaryRepositoryPath,
      referenceRepositoryPaths: input.referenceRepositoryPaths,
      repositoryInstructions: input.repositoryInstructions,
      skills: input.skills,
      actionPolicyLines: input.actionPolicy.describe(),
      repairFindings: input.repairFindings,
    }),
    promptVersion: IMPLEMENTER_PROMPT_VERSION,
    environment: { ...input.projectTestSecrets },
  };
};
```

- [ ] **Step 7: Run the tests**

Run: `npm test -- tests/unit/implementer-input.test.ts tests/unit/agent-runner-registry.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/domain/runs/agent-runner.ts src/domain/runs/implementer-input.ts src/prompts/implementer.ts tests/unit/agent-runner-registry.test.ts tests/unit/implementer-input.test.ts
git commit -m "feat(runners): add the AgentRunner port, the registry, and the Implementer input (SDD sections 33 and 34)"
```

---

### Task 9: OpenCodeRunner

**Files:**
- Create: `src/adapters/runners/opencode/output-parser.ts`
- Create: `src/adapters/runners/opencode/opencode-runner.ts`
- Create: `tests/fixtures/bin/opencode-stub.sh`
- Test: `tests/unit/opencode-output-parser.test.ts`
- Test: `tests/unit/opencode-runner.test.ts`
- Test: `tests/integration/opencode-runner-local.test.ts`

**Interfaces:**
- Consumes: `AgentRunner`, `AgentRunInput`, `AgentResumeInput`, `AgentRunResult`, `AgentSessionRef` of Task 8; `Sandbox`, `ProcessSnapshot` of Task 1; `Redactor` of `src/telemetry/redaction.ts`.
- Produces: `parseOpenCodeOutput(text: string): { sessionId: string | null; summary: string }`, `OpenCodeRunner`. `new OpenCodeRunner({ executable?: string, redactor: Redactor, pollIntervalMs?: number, clock?: () => number })`.

`opencode` writes newline-delimited JSON events when it is called with `--print-logs --format json`. The parser reads the `session.id` from the first event that carries one, and the text of the last `message` event. Any line that is not JSON is ignored, because the CLI also writes plain progress lines.

- [ ] **Step 1: Write the failing parser test**

```ts
// tests/unit/opencode-output-parser.test.ts
import { describe, expect, it } from "vitest";
import { parseOpenCodeOutput } from "~/adapters/runners/opencode/output-parser.js";

describe("parseOpenCodeOutput", () => {
  it("reads the session identifier from the first event that carries one", () => {
    const text = [
      '{"type":"session.start","session":{"id":"ses_abc"}}',
      '{"type":"session.update","session":{"id":"ses_def"}}',
    ].join("\n");
    expect(parseOpenCodeOutput(text).sessionId).toBe("ses_abc");
  });

  it("returns the text of the last message event as the summary", () => {
    const text = [
      '{"type":"message","text":"first"}',
      '{"type":"message","text":"second"}',
    ].join("\n");
    expect(parseOpenCodeOutput(text).summary).toBe("second");
  });

  it("ignores a line that is not JSON", () => {
    const text = ['plain progress line', '{"type":"message","text":"done"}'].join("\n");
    expect(parseOpenCodeOutput(text).summary).toBe("done");
  });

  it("returns a null session identifier when no event carries one", () => {
    expect(parseOpenCodeOutput('{"type":"message","text":"done"}').sessionId).toBeNull();
  });

  it("falls back to the last non-empty line when no message event exists", () => {
    expect(parseOpenCodeOutput("first line\nlast line\n").summary).toBe("last line");
  });

  it("returns an empty summary for empty output", () => {
    expect(parseOpenCodeOutput("")).toEqual({ sessionId: null, summary: "" });
  });
});
```

- [ ] **Step 2: Write the parser**

```ts
// src/adapters/runners/opencode/output-parser.ts

export interface OpenCodeOutput {
  sessionId: string | null;
  summary: string;
}

interface OpenCodeEvent {
  type?: unknown;
  text?: unknown;
  session?: { id?: unknown };
}

/**
 * Reads the newline-delimited JSON event stream of the `opencode` CLI. The CLI also writes plain
 * progress lines, so a line that is not JSON is skipped instead of failing the Run.
 */
export const parseOpenCodeOutput = (text: string): OpenCodeOutput => {
  let sessionId: string | null = null;
  let summary = "";
  let lastPlainLine = "";

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: OpenCodeEvent;
    try {
      event = JSON.parse(trimmed) as OpenCodeEvent;
    } catch {
      lastPlainLine = trimmed;
      continue;
    }
    const id = event.session?.id;
    if (sessionId === null && typeof id === "string" && id.length > 0) sessionId = id;
    if (event.type === "message" && typeof event.text === "string") summary = event.text;
  }

  return { sessionId, summary: summary.length > 0 ? summary : lastPlainLine };
};
```

- [ ] **Step 3: Run the parser test**

Run: `npm test -- tests/unit/opencode-output-parser.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing runner test**

```ts
// tests/unit/opencode-runner.test.ts
import { describe, expect, it } from "vitest";
import { OpenCodeRunner } from "~/adapters/runners/opencode/opencode-runner.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { Redactor } from "~/telemetry/redaction.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const runInput = (sandbox: FakeSandbox, ref: Awaited<ReturnType<FakeSandbox["create"]>>) => ({
  runId: "run-1",
  tenantId: "tenant-1",
  role: "implementer" as const,
  sandbox,
  ref,
  workingDirectory: "/workspace/primary",
  prompt: "Add a health endpoint.",
  promptVersion: "implementer/1",
  environment: { TEST_API_KEY: "super-secret-value" },
  actionPolicy: buildActionPolicy(),
  timeoutMs: 5_000,
});

describe("OpenCodeRunner", () => {
  it("is named opencode", () => {
    expect(new OpenCodeRunner({ redactor: new Redactor() }).name).toBe("opencode");
  });

  it("starts the opencode executable in the working directory", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await Promise.resolve();
    const command = sandbox.commands.at(-1);
    expect(command?.file).toBe("opencode");
    expect(command?.cwd).toBe("/workspace/primary");
    sandbox.finishProcess("process-2", { stdout: '{"type":"session.start","session":{"id":"ses_1"}}' });
    await started;
  });

  it("passes the prompt through the environment, not through the command line", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await Promise.resolve();
    const command = sandbox.commands.at(-1);
    expect(command?.args.join(" ")).not.toContain("Add a health endpoint.");
    expect(command?.env?.FACTOREE_PROMPT).toBe("Add a health endpoint.");
    sandbox.finishProcess("process-2", { stdout: "" });
    await started;
  });

  it("returns the session reference and the summary when the process exits zero", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await Promise.resolve();
    sandbox.finishProcess("process-2", {
      exitCode: 0,
      stdout: ['{"type":"session.start","session":{"id":"ses_1"}}', '{"type":"message","text":"done"}'].join("\n"),
    });
    const result = await started;
    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
    expect(result.session.sessionId).toBe("ses_1");
    expect(result.session.processId).toBe("process-2");
    expect(result.session.runner).toBe("opencode");
  });

  it("reports completed false when the process exits non-zero", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await Promise.resolve();
    sandbox.finishProcess("process-2", { exitCode: 1, stdout: '{"type":"message","text":"failed"}' });
    const result = await started;
    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("redacts a Project secret from the summary (SDD section 60)", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const redactor = new Redactor(["super-secret-value"]);
    const runner = new OpenCodeRunner({ redactor, pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await Promise.resolve();
    sandbox.finishProcess("process-2", {
      exitCode: 0,
      stdout: '{"type":"message","text":"I printed super-secret-value"}',
    });
    const result = await started;
    expect(result.summary).not.toContain("super-secret-value");
    expect(result.summary).toContain("[REDACTED]");
  });

  it("cancels the sandbox process for a session", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const started = runner.run(runInput(sandbox, ref));
    await Promise.resolve();
    await runner.cancel({ sessionId: "ses_1", processId: "process-2", runner: "opencode" });
    const result = await started;
    expect(sandbox.calls).toContain("cancelProcess");
    expect(result.cancelled).toBe(true);
  });

  it("resumes a session with the opencode session flag", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const first = runner.run(runInput(sandbox, ref));
    await Promise.resolve();
    sandbox.finishProcess("process-2", { exitCode: 0, stdout: '{"type":"session.start","session":{"id":"ses_1"}}' });
    const initial = await first;

    const resumed = runner.resume(initial.session, { prompt: "Fix the lint failure.", timeoutMs: 5_000 });
    await Promise.resolve();
    const command = sandbox.commands.at(-1);
    expect(command?.args).toContain("--session");
    expect(command?.args).toContain("ses_1");
    sandbox.finishProcess("process-3", { exitCode: 0, stdout: '{"type":"message","text":"fixed"}' });
    expect((await resumed).summary).toBe("fixed");
  });

  it("cancels the process and reports a timeout when the process outlives its budget", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    const runner = new OpenCodeRunner({ redactor: new Redactor(), pollIntervalMs: 1 });
    const result = await runner.run({ ...runInput(sandbox, ref), timeoutMs: 5 });
    expect(result.completed).toBe(false);
    expect(sandbox.calls).toContain("cancelProcess");
  });
});
```

- [ ] **Step 5: Write the runner**

```ts
// src/adapters/runners/opencode/opencode-runner.ts
import type {
  AgentResumeInput,
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  AgentSessionRef,
} from "~/domain/runs/agent-runner.js";
import type { ProcessRef, Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { parseOpenCodeOutput } from "./output-parser.js";

export interface OpenCodeRunnerOptions {
  /** The executable inside the sandbox. Bootstrap installs it. */
  executable?: string;
  redactor: Redactor;
  pollIntervalMs?: number;
}

interface LiveSession {
  sandbox: Sandbox;
  ref: SandboxRef;
  process: ProcessRef;
  workingDirectory: string;
  environment: Record<string, string>;
  cancelled: boolean;
}

/**
 * SDD section 33. Drives the `opencode` CLI inside a sandbox.
 *
 * The prompt travels in the process environment, never on the command line, so it never reaches
 * a process listing. The runner never receives a Linear token or a GitHub write credential; the
 * Implementer input assembler rejects those before the runner is called (SDD section 30).
 */
export class OpenCodeRunner implements AgentRunner {
  readonly name = "opencode";
  private readonly executable: string;
  private readonly pollIntervalMs: number;
  private readonly sessions = new Map<string, LiveSession>();

  constructor(private readonly options: OpenCodeRunnerOptions) {
    this.executable = options.executable ?? "opencode";
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const process = await input.sandbox.startProcess(input.ref, {
      file: this.executable,
      args: ["run", "--print-logs", "--format", "json"],
      cwd: input.workingDirectory,
      env: { ...input.environment, FACTOREE_PROMPT: input.prompt },
    });

    const live: LiveSession = {
      sandbox: input.sandbox,
      ref: input.ref,
      process,
      workingDirectory: input.workingDirectory,
      environment: input.environment,
      cancelled: false,
    };
    this.sessions.set(process.id, live);

    return await this.await(live, input.timeoutMs);
  }

  async resume(session: AgentSessionRef, input: AgentResumeInput): Promise<AgentRunResult> {
    const previous = this.sessions.get(session.processId);
    if (previous === undefined) {
      throw new Error(`OpenCodeRunner has no live sandbox for session ${session.sessionId}.`);
    }

    const process = await previous.sandbox.startProcess(previous.ref, {
      file: this.executable,
      args: ["run", "--print-logs", "--format", "json", "--session", session.sessionId],
      cwd: previous.workingDirectory,
      env: { ...previous.environment, FACTOREE_PROMPT: input.prompt },
    });

    const live: LiveSession = { ...previous, process, cancelled: false };
    this.sessions.set(process.id, live);
    return await this.await(live, input.timeoutMs);
  }

  async cancel(session: AgentSessionRef): Promise<void> {
    const live = this.sessions.get(session.processId);
    if (live === undefined) return;
    live.cancelled = true;
    await live.sandbox.cancelProcess(live.ref, live.process);
  }

  /** Polls the sandbox process until it exits, its budget ends, or Factoree cancels it. */
  private async await(live: LiveSession, timeoutMs: number): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;

    for (;;) {
      const snapshot = await live.sandbox.readProcess(live.ref, live.process);

      if (!snapshot.running) {
        const parsed = parseOpenCodeOutput(`${snapshot.stdout}\n${snapshot.stderr}`);
        const exitCode = snapshot.exitCode ?? 1;
        return {
          session: {
            sessionId: parsed.sessionId ?? live.process.id,
            processId: live.process.id,
            runner: this.name,
          },
          completed: exitCode === 0 && !live.cancelled,
          exitCode,
          summary: this.options.redactor.redact(parsed.summary),
          durationMs: Date.now() - startedAt,
          cancelled: live.cancelled,
        };
      }

      if (Date.now() >= deadline) {
        // SDD section 50: on timeout, cancel the active process and preserve the evidence.
        await live.sandbox.cancelProcess(live.ref, live.process);
        const final = await live.sandbox.readProcess(live.ref, live.process);
        const parsed = parseOpenCodeOutput(`${final.stdout}\n${final.stderr}`);
        return {
          session: {
            sessionId: parsed.sessionId ?? live.process.id,
            processId: live.process.id,
            runner: this.name,
          },
          completed: false,
          exitCode: final.exitCode ?? 124,
          summary: this.options.redactor.redact(parsed.summary),
          durationMs: Date.now() - startedAt,
          cancelled: true,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }
}
```

- [ ] **Step 6: Run the runner test**

Run: `npm test -- tests/unit/opencode-runner.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the stub executable and the integration test**

```sh
#!/bin/sh
# tests/fixtures/bin/opencode-stub.sh
# A deterministic stand-in for the `opencode` CLI. It proves the runner contract without a model.
# It reads the prompt from FACTOREE_PROMPT and writes the same JSON event stream the CLI writes.
set -e
printf '{"type":"session.start","session":{"id":"ses_stub_1"}}\n'
if [ -n "${FACTOREE_STUB_SLEEP:-}" ]; then
  sleep "$FACTOREE_STUB_SLEEP"
fi
if [ -n "${FACTOREE_STUB_TARGET:-}" ]; then
  printf '%s\n' "$FACTOREE_PROMPT" > "$FACTOREE_STUB_TARGET"
fi
if [ -n "${FACTOREE_STUB_PRINT_SECRET:-}" ]; then
  printf '{"type":"message","text":"I printed %s"}\n' "$FACTOREE_STUB_PRINT_SECRET"
else
  printf '{"type":"message","text":"The change is applied."}\n'
fi
exit "${FACTOREE_STUB_EXIT:-0}"
```

Make it executable: `chmod +x tests/fixtures/bin/opencode-stub.sh`.

```ts
// tests/integration/opencode-runner-local.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { OpenCodeRunner } from "~/adapters/runners/opencode/opencode-runner.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { Redactor } from "~/telemetry/redaction.js";

const stub = resolve("tests/fixtures/bin/opencode-stub.sh");

describe("OpenCodeRunner against a real sandbox process", () => {
  let root: string;
  let sandbox: LocalProcessSandbox;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-runner-"));
    sandbox = new LocalProcessSandbox({ rootDirectory: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const input = async (extraEnv: Record<string, string>) => {
    const ref = await sandbox.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    return {
      ref,
      run: {
        runId: "run-1",
        tenantId: "t",
        role: "implementer" as const,
        sandbox,
        ref,
        workingDirectory: ref.workspacePath,
        prompt: "Write this line into the target file.",
        promptVersion: "implementer/1",
        environment: extraEnv,
        actionPolicy: buildActionPolicy(),
        timeoutMs: 20_000,
      },
    };
  };

  it("runs the agent, which changes a file in the worktree", async () => {
    const { ref, run } = await input({ FACTOREE_STUB_TARGET: "out.txt" });
    const runner = new OpenCodeRunner({ executable: stub, redactor: new Redactor(), pollIntervalMs: 20 });
    const result = await runner.run(run);
    expect(result.completed).toBe(true);
    expect(result.session.sessionId).toBe("ses_stub_1");
    expect(result.summary).toBe("The change is applied.");
    const written = await readFile(join(ref.workspacePath, "out.txt"), "utf8");
    expect(written.trim()).toBe("Write this line into the target file.");
  });

  it("redacts a Project secret the agent printed", async () => {
    const { run } = await input({ FACTOREE_STUB_PRINT_SECRET: "value-from-the-secret-store" });
    const runner = new OpenCodeRunner({
      executable: stub,
      redactor: new Redactor(["value-from-the-secret-store"]),
      pollIntervalMs: 20,
    });
    const result = await runner.run(run);
    expect(result.summary).not.toContain("value-from-the-secret-store");
  });

  it("cancels a running agent process", async () => {
    const { run } = await input({ FACTOREE_STUB_SLEEP: "30" });
    const runner = new OpenCodeRunner({ executable: stub, redactor: new Redactor(), pollIntervalMs: 20 });
    const started = runner.run(run);
    await new Promise((done) => setTimeout(done, 300));
    await runner.cancel({ sessionId: "ses_stub_1", processId: processIdOf(runner), runner: "opencode" });
    const result = await started;
    expect(result.cancelled).toBe(true);
    expect(result.completed).toBe(false);
  });

  it("stops the agent when it outlives its budget", async () => {
    const { run } = await input({ FACTOREE_STUB_SLEEP: "30" });
    const runner = new OpenCodeRunner({ executable: stub, redactor: new Redactor(), pollIntervalMs: 20 });
    const result = await runner.run({ ...run, timeoutMs: 500 });
    expect(result.completed).toBe(false);
    expect(result.cancelled).toBe(true);
  });
});

/**
 * The runner keeps one live session per sandbox process. The test needs the process identifier
 * before the run resolves, so it reads the single live entry.
 */
const processIdOf = (runner: OpenCodeRunner): string => {
  const sessions = (runner as unknown as { sessions: Map<string, unknown> }).sessions;
  const first = [...sessions.keys()][0];
  if (first === undefined) throw new Error("the runner started no session");
  return first;
};
```

- [ ] **Step 8: Run the integration test**

Run: `npm run test:integration -- tests/integration/opencode-runner-local.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/adapters/runners/opencode tests/fixtures/bin tests/unit/opencode-runner.test.ts tests/unit/opencode-output-parser.test.ts tests/integration/opencode-runner-local.test.ts
git commit -m "feat(runners): add OpenCodeRunner with process control and cancellation (SDD section 33)"
```

---

### Task 10: Project secret redaction and AgentExecution persistence

**Files:**
- Modify: `src/telemetry/redaction.ts`
- Create: `src/domain/projects/redaction-loader.ts`
- Create: `src/domain/runs/agent-execution.ts`
- Create: `src/persistence/prisma/agent-execution.prisma.ts`
- Test: `tests/unit/redaction-loader.test.ts`
- Test: `tests/unit/at-32-redaction.test.ts` (extend the existing file)
- Test: `tests/integration/agent-execution.test.ts`

**Interfaces:**
- Consumes: `SecretStore` of `src/domain/projects/secret-store.ts`; `Redactor` of `src/telemetry/redaction.ts`; `createPrismaClient` of `src/persistence/prisma/client.ts`.
- Produces: `registerProjectSecrets(redactor, secrets, tenantId, projectId): Promise<number>`, `AgentExecutionRepository`, `RecordAgentExecutionInput`, `PrismaAgentExecutionRepository`.

This task closes the carried Phase 1 finding: nothing wired `SecretStore` values into `Redactor.addSecret`. It must land before any agent output is captured in a real Run.

- [ ] **Step 1: Lower the redaction length floor and write the failing test**

The current `Redactor.addSecret` ignores a value under six characters. A short Project secret would then leak. Change the floor to four characters and record the reason in a comment.

```ts
// tests/unit/redaction-loader.test.ts
import { describe, expect, it } from "vitest";
import { registerProjectSecrets } from "~/domain/projects/redaction-loader.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";

const store = (values: Record<string, string>): SecretStore => ({
  put: () => Promise.resolve(),
  get: (_t, _p, name) => Promise.resolve(values[name] ?? null),
  listNames: () => Promise.resolve(Object.keys(values)),
  remove: () => Promise.resolve(true),
});

describe("registerProjectSecrets", () => {
  it("adds every Project secret value to the redactor", async () => {
    const redactor = new Redactor();
    const count = await registerProjectSecrets(redactor, store({ A: "alpha-secret", B: "beta-secret" }), "t", "p");
    expect(count).toBe(2);
    expect(redactor.redact("alpha-secret and beta-secret")).toBe("[REDACTED] and [REDACTED]");
  });

  it("skips a name whose value is missing", async () => {
    const redactor = new Redactor();
    const missing: SecretStore = { ...store({}), listNames: () => Promise.resolve(["A"]) };
    expect(await registerProjectSecrets(redactor, missing, "t", "p")).toBe(0);
  });

  it("registers a short secret, because a short secret still leaks", async () => {
    const redactor = new Redactor();
    await registerProjectSecrets(redactor, store({ A: "pw12" }), "t", "p");
    expect(redactor.redact("the value is pw12")).toBe("the value is [REDACTED]");
  });

  it("never returns the secret values to the caller", async () => {
    const redactor = new Redactor();
    const result = await registerProjectSecrets(redactor, store({ A: "alpha-secret" }), "t", "p");
    expect(typeof result).toBe("number");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/redaction-loader.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Change the redaction floor**

In `src/telemetry/redaction.ts`, replace the body of `addSecret`:

```ts
  addSecret(value: string): void {
    // Four characters is the floor. A shorter value would redact ordinary words out of every
    // log line. A Project secret shorter than four characters is a configuration fault, not a
    // redaction fault.
    if (value.length >= 4) this.secrets.add(value);
  }
```

Add a test to `tests/unit/redaction.test.ts`:

```ts
  it("registers a four character secret and ignores a three character value", () => {
    const redactor = new Redactor(["pw12", "abc"]);
    expect(redactor.redact("pw12")).toBe("[REDACTED]");
    expect(redactor.redact("abc")).toBe("abc");
  });
```

- [ ] **Step 4: Write the loader**

```ts
// src/domain/projects/redaction-loader.ts
import type { Redactor } from "~/telemetry/redaction.js";
import type { SecretStore } from "./secret-store.js";

/**
 * SDD section 60. Loads every Project secret value into the redactor before any agent output is
 * captured. Phase 1 registered only the three environment secrets, which left every Project
 * secret unredacted. Returns the count of registered values and never returns a value.
 */
export const registerProjectSecrets = async (
  redactor: Redactor,
  secrets: SecretStore,
  tenantId: string,
  projectId: string,
): Promise<number> => {
  const names = await secrets.listNames(tenantId, projectId);
  let registered = 0;
  for (const name of names) {
    const value = await secrets.get(tenantId, projectId, name);
    if (value === null || value.length === 0) continue;
    redactor.addSecret(value);
    registered += 1;
  }
  return registered;
};
```

- [ ] **Step 5: Extend the AT-32 test**

Add to `tests/unit/at-32-redaction.test.ts`:

```ts
import { registerProjectSecrets } from "~/domain/projects/redaction-loader.js";

  it("AT-32: a Project secret loaded from the SecretStore never reaches a log line", async () => {
    const redactor = new Redactor();
    const store: SecretStore = {
      put: () => Promise.resolve(),
      get: () => Promise.resolve("fixture-secret-value"),
      listNames: () => Promise.resolve(["FIXTURE"]),
      remove: () => Promise.resolve(true),
    };
    await registerProjectSecrets(redactor, store, "tenant-1", "project-1");
    const lines: string[] = [];
    const logger = createLogger({ level: "info", redactor, sink: (line) => lines.push(line) });
    logger.info("the agent printed fixture-secret-value");
    expect(lines.join("\n")).not.toContain("fixture-secret-value");
  });
```

(Reuse the existing imports and the existing `createLogger` call shape in that file. Read the file before you edit it and match its helpers.)

- [ ] **Step 6: Write the AgentExecution repository port and the Prisma implementation**

```ts
// src/domain/runs/agent-execution.ts
import type { AgentRole } from "./agent-runner.js";

export interface RecordAgentExecutionInput {
  tenantId: string;
  runId: string;
  role: AgentRole;
  runner: string;
  model: string | null;
  sessionRef: string | null;
  promptVersion: string;
  durationMs: number;
  /**
   * A small, redacted result record. SDD section 61 forbids persisting the full transcript by
   * default, so this carries the outcome and the redacted summary only.
   */
  finalResult: { completed: boolean; exitCode: number; cancelled: boolean; summary: string };
}

export interface AgentExecutionRecord extends RecordAgentExecutionInput {
  id: string;
  createdAt: Date;
}

export interface AgentExecutionRepository {
  record(input: RecordAgentExecutionInput): Promise<AgentExecutionRecord>;
  listForRun(tenantId: string, runId: string): Promise<AgentExecutionRecord[]>;
}
```

```ts
// src/persistence/prisma/agent-execution.prisma.ts
import type { PrismaClient } from "@prisma/client";
import type {
  AgentExecutionRecord,
  AgentExecutionRepository,
  RecordAgentExecutionInput,
} from "~/domain/runs/agent-execution.js";
import type { AgentRole } from "~/domain/runs/agent-runner.js";

export class PrismaAgentExecutionRepository implements AgentExecutionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async record(input: RecordAgentExecutionInput): Promise<AgentExecutionRecord> {
    const row = await this.prisma.agentExecution.create({
      data: {
        tenantId: input.tenantId,
        runId: input.runId,
        role: input.role,
        runner: input.runner,
        model: input.model,
        sessionRef: input.sessionRef,
        promptVersion: input.promptVersion,
        durationMs: input.durationMs,
        finalResult: input.finalResult,
      },
    });
    return toRecord(row);
  }

  async listForRun(tenantId: string, runId: string): Promise<AgentExecutionRecord[]> {
    // The tenant filter is part of the query, not the caller's responsibility (SDD section 52).
    const rows = await this.prisma.agentExecution.findMany({
      where: { tenantId, runId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toRecord);
  }
}

interface Row {
  id: string;
  tenantId: string;
  runId: string;
  role: string;
  runner: string;
  model: string | null;
  sessionRef: string | null;
  promptVersion: string | null;
  durationMs: number | null;
  finalResult: unknown;
  createdAt: Date;
}

const toRecord = (row: Row): AgentExecutionRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  runId: row.runId,
  role: row.role as AgentRole,
  runner: row.runner,
  model: row.model,
  sessionRef: row.sessionRef,
  promptVersion: row.promptVersion ?? "",
  durationMs: row.durationMs ?? 0,
  finalResult: row.finalResult as RecordAgentExecutionInput["finalResult"],
  createdAt: row.createdAt,
});
```

- [ ] **Step 7: Write the integration test**

```ts
// tests/integration/agent-execution.test.ts
import { describe, expect, it } from "vitest";
import { PrismaAgentExecutionRepository } from "~/persistence/prisma/agent-execution.prisma.js";
import { withDatabase, seedTenantProjectAndRun } from "./support/database.js";

describe("PrismaAgentExecutionRepository", () => {
  it("records an execution and reads it back for the Run", async () => {
    await withDatabase(async (prisma) => {
      const { tenantId, runId } = await seedTenantProjectAndRun(prisma);
      const repository = new PrismaAgentExecutionRepository(prisma);
      await repository.record({
        tenantId,
        runId,
        role: "implementer",
        runner: "opencode",
        model: null,
        sessionRef: "ses_1",
        promptVersion: "implementer/1",
        durationMs: 1_234,
        finalResult: { completed: true, exitCode: 0, cancelled: false, summary: "The change is applied." },
      });
      const rows = await repository.listForRun(tenantId, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.runner).toBe("opencode");
      expect(rows[0]?.finalResult.completed).toBe(true);
    });
  });

  it("does not return an execution that belongs to another tenant (SDD section 52)", async () => {
    await withDatabase(async (prisma) => {
      const first = await seedTenantProjectAndRun(prisma);
      const second = await seedTenantProjectAndRun(prisma);
      const repository = new PrismaAgentExecutionRepository(prisma);
      await repository.record({
        tenantId: first.tenantId,
        runId: first.runId,
        role: "implementer",
        runner: "opencode",
        model: null,
        sessionRef: null,
        promptVersion: "implementer/1",
        durationMs: 1,
        finalResult: { completed: true, exitCode: 0, cancelled: false, summary: "" },
      });
      expect(await repository.listForRun(second.tenantId, first.runId)).toHaveLength(0);
    });
  });
});
```

`withDatabase` and `seedTenantProjectAndRun` come from `tests/integration/support/database.ts`. Read that file first. If `seedTenantProjectAndRun` does not exist, add it there and reuse the existing seeding helpers rather than writing a second seeding path.

- [ ] **Step 8: Run the tests**

Run: `npm test && npm run test:integration -- tests/integration/agent-execution.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/telemetry/redaction.ts src/domain/projects/redaction-loader.ts src/domain/runs/agent-execution.ts src/persistence/prisma/agent-execution.prisma.ts tests
git commit -m "feat(security): register Project secrets with the redactor and persist AgentExecution (SDD sections 60 and 61)"
```

---

### Task 11: Workflow integration, cancellation, retention, and metrics

**Files:**
- Modify: `prisma/schema.prisma` (add `spriteRetainUntil` to `Run`)
- Create: `prisma/migrations/<timestamp>_phase_02_sandbox/migration.sql`
- Create: `src/domain/runs/sprite-reaper.ts`
- Create: `src/activities/sandbox.activities.ts`
- Create: `src/activities/agent.activities.ts`
- Modify: `src/activities/index.ts`
- Modify: `src/activities/run.activities.ts`
- Modify: `src/domain/runs/run-repository.ts`
- Modify: `src/persistence/prisma/run-repository.prisma.ts`
- Modify: `src/workflows/agent-run.workflow.ts`
- Modify: `src/telemetry/metrics.ts`
- Modify: `src/bin/worker.ts`
- Create: `tests/support/fake-runner.ts`
- Test: `tests/unit/sprite-reaper.test.ts`
- Test: `tests/workflow/agent-run.workflow.test.ts` (extend)

**Interfaces:**
- Consumes: `SandboxManager`, `PreparedSandbox` of Task 7; `AgentRunnerRegistry`, `AgentRunResult` of Task 8; `AgentExecutionRepository` of Task 10; `registerProjectSecrets` of Task 10.
- Produces: `prepareSandbox`, `destroySandbox`, `implement`, `cancelImplementer` activities; `SpriteReaper`; `RunRepository.setSandbox`, `RunRepository.clearSandbox`, `RunRepository.listExpiredSandboxes`.

- [ ] **Step 1: Add the retention column**

In `prisma/schema.prisma`, add to `model Run`:

```prisma
  spriteRetainUntil        DateTime?
  spriteAdapter            String?
```

and add the index:

```prisma
  @@index([spriteRetainUntil])
```

Generate the migration:

```bash
DATABASE_URL=postgresql://placeholder npx prisma migrate dev --create-only --name phase_02_sandbox
```

Read the generated SQL and confirm it only adds two nullable columns and one index.

- [ ] **Step 2: Extend the run repository port and its Prisma implementation**

Add to `RunRepository` in `src/domain/runs/run-repository.ts`:

```ts
  setSandbox(
    tenantId: string,
    runId: string,
    sandbox: { spriteId: string; adapter: string; retainUntil: Date; baseSha: string; implementerRunner: string },
  ): Promise<void>;

  clearSandbox(tenantId: string, runId: string): Promise<void>;

  /** Runs whose sandbox retention window has passed and whose sandbox still exists. */
  listExpiredSandboxes(now: Date, limit: number): Promise<Array<{
    tenantId: string;
    runId: string;
    spriteId: string;
    adapter: string;
  }>>;
```

Implement them in `src/persistence/prisma/run-repository.prisma.ts` with the same idiom the existing methods use. `listExpiredSandboxes` must filter `spriteId: { not: null }` and `spriteRetainUntil: { lte: now }`, order by `spriteRetainUntil` ascending, and take `limit`.

- [ ] **Step 3: Write the reaper test**

```ts
// tests/unit/sprite-reaper.test.ts
import { describe, expect, it, vi } from "vitest";
import { SpriteReaper } from "~/domain/runs/sprite-reaper.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const runs = (entries: Array<{ tenantId: string; runId: string; spriteId: string; adapter: string }>) => ({
  listExpiredSandboxes: vi.fn().mockResolvedValue(entries),
  clearSandbox: vi.fn().mockResolvedValue(undefined),
});

describe("SpriteReaper", () => {
  it("destroys every sandbox past its retention window", async () => {
    const sandbox = new FakeSandbox();
    const repository = runs([
      { tenantId: "t", runId: "r1", spriteId: "sprite-1", adapter: "fake" },
      { tenantId: "t", runId: "r2", spriteId: "sprite-2", adapter: "fake" },
    ]);
    const reaper = new SpriteReaper({ sandboxes: { fake: sandbox }, runs: repository });
    expect(await reaper.reap(new Date("2026-01-01T00:00:00Z"))).toBe(2);
    expect(sandbox.destroyed).toEqual(["sprite-1", "sprite-2"]);
  });

  it("clears the sandbox reference on the Run, so the Proof Pack stays readable (AT-34)", async () => {
    const sandbox = new FakeSandbox();
    const repository = runs([{ tenantId: "t", runId: "r1", spriteId: "sprite-1", adapter: "fake" }]);
    const reaper = new SpriteReaper({ sandboxes: { fake: sandbox }, runs: repository });
    await reaper.reap(new Date());
    expect(repository.clearSandbox).toHaveBeenCalledWith("t", "r1");
  });

  it("skips a Run whose adapter is not registered and does not clear it", async () => {
    const sandbox = new FakeSandbox();
    const repository = runs([{ tenantId: "t", runId: "r1", spriteId: "sprite-1", adapter: "unknown" }]);
    const reaper = new SpriteReaper({ sandboxes: { fake: sandbox }, runs: repository });
    expect(await reaper.reap(new Date())).toBe(0);
    expect(repository.clearSandbox).not.toHaveBeenCalled();
  });

  it("continues after one destroy fails", async () => {
    const sandbox = new FakeSandbox();
    vi.spyOn(sandbox, "destroy").mockRejectedValueOnce(new Error("api down"));
    const repository = runs([
      { tenantId: "t", runId: "r1", spriteId: "sprite-1", adapter: "fake" },
      { tenantId: "t", runId: "r2", spriteId: "sprite-2", adapter: "fake" },
    ]);
    const reaper = new SpriteReaper({ sandboxes: { fake: sandbox }, runs: repository });
    expect(await reaper.reap(new Date())).toBe(1);
  });
});
```

- [ ] **Step 4: Write the reaper**

```ts
// src/domain/runs/sprite-reaper.ts
import type { Sandbox } from "./sandbox.js";

export interface ExpiredSandbox {
  tenantId: string;
  runId: string;
  spriteId: string;
  adapter: string;
}

export interface SpriteReaperRuns {
  listExpiredSandboxes(now: Date, limit: number): Promise<ExpiredSandbox[]>;
  clearSandbox(tenantId: string, runId: string): Promise<void>;
}

export interface SpriteReaperOptions {
  sandboxes: Record<string, Sandbox>;
  runs: SpriteReaperRuns;
  batchSize?: number;
}

/**
 * SDD section 51. Deletes a sandbox once its retention window has passed. The Proof Pack and the
 * evidence metadata stay in PostgreSQL, so deleting the sandbox does not remove them (AT-34).
 */
export class SpriteReaper {
  constructor(private readonly options: SpriteReaperOptions) {}

  async reap(now: Date): Promise<number> {
    const expired = await this.options.runs.listExpiredSandboxes(now, this.options.batchSize ?? 50);
    let destroyed = 0;
    for (const entry of expired) {
      const sandbox = this.options.sandboxes[entry.adapter];
      // An unknown adapter is left alone. Clearing it would lose the only reference to the sandbox.
      if (sandbox === undefined) continue;
      try {
        await sandbox.destroy({ id: entry.spriteId, adapter: entry.adapter, workspacePath: "/workspace" });
      } catch {
        // One provider fault must not stop the batch. The next pass retries this entry.
        continue;
      }
      await this.options.runs.clearSandbox(entry.tenantId, entry.runId);
      destroyed += 1;
    }
    return destroyed;
  }
}
```

- [ ] **Step 5: Add the Phase 2 metrics**

Add to the `metrics` object in `src/telemetry/metrics.ts`:

```ts
  implementationDuration: new Histogram({
    name: "factoree_implementation_duration_seconds",
    help: "Implementer duration in seconds",
    labelNames: [...labelNames, "runner"],
    buckets: [10, 30, 60, 300, 900, 1800, 3600],
    registers: [registry],
  }),
  sandboxesCreated: new Counter({
    name: "factoree_sandboxes_created_total",
    help: "Sandboxes created",
    labelNames: [...labelNames, "adapter"],
    registers: [registry],
  }),
  sandboxesDestroyed: new Counter({
    name: "factoree_sandboxes_destroyed_total",
    help: "Sandboxes destroyed",
    labelNames: ["adapter", "reason"],
    registers: [registry],
  }),
```

- [ ] **Step 6: Write the sandbox and agent activities**

```ts
// src/activities/sandbox.activities.ts
import type { Logger } from "~/telemetry/logger.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import type { SpriteReaper } from "~/domain/runs/sprite-reaper.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import type { ProjectRuntimeConfig } from "~/domain/runs/project-runtime-config.js";
import type { RepositorySpec } from "~/domain/runs/checkout.js";
import { metrics } from "~/telemetry/metrics.js";

export interface SandboxActivityDependencies {
  sandboxManager: SandboxManager;
  sandbox: Sandbox;
  runs: RunRepository;
  reaper: SpriteReaper;
  logger: Logger;
}

export interface PrepareSandboxActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  primary: RepositorySpec;
  references: RepositorySpec[];
  config: ProjectRuntimeConfig;
  environment: Record<string, string>;
}

export interface PrepareSandboxActivityOutput {
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  baseSha: string;
  referencePaths: string[];
  baselineCheckpointId: string | null;
}

export const createSandboxActivities = (dependencies: SandboxActivityDependencies) => ({
  async prepareSandbox(input: PrepareSandboxActivityInput): Promise<PrepareSandboxActivityOutput> {
    const prepared = await dependencies.sandboxManager.prepare({
      runId: input.runId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      primary: input.primary,
      references: input.references,
      config: input.config,
      environment: input.environment,
    });

    const retainUntil = new Date(Date.now() + input.config.spriteRetentionHours * 3_600_000);
    await dependencies.runs.setSandbox(input.tenantId, input.runId, {
      spriteId: prepared.ref.id,
      adapter: prepared.ref.adapter,
      retainUntil,
      baseSha: prepared.checkout.primary.baseSha,
      implementerRunner: input.config.implementerRunner,
    });

    metrics.sandboxesCreated.inc({
      tenant_id: input.tenantId,
      project_id: input.projectId,
      adapter: prepared.ref.adapter,
    });
    dependencies.logger.info("sandbox prepared", {
      tenant_id: input.tenantId,
      project_id: input.projectId,
      run_id: input.runId,
      sprite_id: prepared.ref.id,
      base_sha: prepared.checkout.primary.baseSha,
      step: "prepare",
    });

    return {
      spriteId: prepared.ref.id,
      adapter: prepared.ref.adapter,
      workspacePath: prepared.ref.workspacePath,
      primaryPath: prepared.checkout.primary.path,
      baseSha: prepared.checkout.primary.baseSha,
      referencePaths: prepared.checkout.references.map((entry) => entry.path),
      baselineCheckpointId: prepared.baselineCheckpoint?.id ?? null,
    };
  },

  async destroySandbox(input: {
    tenantId: string;
    runId: string;
    spriteId: string;
    adapter: string;
    workspacePath: string;
    reason: string;
  }): Promise<void> {
    await dependencies.sandbox.destroy({
      id: input.spriteId,
      adapter: input.adapter,
      workspacePath: input.workspacePath,
    });
    await dependencies.runs.clearSandbox(input.tenantId, input.runId);
    metrics.sandboxesDestroyed.inc({ adapter: input.adapter, reason: input.reason });
  },

  async reapExpiredSandboxes(): Promise<number> {
    return await dependencies.reaper.reap(new Date());
  },
});
```

```ts
// src/activities/agent.activities.ts
import type { Logger } from "~/telemetry/logger.js";
import type { AgentExecutionRepository } from "~/domain/runs/agent-execution.js";
import type { AgentRunnerRegistry, AgentSessionRef } from "~/domain/runs/agent-runner.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import { registerProjectSecrets } from "~/domain/projects/redaction-loader.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { buildImplementerInput } from "~/domain/runs/implementer-input.js";
import { metrics } from "~/telemetry/metrics.js";
import type { Redactor } from "~/telemetry/redaction.js";

export interface AgentActivityDependencies {
  runners: AgentRunnerRegistry;
  sandbox: Sandbox;
  executions: AgentExecutionRepository;
  secrets: SecretStore;
  redactor: Redactor;
  logger: Logger;
}

export interface ImplementActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  runnerName: string;
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  referencePaths: string[];
  goal: string;
  humanDecisions: string[];
  repositoryInstructions: string;
  repairFindings: string[];
  stagingRead: boolean;
  timeoutMs: number;
}

export interface ImplementActivityOutput {
  sessionId: string;
  processId: string;
  runner: string;
  completed: boolean;
  exitCode: number;
  cancelled: boolean;
  summary: string;
  durationMs: number;
}

export const createAgentActivities = (dependencies: AgentActivityDependencies) => ({
  async implement(input: ImplementActivityInput): Promise<ImplementActivityOutput> {
    // SDD section 60: every Project secret must reach the redactor before any output is captured.
    await registerProjectSecrets(dependencies.redactor, dependencies.secrets, input.tenantId, input.projectId);

    const names = await dependencies.secrets.listNames(input.tenantId, input.projectId);
    const projectTestSecrets: Record<string, string> = {};
    for (const name of names) {
      const value = await dependencies.secrets.get(input.tenantId, input.projectId, name);
      if (value !== null) projectTestSecrets[name] = value;
    }

    const actionPolicy = buildActionPolicy({ stagingRead: input.stagingRead });
    const implementerInput = buildImplementerInput({
      goal: input.goal,
      humanDecisions: input.humanDecisions,
      validationContract: null,
      contextContract: null,
      requiredContext: [],
      primaryRepositoryPath: input.primaryPath,
      referenceRepositoryPaths: input.referencePaths,
      repositoryInstructions: input.repositoryInstructions,
      skills: [],
      actionPolicy,
      repairFindings: input.repairFindings,
      projectTestSecrets,
    });

    const runner = dependencies.runners.get(input.runnerName);
    const result = await runner.run({
      runId: input.runId,
      tenantId: input.tenantId,
      role: "implementer",
      sandbox: dependencies.sandbox,
      ref: { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath },
      workingDirectory: input.primaryPath,
      prompt: implementerInput.prompt,
      promptVersion: implementerInput.promptVersion,
      environment: implementerInput.environment,
      actionPolicy,
      timeoutMs: input.timeoutMs,
    });

    await dependencies.executions.record({
      tenantId: input.tenantId,
      runId: input.runId,
      role: "implementer",
      runner: runner.name,
      model: null,
      sessionRef: result.session.sessionId,
      promptVersion: implementerInput.promptVersion,
      durationMs: result.durationMs,
      finalResult: {
        completed: result.completed,
        exitCode: result.exitCode,
        cancelled: result.cancelled,
        summary: result.summary,
      },
    });

    metrics.implementationDuration.observe(
      { tenant_id: input.tenantId, project_id: input.projectId, runner: runner.name },
      result.durationMs / 1000,
    );
    dependencies.logger.info("implementation finished", {
      tenant_id: input.tenantId,
      project_id: input.projectId,
      run_id: input.runId,
      runner: runner.name,
      completed: result.completed,
      step: "implement",
    });

    return {
      sessionId: result.session.sessionId,
      processId: result.session.processId,
      runner: runner.name,
      completed: result.completed,
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      summary: result.summary,
      durationMs: result.durationMs,
    };
  },

  async cancelImplementer(input: { runnerName: string; session: AgentSessionRef }): Promise<void> {
    // SDD section 50: a stop signal must cancel the active agent process.
    await dependencies.runners.get(input.runnerName).cancel(input.session);
  },
});
```

Register both factories in `src/activities/index.ts` beside the existing two, and extend `ActivityDependencies` with `sandboxManager`, `sandbox`, `runners`, `executions`, `secrets`, `redactor`, and `reaper`.

- [ ] **Step 7: Extend the workflow**

Change `agentRunWorkflow` in `src/workflows/agent-run.workflow.ts` so that after `acknowledgeSession` it runs the prepare and implement steps, then keeps the existing wait. The whole change:

```ts
export interface AgentRunWorkflowInput {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  linearIssueId: string | null;
  agentSessionId: string;
  autonomyLevel: string;
  maxRunMinutes: number;
  /** Phase 2. When this is absent the workflow keeps the Phase 1 behaviour. */
  sandbox?: {
    primary: { url: string; ref: string };
    references: Array<{ url: string; ref: string }>;
    config: ProjectRuntimeConfig;
    goal: string;
    repositoryInstructions: string;
  };
}
```

Inside the `try` block, after the acknowledgement and before the wait:

```ts
    if (input.sandbox !== undefined) {
      status = "PREPARING";
      await activities.setRunStatus({ runId, status, startedAt: new Date(Date.now()).toISOString() });

      const prepared = await sandboxActivities.prepareSandbox({
        runId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        primary: input.sandbox.primary,
        references: input.sandbox.references,
        config: input.sandbox.config,
        environment: {},
      });
      sprite = prepared;

      if (stopRequested) {
        // A stop that arrived during preparation must prevent the Implementer from starting.
        throw new StopRequested();
      }

      status = "IMPLEMENTING";
      await activities.setRunStatus({ runId, status });

      const implementation = await implementActivities.implement({
        runId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        runnerName: input.sandbox.config.implementerRunner,
        spriteId: prepared.spriteId,
        adapter: prepared.adapter,
        workspacePath: prepared.workspacePath,
        primaryPath: prepared.primaryPath,
        referencePaths: prepared.referencePaths,
        goal: input.sandbox.goal,
        humanDecisions: humanInputs,
        repositoryInstructions: input.sandbox.repositoryInstructions,
        repairFindings: [],
        stagingRead: input.sandbox.config.stagingRead,
        timeoutMs: input.maxRunMinutes * 60_000,
      });
      implementerSession = {
        sessionId: implementation.sessionId,
        processId: implementation.processId,
        runner: implementation.runner,
      };
    }
```

Declare `let sprite: PrepareSandboxActivityOutput | null = null;` and
`let implementerSession: AgentSessionRef | null = null;` beside the other locals, and extend the
query snapshot with `spriteId: sprite?.spriteId ?? null`.

Change the stop handler so the cancellation reaches the running agent:

```ts
  setHandler(stopSignal, () => {
    stopRequested = true;
  });
```

stays as it is, and a new detached cancellation runs when the workflow observes a stop while an
Implementer session is live. Add this immediately before the `CANCELLED` branch:

```ts
    if (implementerSession !== null) {
      // SDD section 50: the stop signal must terminate the active agent process before the
      // Run becomes terminal, and publication never happens.
      await notify(() =>
        implementActivities.cancelImplementer({
          runnerName: implementerSession.runner,
          session: implementerSession,
        }),
      );
    }
```

Add a `finally` block that destroys the sandbox when the Run reaches a terminal state, so no
sandbox leaks when a Run ends early:

```ts
  } finally {
    if (sprite !== null) {
      await notify(() =>
        sandboxActivities.destroySandbox({
          tenantId: input.tenantId,
          runId: runId ?? "",
          spriteId: sprite.spriteId,
          adapter: sprite.adapter,
          workspacePath: sprite.workspacePath,
          reason: status,
        }),
      );
    }
  }
```

Proxy the new activities with a longer timeout, because preparation and implementation take
minutes rather than seconds:

```ts
const sandboxActivities = proxyActivities<Activities>({
  startToCloseTimeout: "20 minutes",
  retry: { maximumAttempts: 3, initialInterval: "5 seconds", backoffCoefficient: 2 },
});

const implementActivities = proxyActivities<Activities>({
  startToCloseTimeout: "95 minutes",
  // SDD section 49: a semantic failure must not consume the infrastructure retry policy. The
  // Implementer reports a failed attempt as a result, so one attempt is correct here.
  retry: { maximumAttempts: 1 },
});
```

`StopRequested` is a small local error class the workflow catches and turns into the `CANCELLED`
branch.

- [ ] **Step 8: Write the fake runner and extend the workflow test**

```ts
// tests/support/fake-runner.ts
import type {
  AgentResumeInput,
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  AgentSessionRef,
} from "~/domain/runs/agent-runner.js";

/** An AgentRunner that records what it received and returns a scripted result. */
export class FakeRunner implements AgentRunner {
  readonly runs: AgentRunInput[] = [];
  readonly cancelled: AgentSessionRef[] = [];
  private result: AgentRunResult;

  constructor(
    readonly name = "opencode",
    result: Partial<AgentRunResult> = {},
  ) {
    this.result = {
      session: { sessionId: "ses_fake", processId: "process-fake", runner: name },
      completed: true,
      exitCode: 0,
      summary: "The change is applied.",
      durationMs: 10,
      cancelled: false,
      ...result,
    };
  }

  setResult(result: Partial<AgentRunResult>): void {
    this.result = { ...this.result, ...result };
  }

  run(input: AgentRunInput): Promise<AgentRunResult> {
    this.runs.push(input);
    return Promise.resolve(this.result);
  }

  resume(_session: AgentSessionRef, _input: AgentResumeInput): Promise<AgentRunResult> {
    return Promise.resolve(this.result);
  }

  cancel(session: AgentSessionRef): Promise<void> {
    this.cancelled.push(session);
    return Promise.resolve();
  }
}
```

Add these cases to `tests/workflow/agent-run.workflow.test.ts`, following the existing
`TestWorkflowEnvironment` setup in that file:

```ts
  it("moves through PREPARING and IMPLEMENTING when the input carries a sandbox", async () => {
    // Assert the recorded statuses from the setRunStatus activity mock.
    expect(recordedStatuses).toEqual(["RECEIVED", "PREPARING", "IMPLEMENTING"]);
  });

  it("destroys the sandbox when the Run reaches a terminal state", async () => {
    expect(destroyed).toHaveLength(1);
  });

  it("cancels the Implementer session when a stop signal arrives", async () => {
    expect(cancelledSessions).toHaveLength(1);
    expect(finalStatus).toBe("CANCELLED");
  });

  it("does not start the Implementer when the stop arrives during preparation", async () => {
    expect(implementCalls).toHaveLength(0);
    expect(finalStatus).toBe("CANCELLED");
  });
```

- [ ] **Step 9: Start the reaper in the worker**

In `src/bin/worker.ts`, after the worker is created and before `worker.run()`, start an interval
that calls the reap activity dependency directly and log the count. Clear the interval in the
existing shutdown path. Run it every fifteen minutes:

```ts
const REAP_INTERVAL_MS = 15 * 60_000;
const reapTimer = setInterval(() => {
  void reaper
    .reap(new Date())
    .then((count) => {
      if (count > 0) logger.info("sandboxes reaped", { count, step: "retention" });
    })
    .catch((error: unknown) => logger.error("the sandbox reaper failed", { error }));
}, REAP_INTERVAL_MS);
reapTimer.unref();
```

- [ ] **Step 10: Run the full verification**

Run: `npm run verify`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add prisma src/activities src/workflows src/domain/runs src/telemetry/metrics.ts src/bin/worker.ts tests
git commit -m "feat(workflow): add PREPARING and IMPLEMENTING with cancellation and retention (SDD sections 48 to 51)"
```

---

### Task 12: Phase 2 acceptance tests and evidence

**Files:**
- Create: `tests/acceptance/support/fixture-repository.ts`
- Create: `tests/acceptance/at-12-isolation.test.ts`
- Create: `tests/acceptance/at-13-action-policy.test.ts`
- Create: `tests/acceptance/phase-02-exit.test.ts`
- Modify: `vitest.integration.config.ts` (include `tests/acceptance`)
- Create: `docs/build/evidence/phase-02-verify.txt`

**Interfaces:**
- Consumes: everything from Task 1 to Task 11.
- Produces: `createFixtureRepository(root, name): Promise<string>`, `createFixtureReference(root, name): Promise<string>`.

- [ ] **Step 1: Write the fixture helper**

```ts
// tests/acceptance/support/fixture-repository.ts
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Creates a git repository on disk that a clone can reach through a plain path. The Phase 2
 * acceptance tests never reach the network, so the fixture is local.
 */
export const createFixtureRepository = async (root: string, name: string): Promise<string> => {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await run("git", ["init", "--initial-branch=main", path]);
  await writeFile(join(path, "target.txt"), "original\n", "utf8");
  await writeFile(join(path, "CONTRIBUTING.md"), "Keep the change small.\n", "utf8");
  await run("git", ["-C", path, "add", "."]);
  await run("git", [
    "-C", path, "-c", "user.email=fixture@factoree.test", "-c", "user.name=fixture",
    "commit", "-m", "initial",
  ]);
  return path;
};
```

- [ ] **Step 2: Write the AT-12 isolation test**

```ts
// tests/acceptance/at-12-isolation.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { OpenCodeRunner } from "~/adapters/runners/opencode/opencode-runner.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { DEFAULT_PROJECT_RUNTIME_CONFIG } from "~/domain/runs/project-runtime-config.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createFixtureRepository } from "./support/fixture-repository.js";

const stub = resolve("tests/fixtures/bin/opencode-stub.sh");

describe("AT-12 — isolation", () => {
  let root: string;
  let sandboxRoot: string;
  let repository: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-at12-repos-"));
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-at12-sandboxes-"));
    repository = await createFixtureRepository(root, "app");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("three concurrent Runs use three different sandbox identifiers and cannot modify one another", async () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const runner = new OpenCodeRunner({ executable: stub, redactor: new Redactor(), pollIntervalMs: 20 });

    const runIds = ["run-a", "run-b", "run-c"];
    const prepared = await Promise.all(
      runIds.map((runId) =>
        manager.prepare({
          runId,
          tenantId: "tenant-1",
          projectId: "project-1",
          primary: { url: repository, ref: "main" },
          references: [],
          config: DEFAULT_PROJECT_RUNTIME_CONFIG,
        }),
      ),
    );

    const identifiers = new Set(prepared.map((entry) => entry.ref.id));
    expect(identifiers.size).toBe(3);

    await Promise.all(
      prepared.map((entry, index) =>
        runner.run({
          runId: runIds[index] ?? "",
          tenantId: "tenant-1",
          role: "implementer",
          sandbox,
          ref: entry.ref,
          workingDirectory: entry.checkout.primary.path,
          prompt: `written by ${runIds[index] ?? ""}`,
          promptVersion: "implementer/1",
          environment: { FACTOREE_STUB_TARGET: "target.txt" },
          actionPolicy: buildActionPolicy(),
          timeoutMs: 20_000,
        }),
      ),
    );

    // Every Run must see only its own change.
    for (const [index, entry] of prepared.entries()) {
      const content = await readFile(join(entry.checkout.primary.path, "target.txt"), "utf8");
      expect(content.trim()).toBe(`written by ${runIds[index] ?? ""}`);
    }

    await Promise.all(prepared.map((entry) => manager.release(entry)));
  });
});
```

- [ ] **Step 3: Write the AT-13 Action Policy test**

```ts
// tests/acceptance/at-13-action-policy.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { DEFAULT_PROJECT_RUNTIME_CONFIG } from "~/domain/runs/project-runtime-config.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { ForbiddenImplementerMaterialError, buildImplementerInput } from "~/domain/runs/implementer-input.js";
import { FlySpriteSandbox } from "~/adapters/sandbox/fly-sprites/fly-sprite-sandbox.js";
import { createFixtureRepository } from "./support/fixture-repository.js";

describe("AT-13 — Action Policy", () => {
  let root: string;
  let sandboxRoot: string;
  let primary: string;
  let reference: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-at13-repos-"));
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-at13-sandboxes-"));
    primary = await createFixtureRepository(root, "app");
    reference = await createFixtureRepository(root, "design");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("lets the Implementer write the primary worktree", async () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const prepared = await manager.prepare({
      runId: "run-write",
      tenantId: "t",
      projectId: "p",
      primary: { url: primary, ref: "main" },
      references: [{ url: reference, ref: "main" }],
      config: DEFAULT_PROJECT_RUNTIME_CONFIG,
    });
    const result = await sandbox.exec(prepared.ref, {
      file: "sh",
      args: ["-c", `printf changed > ${prepared.checkout.primary.path}/target.txt && printf OK`],
    });
    expect(result.stdout).toBe("OK");
    await manager.release(prepared);
  });

  it("stops the Implementer from writing a reference repository", async () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const prepared = await manager.prepare({
      runId: "run-reference",
      tenantId: "t",
      projectId: "p",
      primary: { url: primary, ref: "main" },
      references: [{ url: reference, ref: "main" }],
      config: DEFAULT_PROJECT_RUNTIME_CONFIG,
    });
    const path = prepared.checkout.references[0]?.path ?? "";
    const result = await sandbox.exec(prepared.ref, {
      file: "sh",
      args: ["-c", `printf changed > ${path}/target.txt 2>/dev/null; printf %s $?`],
    });
    expect(result.stdout).not.toBe("0");
    await manager.release(prepared);
  });

  it("stops the Implementer from pushing to a git remote", async () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const prepared = await manager.prepare({
      runId: "run-push",
      tenantId: "t",
      projectId: "p",
      primary: { url: primary, ref: "main" },
      references: [],
      config: DEFAULT_PROJECT_RUNTIME_CONFIG,
    });
    const result = await sandbox.exec(prepared.ref, {
      file: "sh",
      args: ["-c", `git -C ${prepared.checkout.primary.path} push origin HEAD 2>&1; printf "|%s" $?`],
    });
    expect(result.stdout).not.toContain("|0");
    expect(result.stdout).toContain("DISABLED_BY_FACTOREE");
    await manager.release(prepared);
  });

  it("denies every domain outside the Project allow list", async () => {
    // The local adapter cannot enforce egress, so the proof is on the required adapter: the
    // policy document FlySpriteSandbox sends. The live proof is Phase 12 (SDD section 66).
    const sent: unknown[] = [];
    const handle = {
      execFile: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      createSession: () => Promise.resolve({ sessionId: "s" }),
      readSession: () => Promise.resolve({ running: false, exitCode: 0, stdout: "", stderr: "" }),
      killSession: () => Promise.resolve(),
      createCheckpoint: () => Promise.resolve({ id: "v1" }),
      updateNetworkPolicy: (policy: unknown) => {
        sent.push(policy);
        return Promise.resolve();
      },
      createService: () => Promise.resolve({ url: "https://example.invalid" }),
      delete: () => Promise.resolve(),
    };
    const sprites = new FlySpriteSandbox({
      gateway: {
        createSprite: () => Promise.resolve({ name: "factoree-run-1", handle }),
        sprite: () => handle,
      },
    });
    const ref = await sprites.create({ runId: "run-1", tenantId: "t", projectId: "p" });
    await sprites.applyNetworkPolicy(ref, { allowedDomains: ["registry.npmjs.org"] });
    expect(sent[0]).toEqual({
      rules: [
        { domain: "registry.npmjs.org", action: "allow" },
        { domain: "*", action: "deny" },
      ],
    });
  });

  it("AT-26: the Implementer cannot read a GitHub write credential", () => {
    expect(() =>
      buildImplementerInput({
        goal: "g",
        humanDecisions: [],
        validationContract: null,
        contextContract: null,
        requiredContext: [],
        primaryRepositoryPath: "/workspace/primary",
        referenceRepositoryPaths: [],
        repositoryInstructions: "",
        skills: [],
        actionPolicy: buildActionPolicy(),
        repairFindings: [],
        projectTestSecrets: { GITHUB_TOKEN: "ghp_forbidden" },
      }),
    ).toThrow(ForbiddenImplementerMaterialError);
  });
});
```

- [ ] **Step 4: Write the Phase 2 exit test**

```ts
// tests/acceptance/phase-02-exit.test.ts
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { OpenCodeRunner } from "~/adapters/runners/opencode/opencode-runner.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { DEFAULT_PROJECT_RUNTIME_CONFIG } from "~/domain/runs/project-runtime-config.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { buildImplementerInput } from "~/domain/runs/implementer-input.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createFixtureRepository } from "./support/fixture-repository.js";

const run = promisify(execFile);
const stub = resolve("tests/fixtures/bin/opencode-stub.sh");

describe("Phase 2 exit condition — an isolated fixture change without publishing", () => {
  let root: string;
  let sandboxRoot: string;
  let repository: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-exit-repos-"));
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-exit-sandboxes-"));
    repository = await createFixtureRepository(root, "app");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("prepares a sandbox, implements a change, and publishes nothing", async () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const runners = new AgentRunnerRegistry([
      new OpenCodeRunner({ executable: stub, redactor: new Redactor(), pollIntervalMs: 20 }),
    ]);

    const prepared = await manager.prepare({
      runId: "run-exit",
      tenantId: "tenant-1",
      projectId: "project-1",
      primary: { url: repository, ref: "main" },
      references: [],
      config: DEFAULT_PROJECT_RUNTIME_CONFIG,
    });

    expect(prepared.checkout.primary.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(prepared.baselineCheckpoint?.name).toBe("baseline");

    const implementerInput = buildImplementerInput({
      goal: "Replace the contents of target.txt.",
      humanDecisions: [],
      validationContract: null,
      contextContract: null,
      requiredContext: [],
      primaryRepositoryPath: prepared.checkout.primary.path,
      referenceRepositoryPaths: [],
      repositoryInstructions: await readFile(join(prepared.checkout.primary.path, "CONTRIBUTING.md"), "utf8"),
      skills: [],
      actionPolicy: buildActionPolicy(),
      repairFindings: [],
      projectTestSecrets: {},
    });

    const result = await runners.get(DEFAULT_PROJECT_RUNTIME_CONFIG.implementerRunner).run({
      runId: "run-exit",
      tenantId: "tenant-1",
      role: "implementer",
      sandbox,
      ref: prepared.ref,
      workingDirectory: prepared.checkout.primary.path,
      prompt: implementerInput.prompt,
      promptVersion: implementerInput.promptVersion,
      environment: { ...implementerInput.environment, FACTOREE_STUB_TARGET: "target.txt" },
      actionPolicy: buildActionPolicy(),
      timeoutMs: 30_000,
    });

    expect(result.completed).toBe(true);

    // The change exists in the isolated worktree.
    const status = await sandbox.exec(prepared.ref, {
      file: "git",
      args: ["-C", prepared.checkout.primary.path, "status", "--porcelain"],
    });
    expect(status.stdout).toContain("target.txt");

    // Nothing was published. The fixture origin still holds the original content and one commit.
    const origin = await readFile(join(repository, "target.txt"), "utf8");
    expect(origin.trim()).toBe("original");
    const commits = await run("git", ["-C", repository, "rev-list", "--count", "HEAD"]);
    expect(commits.stdout.trim()).toBe("1");

    await manager.release(prepared);

    // The sandbox is gone after release.
    await expect(
      sandbox.exec(prepared.ref, { file: "sh", args: ["-c", "true"] }),
    ).rejects.toThrow(/destroyed/);
  });
});
```

- [ ] **Step 5: Include the acceptance directory**

Read `vitest.integration.config.ts`. Add `tests/acceptance/**/*.test.ts` to its `include` array. Confirm the unit configuration in `vitest.config.ts` does not also match that path, so no test runs twice.

- [ ] **Step 6: Run the acceptance tests**

Run: `npm run test:integration`
Expected: PASS, including the three new acceptance files.

- [ ] **Step 7: Run the full verification and capture the evidence**

```bash
npm run verify 2>&1 | tee docs/build/evidence/phase-02-verify.txt
echo "exit=${PIPESTATUS[0]}" >> docs/build/evidence/phase-02-verify.txt
```

Expected: `exit=0` on the last line.

- [ ] **Step 8: Commit**

```bash
git add tests/acceptance docs/build/evidence/phase-02-verify.txt vitest.integration.config.ts
git commit -m "test: add the Phase 2 acceptance tests for isolation, Action Policy, and the exit condition"
```

---

## Self-review record

**Spec coverage.** Every SDD section named in the Phase 2 scope line of §69 has a task: the Fly
Sprite adapter (Task 5), process control (Task 1, Task 4, Task 5, Task 9), checkout (Task 6),
network policy (Task 1, Task 5, Task 7), checkpoint (Task 4, Task 5, Task 7), OpenCodeRunner
(Task 9), and cancellation (Task 9, Task 11). SDD §29, §30, §33, §34, §51, §56, §60, §61, and the
Phase 2 part of §62 are covered by Task 2, Task 8, Task 10, and Task 11.

**Not covered here, by design.** SDD §37 browser validation and §38 HTTP validation need
`exposeService`, which Task 1 defines and both adapters implement, but Phase 7 uses it. SDD §16
skills are Phase 11. SDD §44 patch capture is Phase 9. The `.factoree/config.yaml` loader is
Phase 3; Task 6 defines the typed configuration it will produce.

**Type consistency.** `SandboxRef`, `ProcessRef`, `CheckpointRef`, `AgentSessionRef`,
`ProjectRuntimeConfig`, and `CheckoutResult` are defined once and used with the same field names
in every later task. `Sandbox.readProcess` returns `ProcessSnapshot` in Task 1, Task 4, Task 5,
and Task 9. `AgentRunResult.session` is `AgentSessionRef` in Task 8, Task 9, and Task 11.
