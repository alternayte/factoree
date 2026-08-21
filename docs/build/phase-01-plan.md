# Factoree Phase 1 — Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Factoree control plane so that one Linear delegation creates exactly one durable Temporal-backed Run in PostgreSQL.

**Architecture:** A Fastify API receives Linear agent-session webhooks, verifies the signature, records the delivery for idempotency, resolves the tenant and project, and starts a Temporal workflow with the deterministic workflow ID `linear:{workspaceId}:{agentSessionId}`. A Temporal worker runs `agentRunWorkflow`, which creates the durable Run row, acknowledges the Linear session, and then holds the Run open for signals under a Run timeout. Domain code depends on ports. Linear, Temporal, and Prisma live in adapters.

**Tech Stack:** TypeScript (strict), Node.js 24 LTS, npm, Fastify, Zod, Prisma, PostgreSQL, Temporal TypeScript SDK, `@linear/sdk`, Vitest, Testcontainers, prom-client.

**Spec:** `docs/sdd.md` (version 2.0)

## Global Constraints

- Production runtime is Node.js 24 LTS. Bun MUST NOT run Temporal Worker code (SDD §11).
- TypeScript compiler options MUST include `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true` (SDD §10).
- npm with a committed `package-lock.json` (SDD §10).
- Provider SDKs MUST stay in `src/adapters/**`. Core workflow policy MUST NOT import provider-specific SDKs (SDD §14).
- Tenant boundary is the Linear workspace. Tenant ID MUST be present on tenant-owned persisted records (SDD §52).
- Factoree MUST NOT log raw OAuth tokens, GitHub tokens, model API keys, Project secrets, or authorization headers (SDD §60).
- Full agent transcripts MUST NOT be persisted by default (SDD §61).
- Required checks MUST NOT use `continue-on-error`. CI MUST run `npm run verify` (SDD §65).
- Source layout MUST follow SDD §63.
- Run states MUST use the exact names in SDD §48.
- Workflow ID format MUST be exactly `linear:{workspaceId}:{agentSessionId}` (SDD §26).
- Default maximum Run duration is 90 minutes. A Project MAY override it. The timeout failure reason is `RUN_TIMEOUT` (SDD §50).

## Phase 1 scope (SDD §69)

> Build Linear integration, PostgreSQL, Temporal workflow skeleton, Project model, Run model, and idempotency.
> **Exit:** one Linear delegation creates one durable Run.

**In scope:** toolchain setup; Prisma schema for the entities Phase 1 uses; Project registry and encrypted project secrets; Linear webhook receipt, verification, and idempotency; Linear agent-session acknowledgement, progress, elicitation, stop, and final response; Temporal client, worker, and `agentRunWorkflow` skeleton with signals and timeout; admin API; health endpoints; structured logging with redaction; Phase 1 metrics.

**Out of scope (later phases, do not build):** Refinement (Phase 4), Context Contract (Phase 4 and 5), Validation Contract (Phase 6), sandbox and runners (Phase 2 and 11), deterministic verification (Phase 3), evidence and user validation (Phase 7), review and repair (Phase 8), publishing (Phase 9), Proof Pack (Phase 10).

## Requirement mapping

| SDD requirement | Task |
| --- | --- |
| §10 stack, §11 runtime, §65 commands | Task 1 |
| §60 logging and redaction | Task 2 |
| §62 metrics (Phase 1 subset) | Task 2, Task 9 |
| §52 tenant isolation, §53 persistent model, §54 data ownership | Task 3 |
| §53 Project model, §30 credentials | Task 4 |
| §26 webhook idempotency and signature security | Task 5 |
| §26 Linear agent activities | Task 6 |
| §26 workflow ID, §48 run states, §49 workflow shape, §50 timeout and cancellation | Task 7 |
| §26 delegation creates a durable Run, §59 admin endpoints | Task 8 |
| AT-01, AT-33, AT-35, partial AT-32 | Task 9 |

## Phase 1 exit evidence

- `npm run verify` exits 0.
- An integration test proves one delegation webhook creates one Run, and a duplicate delivery creates no second Run (AT-01).
- A workflow test proves the workflow survives worker restart and creates no duplicate Run (AT-35).
- An integration test proves tenant A cannot read tenant B projects, secrets, or runs (AT-33).
- A unit test proves secrets and tokens are redacted from log output (partial AT-32).

## File structure

**Toolchain and root**

- `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.mjs`, `.nvmrc`, `.gitignore`, `.env.example`, `.github/workflows/ci.yml`
- `vitest.config.ts`, `vitest.integration.config.ts`, `vitest.workflow.config.ts`

**Configuration and telemetry**

- `src/config/env.ts` — Zod-validated process environment.
- `src/telemetry/redaction.ts` — value and pattern redaction.
- `src/telemetry/logger.ts` — structured JSON logger with redaction and run context.
- `src/telemetry/metrics.ts` — Prometheus registry and Phase 1 metrics.

**Persistence**

- `prisma/schema.prisma` — Tenant, LinearInstallation, Project, ProjectSecret, Run, AgentExecution, ProcessedWebhook.
- `src/persistence/prisma/client.ts` — Prisma client factory.
- `src/persistence/prisma/run-repository.prisma.ts`
- `src/persistence/prisma/project-registry.prisma.ts`
- `src/persistence/prisma/webhook-log.prisma.ts`

**Domain (no provider SDK imports)**

- `src/domain/runs/run-status.ts` — `RunStatus`, terminal set, failure reasons.
- `src/domain/runs/run-repository.ts` — `RunRepository` port and plain types.
- `src/domain/runs/ports.ts` — `AgentSessionPort`.
- `src/domain/projects/project-registry.ts` — Project types and `ProjectRegistry` port.
- `src/domain/projects/secret-store.ts` — `SecretStore` port.
- `src/domain/policy/crypto.ts` — AES-256-GCM helpers.

**Adapters**

- `src/adapters/linear/webhook-schemas.ts` — Zod schemas for `AgentSessionEvent`.
- `src/adapters/linear/webhook-verifier.ts` — HMAC verification and timestamp freshness.
- `src/adapters/linear/linear-agent-client.ts` — `AgentSessionPort` on `@linear/sdk`.

**Temporal**

- `src/temporal/connection.ts` — client and worker connection options.
- `src/temporal/workflow-id.ts` — workflow ID builder (imported by API and workflow).
- `src/workflows/agent-run.workflow.ts` — `agentRunWorkflow`, `stopSignal`, `humanInputSignal`, `runStatusQuery`.
- `src/activities/run.activities.ts`
- `src/activities/linear.activities.ts`
- `src/activities/index.ts`
- `src/bin/worker.ts`

**HTTP**

- `src/http/server.ts` — Fastify app factory.
- `src/http/health.routes.ts` — `/healthz`, `/readyz`.
- `src/http/webhooks/linear.routes.ts` — `POST /webhooks/linear`.
- `src/http/admin/auth.ts` — bearer token guard.
- `src/http/admin/projects.routes.ts`
- `src/http/admin/runs.routes.ts`
- `src/http/admin/installations.routes.ts`
- `src/bin/api.ts`

**Tests**

- `tests/unit/**`, `tests/integration/**`, `tests/workflow/**`, `tests/fixtures/**`
---

### Task 1: Toolchain, TypeScript, lint, and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.mjs`, `.nvmrc`, `.gitignore`, `.env.example`, `vitest.config.ts`, `vitest.integration.config.ts`, `vitest.workflow.config.ts`, `.github/workflows/ci.yml`
- Test: `tests/unit/toolchain.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: npm scripts `lint`, `typecheck`, `test`, `test:integration`, `test:workflow`, `build`, `verify`, `db:generate`, `db:migrate`. The path alias `~/*` resolves to `src/*`.

- [ ] **Step 1: Create `.nvmrc` and confirm the Node version**

`.nvmrc`:

```text
24
```

Run: `node -v`
Expected: `v24.x`. If the shell shows another version, prefix PATH with the Node 24 install. On this machine that is `/opt/homebrew/opt/node@24/bin`.

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "factoree",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --config vitest.config.ts",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test:workflow": "vitest run --config vitest.workflow.config.ts",
    "build": "tsc -p tsconfig.build.json",
    "verify": "npm run lint && npm run typecheck && npm test && npm run test:integration && npm run test:workflow && npm run build",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate deploy",
    "db:migrate:dev": "prisma migrate dev"
  }
}
```

- [ ] **Step 3: Install the dependencies**

```bash
npm i @linear/sdk @prisma/client @temporalio/client @temporalio/worker @temporalio/workflow @temporalio/activity fastify zod prom-client
npm i -D typescript @types/node vitest eslint typescript-eslint prisma @temporalio/testing @testcontainers/postgresql testcontainers vite-tsconfig-paths
```

- [ ] **Step 4: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": ".",
    "baseUrl": ".",
    "paths": { "~/*": ["src/*"] }
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "*.ts"]
}
```

- [ ] **Step 5: Create `tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "noEmit": false },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 6: Create `eslint.config.mjs`**

The last block enforces SDD section 14. Domain and workflow code must not import provider SDKs.

```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["src/domain/**/*.ts", "src/workflows/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@linear/sdk*", "@prisma/client*", "octokit*", "@octokit/*"],
              message: "Provider SDKs belong in src/adapters (SDD section 14)."
            }
          ]
        }
      ]
    }
  },
);
```

- [ ] **Step 7: Create the three Vitest configurations**

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
```

`vitest.integration.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
```

`vitest.workflow.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/workflow/**/*.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
```

- [ ] **Step 8: Create `.gitignore` and `.env.example`**

`.gitignore`:

```text
node_modules/
dist/
.env
*.log
```

`.env.example`:

```text
DATABASE_URL=postgresql://factoree:factoree@localhost:5432/factoree
FACTOREE_SECRET_KEY=0000000000000000000000000000000000000000000000000000000000000000
ADMIN_API_TOKEN=change-me-to-a-token-of-32-characters
LINEAR_WEBHOOK_SECRET=change-me
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=factoree
PORT=3000
LOG_LEVEL=info
```

- [ ] **Step 9: Write the failing toolchain test**

`tests/unit/toolchain.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
  engines: { node: string };
};
const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8")) as {
  compilerOptions: Record<string, unknown>;
};

describe("toolchain", () => {
  it("requires Node 24", () => {
    expect(pkg.engines.node).toBe(">=24 <25");
  });

  it("declares every required development command", () => {
    for (const name of ["lint", "typecheck", "test", "test:integration", "test:workflow", "build", "verify"]) {
      expect(pkg.scripts[name], `missing script ${name}`).toBeTypeOf("string");
    }
  });

  it("runs all required non-live checks in verify", () => {
    const verify = pkg.scripts.verify ?? "";
    for (const name of ["lint", "typecheck", "test", "test:integration", "test:workflow", "build"]) {
      expect(verify).toContain(name);
    }
  });

  it("enables the required strict compiler settings", () => {
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.noUncheckedIndexedAccess).toBe(true);
    expect(tsconfig.compilerOptions.exactOptionalPropertyTypes).toBe(true);
  });
});
```

- [ ] **Step 10: Run the test**

Run: `npm test`
Expected: PASS. If a script or a setting is missing, add it, then run the test again.

- [ ] **Step 11: Create `.github/workflows/ci.yml`**

Do not add `continue-on-error` to any step.

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npx prisma generate
      - run: npm run verify
```

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: add TypeScript, lint, and test toolchain for Node 24"
```
---

### Task 2: Configuration, redaction, structured logging, metrics

**Files:**
- Create: `src/config/env.ts`, `src/telemetry/redaction.ts`, `src/telemetry/logger.ts`, `src/telemetry/metrics.ts`
- Test: `tests/unit/redaction.test.ts`, `tests/unit/logger.test.ts`, `tests/unit/env.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `loadEnv(source?: NodeJS.ProcessEnv): Env` and `type Env` with fields `DATABASE_URL`, `FACTOREE_SECRET_KEY`, `ADMIN_API_TOKEN`, `LINEAR_WEBHOOK_SECRET`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `TEMPORAL_API_KEY` (optional), `PORT`, `LOG_LEVEL`.
  - `class Redactor { constructor(secrets?: Iterable<string>); addSecret(value: string): void; redact<T>(value: T): T; }`
  - `createLogger(options: { level: string; redactor: Redactor; sink?: (line: string) => void }): Logger` where `Logger` has `debug|info|warn|error(message: string, fields?: LogFields): void` and `child(fields: LogFields): Logger`.
  - `type LogFields = { tenant_id?: string; project_id?: string; run_id?: string; linear_issue?: string; workflow_id?: string; step?: string; sprite_id?: string; [key: string]: unknown }`.
  - `metrics` object with `runsStarted`, `runsReady`, `runsFailed`, `runsCancelled`, `runDuration`, `activeRuns`, `humanInterventions`, and `registry`.

- [ ] **Step 1: Write the failing redaction test**

`tests/unit/redaction.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Redactor } from "~/telemetry/redaction.js";

describe("Redactor", () => {
  it("removes an exact configured secret value", () => {
    const redactor = new Redactor(["s3cr3t-project-value"]);
    const result = redactor.redact({ note: "value is s3cr3t-project-value here" });
    expect(JSON.stringify(result)).not.toContain("s3cr3t-project-value");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("removes GitHub token patterns", () => {
    const redactor = new Redactor();
    const line = redactor.redact("token ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(line).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("removes model provider key patterns", () => {
    const redactor = new Redactor();
    const line = redactor.redact("key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(line).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("removes an authorization header field by name", () => {
    const redactor = new Redactor();
    const result = redactor.redact({ headers: { authorization: "Bearer abc123", "x-ok": "keep" } });
    expect(result.headers.authorization).toBe("[REDACTED]");
    expect(result.headers["x-ok"]).toBe("keep");
  });

  it("removes a Linear OAuth token pattern", () => {
    const redactor = new Redactor();
    const line = redactor.redact("lin_oauth_0123456789abcdef0123456789abcdef0123456789abcdef");
    expect(line).not.toContain("0123456789abcdef");
  });

  it("keeps unrelated content", () => {
    const redactor = new Redactor(["nope"]);
    expect(redactor.redact("plain message")).toBe("plain message");
  });

  it("ignores empty or very short secret values", () => {
    const redactor = new Redactor(["", "a"]);
    expect(redactor.redact("a plain message")).toBe("a plain message");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- redaction`
Expected: FAIL, because `~/telemetry/redaction.js` does not exist.

- [ ] **Step 3: Implement `src/telemetry/redaction.ts`**

```ts
const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "access_token",
  "refresh_token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
]);

const PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-ant-[A-Za-z0-9-]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /lin_(?:api|oauth)_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Redactor {
  private readonly secrets = new Set<string>();

  constructor(secrets: Iterable<string> = []) {
    for (const secret of secrets) this.addSecret(secret);
  }

  addSecret(value: string): void {
    if (value.length >= 6) this.secrets.add(value);
  }

  redact<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === "string") return this.redactString(value);
    if (Array.isArray(value)) return value.map((item) => this.walk(item));
    if (value instanceof Error) {
      const error = new Error(this.redactString(value.message));
      error.name = value.name;
      if (value.stack) error.stack = this.redactString(value.stack);
      return error;
    }
    if (value !== null && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        output[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : this.walk(item);
      }
      return output;
    }
    return value;
  }

  private redactString(value: string): string {
    let output = value;
    for (const secret of this.secrets) {
      output = output.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
    }
    for (const pattern of PATTERNS) {
      output = output.replace(pattern, REDACTED);
    }
    return output;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- redaction`
Expected: PASS.

- [ ] **Step 5: Write the failing logger test**

`tests/unit/logger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";

const capture = () => {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
};

describe("createLogger", () => {
  it("writes one JSON object per line with level, message, and time", () => {
    const { lines, sink } = capture();
    createLogger({ level: "info", redactor: new Redactor(), sink }).info("started");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("started");
    expect(typeof entry.time).toBe("string");
  });

  it("keeps the required context fields", () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: "info", redactor: new Redactor(), sink });
    logger.child({ tenant_id: "t1", project_id: "p1", run_id: "r1" }).info("step", { step: "receive" });
    const entry = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(entry.tenant_id).toBe("t1");
    expect(entry.project_id).toBe("p1");
    expect(entry.run_id).toBe("r1");
    expect(entry.step).toBe("receive");
  });

  it("redacts secret values in the message and in the fields", () => {
    const { lines, sink } = capture();
    const redactor = new Redactor(["top-secret-value"]);
    const logger = createLogger({ level: "info", redactor, sink });
    logger.info("saw top-secret-value", { token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    const raw = lines[0] ?? "";
    expect(raw).not.toContain("top-secret-value");
    expect(raw).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("drops entries below the configured level", () => {
    const { lines, sink } = capture();
    createLogger({ level: "warn", redactor: new Redactor(), sink }).info("ignored");
    expect(lines).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- logger`
Expected: FAIL, because `~/telemetry/logger.js` does not exist.

- [ ] **Step 7: Implement `src/telemetry/logger.ts`**

```ts
import type { Redactor } from "./redaction.js";

export type LogFields = {
  tenant_id?: string;
  project_id?: string;
  run_id?: string;
  linear_issue?: string;
  workflow_id?: string;
  step?: string;
  sprite_id?: string;
  [key: string]: unknown;
};

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level: string;
  redactor: Redactor;
  sink?: (line: string) => void;
  now?: () => Date;
}

const toLevel = (value: string): LogLevel =>
  value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";

export const createLogger = (options: LoggerOptions): Logger => {
  const level = toLevel(options.level);
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const build = (base: LogFields): Logger => {
    const write = (entryLevel: LogLevel, message: string, fields?: LogFields): void => {
      if (ORDER[entryLevel] < ORDER[level]) return;
      const entry = options.redactor.redact({
        time: now().toISOString(),
        level: entryLevel,
        message,
        ...base,
        ...(fields ?? {}),
      });
      sink(JSON.stringify(entry));
    };

    return {
      debug: (message, fields) => write("debug", message, fields),
      info: (message, fields) => write("info", message, fields),
      warn: (message, fields) => write("warn", message, fields),
      error: (message, fields) => write("error", message, fields),
      child: (fields) => build({ ...base, ...fields }),
    };
  };

  return build({});
};
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- logger`
Expected: PASS.

- [ ] **Step 9: Write the failing environment test**

`tests/unit/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadEnv } from "~/config/env.js";

const base = {
  DATABASE_URL: "postgresql://factoree:factoree@localhost:5432/factoree",
  FACTOREE_SECRET_KEY: "0".repeat(64),
  ADMIN_API_TOKEN: "a".repeat(32),
  LINEAR_WEBHOOK_SECRET: "webhook-secret",
};

describe("loadEnv", () => {
  it("applies the documented defaults", () => {
    const env = loadEnv(base);
    expect(env.TEMPORAL_ADDRESS).toBe("localhost:7233");
    expect(env.TEMPORAL_NAMESPACE).toBe("default");
    expect(env.TEMPORAL_TASK_QUEUE).toBe("factoree");
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("rejects a missing database URL", () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: undefined })).toThrow();
  });

  it("rejects a secret key that is not 32 bytes of hexadecimal", () => {
    expect(() => loadEnv({ ...base, FACTOREE_SECRET_KEY: "abc" })).toThrow();
  });

  it("rejects a short administration token", () => {
    expect(() => loadEnv({ ...base, ADMIN_API_TOKEN: "short" })).toThrow();
  });
});
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npm test -- env`
Expected: FAIL, because `~/config/env.js` does not exist.

- [ ] **Step 11: Implement `src/config/env.ts`**

```ts
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  FACTOREE_SECRET_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 32 bytes of hexadecimal"),
  ADMIN_API_TOKEN: z.string().min(32),
  LINEAR_WEBHOOK_SECRET: z.string().min(1),
  TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
  TEMPORAL_TASK_QUEUE: z.string().min(1).default("factoree"),
  TEMPORAL_API_KEY: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => schema.parse(source);
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `npm test -- env`
Expected: PASS.

- [ ] **Step 13: Implement `src/telemetry/metrics.ts`**

This file registers the SDD section 62 metrics that Phase 1 can produce. Later phases add the remaining metrics.

```ts
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const labelNames = ["tenant_id", "project_id"] as const;

export const metrics = {
  registry,
  runsStarted: new Counter({
    name: "factoree_runs_started_total",
    help: "Runs started",
    labelNames,
    registers: [registry],
  }),
  runsReady: new Counter({
    name: "factoree_runs_ready_total",
    help: "Runs that reached READY_FOR_HUMAN",
    labelNames,
    registers: [registry],
  }),
  runsFailed: new Counter({
    name: "factoree_runs_failed_total",
    help: "Runs that reached a failure state",
    labelNames: [...labelNames, "reason"],
    registers: [registry],
  }),
  runsCancelled: new Counter({
    name: "factoree_runs_cancelled_total",
    help: "Runs that were cancelled",
    labelNames,
    registers: [registry],
  }),
  runDuration: new Histogram({
    name: "factoree_run_duration_seconds",
    help: "Run duration in seconds",
    labelNames,
    buckets: [30, 60, 300, 900, 1800, 3600, 5400],
    registers: [registry],
  }),
  activeRuns: new Gauge({
    name: "factoree_active_runs",
    help: "Runs that are not in a terminal state",
    labelNames,
    registers: [registry],
  }),
  humanInterventions: new Counter({
    name: "factoree_human_interventions_total",
    help: "Human interventions such as elicitation answers and stop requests",
    labelNames,
    registers: [registry],
  }),
};
```

- [ ] **Step 14: Run the checks**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "feat: add configuration, redacting structured logger, and metrics"
```
---

### Task 3: PostgreSQL schema, Prisma client, Run repository

**Files:**
- Create: `prisma/schema.prisma`, `src/persistence/prisma/client.ts`, `src/domain/runs/run-status.ts`, `src/domain/runs/run-repository.ts`, `src/persistence/prisma/run-repository.prisma.ts`, `src/persistence/prisma/webhook-log.prisma.ts`, `tests/integration/support/database.ts`
- Test: `tests/unit/run-status.test.ts`, `tests/integration/run-repository.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `RUN_STATUSES` readonly tuple, `type RunStatus`, `TERMINAL_RUN_STATUSES`, `isTerminalRunStatus(status: RunStatus): boolean`, `RUN_FAILURE_REASONS` including `"RUN_TIMEOUT"`, `type RunFailureReason`.
  - `interface RunRepository` with:
    - `createIfAbsent(input: CreateRunInput): Promise<{ run: RunRecord; created: boolean }>`
    - `findById(tenantId: string, id: string): Promise<RunRecord | null>`
    - `findByAgentSession(tenantId: string, agentSessionId: string): Promise<RunRecord | null>`
    - `updateStatus(id: string, status: RunStatus, patch?: RunStatusPatch): Promise<RunRecord>`
  - `type CreateRunInput = { tenantId: string; projectId: string; linearIssueId: string | null; linearAgentSessionId: string; temporalWorkflowId: string; autonomyLevel: string }`
  - `type RunStatusPatch = { failureReason?: RunFailureReason; startedAt?: Date; completedAt?: Date; repairCount?: number }`
  - `type RunRecord` with the SDD section 53 critical Run fields.
  - `interface WebhookLog { recordIfNew(input: { tenantId: string | null; deliveryId: string; eventType: string }): Promise<boolean> }` which returns `true` when the delivery is new.
  - `createPrismaClient(databaseUrl: string): PrismaClient` and `type FactoreePrismaClient`.
  - Test helper `startDatabase(): Promise<{ url: string; stop: () => Promise<void> }>` in `tests/integration/support/database.ts`.

- [ ] **Step 1: Write the failing run status test**

`tests/unit/run-status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RUN_STATUSES, TERMINAL_RUN_STATUSES, isTerminalRunStatus } from "~/domain/runs/run-status.js";

describe("run status", () => {
  it("declares every SDD section 48 state", () => {
    expect([...RUN_STATUSES]).toEqual([
      "RECEIVED",
      "REFINING",
      "WAITING_FOR_INPUT",
      "RESOLVING_CONTEXT",
      "BUILDING_VALIDATION_CONTRACT",
      "PREPARING",
      "IMPLEMENTING",
      "VERIFYING",
      "USER_VALIDATING",
      "REVIEWING",
      "REPAIRING",
      "PUBLISHING",
      "READY_FOR_HUMAN",
      "STALE_BASE",
      "FAILED_CONFIGURATION",
      "FAILED",
      "FAILED_REVIEW",
      "CANCELLED",
    ]);
  });

  it("declares every SDD section 48 terminal state", () => {
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual(
      ["CANCELLED", "FAILED", "FAILED_CONFIGURATION", "FAILED_REVIEW", "READY_FOR_HUMAN", "STALE_BASE"].sort(),
    );
  });

  it("classifies terminal and non-terminal states", () => {
    expect(isTerminalRunStatus("READY_FOR_HUMAN")).toBe(true);
    expect(isTerminalRunStatus("IMPLEMENTING")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- run-status`
Expected: FAIL, because `~/domain/runs/run-status.js` does not exist.

- [ ] **Step 3: Implement `src/domain/runs/run-status.ts`**

```ts
export const RUN_STATUSES = [
  "RECEIVED",
  "REFINING",
  "WAITING_FOR_INPUT",
  "RESOLVING_CONTEXT",
  "BUILDING_VALIDATION_CONTRACT",
  "PREPARING",
  "IMPLEMENTING",
  "VERIFYING",
  "USER_VALIDATING",
  "REVIEWING",
  "REPAIRING",
  "PUBLISHING",
  "READY_FOR_HUMAN",
  "STALE_BASE",
  "FAILED_CONFIGURATION",
  "FAILED",
  "FAILED_REVIEW",
  "CANCELLED",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = [
  "READY_FOR_HUMAN",
  "STALE_BASE",
  "FAILED_CONFIGURATION",
  "FAILED",
  "FAILED_REVIEW",
  "CANCELLED",
] as const satisfies readonly RunStatus[];

const terminal = new Set<string>(TERMINAL_RUN_STATUSES);

export const isTerminalRunStatus = (status: RunStatus): boolean => terminal.has(status);

export const RUN_FAILURE_REASONS = [
  "RUN_TIMEOUT",
  "STOPPED_BY_HUMAN",
  "CONFIGURATION_INVALID",
  "INTERNAL_ERROR",
] as const;

export type RunFailureReason = (typeof RUN_FAILURE_REASONS)[number];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- run-status`
Expected: PASS.

- [ ] **Step 5: Create `prisma/schema.prisma`**

Every tenant-owned table carries `tenantId` (SDD section 52). Phase 1 creates only the entities that Phase 1 uses. Later phases add the remaining SDD section 53 entities.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Tenant {
  id                String              @id @default(uuid())
  linearWorkspaceId String              @unique
  name              String
  createdAt         DateTime            @default(now())
  installations     LinearInstallation[]
  projects          Project[]
  runs              Run[]
  webhooks          ProcessedWebhook[]
}

model LinearInstallation {
  id                  String   @id @default(uuid())
  tenantId            String
  tenant              Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  linearWorkspaceId   String   @unique
  appUserId           String?
  accessTokenCipher   String
  refreshTokenCipher  String?
  expiresAt           DateTime?
  scopes              String[]
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
}

model Project {
  id                 String          @id @default(uuid())
  tenantId           String
  tenant             Tenant          @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  key                String
  name               String
  primaryRepository  String
  referenceRepositories String[]     @default([])
  linearTeamId       String?
  defaultAutonomy    String          @default("L2")
  maxRunMinutes      Int             @default(90)
  createdAt          DateTime        @default(now())
  updatedAt          DateTime        @updatedAt
  secrets            ProjectSecret[]
  runs               Run[]

  @@unique([tenantId, key])
  @@index([tenantId])
}

model ProjectSecret {
  id          String   @id @default(uuid())
  tenantId    String
  projectId   String
  project     Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  name        String
  valueCipher String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([projectId, name])
  @@index([tenantId])
}

model Run {
  id                       String    @id @default(uuid())
  tenantId                 String
  tenant                   Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  projectId                String
  project                  Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  linearIssueId            String?
  linearAgentSessionId     String    @unique
  temporalWorkflowId       String    @unique
  status                   String
  failureReason            String?
  autonomyLevel            String
  implementerRunner        String?
  validatorRunner          String?
  reviewerRunner           String?
  spriteId                 String?
  baseSha                  String?
  patchSha256              String?
  commitSha                String?
  pullRequestUrl           String?
  contextContractVersion   String?
  validationContractVersion String?
  repairCount              Int       @default(0)
  createdAt                DateTime  @default(now())
  startedAt                DateTime?
  completedAt              DateTime?
  executions               AgentExecution[]

  @@index([tenantId])
  @@index([projectId])
}

model AgentExecution {
  id             String    @id @default(uuid())
  tenantId       String
  runId          String
  run            Run       @relation(fields: [runId], references: [id], onDelete: Cascade)
  role           String
  runner         String
  model          String?
  sessionRef     String?
  promptVersion  String?
  durationMs     Int?
  finalResult    Json?
  costMetadata   Json?
  createdAt      DateTime  @default(now())

  @@index([tenantId])
  @@index([runId])
}

model ProcessedWebhook {
  id         String   @id @default(uuid())
  tenantId   String?
  tenant     Tenant?  @relation(fields: [tenantId], references: [id], onDelete: SetNull)
  deliveryId String   @unique
  eventType  String
  receivedAt DateTime @default(now())

  @@index([tenantId])
}
```

- [ ] **Step 6: Generate the client and the first migration**

```bash
npx prisma generate
```

The migration SQL is created inside the integration test container by `prisma migrate deploy`. Create the migration file once against a local database:

```bash
docker run -d --name factoree-pg -e POSTGRES_PASSWORD=factoree -e POSTGRES_USER=factoree -e POSTGRES_DB=factoree -p 5433:5432 postgres:16
DATABASE_URL=postgresql://factoree:factoree@localhost:5433/factoree npx prisma migrate dev --name init
docker rm -f factoree-pg
```

Commit the generated `prisma/migrations/**` directory.

- [ ] **Step 7: Implement `src/persistence/prisma/client.ts`**

```ts
import { PrismaClient } from "@prisma/client";

export type FactoreePrismaClient = PrismaClient;

export const createPrismaClient = (databaseUrl: string): FactoreePrismaClient =>
  new PrismaClient({ datasources: { db: { url: databaseUrl } } });
```

- [ ] **Step 8: Implement `src/domain/runs/run-repository.ts`**

```ts
import type { RunFailureReason, RunStatus } from "./run-status.js";

export interface RunRecord {
  id: string;
  tenantId: string;
  projectId: string;
  linearIssueId: string | null;
  linearAgentSessionId: string;
  temporalWorkflowId: string;
  status: RunStatus;
  failureReason: RunFailureReason | null;
  autonomyLevel: string;
  implementerRunner: string | null;
  validatorRunner: string | null;
  reviewerRunner: string | null;
  spriteId: string | null;
  baseSha: string | null;
  patchSha256: string | null;
  commitSha: string | null;
  pullRequestUrl: string | null;
  contextContractVersion: string | null;
  validationContractVersion: string | null;
  repairCount: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface CreateRunInput {
  tenantId: string;
  projectId: string;
  linearIssueId: string | null;
  linearAgentSessionId: string;
  temporalWorkflowId: string;
  autonomyLevel: string;
}

export interface RunStatusPatch {
  failureReason?: RunFailureReason;
  startedAt?: Date;
  completedAt?: Date;
  repairCount?: number;
}

export interface RunRepository {
  createIfAbsent(input: CreateRunInput): Promise<{ run: RunRecord; created: boolean }>;
  findById(tenantId: string, id: string): Promise<RunRecord | null>;
  findByAgentSession(tenantId: string, agentSessionId: string): Promise<RunRecord | null>;
  updateStatus(id: string, status: RunStatus, patch?: RunStatusPatch): Promise<RunRecord>;
}

export interface WebhookLog {
  recordIfNew(input: { tenantId: string | null; deliveryId: string; eventType: string }): Promise<boolean>;
}
```

- [ ] **Step 9: Write the failing repository integration test**

Create `tests/integration/support/database.ts`:

```ts
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";

export const startDatabase = async (): Promise<{ url: string; stop: () => Promise<void> }> => {
  const container = await new PostgreSqlContainer("postgres:16").start();
  const url = container.getConnectionUri();
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
  return { url, stop: () => container.stop().then(() => undefined) };
};
```

Create `tests/integration/run-repository.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";

let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let tenantA = "";
let tenantB = "";
let projectA = "";

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  const a = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-a", name: "A" } });
  const b = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-b", name: "B" } });
  tenantA = a.id;
  tenantB = b.id;
  const project = await prisma.project.create({
    data: { tenantId: tenantA, key: "demo", name: "Demo", primaryRepository: "acme/demo" },
  });
  projectA = project.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  await stop();
});

const input = (sessionId: string) => ({
  tenantId: tenantA,
  projectId: projectA,
  linearIssueId: "issue-1",
  linearAgentSessionId: sessionId,
  temporalWorkflowId: `linear:ws-a:${sessionId}`,
  autonomyLevel: "L2",
});

describe("PrismaRunRepository", () => {
  it("creates one Run and reports creation", async () => {
    const repository = new PrismaRunRepository(prisma);
    const result = await repository.createIfAbsent(input("session-1"));
    expect(result.created).toBe(true);
    expect(result.run.status).toBe("RECEIVED");
    expect(result.run.tenantId).toBe(tenantA);
  });

  it("returns the same Run for a repeated agent session", async () => {
    const repository = new PrismaRunRepository(prisma);
    const first = await repository.createIfAbsent(input("session-2"));
    const second = await repository.createIfAbsent(input("session-2"));
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(await prisma.run.count({ where: { linearAgentSessionId: "session-2" } })).toBe(1);
  });

  it("hides a Run from another tenant", async () => {
    const repository = new PrismaRunRepository(prisma);
    const created = await repository.createIfAbsent(input("session-3"));
    expect(await repository.findById(tenantB, created.run.id)).toBeNull();
    expect(await repository.findById(tenantA, created.run.id)).not.toBeNull();
  });

  it("updates the status and records the completion time", async () => {
    const repository = new PrismaRunRepository(prisma);
    const created = await repository.createIfAbsent(input("session-4"));
    const completedAt = new Date();
    const updated = await repository.updateStatus(created.run.id, "CANCELLED", {
      failureReason: "STOPPED_BY_HUMAN",
      completedAt,
    });
    expect(updated.status).toBe("CANCELLED");
    expect(updated.failureReason).toBe("STOPPED_BY_HUMAN");
    expect(updated.completedAt?.getTime()).toBe(completedAt.getTime());
  });
});

describe("PrismaWebhookLog", () => {
  it("accepts a delivery once", async () => {
    const log = new PrismaWebhookLog(prisma);
    const first = await log.recordIfNew({ tenantId: tenantA, deliveryId: "delivery-1", eventType: "AgentSessionEvent" });
    const second = await log.recordIfNew({ tenantId: tenantA, deliveryId: "delivery-1", eventType: "AgentSessionEvent" });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npm run test:integration -- run-repository`
Expected: FAIL, because the repository modules do not exist.

- [ ] **Step 11: Implement `src/persistence/prisma/run-repository.prisma.ts`**

```ts
import { Prisma } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import type {
  CreateRunInput,
  RunRecord,
  RunRepository,
  RunStatusPatch,
} from "~/domain/runs/run-repository.js";
import type { RunFailureReason, RunStatus } from "~/domain/runs/run-status.js";

type RunRow = Awaited<ReturnType<FactoreePrismaClient["run"]["findFirst"]>>;

const toRecord = (row: NonNullable<RunRow>): RunRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  projectId: row.projectId,
  linearIssueId: row.linearIssueId,
  linearAgentSessionId: row.linearAgentSessionId,
  temporalWorkflowId: row.temporalWorkflowId,
  status: row.status as RunStatus,
  failureReason: (row.failureReason as RunFailureReason | null) ?? null,
  autonomyLevel: row.autonomyLevel,
  implementerRunner: row.implementerRunner,
  validatorRunner: row.validatorRunner,
  reviewerRunner: row.reviewerRunner,
  spriteId: row.spriteId,
  baseSha: row.baseSha,
  patchSha256: row.patchSha256,
  commitSha: row.commitSha,
  pullRequestUrl: row.pullRequestUrl,
  contextContractVersion: row.contextContractVersion,
  validationContractVersion: row.validationContractVersion,
  repairCount: row.repairCount,
  createdAt: row.createdAt,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
});

export class PrismaRunRepository implements RunRepository {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async createIfAbsent(input: CreateRunInput): Promise<{ run: RunRecord; created: boolean }> {
    try {
      const row = await this.prisma.run.create({
        data: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          linearIssueId: input.linearIssueId,
          linearAgentSessionId: input.linearAgentSessionId,
          temporalWorkflowId: input.temporalWorkflowId,
          autonomyLevel: input.autonomyLevel,
          status: "RECEIVED",
        },
      });
      return { run: toRecord(row), created: true };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.run.findUnique({
          where: { linearAgentSessionId: input.linearAgentSessionId },
        });
        if (existing) return { run: toRecord(existing), created: false };
      }
      throw error;
    }
  }

  async findById(tenantId: string, id: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findFirst({ where: { id, tenantId } });
    return row ? toRecord(row) : null;
  }

  async findByAgentSession(tenantId: string, agentSessionId: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findFirst({
      where: { tenantId, linearAgentSessionId: agentSessionId },
    });
    return row ? toRecord(row) : null;
  }

  async updateStatus(id: string, status: RunStatus, patch: RunStatusPatch = {}): Promise<RunRecord> {
    const row = await this.prisma.run.update({
      where: { id },
      data: {
        status,
        ...(patch.failureReason === undefined ? {} : { failureReason: patch.failureReason }),
        ...(patch.startedAt === undefined ? {} : { startedAt: patch.startedAt }),
        ...(patch.completedAt === undefined ? {} : { completedAt: patch.completedAt }),
        ...(patch.repairCount === undefined ? {} : { repairCount: patch.repairCount }),
      },
    });
    return toRecord(row);
  }
}
```

- [ ] **Step 12: Implement `src/persistence/prisma/webhook-log.prisma.ts`**

```ts
import { Prisma } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import type { WebhookLog } from "~/domain/runs/run-repository.js";

export class PrismaWebhookLog implements WebhookLog {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async recordIfNew(input: {
    tenantId: string | null;
    deliveryId: string;
    eventType: string;
  }): Promise<boolean> {
    try {
      await this.prisma.processedWebhook.create({
        data: { tenantId: input.tenantId, deliveryId: input.deliveryId, eventType: input.eventType },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
      throw error;
    }
  }
}
```

- [ ] **Step 13: Run the tests to verify they pass**

Run: `npm run test:integration -- run-repository`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat: add PostgreSQL schema, Run repository, and webhook idempotency log"
```
---

### Task 4: Project registry, secret encryption, tenant registry

**Files:**
- Create: `src/domain/policy/crypto.ts`, `src/domain/projects/project-registry.ts`, `src/domain/projects/secret-store.ts`, `src/persistence/prisma/project-registry.prisma.ts`
- Test: `tests/unit/crypto.test.ts`, `tests/integration/project-registry.test.ts`

**Interfaces:**
- Consumes: `FactoreePrismaClient` from Task 3.
- Produces:
  - `encryptSecret(plaintext: string, keyHex: string): string` and `decryptSecret(cipher: string, keyHex: string): string`. The cipher format is `v1.<iv-base64>.<tag-base64>.<ciphertext-base64>`.
  - `interface ProjectRecord { id; tenantId; key; name; primaryRepository; referenceRepositories: string[]; linearTeamId: string | null; defaultAutonomy: string; maxRunMinutes: number; createdAt: Date; updatedAt: Date }`
  - `interface ProjectRegistry` with `create`, `list`, `findById`, `findByLinearTeam`, `findDefaultForTenant`, `update`, `remove`.
  - `interface SecretStore` with `put(tenantId, projectId, name, value)`, `get(tenantId, projectId, name)`, `listNames(tenantId, projectId)`, `remove(tenantId, projectId, name)`.
  - `interface TenantRegistry` with `ensureTenant(linearWorkspaceId: string, name: string)`, `findByWorkspace(linearWorkspaceId: string)`, `putInstallation(input)`, `getInstallationToken(linearWorkspaceId: string)`.

- [ ] **Step 1: Write the failing crypto test**

`tests/unit/crypto.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "~/domain/policy/crypto.js";

const key = "a".repeat(64);

describe("secret encryption", () => {
  it("returns the original value after a round trip", () => {
    const cipher = encryptSecret("super-secret", key);
    expect(decryptSecret(cipher, key)).toBe("super-secret");
  });

  it("never stores the plaintext in the cipher text", () => {
    expect(encryptSecret("super-secret", key)).not.toContain("super-secret");
  });

  it("produces a different cipher text for the same input", () => {
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it("rejects a modified cipher text", () => {
    const cipher = encryptSecret("super-secret", key);
    const parts = cipher.split(".");
    const broken = [parts[0], parts[1], parts[2], Buffer.from("tampered").toString("base64")].join(".");
    expect(() => decryptSecret(broken, key)).toThrow();
  });

  it("rejects a key of the wrong size", () => {
    expect(() => encryptSecret("value", "abcd")).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- crypto`
Expected: FAIL, because `~/domain/policy/crypto.js` does not exist.

- [ ] **Step 3: Implement `src/domain/policy/crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

const toKey = (keyHex: string): Buffer => {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("FACTOREE_SECRET_KEY must be 32 bytes of hexadecimal");
  }
  return Buffer.from(keyHex, "hex");
};

export const encryptSecret = (plaintext: string, keyHex: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", toKey(keyHex), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
};

export const decryptSecret = (value: string, keyHex: string): string => {
  const [version, ivPart, tagPart, bodyPart] = value.split(".");
  if (version !== VERSION || !ivPart || !tagPart || !bodyPart) {
    throw new Error("unsupported cipher text format");
  }
  const decipher = createDecipheriv("aes-256-gcm", toKey(keyHex), Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(bodyPart, "base64")), decipher.final()]).toString("utf8");
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- crypto`
Expected: PASS.

- [ ] **Step 5: Implement the domain ports**

`src/domain/projects/project-registry.ts`:

```ts
export interface ProjectRecord {
  id: string;
  tenantId: string;
  key: string;
  name: string;
  primaryRepository: string;
  referenceRepositories: string[];
  linearTeamId: string | null;
  defaultAutonomy: string;
  maxRunMinutes: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectInput {
  tenantId: string;
  key: string;
  name: string;
  primaryRepository: string;
  referenceRepositories?: string[];
  linearTeamId?: string;
  defaultAutonomy?: string;
  maxRunMinutes?: number;
}

export type UpdateProjectInput = Partial<Omit<CreateProjectInput, "tenantId" | "key">>;

export interface ProjectRegistry {
  create(input: CreateProjectInput): Promise<ProjectRecord>;
  list(tenantId: string): Promise<ProjectRecord[]>;
  findById(tenantId: string, id: string): Promise<ProjectRecord | null>;
  findByLinearTeam(tenantId: string, linearTeamId: string): Promise<ProjectRecord | null>;
  findDefaultForTenant(tenantId: string): Promise<ProjectRecord | null>;
  update(tenantId: string, id: string, input: UpdateProjectInput): Promise<ProjectRecord | null>;
  remove(tenantId: string, id: string): Promise<boolean>;
}

export interface TenantRecord {
  id: string;
  linearWorkspaceId: string;
  name: string;
}

export interface InstallationInput {
  linearWorkspaceId: string;
  workspaceName: string;
  appUserId?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
}

export interface TenantRegistry {
  ensureTenant(linearWorkspaceId: string, name: string): Promise<TenantRecord>;
  findByWorkspace(linearWorkspaceId: string): Promise<TenantRecord | null>;
  putInstallation(input: InstallationInput): Promise<TenantRecord>;
  getInstallationToken(linearWorkspaceId: string): Promise<string | null>;
}
```

`src/domain/projects/secret-store.ts`:

```ts
export interface SecretStore {
  put(tenantId: string, projectId: string, name: string, value: string): Promise<void>;
  get(tenantId: string, projectId: string, name: string): Promise<string | null>;
  listNames(tenantId: string, projectId: string): Promise<string[]>;
  remove(tenantId: string, projectId: string, name: string): Promise<boolean>;
}
```

- [ ] **Step 6: Write the failing registry integration test**

`tests/integration/project-registry.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import {
  PrismaProjectRegistry,
  PrismaSecretStore,
  PrismaTenantRegistry,
} from "~/persistence/prisma/project-registry.prisma.js";

const key = "b".repeat(64);
let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let tenants: PrismaTenantRegistry;
let projects: PrismaProjectRegistry;
let secrets: PrismaSecretStore;

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  tenants = new PrismaTenantRegistry(prisma, key);
  projects = new PrismaProjectRegistry(prisma);
  secrets = new PrismaSecretStore(prisma, key);
});

afterAll(async () => {
  await prisma.$disconnect();
  await stop();
});

describe("project registry", () => {
  it("creates and lists a project inside one tenant", async () => {
    const tenant = await tenants.ensureTenant("ws-1", "Workspace One");
    const project = await projects.create({
      tenantId: tenant.id,
      key: "demo",
      name: "Demo",
      primaryRepository: "acme/demo",
      linearTeamId: "team-1",
    });
    expect(project.maxRunMinutes).toBe(90);
    expect(project.defaultAutonomy).toBe("L2");
    expect(await projects.list(tenant.id)).toHaveLength(1);
    expect(await projects.findByLinearTeam(tenant.id, "team-1")).not.toBeNull();
  });

  it("does not return another tenant project", async () => {
    const first = await tenants.ensureTenant("ws-2", "Workspace Two");
    const second = await tenants.ensureTenant("ws-3", "Workspace Three");
    const project = await projects.create({
      tenantId: first.id,
      key: "one",
      name: "One",
      primaryRepository: "acme/one",
    });
    expect(await projects.findById(second.id, project.id)).toBeNull();
    expect(await projects.list(second.id)).toHaveLength(0);
    expect(await projects.update(second.id, project.id, { name: "Stolen" })).toBeNull();
    expect(await projects.remove(second.id, project.id)).toBe(false);
  });

  it("stores a secret encrypted and reads it back", async () => {
    const tenant = await tenants.ensureTenant("ws-4", "Workspace Four");
    const project = await projects.create({
      tenantId: tenant.id,
      key: "secrets",
      name: "Secrets",
      primaryRepository: "acme/secrets",
    });
    await secrets.put(tenant.id, project.id, "GITHUB_TOKEN", "ghp_value_for_test_1234567890");
    const stored = await prisma.projectSecret.findFirstOrThrow({ where: { projectId: project.id } });
    expect(stored.valueCipher).not.toContain("ghp_value_for_test_1234567890");
    expect(await secrets.get(tenant.id, project.id, "GITHUB_TOKEN")).toBe("ghp_value_for_test_1234567890");
    expect(await secrets.listNames(tenant.id, project.id)).toEqual(["GITHUB_TOKEN"]);
  });

  it("does not return a secret to another tenant", async () => {
    const owner = await tenants.ensureTenant("ws-5", "Workspace Five");
    const other = await tenants.ensureTenant("ws-6", "Workspace Six");
    const project = await projects.create({
      tenantId: owner.id,
      key: "guard",
      name: "Guard",
      primaryRepository: "acme/guard",
    });
    await secrets.put(owner.id, project.id, "TOKEN", "value-1234567890");
    expect(await secrets.get(other.id, project.id, "TOKEN")).toBeNull();
    expect(await secrets.listNames(other.id, project.id)).toEqual([]);
  });

  it("stores the installation access token encrypted", async () => {
    await tenants.putInstallation({
      linearWorkspaceId: "ws-7",
      workspaceName: "Workspace Seven",
      accessToken: "lin_oauth_abcdefghijklmnopqrstuvwxyz012345",
    });
    const row = await prisma.linearInstallation.findFirstOrThrow({ where: { linearWorkspaceId: "ws-7" } });
    expect(row.accessTokenCipher).not.toContain("lin_oauth_abcdefghijklmnopqrstuvwxyz012345");
    expect(await tenants.getInstallationToken("ws-7")).toBe("lin_oauth_abcdefghijklmnopqrstuvwxyz012345");
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm run test:integration -- project-registry`
Expected: FAIL, because `~/persistence/prisma/project-registry.prisma.js` does not exist.

- [ ] **Step 8: Implement `src/persistence/prisma/project-registry.prisma.ts`**

```ts
import type { FactoreePrismaClient } from "./client.js";
import { decryptSecret, encryptSecret } from "~/domain/policy/crypto.js";
import type {
  CreateProjectInput,
  InstallationInput,
  ProjectRecord,
  ProjectRegistry,
  TenantRecord,
  TenantRegistry,
  UpdateProjectInput,
} from "~/domain/projects/project-registry.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";

type ProjectRow = {
  id: string;
  tenantId: string;
  key: string;
  name: string;
  primaryRepository: string;
  referenceRepositories: string[];
  linearTeamId: string | null;
  defaultAutonomy: string;
  maxRunMinutes: number;
  createdAt: Date;
  updatedAt: Date;
};

const toProject = (row: ProjectRow): ProjectRecord => ({ ...row });

export class PrismaProjectRegistry implements ProjectRegistry {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async create(input: CreateProjectInput): Promise<ProjectRecord> {
    const row = await this.prisma.project.create({
      data: {
        tenantId: input.tenantId,
        key: input.key,
        name: input.name,
        primaryRepository: input.primaryRepository,
        referenceRepositories: input.referenceRepositories ?? [],
        ...(input.linearTeamId === undefined ? {} : { linearTeamId: input.linearTeamId }),
        ...(input.defaultAutonomy === undefined ? {} : { defaultAutonomy: input.defaultAutonomy }),
        ...(input.maxRunMinutes === undefined ? {} : { maxRunMinutes: input.maxRunMinutes }),
      },
    });
    return toProject(row);
  }

  async list(tenantId: string): Promise<ProjectRecord[]> {
    const rows = await this.prisma.project.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
    return rows.map(toProject);
  }

  async findById(tenantId: string, id: string): Promise<ProjectRecord | null> {
    const row = await this.prisma.project.findFirst({ where: { id, tenantId } });
    return row ? toProject(row) : null;
  }

  async findByLinearTeam(tenantId: string, linearTeamId: string): Promise<ProjectRecord | null> {
    const row = await this.prisma.project.findFirst({ where: { tenantId, linearTeamId } });
    return row ? toProject(row) : null;
  }

  async findDefaultForTenant(tenantId: string): Promise<ProjectRecord | null> {
    const rows = await this.prisma.project.findMany({ where: { tenantId }, take: 2 });
    return rows.length === 1 && rows[0] ? toProject(rows[0]) : null;
  }

  async update(tenantId: string, id: string, input: UpdateProjectInput): Promise<ProjectRecord | null> {
    const existing = await this.findById(tenantId, id);
    if (!existing) return null;
    const row = await this.prisma.project.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.primaryRepository === undefined ? {} : { primaryRepository: input.primaryRepository }),
        ...(input.referenceRepositories === undefined ? {} : { referenceRepositories: input.referenceRepositories }),
        ...(input.linearTeamId === undefined ? {} : { linearTeamId: input.linearTeamId }),
        ...(input.defaultAutonomy === undefined ? {} : { defaultAutonomy: input.defaultAutonomy }),
        ...(input.maxRunMinutes === undefined ? {} : { maxRunMinutes: input.maxRunMinutes }),
      },
    });
    return toProject(row);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const existing = await this.findById(tenantId, id);
    if (!existing) return false;
    await this.prisma.project.delete({ where: { id } });
    return true;
  }
}

export class PrismaSecretStore implements SecretStore {
  constructor(private readonly prisma: FactoreePrismaClient, private readonly keyHex: string) {}

  async put(tenantId: string, projectId: string, name: string, value: string): Promise<void> {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, tenantId } });
    if (!project) throw new Error("project not found for tenant");
    const valueCipher = encryptSecret(value, this.keyHex);
    await this.prisma.projectSecret.upsert({
      where: { projectId_name: { projectId, name } },
      create: { tenantId, projectId, name, valueCipher },
      update: { valueCipher },
    });
  }

  async get(tenantId: string, projectId: string, name: string): Promise<string | null> {
    const row = await this.prisma.projectSecret.findFirst({ where: { tenantId, projectId, name } });
    return row ? decryptSecret(row.valueCipher, this.keyHex) : null;
  }

  async listNames(tenantId: string, projectId: string): Promise<string[]> {
    const rows = await this.prisma.projectSecret.findMany({
      where: { tenantId, projectId },
      orderBy: { name: "asc" },
    });
    return rows.map((row) => row.name);
  }

  async remove(tenantId: string, projectId: string, name: string): Promise<boolean> {
    const row = await this.prisma.projectSecret.findFirst({ where: { tenantId, projectId, name } });
    if (!row) return false;
    await this.prisma.projectSecret.delete({ where: { id: row.id } });
    return true;
  }
}

export class PrismaTenantRegistry implements TenantRegistry {
  constructor(private readonly prisma: FactoreePrismaClient, private readonly keyHex: string) {}

  async ensureTenant(linearWorkspaceId: string, name: string): Promise<TenantRecord> {
    const row = await this.prisma.tenant.upsert({
      where: { linearWorkspaceId },
      create: { linearWorkspaceId, name },
      update: {},
    });
    return { id: row.id, linearWorkspaceId: row.linearWorkspaceId, name: row.name };
  }

  async findByWorkspace(linearWorkspaceId: string): Promise<TenantRecord | null> {
    const row = await this.prisma.tenant.findUnique({ where: { linearWorkspaceId } });
    return row ? { id: row.id, linearWorkspaceId: row.linearWorkspaceId, name: row.name } : null;
  }

  async putInstallation(input: InstallationInput): Promise<TenantRecord> {
    const tenant = await this.ensureTenant(input.linearWorkspaceId, input.workspaceName);
    const accessTokenCipher = encryptSecret(input.accessToken, this.keyHex);
    const refreshTokenCipher =
      input.refreshToken === undefined ? null : encryptSecret(input.refreshToken, this.keyHex);
    await this.prisma.linearInstallation.upsert({
      where: { linearWorkspaceId: input.linearWorkspaceId },
      create: {
        tenantId: tenant.id,
        linearWorkspaceId: input.linearWorkspaceId,
        appUserId: input.appUserId ?? null,
        accessTokenCipher,
        refreshTokenCipher,
        expiresAt: input.expiresAt ?? null,
        scopes: input.scopes ?? [],
      },
      update: {
        appUserId: input.appUserId ?? null,
        accessTokenCipher,
        refreshTokenCipher,
        expiresAt: input.expiresAt ?? null,
        scopes: input.scopes ?? [],
      },
    });
    return tenant;
  }

  async getInstallationToken(linearWorkspaceId: string): Promise<string | null> {
    const row = await this.prisma.linearInstallation.findUnique({ where: { linearWorkspaceId } });
    return row ? decryptSecret(row.accessTokenCipher, this.keyHex) : null;
  }
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm run test:integration -- project-registry`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add project registry, tenant registry, and encrypted secret store"
```
---

### Task 5: Linear webhook verification and payload schemas

**Files:**
- Create: `src/adapters/linear/webhook-verifier.ts`, `src/adapters/linear/webhook-schemas.ts`
- Test: `tests/unit/linear-webhook-verifier.test.ts`, `tests/unit/linear-webhook-schemas.test.ts`, `tests/fixtures/linear/agent-session-created.json`, `tests/fixtures/linear/agent-session-prompted-stop.json`

**Background:** Linear signs a webhook with an HMAC SHA-256 of the raw request body, keyed with the webhook secret, and sends it in the `linear-signature` header as lower-case hexadecimal. The body carries `webhookTimestamp` in milliseconds. Linear sends `AgentSessionEvent` with `action: "created"` for a delegation and `action: "prompted"` for a follow-up. A stop request arrives as `action: "prompted"` with `agentActivity.signal === "stop"`.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `verifyLinearSignature(input: { rawBody: Buffer | string; signature: string | undefined; secret: string; timestampMs?: number; now?: number; toleranceMs?: number }): { ok: true } | { ok: false; reason: LinearSignatureFailure }` where `LinearSignatureFailure` is `"missing_signature" | "bad_signature" | "stale_timestamp"`.
  - `agentSessionEventSchema` (Zod) and `type AgentSessionEvent`.
  - `classifyAgentSessionEvent(event: AgentSessionEvent): AgentSessionCommand` returning
    `{ kind: "delegation" } | { kind: "prompt"; body: string } | { kind: "stop" } | { kind: "ignore"; reason: string }`.

- [ ] **Step 1: Create the fixtures**

`tests/fixtures/linear/agent-session-created.json`:

```json
{
  "type": "AgentSessionEvent",
  "action": "created",
  "createdAt": "2026-08-21T10:00:00.000Z",
  "organizationId": "workspace-123",
  "oauthClientId": "oauth-client-1",
  "appUserId": "app-user-1",
  "webhookId": "webhook-1",
  "webhookTimestamp": 1755770400000,
  "promptContext": "Issue: Add a health endpoint",
  "agentSession": {
    "id": "session-1",
    "appUserId": "app-user-1",
    "organizationId": "workspace-123",
    "createdAt": "2026-08-21T10:00:00.000Z",
    "updatedAt": "2026-08-21T10:00:00.000Z",
    "status": "pending",
    "type": "commentThread",
    "issueId": "issue-1",
    "creatorId": "user-1",
    "issue": {
      "id": "issue-1",
      "identifier": "FAC-1",
      "title": "Add a health endpoint",
      "description": "## Goal\n\nExpose a health endpoint.",
      "teamId": "team-1",
      "url": "https://linear.app/acme/issue/FAC-1"
    },
    "creator": { "id": "user-1", "name": "Nate" }
  }
}
```

`tests/fixtures/linear/agent-session-prompted-stop.json`:

```json
{
  "type": "AgentSessionEvent",
  "action": "prompted",
  "createdAt": "2026-08-21T10:05:00.000Z",
  "organizationId": "workspace-123",
  "oauthClientId": "oauth-client-1",
  "appUserId": "app-user-1",
  "webhookId": "webhook-2",
  "webhookTimestamp": 1755770700000,
  "agentActivity": {
    "id": "activity-1",
    "signal": "stop",
    "content": { "type": "prompt", "body": "" }
  },
  "agentSession": {
    "id": "session-1",
    "appUserId": "app-user-1",
    "organizationId": "workspace-123",
    "createdAt": "2026-08-21T10:00:00.000Z",
    "updatedAt": "2026-08-21T10:05:00.000Z",
    "status": "active",
    "type": "commentThread",
    "issueId": "issue-1"
  }
}
```

- [ ] **Step 2: Write the failing verifier test**

`tests/unit/linear-webhook-verifier.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyLinearSignature } from "~/adapters/linear/webhook-verifier.js";

const secret = "webhook-secret";
const body = JSON.stringify({ hello: "world", webhookTimestamp: 1_000_000 });
const sign = (value: string) => createHmac("sha256", secret).update(value).digest("hex");

describe("verifyLinearSignature", () => {
  it("accepts a correct signature", () => {
    const result = verifyLinearSignature({
      rawBody: body,
      signature: sign(body),
      secret,
      timestampMs: 1_000_000,
      now: 1_000_000,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing signature", () => {
    const result = verifyLinearSignature({ rawBody: body, signature: undefined, secret });
    expect(result).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("rejects a wrong signature", () => {
    const result = verifyLinearSignature({ rawBody: body, signature: sign("other body"), secret });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature of the wrong length without throwing", () => {
    const result = verifyLinearSignature({ rawBody: body, signature: "abc", secret });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a stale timestamp", () => {
    const result = verifyLinearSignature({
      rawBody: body,
      signature: sign(body),
      secret,
      timestampMs: 1_000_000,
      now: 1_000_000 + 61_000,
      toleranceMs: 60_000,
    });
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- linear-webhook-verifier`
Expected: FAIL, because the module does not exist.

- [ ] **Step 4: Implement `src/adapters/linear/webhook-verifier.ts`**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export type LinearSignatureFailure = "missing_signature" | "bad_signature" | "stale_timestamp";

export type LinearSignatureResult = { ok: true } | { ok: false; reason: LinearSignatureFailure };

export interface VerifyLinearSignatureInput {
  rawBody: Buffer | string;
  signature: string | undefined;
  secret: string;
  timestampMs?: number;
  now?: number;
  toleranceMs?: number;
}

const DEFAULT_TOLERANCE_MS = 60_000;

export const verifyLinearSignature = (input: VerifyLinearSignatureInput): LinearSignatureResult => {
  if (!input.signature) return { ok: false, reason: "missing_signature" };

  const expected = createHmac("sha256", input.secret)
    .update(typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : input.rawBody)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(input.signature, "hex");
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  if (input.timestampMs !== undefined) {
    const now = input.now ?? Date.now();
    const tolerance = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;
    if (Math.abs(now - input.timestampMs) > tolerance) return { ok: false, reason: "stale_timestamp" };
  }

  return { ok: true };
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- linear-webhook-verifier`
Expected: PASS.

- [ ] **Step 6: Write the failing schema test**

`tests/unit/linear-webhook-schemas.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agentSessionEventSchema,
  classifyAgentSessionEvent,
} from "~/adapters/linear/webhook-schemas.js";

const load = (name: string): unknown =>
  JSON.parse(readFileSync(`tests/fixtures/linear/${name}.json`, "utf8")) as unknown;

describe("agentSessionEventSchema", () => {
  it("parses a delegation event", () => {
    const event = agentSessionEventSchema.parse(load("agent-session-created"));
    expect(event.action).toBe("created");
    expect(event.organizationId).toBe("workspace-123");
    expect(event.agentSession.id).toBe("session-1");
    expect(event.agentSession.issue?.teamId).toBe("team-1");
    expect(classifyAgentSessionEvent(event)).toEqual({ kind: "delegation" });
  });

  it("parses a stop event", () => {
    const event = agentSessionEventSchema.parse(load("agent-session-prompted-stop"));
    expect(classifyAgentSessionEvent(event)).toEqual({ kind: "stop" });
  });

  it("classifies a follow-up prompt", () => {
    const raw = load("agent-session-prompted-stop") as Record<string, unknown>;
    const event = agentSessionEventSchema.parse({
      ...raw,
      agentActivity: { id: "activity-2", content: { type: "prompt", body: "please use Postgres" } },
    });
    expect(classifyAgentSessionEvent(event)).toEqual({ kind: "prompt", body: "please use Postgres" });
  });

  it("ignores an unknown action", () => {
    const raw = load("agent-session-created") as Record<string, unknown>;
    const event = agentSessionEventSchema.parse({ ...raw, action: "archived" });
    expect(classifyAgentSessionEvent(event).kind).toBe("ignore");
  });

  it("rejects a payload without an agent session", () => {
    const raw = load("agent-session-created") as Record<string, unknown>;
    delete raw.agentSession;
    expect(() => agentSessionEventSchema.parse(raw)).toThrow();
  });

  it("keeps unknown fields out of the parsed value", () => {
    const raw = load("agent-session-created") as Record<string, unknown>;
    const event = agentSessionEventSchema.parse({ ...raw, futureField: "ignored" });
    expect(event).not.toHaveProperty("futureField");
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test -- linear-webhook-schemas`
Expected: FAIL, because the module does not exist.

- [ ] **Step 8: Implement `src/adapters/linear/webhook-schemas.ts`**

The schema is permissive about fields Linear may add, and strict about the fields Factoree needs.

```ts
import { z } from "zod";

const issueSchema = z.object({
  id: z.string(),
  identifier: z.string().optional(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  teamId: z.string().optional(),
  url: z.string().optional(),
});

const agentSessionSchema = z.object({
  id: z.string(),
  appUserId: z.string().optional(),
  organizationId: z.string().optional(),
  issueId: z.string().nullable().optional(),
  commentId: z.string().nullable().optional(),
  creatorId: z.string().nullable().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  url: z.string().nullable().optional(),
  issue: issueSchema.nullable().optional(),
  creator: z.object({ id: z.string(), name: z.string().optional() }).nullable().optional(),
});

const agentActivitySchema = z.object({
  id: z.string().optional(),
  signal: z.string().nullable().optional(),
  content: z
    .object({ type: z.string().optional(), body: z.string().optional() })
    .nullable()
    .optional(),
});

export const agentSessionEventSchema = z.object({
  type: z.literal("AgentSessionEvent"),
  action: z.string(),
  organizationId: z.string(),
  oauthClientId: z.string().optional(),
  appUserId: z.string().optional(),
  webhookId: z.string().optional(),
  webhookTimestamp: z.number().optional(),
  promptContext: z.string().nullable().optional(),
  agentActivity: agentActivitySchema.nullable().optional(),
  agentSession: agentSessionSchema,
});

export type AgentSessionEvent = z.infer<typeof agentSessionEventSchema>;

export type AgentSessionCommand =
  | { kind: "delegation" }
  | { kind: "prompt"; body: string }
  | { kind: "stop" }
  | { kind: "ignore"; reason: string };

export const classifyAgentSessionEvent = (event: AgentSessionEvent): AgentSessionCommand => {
  if (event.action === "created") return { kind: "delegation" };
  if (event.action !== "prompted") return { kind: "ignore", reason: `unsupported action ${event.action}` };
  if (event.agentActivity?.signal === "stop") return { kind: "stop" };
  return { kind: "prompt", body: event.agentActivity?.content?.body ?? "" };
};
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test -- linear-webhook`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: verify Linear webhook signatures and parse agent session events"
```
---

### Task 6: Agent session port and Linear adapter

**Files:**
- Create: `src/domain/runs/ports.ts`, `src/adapters/linear/linear-agent-client.ts`
- Test: `tests/unit/linear-agent-client.test.ts`

**Background:** SDD section 26 requires delegation, mention, progress, elicitation, stop, and final response. Linear expects a `thought` activity within 10 seconds to acknowledge a session. The Linear SDK method is `linearClient.createAgentActivity({ agentSessionId, content })`. Content types are `thought`, `action`, `response`, `elicitation`, and `error`.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface AgentSessionPort` with:
    - `acknowledge(sessionId: string, message: string): Promise<void>`
    - `progress(sessionId: string, message: string): Promise<void>`
    - `elicit(sessionId: string, question: string): Promise<void>`
    - `respond(sessionId: string, body: string): Promise<void>`
    - `fail(sessionId: string, message: string): Promise<void>`
  - `class LinearAgentClient implements AgentSessionPort` with `constructor(client: AgentActivityCreator)`.
  - `interface AgentActivityCreator { createAgentActivity(input: { agentSessionId: string; content: AgentActivityContent }): Promise<unknown> }`.
  - `createLinearAgentClient(accessToken: string): LinearAgentClient`.

- [ ] **Step 1: Implement `src/domain/runs/ports.ts`**

Domain code must not import the Linear SDK.

```ts
export interface AgentSessionPort {
  acknowledge(sessionId: string, message: string): Promise<void>;
  progress(sessionId: string, message: string): Promise<void>;
  elicit(sessionId: string, question: string): Promise<void>;
  respond(sessionId: string, body: string): Promise<void>;
  fail(sessionId: string, message: string): Promise<void>;
}
```

- [ ] **Step 2: Write the failing adapter test**

`tests/unit/linear-agent-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { LinearAgentClient } from "~/adapters/linear/linear-agent-client.js";

const spyClient = () => {
  const calls: Array<{ agentSessionId: string; content: Record<string, unknown> }> = [];
  return {
    calls,
    createAgentActivity: vi.fn(async (input: { agentSessionId: string; content: Record<string, unknown> }) => {
      calls.push(input);
      return { success: true };
    }),
  };
};

describe("LinearAgentClient", () => {
  it("acknowledges a session with a thought activity", async () => {
    const client = spyClient();
    await new LinearAgentClient(client).acknowledge("session-1", "Factoree accepted the work.");
    expect(client.calls[0]).toEqual({
      agentSessionId: "session-1",
      content: { type: "thought", body: "Factoree accepted the work." },
    });
  });

  it("reports progress with a thought activity", async () => {
    const client = spyClient();
    await new LinearAgentClient(client).progress("session-1", "Resolving context.");
    expect(client.calls[0]?.content).toEqual({ type: "thought", body: "Resolving context." });
  });

  it("asks a question with an elicitation activity", async () => {
    const client = spyClient();
    await new LinearAgentClient(client).elicit("session-1", "Which database?");
    expect(client.calls[0]?.content).toEqual({ type: "elicitation", body: "Which database?" });
  });

  it("sends the final result with a response activity", async () => {
    const client = spyClient();
    await new LinearAgentClient(client).respond("session-1", "Proof Pack");
    expect(client.calls[0]?.content).toEqual({ type: "response", body: "Proof Pack" });
  });

  it("reports a failure with an error activity", async () => {
    const client = spyClient();
    await new LinearAgentClient(client).fail("session-1", "Run failed.");
    expect(client.calls[0]?.content).toEqual({ type: "error", body: "Run failed." });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- linear-agent-client`
Expected: FAIL, because the module does not exist.

- [ ] **Step 4: Implement `src/adapters/linear/linear-agent-client.ts`**

```ts
import { LinearClient } from "@linear/sdk";
import type { AgentSessionPort } from "~/domain/runs/ports.js";

export type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

export interface AgentActivityCreator {
  createAgentActivity(input: {
    agentSessionId: string;
    content: AgentActivityContent;
  }): Promise<unknown>;
}

export class LinearAgentClient implements AgentSessionPort {
  constructor(private readonly client: AgentActivityCreator) {}

  private async emit(sessionId: string, content: AgentActivityContent): Promise<void> {
    await this.client.createAgentActivity({ agentSessionId: sessionId, content });
  }

  acknowledge(sessionId: string, message: string): Promise<void> {
    return this.emit(sessionId, { type: "thought", body: message });
  }

  progress(sessionId: string, message: string): Promise<void> {
    return this.emit(sessionId, { type: "thought", body: message });
  }

  elicit(sessionId: string, question: string): Promise<void> {
    return this.emit(sessionId, { type: "elicitation", body: question });
  }

  respond(sessionId: string, body: string): Promise<void> {
    return this.emit(sessionId, { type: "response", body });
  }

  fail(sessionId: string, message: string): Promise<void> {
    return this.emit(sessionId, { type: "error", body: message });
  }
}

export const createLinearAgentClient = (accessToken: string): LinearAgentClient =>
  new LinearAgentClient(new LinearClient({ accessToken }) as unknown as AgentActivityCreator);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- linear-agent-client`
Expected: PASS.

- [ ] **Step 6: Check the SDK content types compile**

Run: `npm run typecheck`
Expected: PASS. If the SDK rejects the literal content type, import `LinearDocument as L` from `@linear/sdk` and use `L.AgentActivityType.Thought`, `L.AgentActivityType.Elicitation`, `L.AgentActivityType.Response`, and `L.AgentActivityType.Error` for the `type` values. Keep the emitted values equal to the strings the test expects.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add agent session port and Linear agent activity adapter"
```
---

### Task 7: Temporal workflow skeleton, activities, and worker

**Files:**
- Create: `src/temporal/workflow-id.ts`, `src/temporal/connection.ts`, `src/workflows/agent-run.workflow.ts`, `src/activities/run.activities.ts`, `src/activities/linear.activities.ts`, `src/activities/index.ts`, `src/bin/worker.ts`
- Test: `tests/unit/workflow-id.test.ts`, `tests/workflow/agent-run.workflow.test.ts`

**Background:** SDD section 26 fixes the workflow ID as `linear:{workspaceId}:{agentSessionId}`. SDD section 49 defines the workflow order. Phase 1 implements the `receive` step and the control behavior around it: the workflow creates the durable Run, acknowledges the Linear session, then waits for a stop signal, a human input signal, or the Run timeout. Later phases replace the wait with the refinement and delivery steps. SDD section 50 sets the default maximum Run duration at 90 minutes and the timeout failure reason at `RUN_TIMEOUT`.

**Interfaces:**
- Consumes: `RunRepository`, `RunStatus` (Task 3); `AgentSessionPort` (Task 6).
- Produces:
  - `buildWorkflowId(workspaceId: string, agentSessionId: string): string`.
  - `agentRunWorkflow(input: AgentRunWorkflowInput): Promise<AgentRunWorkflowResult>`.
  - `type AgentRunWorkflowInput = { tenantId: string; workspaceId: string; projectId: string; linearIssueId: string | null; agentSessionId: string; autonomyLevel: string; maxRunMinutes: number }`.
  - `type AgentRunWorkflowResult = { runId: string; status: RunStatus }`.
  - `stopSignal: SignalDefinition<[]>`, `humanInputSignal: SignalDefinition<[string]>`, `runStatusQuery: QueryDefinition<RunSnapshot>` where `RunSnapshot = { runId: string | null; status: RunStatus; humanInputs: string[] }`.
  - Activities `createRun`, `setRunStatus`, `completeRun`, `acknowledgeSession`, `postProgress`, `postFinalResponse`, `postError`.
  - `createActivities(dependencies: ActivityDependencies): Activities` in `src/activities/index.ts`.
  - `type ActivityDependencies = { runs: RunRepository; agentSession: AgentSessionPort; logger: Logger }`.

- [ ] **Step 1: Write the failing workflow ID test**

`tests/unit/workflow-id.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildWorkflowId } from "~/temporal/workflow-id.js";

describe("buildWorkflowId", () => {
  it("uses the SDD section 26 format", () => {
    expect(buildWorkflowId("workspace-123", "session-1")).toBe("linear:workspace-123:session-1");
  });

  it("rejects an empty part", () => {
    expect(() => buildWorkflowId("", "session-1")).toThrow();
    expect(() => buildWorkflowId("workspace-123", "")).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- workflow-id`
Expected: FAIL.

- [ ] **Step 3: Implement `src/temporal/workflow-id.ts`**

```ts
export const buildWorkflowId = (workspaceId: string, agentSessionId: string): string => {
  if (!workspaceId || !agentSessionId) throw new Error("workspaceId and agentSessionId are required");
  return `linear:${workspaceId}:${agentSessionId}`;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- workflow-id`
Expected: PASS.

- [ ] **Step 5: Implement `src/activities/run.activities.ts`**

```ts
import type { Logger } from "~/telemetry/logger.js";
import type { CreateRunInput, RunRepository } from "~/domain/runs/run-repository.js";
import type { RunFailureReason, RunStatus } from "~/domain/runs/run-status.js";
import { metrics } from "~/telemetry/metrics.js";

export interface RunActivityDependencies {
  runs: RunRepository;
  logger: Logger;
}

export const createRunActivities = (dependencies: RunActivityDependencies) => ({
  async createRun(input: CreateRunInput): Promise<{ runId: string; created: boolean }> {
    const { run, created } = await dependencies.runs.createIfAbsent(input);
    if (created) {
      metrics.runsStarted.inc({ tenant_id: input.tenantId, project_id: input.projectId });
      metrics.activeRuns.inc({ tenant_id: input.tenantId, project_id: input.projectId });
    }
    dependencies.logger.info("run received", {
      tenant_id: run.tenantId,
      project_id: run.projectId,
      run_id: run.id,
      workflow_id: run.temporalWorkflowId,
      step: "receive",
    });
    return { runId: run.id, created };
  },

  async setRunStatus(input: { runId: string; status: RunStatus; startedAt?: string }): Promise<void> {
    await dependencies.runs.updateStatus(input.runId, input.status, {
      ...(input.startedAt === undefined ? {} : { startedAt: new Date(input.startedAt) }),
    });
  },

  async completeRun(input: {
    runId: string;
    status: RunStatus;
    failureReason?: RunFailureReason;
    completedAt: string;
  }): Promise<void> {
    const run = await dependencies.runs.updateStatus(input.runId, input.status, {
      ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
      completedAt: new Date(input.completedAt),
    });
    const labels = { tenant_id: run.tenantId, project_id: run.projectId };
    const completedAt = run.completedAt ?? new Date(input.completedAt);
    metrics.activeRuns.dec(labels);
    metrics.runDuration.observe(labels, (completedAt.getTime() - run.createdAt.getTime()) / 1000);
    if (input.status === "READY_FOR_HUMAN") metrics.runsReady.inc(labels);
    else if (input.status === "CANCELLED") metrics.runsCancelled.inc(labels);
    else metrics.runsFailed.inc({ ...labels, reason: input.failureReason ?? "UNKNOWN" });
    dependencies.logger.info("run completed", {
      tenant_id: run.tenantId,
      project_id: run.projectId,
      run_id: run.id,
      step: "complete",
      status: input.status,
    });
  },
});
```

- [ ] **Step 6: Implement `src/activities/linear.activities.ts`**

```ts
import type { AgentSessionPort } from "~/domain/runs/ports.js";

export interface LinearActivityDependencies {
  agentSession: AgentSessionPort;
}

export const createLinearActivities = (dependencies: LinearActivityDependencies) => ({
  acknowledgeSession: (input: { sessionId: string; message: string }): Promise<void> =>
    dependencies.agentSession.acknowledge(input.sessionId, input.message),
  postProgress: (input: { sessionId: string; message: string }): Promise<void> =>
    dependencies.agentSession.progress(input.sessionId, input.message),
  postElicitation: (input: { sessionId: string; question: string }): Promise<void> =>
    dependencies.agentSession.elicit(input.sessionId, input.question),
  postFinalResponse: (input: { sessionId: string; body: string }): Promise<void> =>
    dependencies.agentSession.respond(input.sessionId, input.body),
  postError: (input: { sessionId: string; message: string }): Promise<void> =>
    dependencies.agentSession.fail(input.sessionId, input.message),
});
```

- [ ] **Step 7: Implement `src/activities/index.ts`**

```ts
import type { Logger } from "~/telemetry/logger.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";
import { createRunActivities } from "./run.activities.js";
import { createLinearActivities } from "./linear.activities.js";

export interface ActivityDependencies {
  runs: RunRepository;
  agentSession: AgentSessionPort;
  logger: Logger;
}

export const createActivities = (dependencies: ActivityDependencies) => ({
  ...createRunActivities({ runs: dependencies.runs, logger: dependencies.logger }),
  ...createLinearActivities({ agentSession: dependencies.agentSession }),
});

export type Activities = ReturnType<typeof createActivities>;
```

- [ ] **Step 8: Write the failing workflow test**

`tests/workflow/agent-run.workflow.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { WorkflowFailedError } from "@temporalio/client";
import { agentRunWorkflow, stopSignal, runStatusQuery } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";

let environment: TestWorkflowEnvironment;
const created: string[] = [];
const acknowledged: string[] = [];
const completions: Array<{ runId: string; status: string; failureReason?: string }> = [];

const activities = {
  createRun: async (input: { linearAgentSessionId: string }) => {
    created.push(input.linearAgentSessionId);
    return { runId: `run-${input.linearAgentSessionId}`, created: created.filter((id) => id === input.linearAgentSessionId).length === 1 };
  },
  setRunStatus: async () => undefined,
  completeRun: async (input: { runId: string; status: string; failureReason?: string }) => {
    completions.push(input);
  },
  acknowledgeSession: async (input: { sessionId: string }) => {
    acknowledged.push(input.sessionId);
  },
  postProgress: async () => undefined,
  postElicitation: async () => undefined,
  postFinalResponse: async () => undefined,
  postError: async () => undefined,
};

const input = (sessionId: string, maxRunMinutes = 90) => ({
  tenantId: "tenant-1",
  workspaceId: "workspace-123",
  projectId: "project-1",
  linearIssueId: "issue-1",
  agentSessionId: sessionId,
  autonomyLevel: "L2",
  maxRunMinutes,
});

const runWorker = async <T>(body: () => Promise<T>): Promise<T> => {
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: "test",
    workflowsPath: new URL("../../src/workflows/agent-run.workflow.ts", import.meta.url).pathname,
    activities,
  });
  return worker.runUntil(body());
};

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

describe("agentRunWorkflow", () => {
  it("creates a durable Run and acknowledges the Linear session", async () => {
    const result = await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "session-a"),
        args: [input("session-a")],
      });
      await handle.signal(stopSignal);
      return handle.result();
    });
    expect(created).toContain("session-a");
    expect(acknowledged).toContain("session-a");
    expect(result.runId).toBe("run-session-a");
    expect(result.status).toBe("CANCELLED");
  });

  it("rejects a second workflow with the same workflow ID", async () => {
    await runWorker(async () => {
      const workflowId = buildWorkflowId("workspace-123", "session-b");
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId,
        args: [input("session-b")],
      });
      await expect(
        environment.client.workflow.start(agentRunWorkflow, {
          taskQueue: "test",
          workflowId,
          args: [input("session-b")],
        }),
      ).rejects.toThrow();
      await handle.signal(stopSignal);
      await handle.result();
    });
    expect(created.filter((id) => id === "session-b")).toHaveLength(1);
  });

  it("answers the status query while the Run waits", async () => {
    await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "session-c"),
        args: [input("session-c")],
      });
      const snapshot = await handle.query(runStatusQuery);
      expect(snapshot.runId).toBe("run-session-c");
      expect(snapshot.status).toBe("WAITING_FOR_INPUT");
      await handle.signal(stopSignal);
      await handle.result();
    });
  });

  it("fails with RUN_TIMEOUT after the maximum Run duration", async () => {
    const result = await runWorker(async () => {
      const handle = await environment.client.workflow.start(agentRunWorkflow, {
        taskQueue: "test",
        workflowId: buildWorkflowId("workspace-123", "session-d"),
        args: [input("session-d", 1)],
      });
      return handle.result();
    });
    expect(result.status).toBe("FAILED");
    expect(completions.at(-1)?.failureReason).toBe("RUN_TIMEOUT");
  });
});
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `npm run test:workflow`
Expected: FAIL, because `~/workflows/agent-run.workflow.js` does not exist.

- [ ] **Step 10: Implement `src/workflows/agent-run.workflow.ts`**

The workflow must not import Prisma or the Linear SDK. It calls activities only.

```ts
import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import type { RunStatus } from "~/domain/runs/run-status.js";
import type { Activities } from "~/activities/index.js";

export interface AgentRunWorkflowInput {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  linearIssueId: string | null;
  agentSessionId: string;
  autonomyLevel: string;
  maxRunMinutes: number;
}

export interface AgentRunWorkflowResult {
  runId: string;
  status: RunStatus;
}

export interface RunSnapshot {
  runId: string | null;
  status: RunStatus;
  humanInputs: string[];
}

export const stopSignal = defineSignal("stop");
export const humanInputSignal = defineSignal<[string]>("humanInput");
export const runStatusQuery = defineQuery<RunSnapshot>("runStatus");

const activities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, initialInterval: "1 second", backoffCoefficient: 2 },
});

export async function agentRunWorkflow(
  input: AgentRunWorkflowInput,
): Promise<AgentRunWorkflowResult> {
  let runId: string | null = null;
  let status: RunStatus = "RECEIVED";
  const humanInputs: string[] = [];
  let stopRequested = false;

  setHandler(stopSignal, () => {
    stopRequested = true;
  });
  setHandler(humanInputSignal, (body: string) => {
    humanInputs.push(body);
  });
  setHandler(runStatusQuery, () => ({ runId, status, humanInputs }));

  const created = await activities.createRun({
    tenantId: input.tenantId,
    projectId: input.projectId,
    linearIssueId: input.linearIssueId,
    linearAgentSessionId: input.agentSessionId,
    temporalWorkflowId: `linear:${input.workspaceId}:${input.agentSessionId}`,
    autonomyLevel: input.autonomyLevel,
  });
  runId = created.runId;

  await activities.acknowledgeSession({
    sessionId: input.agentSessionId,
    message: "Factoree accepted the work and started a Run.",
  });

  // The delivery pipeline of SDD section 49 is added by later phases. Until then the Run
  // stays open for a stop signal, for human input, or until the maximum Run duration ends it.
  status = "WAITING_FOR_INPUT";
  await activities.setRunStatus({ runId, status, startedAt: new Date().toISOString() });

  const timedOut = !(await Promise.race([
    condition(() => stopRequested).then(() => true),
    sleep(input.maxRunMinutes * 60_000).then(() => false),
  ]));

  if (timedOut) {
    status = "FAILED";
    await activities.postError({
      sessionId: input.agentSessionId,
      message: "Factoree stopped the Run because it reached the maximum Run duration.",
    });
    await activities.completeRun({
      runId,
      status,
      failureReason: "RUN_TIMEOUT",
      completedAt: new Date().toISOString(),
    });
    return { runId, status };
  }

  status = "CANCELLED";
  await activities.postFinalResponse({
    sessionId: input.agentSessionId,
    body: "Factoree stopped this Run at your request. No change was published.",
  });
  await activities.completeRun({
    runId,
    status,
    failureReason: "STOPPED_BY_HUMAN",
    completedAt: new Date().toISOString(),
  });
  return { runId, status };
}
```

- [ ] **Step 11: Run the workflow tests**

Run: `npm run test:workflow`
Expected: PASS. If `Date` use inside the workflow raises a determinism warning, replace `new Date().toISOString()` with `new Date(Date.now()).toISOString()`; inside a Temporal workflow `Date.now()` is deterministic and replay-safe.

- [ ] **Step 12: Implement `src/temporal/connection.ts`**

```ts
import { Connection, Client } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import type { Env } from "~/config/env.js";

const tlsOptions = (env: Env) => (env.TEMPORAL_API_KEY === undefined ? {} : { tls: true, apiKey: env.TEMPORAL_API_KEY });

export const createTemporalClient = async (env: Env): Promise<Client> => {
  const connection = await Connection.connect({ address: env.TEMPORAL_ADDRESS, ...tlsOptions(env) });
  return new Client({ connection, namespace: env.TEMPORAL_NAMESPACE });
};

export const createWorkerConnection = async (env: Env): Promise<NativeConnection> =>
  NativeConnection.connect({ address: env.TEMPORAL_ADDRESS, ...tlsOptions(env) });
```

- [ ] **Step 13: Implement `src/bin/worker.ts`**

```ts
import { Worker } from "@temporalio/worker";
import { loadEnv } from "~/config/env.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createPrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaTenantRegistry } from "~/persistence/prisma/project-registry.prisma.js";
import { createLinearAgentClient } from "~/adapters/linear/linear-agent-client.js";
import { createActivities } from "~/activities/index.js";
import { createWorkerConnection } from "~/temporal/connection.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";

const env = loadEnv();
const redactor = new Redactor([env.ADMIN_API_TOKEN, env.LINEAR_WEBHOOK_SECRET, env.FACTOREE_SECRET_KEY]);
const logger = createLogger({ level: env.LOG_LEVEL, redactor });
const prisma = createPrismaClient(env.DATABASE_URL);
const tenants = new PrismaTenantRegistry(prisma, env.FACTOREE_SECRET_KEY);

// The Linear access token belongs to the workspace of the Run. The session id carries the
// workspace prefix in the workflow id, so the activity resolves the client for each call.
const agentSession: AgentSessionPort = {
  acknowledge: (sessionId, message) => call(sessionId, (client) => client.acknowledge(sessionId, message)),
  progress: (sessionId, message) => call(sessionId, (client) => client.progress(sessionId, message)),
  elicit: (sessionId, question) => call(sessionId, (client) => client.elicit(sessionId, question)),
  respond: (sessionId, body) => call(sessionId, (client) => client.respond(sessionId, body)),
  fail: (sessionId, message) => call(sessionId, (client) => client.fail(sessionId, message)),
};

async function call(
  sessionId: string,
  body: (client: ReturnType<typeof createLinearAgentClient>) => Promise<void>,
): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { linearAgentSessionId: sessionId },
    select: { temporalWorkflowId: true },
  });
  const workspaceId = run?.temporalWorkflowId.split(":")[1];
  if (!workspaceId) throw new Error(`no workspace for agent session ${sessionId}`);
  const token = await tenants.getInstallationToken(workspaceId);
  if (!token) throw new Error(`no Linear installation for workspace ${workspaceId}`);
  await body(createLinearAgentClient(token));
}

const worker = await Worker.create({
  connection: await createWorkerConnection(env),
  namespace: env.TEMPORAL_NAMESPACE,
  taskQueue: env.TEMPORAL_TASK_QUEUE,
  workflowsPath: new URL("../workflows/agent-run.workflow.js", import.meta.url).pathname,
  activities: createActivities({ runs: new PrismaRunRepository(prisma), agentSession, logger }),
});

logger.info("worker started", { step: "boot" });
await worker.run();
```

- [ ] **Step 14: Run the checks**

Run: `npm run lint && npm run typecheck && npm run test:workflow`
Expected: all pass.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "feat: add Temporal workflow skeleton, run activities, and worker"
```
---

### Task 8: Fastify API, webhook route, admin endpoints, health

**Files:**
- Create: `src/http/server.ts`, `src/http/health.routes.ts`, `src/http/admin/auth.ts`, `src/http/admin/projects.routes.ts`, `src/http/admin/runs.routes.ts`, `src/http/admin/installations.routes.ts`, `src/http/webhooks/linear.routes.ts`, `src/domain/runs/delegation-service.ts`, `src/bin/api.ts`
- Test: `tests/unit/delegation-service.test.ts`, `tests/integration/admin-api.test.ts`

**Background:** SDD section 59 fixes the required endpoints. SDD section 26 requires idempotent webhook handling and a session acknowledgement before long work. The webhook route must answer inside five seconds, so it starts the workflow and returns.

**Interfaces:**
- Consumes: everything from Tasks 2 to 7.
- Produces:
  - `class DelegationService` with `handleAgentSessionEvent(event: AgentSessionEvent, deliveryId: string): Promise<DelegationOutcome>` where
    `DelegationOutcome = { kind: "started"; runId: string; workflowId: string } | { kind: "duplicate" } | { kind: "stopped"; workflowId: string } | { kind: "prompt_forwarded"; workflowId: string } | { kind: "ignored"; reason: string } | { kind: "unconfigured"; reason: string }`.
  - `interface WorkflowStarter` with
    `start(input: { workflowId: string; args: [AgentRunWorkflowInput] }): Promise<void>`,
    `signalStop(workflowId: string): Promise<void>`,
    `signalHumanInput(workflowId: string, body: string): Promise<void>`.
  - `createTemporalWorkflowStarter(client: Client, taskQueue: string): WorkflowStarter` in `src/temporal/connection.ts`.
  - `buildServer(dependencies: ServerDependencies): FastifyInstance`.
  - `type ServerDependencies = { env: Env; logger: Logger; prisma: FactoreePrismaClient; projects: ProjectRegistry; tenants: TenantRegistry; secrets: SecretStore; runs: RunRepository; delegation: DelegationService }`.

- [ ] **Step 1: Write the failing delegation service test**

`tests/unit/delegation-service.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { agentSessionEventSchema } from "~/adapters/linear/webhook-schemas.js";
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";

const event = (name: string) =>
  agentSessionEventSchema.parse(JSON.parse(readFileSync(`tests/fixtures/linear/${name}.json`, "utf8")));

const logger = createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined });

const project = {
  id: "project-1",
  tenantId: "tenant-1",
  key: "demo",
  name: "Demo",
  primaryRepository: "acme/demo",
  referenceRepositories: [],
  linearTeamId: "team-1",
  defaultAutonomy: "L2",
  maxRunMinutes: 90,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const build = (overrides: Partial<{ isNewDelivery: boolean; tenant: unknown; project: unknown }> = {}) => {
  const starter = { start: vi.fn(async () => undefined), signalStop: vi.fn(async () => undefined), signalHumanInput: vi.fn(async () => undefined) };
  const service = new DelegationService({
    tenants: {
      findByWorkspace: async () => (overrides.tenant === undefined ? { id: "tenant-1", linearWorkspaceId: "workspace-123", name: "A" } : overrides.tenant),
      ensureTenant: async () => ({ id: "tenant-1", linearWorkspaceId: "workspace-123", name: "A" }),
      putInstallation: async () => ({ id: "tenant-1", linearWorkspaceId: "workspace-123", name: "A" }),
      getInstallationToken: async () => "token",
    } as never,
    projects: {
      findByLinearTeam: async () => (overrides.project === undefined ? project : overrides.project),
      findDefaultForTenant: async () => (overrides.project === undefined ? project : overrides.project),
    } as never,
    webhookLog: { recordIfNew: async () => overrides.isNewDelivery ?? true },
    starter,
    logger,
  });
  return { service, starter };
};

describe("DelegationService", () => {
  it("starts one workflow for a delegation", async () => {
    const { service, starter } = build();
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-1");
    expect(outcome).toEqual({ kind: "started", runId: "session-1", workflowId: "linear:workspace-123:session-1" });
    expect(starter.start).toHaveBeenCalledTimes(1);
    const call = starter.start.mock.calls[0]?.[0] as { workflowId: string; args: [Record<string, unknown>] };
    expect(call.workflowId).toBe("linear:workspace-123:session-1");
    expect(call.args[0]).toMatchObject({
      tenantId: "tenant-1",
      projectId: "project-1",
      workspaceId: "workspace-123",
      agentSessionId: "session-1",
      linearIssueId: "issue-1",
      autonomyLevel: "L2",
      maxRunMinutes: 90,
    });
  });

  it("does not start a second workflow for a duplicate delivery", async () => {
    const { service, starter } = build({ isNewDelivery: false });
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-1");
    expect(outcome).toEqual({ kind: "duplicate" });
    expect(starter.start).not.toHaveBeenCalled();
  });

  it("signals stop for a stop event", async () => {
    const { service, starter } = build();
    const outcome = await service.handleAgentSessionEvent(event("agent-session-prompted-stop"), "delivery-2");
    expect(outcome).toEqual({ kind: "stopped", workflowId: "linear:workspace-123:session-1" });
    expect(starter.signalStop).toHaveBeenCalledWith("linear:workspace-123:session-1");
  });

  it("reports an unknown workspace instead of starting work", async () => {
    const { service, starter } = build({ tenant: null });
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-3");
    expect(outcome.kind).toBe("unconfigured");
    expect(starter.start).not.toHaveBeenCalled();
  });

  it("reports a missing project instead of starting work", async () => {
    const { service, starter } = build({ project: null });
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-4");
    expect(outcome.kind).toBe("unconfigured");
    expect(starter.start).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- delegation-service`
Expected: FAIL.

- [ ] **Step 3: Implement `src/domain/runs/delegation-service.ts`**

```ts
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import type { Logger } from "~/telemetry/logger.js";
import type { ProjectRegistry, TenantRegistry } from "~/domain/projects/project-registry.js";
import type { WebhookLog } from "~/domain/runs/run-repository.js";
import type { AgentSessionEvent } from "~/adapters/linear/webhook-schemas.js";
import { classifyAgentSessionEvent } from "~/adapters/linear/webhook-schemas.js";
import type { AgentRunWorkflowInput } from "~/workflows/agent-run.workflow.js";

export interface WorkflowStarter {
  start(input: { workflowId: string; args: [AgentRunWorkflowInput] }): Promise<void>;
  signalStop(workflowId: string): Promise<void>;
  signalHumanInput(workflowId: string, body: string): Promise<void>;
}

export type DelegationOutcome =
  | { kind: "started"; runId: string; workflowId: string }
  | { kind: "duplicate" }
  | { kind: "stopped"; workflowId: string }
  | { kind: "prompt_forwarded"; workflowId: string }
  | { kind: "ignored"; reason: string }
  | { kind: "unconfigured"; reason: string };

export interface DelegationDependencies {
  tenants: TenantRegistry;
  projects: ProjectRegistry;
  webhookLog: WebhookLog;
  starter: WorkflowStarter;
  logger: Logger;
}

export class DelegationService {
  constructor(private readonly dependencies: DelegationDependencies) {}

  async handleAgentSessionEvent(event: AgentSessionEvent, deliveryId: string): Promise<DelegationOutcome> {
    const tenant = await this.dependencies.tenants.findByWorkspace(event.organizationId);
    const isNew = await this.dependencies.webhookLog.recordIfNew({
      tenantId: tenant?.id ?? null,
      deliveryId,
      eventType: `${event.type}.${event.action}`,
    });
    if (!isNew) {
      this.dependencies.logger.info("duplicate webhook ignored", { step: "receive", tenant_id: tenant?.id });
      return { kind: "duplicate" };
    }
    if (!tenant) {
      return { kind: "unconfigured", reason: `no tenant for Linear workspace ${event.organizationId}` };
    }

    const workflowId = buildWorkflowId(event.organizationId, event.agentSession.id);
    const command = classifyAgentSessionEvent(event);

    if (command.kind === "ignore") return { kind: "ignored", reason: command.reason };
    if (command.kind === "stop") {
      await this.dependencies.starter.signalStop(workflowId);
      return { kind: "stopped", workflowId };
    }
    if (command.kind === "prompt") {
      await this.dependencies.starter.signalHumanInput(workflowId, command.body);
      return { kind: "prompt_forwarded", workflowId };
    }

    const teamId = event.agentSession.issue?.teamId;
    const project = teamId
      ? await this.dependencies.projects.findByLinearTeam(tenant.id, teamId)
      : await this.dependencies.projects.findDefaultForTenant(tenant.id);
    if (!project) {
      return { kind: "unconfigured", reason: `no project for Linear team ${teamId ?? "unknown"}` };
    }

    await this.dependencies.starter.start({
      workflowId,
      args: [
        {
          tenantId: tenant.id,
          workspaceId: event.organizationId,
          projectId: project.id,
          linearIssueId: event.agentSession.issueId ?? event.agentSession.issue?.id ?? null,
          agentSessionId: event.agentSession.id,
          autonomyLevel: project.defaultAutonomy,
          maxRunMinutes: project.maxRunMinutes,
        },
      ],
    });

    return { kind: "started", runId: event.agentSession.id, workflowId };
  }
}
```

Note: the outcome `runId` is the agent session id at this point. The Run identifier lives in PostgreSQL after the workflow first activity. The unit test asserts this behavior.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- delegation-service`
Expected: PASS.

- [ ] **Step 5: Add the workflow starter to `src/temporal/connection.ts`**

```ts
import type { Client } from "@temporalio/client";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { agentRunWorkflow, humanInputSignal, stopSignal } from "~/workflows/agent-run.workflow.js";
import type { WorkflowStarter } from "~/domain/runs/delegation-service.js";

export const createTemporalWorkflowStarter = (client: Client, taskQueue: string): WorkflowStarter => ({
  async start(input) {
    try {
      await client.workflow.start(agentRunWorkflow, {
        taskQueue,
        workflowId: input.workflowId,
        args: input.args,
      });
    } catch (error) {
      // A repeated delivery that passed the database check must not create a second Run.
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
  },
  async signalStop(workflowId) {
    await client.workflow.getHandle(workflowId).signal(stopSignal);
  },
  async signalHumanInput(workflowId, body) {
    await client.workflow.getHandle(workflowId).signal(humanInputSignal, body);
  },
});
```

- [ ] **Step 6: Implement `src/http/admin/auth.ts`**

```ts
import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export const createAdminGuard = (token: string) => {
  const expected = Buffer.from(token, "utf8");
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization ?? "";
    const provided = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "", "utf8");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
};
```

- [ ] **Step 7: Implement `src/http/health.routes.ts`**

```ts
import type { FastifyInstance } from "fastify";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { registry } from "~/telemetry/metrics.js";

export const registerHealthRoutes = (app: FastifyInstance, prisma: FactoreePrismaClient): void => {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
};
```

- [ ] **Step 8: Implement `src/http/webhooks/linear.routes.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { verifyLinearSignature } from "~/adapters/linear/webhook-verifier.js";
import { agentSessionEventSchema } from "~/adapters/linear/webhook-schemas.js";
import type { DelegationService } from "~/domain/runs/delegation-service.js";
import type { Logger } from "~/telemetry/logger.js";

export const registerLinearWebhookRoutes = (
  app: FastifyInstance,
  dependencies: { secret: string; delegation: DelegationService; logger: Logger },
): void => {
  app.post("/webhooks/linear", { config: { rawBody: true } }, async (request, reply) => {
    const rawBody = request.rawBody ?? Buffer.from(JSON.stringify(request.body ?? {}), "utf8");
    const parsedBody = request.body as { webhookTimestamp?: number; webhookId?: string } | undefined;

    const verified = verifyLinearSignature({
      rawBody,
      signature: request.headers["linear-signature"] as string | undefined,
      secret: dependencies.secret,
      ...(parsedBody?.webhookTimestamp === undefined ? {} : { timestampMs: parsedBody.webhookTimestamp }),
    });
    if (!verified.ok) {
      dependencies.logger.warn("rejected Linear webhook", { step: "receive", reason: verified.reason });
      return reply.code(401).send({ error: verified.reason });
    }

    const parsed = agentSessionEventSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(202).send({ status: "ignored", reason: "unsupported payload" });

    const deliveryId =
      (request.headers["linear-delivery"] as string | undefined) ??
      parsedBody?.webhookId ??
      `${parsed.data.agentSession.id}:${parsed.data.action}:${parsedBody?.webhookTimestamp ?? 0}`;

    const outcome = await dependencies.delegation.handleAgentSessionEvent(parsed.data, deliveryId);
    return reply.code(202).send(outcome);
  });
};
```

The raw body is required for signature verification. Register a content type parser in `src/http/server.ts` that keeps the raw buffer, so no extra plugin is needed.

- [ ] **Step 9: Implement `src/http/admin/projects.routes.ts`**

Every route resolves the tenant from the request body or query, so no route can read across tenants.

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProjectRegistry, TenantRegistry } from "~/domain/projects/project-registry.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";

const createSchema = z.object({
  linearWorkspaceId: z.string().min(1),
  workspaceName: z.string().min(1).default("workspace"),
  key: z.string().min(1),
  name: z.string().min(1),
  primaryRepository: z.string().regex(/^[^/]+\/[^/]+$/),
  referenceRepositories: z.array(z.string()).default([]),
  linearTeamId: z.string().min(1).optional(),
  defaultAutonomy: z.enum(["L0", "L1", "L2", "L3", "L4"]).default("L2"),
  maxRunMinutes: z.number().int().positive().max(600).default(90),
});

const updateSchema = createSchema.partial().omit({ linearWorkspaceId: true, workspaceName: true, key: true });

const tenantQuerySchema = z.object({ linearWorkspaceId: z.string().min(1) });

export const registerProjectRoutes = (
  app: FastifyInstance,
  dependencies: { projects: ProjectRegistry; tenants: TenantRegistry; secrets: SecretStore },
): void => {
  const resolveTenant = async (linearWorkspaceId: string) =>
    dependencies.tenants.findByWorkspace(linearWorkspaceId);

  app.post("/admin/projects", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await dependencies.tenants.ensureTenant(parsed.data.linearWorkspaceId, parsed.data.workspaceName);
    const project = await dependencies.projects.create({
      tenantId: tenant.id,
      key: parsed.data.key,
      name: parsed.data.name,
      primaryRepository: parsed.data.primaryRepository,
      referenceRepositories: parsed.data.referenceRepositories,
      ...(parsed.data.linearTeamId === undefined ? {} : { linearTeamId: parsed.data.linearTeamId }),
      defaultAutonomy: parsed.data.defaultAutonomy,
      maxRunMinutes: parsed.data.maxRunMinutes,
    });
    return reply.code(201).send(project);
  });

  app.get("/admin/projects", async (request, reply) => {
    const parsed = tenantQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await resolveTenant(parsed.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    return dependencies.projects.list(tenant.id);
  });

  app.get<{ Params: { id: string } }>("/admin/projects/:id", async (request, reply) => {
    const parsed = tenantQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await resolveTenant(parsed.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const project = await dependencies.projects.findById(tenant.id, request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return project;
  });

  app.put<{ Params: { id: string } }>("/admin/projects/:id", async (request, reply) => {
    const query = tenantQuerySchema.safeParse(request.query);
    const body = updateSchema.safeParse(request.body);
    if (!query.success || !body.success) return reply.code(400).send({ error: "invalid request" });
    const tenant = await resolveTenant(query.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const project = await dependencies.projects.update(tenant.id, request.params.id, body.data);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return project;
  });

  app.delete<{ Params: { id: string } }>("/admin/projects/:id", async (request, reply) => {
    const query = tenantQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    const tenant = await resolveTenant(query.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const removed = await dependencies.projects.remove(tenant.id, request.params.id);
    if (!removed) return reply.code(404).send({ error: "project not found" });
    return reply.code(204).send();
  });

  app.put<{ Params: { id: string; name: string } }>("/admin/projects/:id/secrets/:name", async (request, reply) => {
    const query = tenantQuerySchema.safeParse(request.query);
    const body = z.object({ value: z.string().min(1) }).safeParse(request.body);
    if (!query.success || !body.success) return reply.code(400).send({ error: "invalid request" });
    const tenant = await resolveTenant(query.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const project = await dependencies.projects.findById(tenant.id, request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    await dependencies.secrets.put(tenant.id, project.id, request.params.name, body.data.value);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string; name: string } }>("/admin/projects/:id/secrets/:name", async (request, reply) => {
    const query = tenantQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    const tenant = await resolveTenant(query.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const removed = await dependencies.secrets.remove(tenant.id, request.params.id, request.params.name);
    if (!removed) return reply.code(404).send({ error: "secret not found" });
    return reply.code(204).send();
  });
};
```

The context-source endpoints of SDD section 59 belong to Phase 5. Do not add them now.

- [ ] **Step 10: Implement `src/http/admin/runs.routes.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { TenantRegistry } from "~/domain/projects/project-registry.js";

const querySchema = z.object({ linearWorkspaceId: z.string().min(1) });

export const registerRunRoutes = (
  app: FastifyInstance,
  dependencies: { runs: RunRepository; tenants: TenantRegistry },
): void => {
  app.get<{ Params: { id: string } }>("/admin/runs/:id", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await dependencies.tenants.findByWorkspace(parsed.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const run = await dependencies.runs.findById(tenant.id, request.params.id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return run;
  });
};
```

`GET /admin/runs/:id/context` and `GET /admin/runs/:id/validation` belong to Phase 4 and Phase 6. Do not add them now.

- [ ] **Step 11: Implement `src/http/admin/installations.routes.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TenantRegistry } from "~/domain/projects/project-registry.js";

const schema = z.object({
  linearWorkspaceId: z.string().min(1),
  workspaceName: z.string().min(1),
  appUserId: z.string().min(1).optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  scopes: z.array(z.string()).default([]),
});

export const registerInstallationRoutes = (
  app: FastifyInstance,
  dependencies: { tenants: TenantRegistry },
): void => {
  app.put("/admin/linear-installations", async (request, reply) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await dependencies.tenants.putInstallation(parsed.data);
    return reply.code(200).send({ tenantId: tenant.id, linearWorkspaceId: tenant.linearWorkspaceId });
  });
};
```

- [ ] **Step 12: Implement `src/http/server.ts`**

```ts
import Fastify, { type FastifyInstance } from "fastify";
import type { Env } from "~/config/env.js";
import type { Logger } from "~/telemetry/logger.js";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import type { ProjectRegistry, TenantRegistry } from "~/domain/projects/project-registry.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { DelegationService } from "~/domain/runs/delegation-service.js";
import { createAdminGuard } from "./admin/auth.js";
import { registerHealthRoutes } from "./health.routes.js";
import { registerProjectRoutes } from "./admin/projects.routes.js";
import { registerRunRoutes } from "./admin/runs.routes.js";
import { registerInstallationRoutes } from "./admin/installations.routes.js";
import { registerLinearWebhookRoutes } from "./webhooks/linear.routes.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface ServerDependencies {
  env: Env;
  logger: Logger;
  prisma: FactoreePrismaClient;
  projects: ProjectRegistry;
  tenants: TenantRegistry;
  secrets: SecretStore;
  runs: RunRepository;
  delegation: DelegationService;
}

export const buildServer = (dependencies: ServerDependencies): FastifyInstance => {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const buffer = body as Buffer;
    request.rawBody = buffer;
    try {
      done(null, buffer.length === 0 ? {} : (JSON.parse(buffer.toString("utf8")) as unknown));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  registerHealthRoutes(app, dependencies.prisma);
  registerLinearWebhookRoutes(app, {
    secret: dependencies.env.LINEAR_WEBHOOK_SECRET,
    delegation: dependencies.delegation,
    logger: dependencies.logger,
  });

  void app.register(async (admin) => {
    admin.addHook("onRequest", createAdminGuard(dependencies.env.ADMIN_API_TOKEN));
    registerProjectRoutes(admin, {
      projects: dependencies.projects,
      tenants: dependencies.tenants,
      secrets: dependencies.secrets,
    });
    registerRunRoutes(admin, { runs: dependencies.runs, tenants: dependencies.tenants });
    registerInstallationRoutes(admin, { tenants: dependencies.tenants });
  });

  return app;
};
```

- [ ] **Step 13: Implement `src/bin/api.ts`**

```ts
import { loadEnv } from "~/config/env.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import { createPrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";
import {
  PrismaProjectRegistry,
  PrismaSecretStore,
  PrismaTenantRegistry,
} from "~/persistence/prisma/project-registry.prisma.js";
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { createTemporalClient, createTemporalWorkflowStarter } from "~/temporal/connection.js";
import { buildServer } from "~/http/server.js";

const env = loadEnv();
const redactor = new Redactor([env.ADMIN_API_TOKEN, env.LINEAR_WEBHOOK_SECRET, env.FACTOREE_SECRET_KEY]);
const logger = createLogger({ level: env.LOG_LEVEL, redactor });
const prisma = createPrismaClient(env.DATABASE_URL);
const tenants = new PrismaTenantRegistry(prisma, env.FACTOREE_SECRET_KEY);
const projects = new PrismaProjectRegistry(prisma);
const secrets = new PrismaSecretStore(prisma, env.FACTOREE_SECRET_KEY);
const runs = new PrismaRunRepository(prisma);
const client = await createTemporalClient(env);

const delegation = new DelegationService({
  tenants,
  projects,
  webhookLog: new PrismaWebhookLog(prisma),
  starter: createTemporalWorkflowStarter(client, env.TEMPORAL_TASK_QUEUE),
  logger,
});

const app = buildServer({ env, logger, prisma, projects, tenants, secrets, runs, delegation });
await app.listen({ port: env.PORT, host: "0.0.0.0" });
logger.info("api started", { step: "boot" });
```

- [ ] **Step 14: Write the failing admin API integration test**

`tests/integration/admin-api.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";
import {
  PrismaProjectRegistry,
  PrismaSecretStore,
  PrismaTenantRegistry,
} from "~/persistence/prisma/project-registry.prisma.js";
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { buildServer } from "~/http/server.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { Env } from "~/config/env.js";

const token = "t".repeat(32);
const env = {
  DATABASE_URL: "",
  FACTOREE_SECRET_KEY: "c".repeat(64),
  ADMIN_API_TOKEN: token,
  LINEAR_WEBHOOK_SECRET: "webhook-secret",
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "factoree",
  PORT: 3000,
  LOG_LEVEL: "error",
} satisfies Env;

let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let app: ReturnType<typeof buildServer>;

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  const tenants = new PrismaTenantRegistry(prisma, env.FACTOREE_SECRET_KEY);
  app = buildServer({
    env,
    logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
    prisma,
    projects: new PrismaProjectRegistry(prisma),
    tenants,
    secrets: new PrismaSecretStore(prisma, env.FACTOREE_SECRET_KEY),
    runs: new PrismaRunRepository(prisma),
    delegation: new DelegationService({
      tenants,
      projects: new PrismaProjectRegistry(prisma),
      webhookLog: new PrismaWebhookLog(prisma),
      starter: { start: vi.fn(async () => undefined), signalStop: vi.fn(async () => undefined), signalHumanInput: vi.fn(async () => undefined) },
      logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
    }),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await stop();
});

const auth = { authorization: `Bearer ${token}` };

describe("administration API", () => {
  it("reports health and readiness", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });

  it("rejects an administration request without the token", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/projects?linearWorkspaceId=ws-1" });
    expect(response.statusCode).toBe(401);
  });

  it("creates, reads, updates, and deletes a project", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/projects",
      headers: auth,
      payload: {
        linearWorkspaceId: "ws-admin",
        workspaceName: "Admin",
        key: "demo",
        name: "Demo",
        primaryRepository: "acme/demo",
        linearTeamId: "team-1",
      },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json() as { id: string };

    const read = await app.inject({
      method: "GET",
      url: `/admin/projects/${project.id}?linearWorkspaceId=ws-admin`,
      headers: auth,
    });
    expect(read.statusCode).toBe(200);

    const updated = await app.inject({
      method: "PUT",
      url: `/admin/projects/${project.id}?linearWorkspaceId=ws-admin`,
      headers: auth,
      payload: { name: "Renamed" },
    });
    expect((updated.json() as { name: string }).name).toBe("Renamed");

    const removed = await app.inject({
      method: "DELETE",
      url: `/admin/projects/${project.id}?linearWorkspaceId=ws-admin`,
      headers: auth,
    });
    expect(removed.statusCode).toBe(204);
  });

  it("stores a project secret and never returns its value", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/projects",
      headers: auth,
      payload: {
        linearWorkspaceId: "ws-secret",
        workspaceName: "Secret",
        key: "s",
        name: "S",
        primaryRepository: "acme/s",
      },
    });
    const project = created.json() as { id: string };
    const put = await app.inject({
      method: "PUT",
      url: `/admin/projects/${project.id}/secrets/GITHUB_TOKEN?linearWorkspaceId=ws-secret`,
      headers: auth,
      payload: { value: "ghp_super_secret_value_12345678" },
    });
    expect(put.statusCode).toBe(204);
    const read = await app.inject({
      method: "GET",
      url: `/admin/projects/${project.id}?linearWorkspaceId=ws-secret`,
      headers: auth,
    });
    expect(read.body).not.toContain("ghp_super_secret_value_12345678");
  });

  it("does not return a project of another tenant", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/projects",
      headers: auth,
      payload: {
        linearWorkspaceId: "ws-owner",
        workspaceName: "Owner",
        key: "own",
        name: "Own",
        primaryRepository: "acme/own",
      },
    });
    const project = created.json() as { id: string };
    await app.inject({
      method: "POST",
      url: "/admin/projects",
      headers: auth,
      payload: {
        linearWorkspaceId: "ws-other",
        workspaceName: "Other",
        key: "oth",
        name: "Oth",
        primaryRepository: "acme/oth",
      },
    });
    const stolen = await app.inject({
      method: "GET",
      url: `/admin/projects/${project.id}?linearWorkspaceId=ws-other`,
      headers: auth,
    });
    expect(stolen.statusCode).toBe(404);
  });
});
```

- [ ] **Step 15: Run the tests and fix what fails**

Run: `npm run test:integration -- admin-api`
Expected: PASS.

- [ ] **Step 16: Run the whole verification**

Run: `npm run verify`
Expected: exit 0.

- [ ] **Step 17: Commit**

```bash
git add -A
git commit -m "feat: add API server, Linear webhook route, and administration endpoints"
```
---

### Task 9: Phase 1 acceptance tests (AT-01, AT-33, AT-35, partial AT-32)

**Files:**
- Create: `tests/integration/support/temporal.ts`, `tests/integration/at-01-delegation.test.ts`, `tests/integration/at-33-tenant-isolation.test.ts`, `tests/workflow/at-35-worker-restart.test.ts`, `tests/unit/at-32-redaction.test.ts`
- Modify: none.

**Background:** These tests are the evidence for the Phase 1 exit condition. AT-01 requires that a valid delegation creates exactly one Run and that a duplicate delivery creates no second Run. AT-33 requires that tenant A cannot reach tenant B data. AT-35 requires that a worker restart during a Run creates no duplicate Run. AT-32 requires that a printed secret never appears in Factoree logs; the log part is provable now, and the Linear evidence and Proof Pack parts arrive in Phase 7 and Phase 10.

**Interfaces:**
- Consumes: everything from Tasks 1 to 8.
- Produces: `startTemporal(): Promise<{ environment: TestWorkflowEnvironment; stop: () => Promise<void> }>` in `tests/integration/support/temporal.ts`.

- [ ] **Step 1: Create the Temporal test helper**

`tests/integration/support/temporal.ts`:

```ts
import { TestWorkflowEnvironment } from "@temporalio/testing";

export const startTemporal = async (): Promise<{
  environment: TestWorkflowEnvironment;
  stop: () => Promise<void>;
}> => {
  const environment = await TestWorkflowEnvironment.createLocal();
  return { environment, stop: () => environment.teardown() };
};
```

- [ ] **Step 2: Write the AT-01 test**

This test drives the real HTTP route, the real signature check, the real database, and a real Temporal test server. It asserts one Run for two identical deliveries.

`tests/integration/at-01-delegation.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "@temporalio/worker";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { startDatabase } from "./support/database.js";
import { startTemporal } from "./support/temporal.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";
import {
  PrismaProjectRegistry,
  PrismaSecretStore,
  PrismaTenantRegistry,
} from "~/persistence/prisma/project-registry.prisma.js";
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { createTemporalWorkflowStarter } from "~/temporal/connection.js";
import { createActivities } from "~/activities/index.js";
import { buildServer } from "~/http/server.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { Env } from "~/config/env.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";

const secret = "webhook-secret";
const env = {
  DATABASE_URL: "",
  FACTOREE_SECRET_KEY: "d".repeat(64),
  ADMIN_API_TOKEN: "t".repeat(32),
  LINEAR_WEBHOOK_SECRET: secret,
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "factoree-at01",
  PORT: 3000,
  LOG_LEVEL: "error",
} satisfies Env;

const logger = createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined });
const acknowledged: string[] = [];
const agentSession: AgentSessionPort = {
  acknowledge: async (sessionId) => {
    acknowledged.push(sessionId);
  },
  progress: async () => undefined,
  elicit: async () => undefined,
  respond: async () => undefined,
  fail: async () => undefined,
};

let prisma: FactoreePrismaClient;
let stopDatabase: () => Promise<void>;
let stopTemporal: () => Promise<void>;
let environment: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;
let app: ReturnType<typeof buildServer>;

const payload = JSON.parse(readFileSync("tests/fixtures/linear/agent-session-created.json", "utf8")) as Record<string, unknown>;

const send = async (body: Record<string, unknown>, deliveryId: string) => {
  const raw = JSON.stringify({ ...body, webhookTimestamp: Date.now() });
  return app.inject({
    method: "POST",
    url: "/webhooks/linear",
    headers: {
      "content-type": "application/json",
      "linear-signature": createHmac("sha256", secret).update(raw).digest("hex"),
      "linear-delivery": deliveryId,
    },
    payload: raw,
  });
};

beforeAll(async () => {
  const database = await startDatabase();
  stopDatabase = database.stop;
  prisma = createPrismaClient(database.url);

  const temporal = await startTemporal();
  environment = temporal.environment;
  stopTemporal = temporal.stop;

  const tenants = new PrismaTenantRegistry(prisma, env.FACTOREE_SECRET_KEY);
  const projects = new PrismaProjectRegistry(prisma);
  const tenant = await tenants.ensureTenant("workspace-123", "Acme");
  await projects.create({
    tenantId: tenant.id,
    key: "demo",
    name: "Demo",
    primaryRepository: "acme/demo",
    linearTeamId: "team-1",
  });

  worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: env.TEMPORAL_TASK_QUEUE,
    workflowsPath: new URL("../../src/workflows/agent-run.workflow.ts", import.meta.url).pathname,
    activities: createActivities({ runs: new PrismaRunRepository(prisma), agentSession, logger }),
  });
  workerRun = worker.run();

  app = buildServer({
    env,
    logger,
    prisma,
    projects,
    tenants,
    secrets: new PrismaSecretStore(prisma, env.FACTOREE_SECRET_KEY),
    runs: new PrismaRunRepository(prisma),
    delegation: new DelegationService({
      tenants,
      projects,
      webhookLog: new PrismaWebhookLog(prisma),
      starter: createTemporalWorkflowStarter(environment.client, env.TEMPORAL_TASK_QUEUE),
      logger,
    }),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  worker.shutdown();
  await workerRun;
  await prisma.$disconnect();
  await stopTemporal();
  await stopDatabase();
});

const waitForRun = async (sessionId: string): Promise<void> => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const count = await prisma.run.count({ where: { linearAgentSessionId: sessionId } });
    if (count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no Run appeared for ${sessionId}`);
};

describe("AT-01 delegation", () => {
  it("creates exactly one Run for one delegation and ignores a duplicate delivery", async () => {
    const first = await send(payload, "delivery-at01");
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ kind: "started" });

    await waitForRun("session-1");

    const duplicate = await send(payload, "delivery-at01");
    expect(duplicate.json()).toEqual({ kind: "duplicate" });

    const differentDelivery = await send(payload, "delivery-at01-b");
    expect(differentDelivery.json()).toMatchObject({ kind: "started" });

    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await prisma.run.count({ where: { linearAgentSessionId: "session-1" } })).toBe(1);
    expect(acknowledged.filter((id) => id === "session-1")).toHaveLength(1);
  });

  it("rejects a webhook with a wrong signature", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/linear",
      headers: { "content-type": "application/json", "linear-signature": "00", "linear-delivery": "bad" },
      payload: JSON.stringify(payload),
    });
    expect(response.statusCode).toBe(401);
  });
});
```

Note the second assertion. A repeated Linear delivery with a new delivery identifier still must not create a second Run, because the Temporal workflow identifier and the unique agent session column both stop it.

- [ ] **Step 3: Run the test**

Run: `npm run test:integration -- at-01`
Expected: PASS. If the Run does not appear, check that the worker task queue matches `TEMPORAL_TASK_QUEUE`.

- [ ] **Step 4: Write the AT-33 test**

`tests/integration/at-33-tenant-isolation.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import {
  PrismaProjectRegistry,
  PrismaSecretStore,
  PrismaTenantRegistry,
} from "~/persistence/prisma/project-registry.prisma.js";

const key = "e".repeat(64);
let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
});

afterAll(async () => {
  await prisma.$disconnect();
  await stop();
});

describe("AT-33 tenant isolation", () => {
  it("keeps projects, secrets, and runs inside their own tenant", async () => {
    const tenants = new PrismaTenantRegistry(prisma, key);
    const projects = new PrismaProjectRegistry(prisma);
    const secrets = new PrismaSecretStore(prisma, key);
    const runs = new PrismaRunRepository(prisma);

    const a = await tenants.ensureTenant("ws-at33-a", "A");
    const b = await tenants.ensureTenant("ws-at33-b", "B");

    const projectA = await projects.create({
      tenantId: a.id,
      key: "a",
      name: "A",
      primaryRepository: "acme/a",
    });
    await secrets.put(a.id, projectA.id, "TOKEN", "secret-value-of-tenant-a");
    const run = await runs.createIfAbsent({
      tenantId: a.id,
      projectId: projectA.id,
      linearIssueId: "issue-a",
      linearAgentSessionId: "session-at33",
      temporalWorkflowId: "linear:ws-at33-a:session-at33",
      autonomyLevel: "L2",
    });

    expect(await projects.list(b.id)).toHaveLength(0);
    expect(await projects.findById(b.id, projectA.id)).toBeNull();
    expect(await secrets.get(b.id, projectA.id, "TOKEN")).toBeNull();
    expect(await secrets.listNames(b.id, projectA.id)).toEqual([]);
    expect(await runs.findById(b.id, run.run.id)).toBeNull();
    expect(await runs.findByAgentSession(b.id, "session-at33")).toBeNull();

    expect(await projects.findById(a.id, projectA.id)).not.toBeNull();
    expect(await runs.findById(a.id, run.run.id)).not.toBeNull();
  });

  it("records the tenant on every tenant-owned row", async () => {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenantId'
    `;
    const names = rows.map((row) => row.table_name).sort();
    expect(names).toEqual(
      ["AgentExecution", "LinearInstallation", "ProcessedWebhook", "Project", "ProjectSecret", "Run"].sort(),
    );
  });
});
```

- [ ] **Step 5: Run the test**

Run: `npm run test:integration -- at-33`
Expected: PASS.

- [ ] **Step 6: Write the AT-35 worker restart test**

`tests/workflow/at-35-worker-restart.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { agentRunWorkflow, stopSignal } from "~/workflows/agent-run.workflow.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";

let environment: TestWorkflowEnvironment;
const createCalls: string[] = [];
const completions: string[] = [];

const activities = {
  createRun: async (input: { linearAgentSessionId: string }) => {
    // The repository is idempotent, so a repeated call returns the same Run.
    createCalls.push(input.linearAgentSessionId);
    return { runId: `run-${input.linearAgentSessionId}`, created: createCalls.length === 1 };
  },
  setRunStatus: async () => undefined,
  completeRun: async (input: { runId: string }) => {
    completions.push(input.runId);
  },
  acknowledgeSession: async () => undefined,
  postProgress: async () => undefined,
  postElicitation: async () => undefined,
  postFinalResponse: async () => undefined,
  postError: async () => undefined,
};

const newWorker = async (): Promise<Worker> =>
  Worker.create({
    connection: environment.nativeConnection,
    taskQueue: "at-35",
    workflowsPath: new URL("../../src/workflows/agent-run.workflow.ts", import.meta.url).pathname,
    activities,
  });

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
});

afterAll(async () => {
  await environment.teardown();
});

describe("AT-35 worker restart", () => {
  it("does not duplicate a Run when the worker restarts during it", async () => {
    const workflowId = buildWorkflowId("workspace-123", "session-at35");

    const first = await newWorker();
    const firstRun = first.run();
    const handle = await environment.client.workflow.start(agentRunWorkflow, {
      taskQueue: "at-35",
      workflowId,
      args: [
        {
          tenantId: "tenant-1",
          workspaceId: "workspace-123",
          projectId: "project-1",
          linearIssueId: "issue-1",
          agentSessionId: "session-at35",
          autonomyLevel: "L2",
          maxRunMinutes: 90,
        },
      ],
    });

    // Wait until the Run exists, then stop the worker while the workflow is still open.
    for (let attempt = 0; attempt < 40 && createCalls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(createCalls).toHaveLength(1);
    first.shutdown();
    await firstRun;

    const second = await newWorker();
    const secondRun = second.run();
    await handle.signal(stopSignal);
    const result = await handle.result();
    second.shutdown();
    await secondRun;

    expect(result.runId).toBe("run-session-at35");
    expect(createCalls).toHaveLength(1);
    expect(completions).toEqual(["run-session-at35"]);
    const description = await handle.describe();
    expect(description.status.name).toBe("COMPLETED");
  });
});
```

- [ ] **Step 7: Run the test**

Run: `npm run test:workflow -- at-35`
Expected: PASS. The workflow replays from history after the restart, so `createRun` runs once.

- [ ] **Step 8: Write the AT-32 log redaction test**

`tests/unit/at-32-redaction.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";

describe("AT-32 redaction in logs", () => {
  it("keeps a configured project secret out of every log line", () => {
    const lines: string[] = [];
    const redactor = new Redactor(["fixture-secret-value-12345"]);
    const logger = createLogger({ level: "debug", redactor, sink: (line) => lines.push(line) });

    logger.info("agent printed fixture-secret-value-12345 to stdout", {
      run_id: "run-1",
      output: "echo fixture-secret-value-12345",
      headers: { authorization: "Bearer abcdefghijklmnop" },
    });
    logger.error("failure", { error: new Error("token fixture-secret-value-12345 rejected") });

    const all = lines.join("\n");
    expect(all).not.toContain("fixture-secret-value-12345");
    expect(all).not.toContain("Bearer abcdefghijklmnop");
    expect(all).toContain("run-1");
  });

  it("redacts a secret added after the logger was created", () => {
    const lines: string[] = [];
    const redactor = new Redactor();
    const logger = createLogger({ level: "debug", redactor, sink: (line) => lines.push(line) });
    redactor.addSecret("late-added-secret-value");
    logger.info("value late-added-secret-value");
    expect(lines.join("")).not.toContain("late-added-secret-value");
  });
});
```

- [ ] **Step 9: Run the test**

Run: `npm test -- at-32`
Expected: PASS.

- [ ] **Step 10: Run the full verification and record the evidence**

Run: `npm run verify`
Expected: exit 0. Save the output tail into `docs/build/evidence/phase-01-verify.txt`.

```bash
mkdir -p docs/build/evidence
npm run verify 2>&1 | tee docs/build/evidence/phase-01-verify.txt
echo "exit=${PIPESTATUS[0]}" >> docs/build/evidence/phase-01-verify.txt
```

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "test: add Phase 1 acceptance tests for delegation, isolation, restart, and redaction"
```
---

## Self-review against `docs/sdd.md`

**Coverage of the Phase 1 sentence (SDD section 69).**

- Linear integration: Task 5 verifies the webhook, Task 6 sends progress, elicitation, final response, and error activities, Task 8 routes the delivery and forwards a stop signal.
- PostgreSQL: Task 3 and Task 4.
- Temporal workflow skeleton: Task 7.
- Project model: Task 4 and Task 8.
- Run model: Task 3.
- Idempotency: three independent layers. The `ProcessedWebhook` unique delivery identifier (Task 3), the unique `linearAgentSessionId` column on `Run` (Task 3), and the deterministic Temporal workflow identifier (Task 7 and Task 8).
- Exit condition: Task 9, test `at-01-delegation`.

**Decisions taken inside the plan.**

1. *The workflow waits after the receive step.* SDD section 49 defines a pipeline whose later steps belong to Phases 4 to 10. The Phase 1 workflow performs the real receive step, acknowledges the session, and then holds the Run open for a stop signal, for human input, or until the maximum Run duration. This is real behavior, not a stub. Later phases replace the wait with the refinement and delivery steps.
2. *Secrets are encrypted at rest.* SDD section 30 requires credential handling. AES-256-GCM with a control-plane key is the least complex option that keeps a database dump useless.
3. *`PUT /admin/linear-installations` is added.* SDD section 59 lists the required endpoints and does not forbid others. An installation record is needed before any Linear call can be authorized. The OAuth flow of `src/http/oauth/` arrives with the live proof in Phase 12.
4. *Endpoints deferred on purpose.* `POST|GET|DELETE /admin/projects/:id/context-sources` belongs to Phase 5. `GET /admin/runs/:id/context` belongs to Phase 4. `GET /admin/runs/:id/validation` belongs to Phase 6. Phase 1 must not create placeholder handlers for them.
5. *Entities deferred on purpose.* `ContextSourceConfiguration`, `ContextContract`, `ContextItem`, `ContextConflict`, `ValidationContract`, `ValidationAssertion`, `Evidence`, and `ReviewFinding` from SDD section 53 are created by the phases that own them.
6. *`DelegationService` lives in `src/domain/runs/`.* It imports Zod schemas and workflow input types only. It imports no provider SDK, so it satisfies SDD section 14. The ESLint rule in Task 1 enforces this.

**Requirements this phase cannot yet prove.**

- AT-32 is only partly provable. The log part is proved in Task 9. The Linear evidence part and the Proof Pack part need Phase 7 and Phase 10.
- Live Linear delegation against a real workspace needs credentials and a public webhook URL. SDD section 66 places the live acceptance test in Phase 12. Phase 1 proves the same path with the real signature check, the real database, and a real Temporal test server.

**Placeholder scan.** No task contains "TBD", "implement later", or an instruction without its code. Every test step names the command and the expected result.

**Type consistency.** `Activities` in Task 7 is the single source for activity names. Every workflow test stub in Task 7 and Task 9 declares the same seven activity names. `RunRepository`, `ProjectRegistry`, `TenantRegistry`, `SecretStore`, `WebhookLog`, `AgentSessionPort`, and `WorkflowStarter` are each defined once and consumed by name.
