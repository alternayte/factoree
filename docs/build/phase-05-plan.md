# Factoree Phase 5 — Backstage and MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Factoree a configured Backstage topology source and a configured generic MCP source, so that a fixture dependency is discovered from the Backstage catalog with full provenance, and so that a Project can add an organization-specific context source without a code change.

**Architecture:** A new `ContextSourceConfiguration` entity holds one row per configured source of one Project. The context sources of a Run are therefore built per Run, not once per worker, so a `ContextSourceProvider` replaces the fixed registry the resolver held. Before discovery the resolve activity reads `.factoree/config.yaml` at the pinned primary SHA through the existing read-only git reader, because the `context` block of SDD section 15 governs discovery and discovery runs before the sandbox exists. `BackstageContextSource` starts from the catalog entity of the primary repository and walks one hop of `dependsOn`, `providesApis`, `consumesApis`, and ownership. It never enumerates the catalog. `McpContextSource` calls two allow-listed tools of one configured MCP server over JSON-RPC. Both sources live in `src/domain/context/` behind a port, and the HTTP clients live in `src/adapters/backstage/` and `src/adapters/mcp/`.

**Tech Stack:** TypeScript (strict), Node.js 24 LTS, npm, Temporal TypeScript SDK, Prisma, PostgreSQL, Fastify, `yaml`, `zod`, Vitest, Testcontainers, prom-client, the git command line, `fetch`.

**Spec:** `docs/sdd.md` (version 2.0, SHA-256 `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`)

## Global Constraints

These hold for every task. Every value is copied from the SDD.

- Production runtime is Node.js 24 LTS. Bun MUST NOT run Temporal Worker code (SDD section 11).
- TypeScript MUST keep `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true` (SDD section 10).
- npm with a committed `package-lock.json` (SDD section 10).
- Provider SDKs and provider HTTP clients MUST stay in `src/adapters/**`. Core workflow policy MUST NOT import a provider client (SDD section 14).
- Source layout MUST follow SDD section 63. Phase 5 fills `src/adapters/backstage/` and `src/adapters/mcp/`.
- Tenant boundary is the Linear workspace. Every tenant-owned persisted record MUST carry a tenant identifier, and every read MUST filter on it (SDD section 52).
- Factoree MUST NOT log an OAuth token, a GitHub token, a model API key, a Project secret, or an authorization header (SDD section 60).
- Organization-wide unbounded retrieval MUST be disabled by default (SDD section 18).
- Backstage MUST NOT automatically override executable code or an accepted architecture decision (SDD section 19).
- Every MCP tool call MUST pass through the Action Policy. An Implementer MUST NOT receive unrestricted organization-wide MCP access by default (SDD section 58).
- Every selected Context Item MUST record source, stable reference, source version, authority class, selection reason, and classification (SDD section 21).
- Every reference repository MUST be checked out at an explicit commit SHA and MUST stay read-only to the Implementer (SDD section 20).
- Unknown configuration keys MUST fail validation (SDD section 15).
- Run state names MUST stay exactly the names of SDD section 48. Phase 5 adds no state.
- Required checks MUST NOT use `continue-on-error`. `npm run verify` MUST pass (SDD section 65).
- The Context Contract stays immutable and is written once per Run (SDD section 21).

---

## Phase 5 scope (SDD section 69)

> Build Backstage topology integration and generic MCP source.
> **Exit:** a fixture dependency can be discovered from Backstage with provenance.

**In scope:** the `ContextSourceConfiguration` entity of SDD section 53, its Prisma model, its migration, and its store; the SDD section 59 administration endpoints `POST`, `GET`, and `DELETE` on `/admin/projects/:id/context-sources`; a per-Run `ContextSourceProvider` that replaces the fixed registry; the read of the `context` block of `.factoree/config.yaml` at the pinned primary SHA; the Backstage Catalog port, its HTTP adapter, and `BackstageContextSource`; the SDD section 18 rules `backstage_relation` and `backstage_api_relation`; automatic reference repository discovery from a Backstage repository location; the generic MCP JSON-RPC client, the Action Policy MCP tool gate of SDD section 58, and `McpContextSource`; the Work Item labels read through the Linear API, which repairs the dead autonomy cap of SDD section 28; AT-04 and AT-36.

**Out of scope (later phases, do not build):** the Validation Contract and its assertions (Phase 6); preview startup, Playwright, HTTP validation, and Linear evidence upload (Phase 7); the Reviewer and the repair loop (Phase 8); patch capture and publishing (Phase 9); the Proof Pack (Phase 10); `ClaudeCodeRunner` and skill discovery, which SDD section 69 gives to Phase 11, so AT-37 is not built here (Phase 11); the live Fly Sprite proof and the remaining Definition of Done items (Phase 12). A success terminal state still does not exist, and Phase 5 does not add one.

---

## Decisions taken by the controller

Recorded so a later reviewer does not treat them as drift.

1. **A context source is configured per Project, so the source list is built per Run.** SDD section 53 requires a `ContextSourceConfiguration` entity, and SDD section 59 gives it three administration endpoints under one Project. A registry built once at worker start cannot hold a per-Project endpoint or a per-Project credential. `ContextResolver` therefore receives the sources of the Run in its `resolve` call rather than in its constructor.

2. **The `context` block of `.factoree/config.yaml` is read at the pinned primary SHA, on the control plane.** The block governs discovery, and SDD section 49 places context resolution before the sandbox exists. `git cat-file blob <sha>:.factoree/config.yaml` reads the exact file the sandbox later checks out. This carries out the Phase 4 plan decision 3 that Phase 4 did not build, and it closes the carried finding that the block is parsed and consumed by nothing.

3. **A discovery-time read of `.factoree/config.yaml` that fails is not fatal.** SDD section 15 makes the file mandatory, and `SandboxManager` already fails the Run on a missing or invalid file at `PREPARING`, against the authoritative checkout. A second enforcement point during discovery would duplicate that rule and would break on a repository whose file is valid but unreadable at this moment. A failed read therefore yields the defaults, which are `backstage: false` and `automaticDiscovery: false`. The safe direction and SDD section 18 agree: no source is added by a failure.

4. **Backstage needs two switches: an administrator configures the endpoint, and the repository opts in.** SDD section 19 says "When configured". The configuration row carries the endpoint and the credential, which only an administrator can set. `context.backstage.enabled` in the repository says this repository wants topology discovery. Both must be true. Either switch alone leaves the source unregistered.

5. **Every Backstage candidate carries the authority class `declarative_catalog`.** SDD section 19 states that Backstage does not automatically override executable code or an accepted architecture decision. `declarative_catalog` sits in the `system_topology` domain of SDD section 22, and that domain never competes with `architecture_intent` or `current_implementation`, so a catalog entry can never win against an ADR or against source code. Giving an API entity the class `machine_readable_contract` would place it in the `interface_contract` domain and would let the catalog beat a contract test, which SDD section 19 forbids.

6. **Backstage discovery is one hop from the entity of the primary repository, with a hard entity cap.** SDD section 18 forbids organization-wide unbounded retrieval by default. The walk starts from one entity, follows `dependsOn`, `providesApis`, `consumesApis`, the owner, and the system, and stops. It never calls a catalog list endpoint without a filter.

7. **A Backstage repository location becomes a real reference repository of the Run, not a note.** SDD section 20 requires an explicit commit SHA for every reference repository. A discovered repository therefore goes through the same repository source, in a second discovery pass, and its pinned SHA reaches the checkout. Automatic discovery stays off unless `context.referenceRepositories.automaticDiscovery` is true, and at most three repositories are added, because each one costs a mirror clone.

8. **An automatically discovered repository is accepted only on the host of the Project.** The workflow rebuilds every clone URL from `project.repositoryBaseUrl` and a slug. A repository on another host would silently become the wrong URL. Such a repository is recorded as a `discoverable` Context Item with its real location, and it is not checked out.

9. **The MCP client is a small JSON-RPC client, not a new dependency.** SDD section 10 names "MCP client" and names no library. The source needs `initialize`, `tools/list`, and `tools/call` only. A hand-written client over `fetch` keeps the dependency set unchanged, matches the hand-written Fly Sprites client and git port already in the repository, and makes a deterministic fixture server possible.

10. **The Action Policy gains an MCP tool decision, and the SDD section 29 action table is unchanged.** SDD section 29 enumerates agent actions in a sandbox. SDD section 58 adds a separate rule for MCP tool calls. The policy module therefore answers `decideMcpTool(name)`, which denies every tool unless the Project configuration allow-lists it by name. The default allow list is empty, which is exactly "no unrestricted organization-wide MCP access by default".

11. **The MCP authority class is configured, and the default is `prose_documentation`.** A generic external source has no fixed authority. The administrator states it, and the value is validated against the SDD section 22 class list, so no unknown class can reach a Context Item.

12. **Work Item labels are read in an activity, not in the webhook handler.** The Linear agent session webhook carries no label field, which is why the autonomy cap of SDD section 28 is dead today. The webhook handler must stay fast and must not depend on a Linear API round trip. An activity runs under the Temporal retry policy, and the workflow already resolves the Linear client per session, so the read belongs there.

13. **A Backstage or MCP failure degrades the Run; it does not fail it.** Neither source is required by SDD section 17 for a Run to proceed, and both are remote systems. A transport fault yields no candidate from that source, and the Run continues with the Linear and repository sources. A configuration fault, for example an endpoint that is not a URL, is caught at the administration API instead, where a human can repair it.

---

## Requirement mapping

| Requirement | Where |
| --- | --- |
| SDD section 17, Backstage Catalog source | Task 5 |
| SDD section 17, generic MCP source | Task 8 |
| SDD section 18, rule 3 `backstage_relation` | Task 5 |
| SDD section 18, rule 4 `backstage_api_relation` | Task 5 |
| SDD section 18, no unbounded organization retrieval | Tasks 5, 7, 8 |
| SDD section 19, entity kinds, ownership, `dependsOn`, `providesApis`, `consumesApis`, repository locations | Tasks 4, 5, 6 |
| SDD section 19, Backstage does not override code or an ADR | Task 5, decision 5 |
| SDD section 20, an automatically discovered reference repository is pinned to a SHA | Task 6 |
| SDD section 15, the `context` block is consumed | Task 3 |
| SDD section 21, provenance on every Backstage and MCP item | Tasks 5, 8 |
| SDD section 28, the autonomy cap reads real labels | Task 9 |
| SDD section 52, tenant scoping of the new entity | Tasks 1, 2 |
| SDD section 53, `ContextSourceConfiguration` | Task 1 |
| SDD section 58, every MCP tool call passes the Action Policy | Task 7 |
| SDD section 59, the three context-source endpoints | Task 2 |
| SDD section 60, no token in a log or an error | Tasks 4, 7 |
| AT-04 | Task 10 |
| AT-36 | Task 10 |

---

## Phase 5 exit evidence

The phase is complete when all of the following hold, and the controller has seen each one itself.

1. `npm run verify` exits 0 on the phase branch and again on `main` after the merge.
2. The skipped-test count is 7, the Phase 2, Phase 3, and Phase 4 baseline.
3. `tests/acceptance/at-04-backstage-discovery.test.ts` passes. A fixture Backstage catalog holds a component for the primary repository and an API that component consumes. The resolution produces a Context Candidate for that API, whose `reason` names the topology relation, whose `priority` is the SDD section 18 API-relation priority, whose `sourceId` is the configured source, and whose `sourceVersion` is the catalog entity version.
4. `tests/acceptance/at-36-mcp-source.test.ts` passes. A fixture MCP server over real HTTP supplies one candidate with a stable reference, a source version, an authority class, and a selection reason, and the item reaches the frozen Context Contract.
5. `tests/acceptance/phase-05-exit.test.ts` passes and asserts the SDD section 69 exit sentence: a fixture dependency is discovered from Backstage with provenance.
6. An MCP tool the Project did not allow-list is refused by the Action Policy, proved by a test.
7. No test is skipped or weakened to make the phase pass.

---

## File structure

**Create**

- `src/domain/context/context-source-configuration.ts` — the entity, the per-kind settings schema, and the store port.
- `src/domain/context/context-source-provider.ts` — builds the registry of one Run from the configurations.
- `src/domain/context/repository-context-configuration.ts` — reads the `context` block at the pinned primary SHA.
- `src/domain/context/backstage-source.ts` — `BackstageContextSource` and the catalog port.
- `src/domain/context/mcp-source.ts` — `McpContextSource` and the MCP tool port.
- `src/adapters/backstage/backstage-catalog-client.ts` — the Backstage Catalog HTTP client.
- `src/adapters/mcp/mcp-json-rpc-client.ts` — the MCP JSON-RPC client.
- `src/persistence/prisma/context-source-configuration.prisma.ts` — the Prisma store.
- `src/http/admin/context-sources.routes.ts` — the three SDD section 59 endpoints.
- `src/activities/github.activities.ts` — no. Not in this phase. (See "Out of scope".)
- `prisma/migrations/20260824120000_add_context_source_configuration/migration.sql`
- Tests, listed inside each task.

**Modify**

- `prisma/schema.prisma` — the `ContextSourceConfiguration` model and the `Project` relation.
- `src/domain/context/context-source.ts` — `ContextDiscoveryRequest.contextConfiguration`, `ContextCandidate.discoveredRepository`.
- `src/domain/context/context-resolver.ts` — sources per call, the second discovery pass, the discovered reference repositories.
- `src/domain/policy/action-policy.ts` — `decideMcpTool` and the allow list.
- `src/activities/context.activities.ts` — the configuration read and the provider.
- `src/activities/linear.activities.ts` — `fetchWorkItemLabels`.
- `src/domain/runs/ports.ts` — `WorkItemPort`.
- `src/adapters/linear/linear-agent-client.ts` — the label read.
- `src/workflows/agent-run.workflow.ts` — the label activity before refinement.
- `src/http/server.ts` — register the new routes.
- `src/bin/worker.ts` — wire the provider, the factories, and the reader.
- `tests/acceptance/support/resolve-fixture-context.ts` — the new resolver call shape.
- `tests/acceptance/support/context-fixture-repository.ts` — an optional `.factoree/config.yaml` override.

---

## Environment notes for every task

- Node 24 LTS is at `/opt/homebrew/opt/node@24/bin`. Prefix `PATH` with it. The Homebrew `node` 25 binary is broken.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`. Never write a file through a `cat` heredoc, and never build a commit message with `git commit -m "$(cat <<EOF ...)"`. Use `git commit -F` with a file.
- `node` and `npx` print a `dyld: Library not loaded: libllhttp.9.3.dylib` warning. It is noise, but it can kill a command silently.
- `timeout` and `gtimeout` are not installed.
- Docker is required for the integration and workflow suites.
- The Prisma CLI resolves `DATABASE_URL` eagerly, so every CLI call needs a value.
- Run the whole integration suite before you call a task complete, not one file. A Phase 4 task broke AT-33, and the regression survived four tasks, because each task ran only its own file.
- Write the migration SQL by hand and apply it through the Testcontainers database, the way both Phase 4 migrations were written.

---

### Task 1: The `ContextSourceConfiguration` entity

**Files:**
- Create: `src/domain/context/context-source-configuration.ts`
- Create: `src/persistence/prisma/context-source-configuration.prisma.ts`
- Create: `prisma/migrations/20260824120000_add_context_source_configuration/migration.sql`
- Modify: `prisma/schema.prisma`
- Test: `tests/unit/context-source-configuration.test.ts`
- Test: `tests/integration/context-source-configuration.test.ts`

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces: `ContextSourceKind`, `ContextSourceConfigurationRecord`, `CreateContextSourceConfigurationInput`, `ContextSourceConfigurationStore`, `parseContextSourceSettings`, `BackstageSourceSettings`, `McpSourceSettings`, `PrismaContextSourceConfigurationStore`, `RESERVED_CONTEXT_SOURCE_IDS`.

- [ ] **Step 1: Write the failing settings test**

Create `tests/unit/context-source-configuration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  RESERVED_CONTEXT_SOURCE_IDS,
  assertContextSourceId,
  parseContextSourceSettings,
} from "~/domain/context/context-source-configuration.js";

describe("parseContextSourceSettings", () => {
  it("gives a Backstage source its bounded defaults", () => {
    const settings = parseContextSourceSettings("backstage", {});
    expect(settings).toEqual({
      kind: "backstage",
      primaryComponent: null,
      maxEntities: 50,
      includeOwnership: true,
    });
  });

  it("rejects an unknown Backstage key", () => {
    expect(() => parseContextSourceSettings("backstage", { catalogWide: true })).toThrow(
      /catalogWide/,
    );
  });

  it("rejects an entity cap above the ceiling", () => {
    expect(() => parseContextSourceSettings("backstage", { maxEntities: 5000 })).toThrow(
      /maxEntities/,
    );
  });

  it("requires the two MCP tool names", () => {
    expect(() => parseContextSourceSettings("mcp", {})).toThrow(/discoverTool/);
  });

  it("allow-lists the two MCP tools it uses", () => {
    const settings = parseContextSourceSettings("mcp", {
      discoverTool: "search_docs",
      fetchTool: "read_doc",
    });
    expect(settings).toEqual({
      kind: "mcp",
      discoverTool: "search_docs",
      fetchTool: "read_doc",
      allowedTools: ["read_doc", "search_docs"],
      authority: "prose_documentation",
      maxCandidates: 20,
    });
  });

  it("rejects an authority class the SDD does not define", () => {
    expect(() =>
      parseContextSourceSettings("mcp", {
        discoverTool: "a",
        fetchTool: "b",
        authority: "gut_feeling",
      }),
    ).toThrow(/authority/);
  });

  it("keeps an extra allow-listed tool and still holds the two it calls", () => {
    const settings = parseContextSourceSettings("mcp", {
      discoverTool: "search_docs",
      fetchTool: "read_doc",
      allowedTools: ["ping"],
    });
    expect(settings).toEqual({
      kind: "mcp",
      discoverTool: "search_docs",
      fetchTool: "read_doc",
      allowedTools: ["ping", "read_doc", "search_docs"],
      authority: "prose_documentation",
      maxCandidates: 20,
    });
  });
});

describe("assertContextSourceId", () => {
  it("accepts a namespaced identifier", () => {
    expect(() => assertContextSourceId("mcp:internal-docs")).not.toThrow();
  });

  it("refuses an identifier a built-in source already owns", () => {
    for (const id of RESERVED_CONTEXT_SOURCE_IDS) {
      expect(() => assertContextSourceId(id)).toThrow(/reserved/);
    }
  });

  it("refuses an identifier with a space", () => {
    expect(() => assertContextSourceId("my source")).toThrow(/lower case/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/context-source-configuration.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the entity module**

Create `src/domain/context/context-source-configuration.ts`:

```ts
import { z } from "zod";
import { AUTHORITY_CLASSES, type AuthorityClass } from "./authority.js";

/**
 * SDD section 53 requires a `ContextSourceConfiguration` entity. SDD section 17 fixes the source
 * list of Version 1. Linear and the GitHub repositories are always present and need no row, so a
 * row configures a Backstage catalog or a generic MCP server only.
 */
export const CONTEXT_SOURCE_KINDS = ["backstage", "mcp"] as const;

export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];

/** The identifiers the built-in sources own. A configuration must not shadow one. */
export const RESERVED_CONTEXT_SOURCE_IDS = ["linear", "repository"] as const;

const SOURCE_ID = /^[a-z0-9][a-z0-9._:-]*$/;

export class ContextSourceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextSourceConfigurationError";
  }
}

export const assertContextSourceId = (id: string): void => {
  if (!SOURCE_ID.test(id)) {
    throw new ContextSourceConfigurationError(
      `The context source identifier "${id}" must be lower case letters, digits, dot, colon, ` +
        "underscore, or hyphen, and must start with a letter or a digit.",
    );
  }
  if ((RESERVED_CONTEXT_SOURCE_IDS as readonly string[]).includes(id)) {
    throw new ContextSourceConfigurationError(
      `The context source identifier "${id}" is reserved for a built-in source.`,
    );
  }
};

/**
 * SDD section 18 forbids organization-wide unbounded retrieval by default, so every bound below
 * has a ceiling a configuration cannot raise.
 */
const backstageSettings = z
  .object({
    kind: z.literal("backstage").default("backstage"),
    /**
     * The catalog entity to start from, as `component:default/name`. When it is null the source
     * finds the entity of the primary repository instead.
     */
    primaryComponent: z.string().min(1).nullable().default(null),
    maxEntities: z.number().int().min(1).max(200).default(50),
    includeOwnership: z.boolean().default(true),
  })
  .strict();

const mcpSettings = z
  .object({
    kind: z.literal("mcp").default("mcp"),
    discoverTool: z.string().min(1),
    fetchTool: z.string().min(1),
    /**
     * SDD section 58. A tool call is denied unless this list names the tool. The two tools the
     * source calls are always added, because configuring a tool and forbidding it is a mistake,
     * not a policy.
     */
    allowedTools: z.array(z.string().min(1)).default([]),
    authority: z.enum(AUTHORITY_CLASSES as unknown as [string, ...string[]]).default(
      "prose_documentation",
    ),
    maxCandidates: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export type BackstageSourceSettings = z.infer<typeof backstageSettings>;

export interface McpSourceSettings {
  kind: "mcp";
  discoverTool: string;
  fetchTool: string;
  allowedTools: string[];
  authority: AuthorityClass;
  maxCandidates: number;
}

export type ContextSourceSettings = BackstageSourceSettings | McpSourceSettings;

const describeIssue = (issue: z.core.$ZodIssue): string => {
  const path = issue.path.length === 0 ? "settings" : issue.path.join(".");
  const keys = issue.code === "unrecognized_keys" ? ` (${issue.keys.join(", ")})` : "";
  return `${path}: ${issue.message}${keys}`;
};

/**
 * Validates the settings of one configuration row. SDD section 15 requires that an unknown key
 * fails validation, and the same rule is right here: a typo must never pass as a default.
 */
export const parseContextSourceSettings = (
  kind: ContextSourceKind,
  settings: unknown,
): ContextSourceSettings => {
  const schema = kind === "backstage" ? backstageSettings : mcpSettings;
  const parsed = schema.safeParse(settings ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map(describeIssue).join("; ");
    throw new ContextSourceConfigurationError(
      `The ${kind} context source settings are invalid: ${detail}`,
    );
  }
  if (parsed.data.kind === "backstage") return parsed.data as BackstageSourceSettings;
  const data = parsed.data as z.infer<typeof mcpSettings>;
  return {
    kind: "mcp",
    discoverTool: data.discoverTool,
    fetchTool: data.fetchTool,
    allowedTools: [...new Set([...data.allowedTools, data.discoverTool, data.fetchTool])].sort(),
    authority: data.authority as AuthorityClass,
    maxCandidates: data.maxCandidates,
  };
};

export interface ContextSourceConfigurationRecord {
  id: string;
  tenantId: string;
  projectId: string;
  /** The value `ContextSource.id()` returns for the built source. */
  sourceId: string;
  kind: ContextSourceKind;
  enabled: boolean;
  /** The base URL of the catalog or of the MCP server. */
  endpoint: string;
  /**
   * SDD section 30. A credential never lives in this row. The column names one `ProjectSecret`
   * of the same Project, and the value is read at the moment the source is built.
   */
  secretName: string | null;
  settings: ContextSourceSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateContextSourceConfigurationInput {
  tenantId: string;
  projectId: string;
  sourceId: string;
  kind: ContextSourceKind;
  endpoint: string;
  enabled?: boolean;
  secretName?: string | null;
  settings?: unknown;
}

/** SDD section 52. Every method filters on the tenant. */
export interface ContextSourceConfigurationStore {
  put(input: CreateContextSourceConfigurationInput): Promise<ContextSourceConfigurationRecord>;
  list(tenantId: string, projectId: string): Promise<ContextSourceConfigurationRecord[]>;
  remove(tenantId: string, projectId: string, sourceId: string): Promise<boolean>;
}
```

- [ ] **Step 4: Run the unit test and watch it pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/context-source-configuration.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the Prisma model**

In `prisma/schema.prisma`, add to `model Project` the relation line:

```prisma
  contextSources     ContextSourceConfiguration[]
```

and add the model:

```prisma
model ContextSourceConfiguration {
  id          String   @id @default(uuid())
  tenantId    String
  projectId   String
  project     Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  // The identifier the built source reports from `ContextSource.id()`.
  sourceId    String
  kind        String
  enabled     Boolean  @default(true)
  endpoint    String
  // SDD section 30. This column names a ProjectSecret. It never holds a credential.
  secretName  String?
  settings    Json
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([projectId, sourceId])
  @@index([tenantId])
}
```

- [ ] **Step 6: Write the migration by hand**

Create `prisma/migrations/20260824120000_add_context_source_configuration/migration.sql`:

```sql
-- SDD section 53. One row per configured Backstage catalog or MCP server of one Project.
-- The table is new, so no row can exist and no backfill is needed.
CREATE TABLE "ContextSourceConfiguration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "endpoint" TEXT NOT NULL,
    "secretName" TEXT,
    "settings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextSourceConfiguration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContextSourceConfiguration_projectId_sourceId_key"
    ON "ContextSourceConfiguration"("projectId", "sourceId");

CREATE INDEX "ContextSourceConfiguration_tenantId_idx"
    ON "ContextSourceConfiguration"("tenantId");

ALTER TABLE "ContextSourceConfiguration"
    ADD CONSTRAINT "ContextSourceConfiguration_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 7: Regenerate the Prisma client**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH DATABASE_URL=postgresql://placeholder npx prisma generate`
Expected: the client generates without an error.

- [ ] **Step 8: Write the failing store integration test**

Create `tests/integration/context-source-configuration.test.ts`. Copy the container and Prisma setup of `tests/integration/project-registry.test.ts` exactly, then assert:

```ts
it("writes, reads back, and removes one configuration inside one tenant", async () => {
  const store = new PrismaContextSourceConfigurationStore(prisma);
  const created = await store.put({
    tenantId: tenant.id,
    projectId: project.id,
    sourceId: "backstage",
    kind: "backstage",
    endpoint: "https://backstage.example.test",
    secretName: "BACKSTAGE_TOKEN",
    settings: { maxEntities: 10 },
  });
  expect(created.settings).toEqual({
    kind: "backstage",
    primaryComponent: null,
    maxEntities: 10,
    includeOwnership: true,
  });

  const listed = await store.list(tenant.id, project.id);
  expect(listed.map((row) => row.sourceId)).toEqual(["backstage"]);

  // SDD section 52. Another tenant sees nothing, even with the right project id.
  expect(await store.list(otherTenant.id, project.id)).toEqual([]);
  expect(await store.remove(otherTenant.id, project.id, "backstage")).toBe(false);
  expect(await store.remove(tenant.id, project.id, "backstage")).toBe(true);
  expect(await store.list(tenant.id, project.id)).toEqual([]);
});

it("replaces the row of the same source identifier rather than adding a second", async () => {
  const store = new PrismaContextSourceConfigurationStore(prisma);
  await store.put({ tenantId: tenant.id, projectId: project.id, sourceId: "backstage", kind: "backstage", endpoint: "https://a.test" });
  const second = await store.put({ tenantId: tenant.id, projectId: project.id, sourceId: "backstage", kind: "backstage", endpoint: "https://b.test" });
  expect(second.endpoint).toBe("https://b.test");
  expect(await store.list(tenant.id, project.id)).toHaveLength(1);
});

it("refuses settings that do not belong to the kind", async () => {
  const store = new PrismaContextSourceConfigurationStore(prisma);
  await expect(
    store.put({ tenantId: tenant.id, projectId: project.id, sourceId: "docs", kind: "mcp", endpoint: "https://a.test", settings: {} }),
  ).rejects.toThrow(/discoverTool/);
});
```

- [ ] **Step 9: Run it and watch it fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/context-source-configuration.test.ts`
Expected: FAIL, the store does not exist.

- [ ] **Step 10: Write the Prisma store**

Create `src/persistence/prisma/context-source-configuration.prisma.ts`:

```ts
import type { PrismaClient } from "@prisma/client";
import type {
  ContextSourceConfigurationRecord,
  ContextSourceConfigurationStore,
  ContextSourceKind,
  CreateContextSourceConfigurationInput,
} from "~/domain/context/context-source-configuration.js";
import {
  CONTEXT_SOURCE_KINDS,
  ContextSourceConfigurationError,
  assertContextSourceId,
  parseContextSourceSettings,
} from "~/domain/context/context-source-configuration.js";

/**
 * A stored string column is guarded rather than cast, the way the Phase 4 context store guards
 * every column it reads back.
 */
const asKind = (value: string): ContextSourceKind => {
  if ((CONTEXT_SOURCE_KINDS as readonly string[]).includes(value)) return value as ContextSourceKind;
  throw new ContextSourceConfigurationError(`"${value}" is not a context source kind.`);
};

interface Row {
  id: string;
  tenantId: string;
  projectId: string;
  sourceId: string;
  kind: string;
  enabled: boolean;
  endpoint: string;
  secretName: string | null;
  settings: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const toRecord = (row: Row): ContextSourceConfigurationRecord => {
  const kind = asKind(row.kind);
  return {
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    sourceId: row.sourceId,
    kind,
    enabled: row.enabled,
    endpoint: row.endpoint,
    secretName: row.secretName,
    settings: parseContextSourceSettings(kind, row.settings),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

export class PrismaContextSourceConfigurationStore implements ContextSourceConfigurationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async put(
    input: CreateContextSourceConfigurationInput,
  ): Promise<ContextSourceConfigurationRecord> {
    assertContextSourceId(input.sourceId);
    const settings = parseContextSourceSettings(input.kind, input.settings);
    // The endpoint must be a URL an operator can repair now, not a fault inside a Run.
    try {
      new URL(input.endpoint);
    } catch {
      throw new ContextSourceConfigurationError(
        `The endpoint "${input.endpoint}" is not a valid URL.`,
      );
    }
    const data = {
      tenantId: input.tenantId,
      projectId: input.projectId,
      sourceId: input.sourceId,
      kind: input.kind,
      enabled: input.enabled ?? true,
      endpoint: input.endpoint,
      secretName: input.secretName ?? null,
      settings: settings as unknown as object,
    };
    const row = await this.prisma.contextSourceConfiguration.upsert({
      where: { projectId_sourceId: { projectId: input.projectId, sourceId: input.sourceId } },
      create: data,
      update: data,
    });
    return toRecord(row as Row);
  }

  async list(tenantId: string, projectId: string): Promise<ContextSourceConfigurationRecord[]> {
    const rows = await this.prisma.contextSourceConfiguration.findMany({
      where: { tenantId, projectId },
      orderBy: { sourceId: "asc" },
    });
    return rows.map((row) => toRecord(row as Row));
  }

  async remove(tenantId: string, projectId: string, sourceId: string): Promise<boolean> {
    const result = await this.prisma.contextSourceConfiguration.deleteMany({
      where: { tenantId, projectId, sourceId },
    });
    return result.count > 0;
  }
}
```

- [ ] **Step 11: Run the integration test and watch it pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/context-source-configuration.test.ts`
Expected: PASS.

- [ ] **Step 12: Run the whole verification**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run verify`
Expected: exit 0.

- [ ] **Step 13: Commit**

```bash
git add prisma src/domain/context/context-source-configuration.ts src/persistence/prisma/context-source-configuration.prisma.ts tests/unit/context-source-configuration.test.ts tests/integration/context-source-configuration.test.ts
git commit -F /tmp/factoree-commit-msg.txt
```

The message: `feat(context): add the ContextSourceConfiguration entity of SDD section 53`.

---

### Task 2: The administration endpoints of SDD section 59

**Files:**
- Create: `src/http/admin/context-sources.routes.ts`
- Modify: `src/http/server.ts`
- Test: `tests/integration/admin-api.test.ts` (extend)

**Interfaces:**
- Consumes: `ContextSourceConfigurationStore`, `ContextSourceConfigurationError` from Task 1.
- Produces: `registerContextSourceRoutes(app, dependencies)`.

- [ ] **Step 1: Read the existing routes**

Read `src/http/admin/projects.routes.ts` and `src/http/server.ts`. Match their shape exactly: the same authentication hook, the same tenant resolution, the same error mapping, the same reply codes.

- [ ] **Step 2: Write the failing route tests**

Extend `tests/integration/admin-api.test.ts` with a describe block:

```ts
describe("the context source endpoints of SDD section 59", () => {
  it("creates, lists, and deletes one source", async () => {
    const created = await request("POST", `/admin/projects/${projectId}/context-sources`, {
      sourceId: "backstage",
      kind: "backstage",
      endpoint: "https://backstage.example.test",
      secretName: "BACKSTAGE_TOKEN",
      settings: { maxEntities: 10 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().sourceId).toBe("backstage");
    // SDD section 60. The response names the secret and never carries its value.
    expect(JSON.stringify(created.json())).not.toContain("secretValue");

    const listed = await request("GET", `/admin/projects/${projectId}/context-sources`);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().map((row: { sourceId: string }) => row.sourceId)).toEqual(["backstage"]);

    const deleted = await request("DELETE", `/admin/projects/${projectId}/context-sources/backstage`);
    expect(deleted.statusCode).toBe(204);
    expect((await request("DELETE", `/admin/projects/${projectId}/context-sources/backstage`)).statusCode).toBe(404);
  });

  it("refuses an invalid setting with 400 and names the key", async () => {
    const response = await request("POST", `/admin/projects/${projectId}/context-sources`, {
      sourceId: "docs",
      kind: "mcp",
      endpoint: "https://docs.example.test",
      settings: { discoverTool: "search", fetchTool: "read", catalogWide: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/catalogWide/);
  });

  it("refuses a reserved source identifier with 400", async () => {
    const response = await request("POST", `/admin/projects/${projectId}/context-sources`, {
      sourceId: "linear",
      kind: "mcp",
      endpoint: "https://docs.example.test",
      settings: { discoverTool: "search", fetchTool: "read" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/reserved/);
  });

  it("refuses a request without the administration token", async () => {
    const response = await unauthenticatedRequest("GET", `/admin/projects/${projectId}/context-sources`);
    expect(response.statusCode).toBe(401);
  });

  it("returns 404 for a project of another tenant", async () => {
    const response = await request("GET", `/admin/projects/${otherTenantProjectId}/context-sources`);
    expect(response.statusCode).toBe(404);
  });
});
```

Use the helpers the file already defines. If it has no `unauthenticatedRequest`, follow whatever the existing unauthorized test uses.

- [ ] **Step 3: Run it and watch it fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.integration.config.ts tests/integration/admin-api.test.ts`
Expected: FAIL with 404 on the new paths.

- [ ] **Step 4: Write the routes**

Create `src/http/admin/context-sources.routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProjectRegistry } from "~/domain/projects/project-registry.js";
import type { ContextSourceConfigurationStore } from "~/domain/context/context-source-configuration.js";
import {
  CONTEXT_SOURCE_KINDS,
  ContextSourceConfigurationError,
} from "~/domain/context/context-source-configuration.js";

export interface ContextSourceRouteDependencies {
  projects: ProjectRegistry;
  contextSources: ContextSourceConfigurationStore;
  /** The same tenant resolution the other administration routes use. */
  resolveTenantId: (request: unknown) => Promise<string>;
}

const body = z
  .object({
    sourceId: z.string().min(1),
    kind: z.enum(CONTEXT_SOURCE_KINDS),
    endpoint: z.string().min(1),
    enabled: z.boolean().optional(),
    secretName: z.string().min(1).nullable().optional(),
    settings: z.unknown().optional(),
  })
  .strict();

/** SDD section 59 fixes these three paths. */
export const registerContextSourceRoutes = (
  app: FastifyInstance,
  dependencies: ContextSourceRouteDependencies,
): void => {
  app.post<{ Params: { id: string } }>(
    "/admin/projects/:id/context-sources",
    async (request, reply) => {
      const tenantId = await dependencies.resolveTenantId(request);
      const project = await dependencies.projects.findById(tenantId, request.params.id);
      if (!project) return reply.code(404).send({ error: "no such project" });

      const parsed = body.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
      }

      try {
        const record = await dependencies.contextSources.put({
          tenantId,
          projectId: project.id,
          sourceId: parsed.data.sourceId,
          kind: parsed.data.kind,
          endpoint: parsed.data.endpoint,
          ...(parsed.data.enabled === undefined ? {} : { enabled: parsed.data.enabled }),
          ...(parsed.data.secretName === undefined ? {} : { secretName: parsed.data.secretName }),
          settings: parsed.data.settings,
        });
        return reply.code(201).send(record);
      } catch (error) {
        if (error instanceof ContextSourceConfigurationError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/projects/:id/context-sources",
    async (request, reply) => {
      const tenantId = await dependencies.resolveTenantId(request);
      const project = await dependencies.projects.findById(tenantId, request.params.id);
      if (!project) return reply.code(404).send({ error: "no such project" });
      return reply.code(200).send(await dependencies.contextSources.list(tenantId, project.id));
    },
  );

  app.delete<{ Params: { id: string; sourceId: string } }>(
    "/admin/projects/:id/context-sources/:sourceId",
    async (request, reply) => {
      const tenantId = await dependencies.resolveTenantId(request);
      const project = await dependencies.projects.findById(tenantId, request.params.id);
      if (!project) return reply.code(404).send({ error: "no such project" });
      const removed = await dependencies.contextSources.remove(
        tenantId,
        project.id,
        request.params.sourceId,
      );
      return removed ? reply.code(204).send() : reply.code(404).send({ error: "no such context source" });
    },
  );
};
```

Adjust `resolveTenantId` to the exact mechanism `projects.routes.ts` already uses. Do not invent a second mechanism.

- [ ] **Step 5: Register the routes**

In `src/http/server.ts`, call `registerContextSourceRoutes` beside `registerProjectRoutes`, with the store built from the same Prisma client.

- [ ] **Step 6: Run the integration suite and watch it pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test:integration`
Expected: PASS, including AT-33.

- [ ] **Step 7: Run the whole verification and commit**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run verify`
Then commit with the message `feat(admin): add the context source endpoints of SDD section 59`.

---

### Task 3: Per-Run sources and the repository `context` block

**Files:**
- Create: `src/domain/context/context-source-provider.ts`
- Create: `src/domain/context/repository-context-configuration.ts`
- Modify: `src/domain/context/context-source.ts`
- Modify: `src/domain/context/context-resolver.ts`
- Modify: `src/activities/context.activities.ts`
- Modify: `src/bin/worker.ts`
- Modify: `tests/acceptance/support/resolve-fixture-context.ts`
- Test: `tests/unit/repository-context-configuration.test.ts`
- Test: `tests/unit/context-source-provider.test.ts`
- Test: `tests/unit/context-resolver.test.ts` (update the call shape)
- Test: `tests/unit/resolve-context-activity.test.ts` (update the wiring)

**Interfaces:**
- Consumes: `ContextSourceConfigurationRecord`, `ContextSourceConfigurationStore` from Task 1.
- Produces:
  - `RepositoryContextConfiguration = { backstageEnabled: boolean; automaticReferenceDiscovery: boolean }`
  - `DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION`
  - `readRepositoryContextConfiguration(reader, url, ref): Promise<RepositoryContextConfiguration>`
  - `ContextSourceFactory = (record, credential) => ContextSource`
  - `ContextSourceProvider` with `sourcesFor(scope): Promise<ContextSourceRegistry>`
  - `ConfiguredContextSourceProvider`
  - `ContextDiscoveryRequest.contextConfiguration`
  - `ContextResolver` with no constructor argument, and `ResolveContextInput.sources` plus `ResolveContextInput.contextConfiguration`.

- [ ] **Step 1: Write the failing configuration-read test**

Create `tests/unit/repository-context-configuration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeRepositoryReader } from "../support/fake-repository-reader.js";
import {
  DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION,
  readRepositoryContextConfiguration,
} from "~/domain/context/repository-context-configuration.js";

const VALID = `version: 1

verify:
  commands:
    - name: check
      run: "true"

context:
  backstage:
    enabled: true
  referenceRepositories:
    automaticDiscovery: true
`;

describe("readRepositoryContextConfiguration", () => {
  it("reads the context block at the pinned SHA", async () => {
    const reader = new FakeRepositoryReader({
      "https://git.test/acme/app.git": { sha: "a".repeat(40), files: { ".factoree/config.yaml": VALID } },
    });
    const configuration = await readRepositoryContextConfiguration(
      reader,
      "https://git.test/acme/app.git",
      "main",
    );
    expect(configuration).toEqual({ backstageEnabled: true, automaticReferenceDiscovery: true });
    // The read must use the SHA, never the branch name.
    expect(reader.calls).toContain(`readBlob https://git.test/acme/app.git ${"a".repeat(40)} .factoree/config.yaml`);
  });

  it("returns the defaults when the file is missing", async () => {
    const reader = new FakeRepositoryReader({
      "https://git.test/acme/app.git": { sha: "b".repeat(40), files: {} },
    });
    expect(
      await readRepositoryContextConfiguration(reader, "https://git.test/acme/app.git", "main"),
    ).toEqual(DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION);
  });

  it("returns the defaults when the file is invalid, because PREPARING fails the Run instead", async () => {
    const reader = new FakeRepositoryReader({
      "https://git.test/acme/app.git": { sha: "c".repeat(40), files: { ".factoree/config.yaml": "nope: 1" } },
    });
    expect(
      await readRepositoryContextConfiguration(reader, "https://git.test/acme/app.git", "main"),
    ).toEqual(DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION);
  });

  it("returns the defaults when the repository cannot be reached", async () => {
    const reader = new FakeRepositoryReader({});
    expect(
      await readRepositoryContextConfiguration(reader, "https://git.test/missing.git", "main"),
    ).toEqual(DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/repository-context-configuration.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the configuration reader**

Create `src/domain/context/repository-context-configuration.ts`:

```ts
import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { FACTOREE_CONFIG_PATH, parseFactoreeConfig } from "~/domain/projects/factoree-config.js";

/**
 * SDD section 15. The `context` block governs discovery, and SDD section 49 puts discovery
 * before the sandbox exists. The file is therefore read on the control plane, at the SHA the
 * checkout will later use, through the same read-only git port discovery already uses.
 */
export interface RepositoryContextConfiguration {
  /** SDD section 19. This repository asks for Backstage topology discovery. */
  backstageEnabled: boolean;
  /** SDD section 20. This repository accepts a reference repository Factoree discovers. */
  automaticReferenceDiscovery: boolean;
}

/** SDD section 18 disables broad retrieval by default, so both switches start off. */
export const DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION: RepositoryContextConfiguration = {
  backstageEnabled: false,
  automaticReferenceDiscovery: false,
};

/**
 * Reads the block. A missing file, an invalid file, and an unreachable repository all yield the
 * defaults. SDD section 15 is enforced against the real checkout in `SandboxManager`, which
 * fails the Run there. A second enforcement point here would fail a Run twice for one fault, and
 * would let a transient read fault stop a Run that has a valid file. See controller decision 3.
 */
export const readRepositoryContextConfiguration = async (
  reader: RepositoryReader,
  url: string,
  ref: string,
): Promise<RepositoryContextConfiguration> => {
  try {
    const sha = await reader.resolveRef(url, ref);
    const text = await reader.readBlob(url, sha, FACTOREE_CONFIG_PATH);
    if (text === null) return DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION;
    const config = parseFactoreeConfig(text);
    return {
      backstageEnabled: config.context.backstage.enabled,
      automaticReferenceDiscovery: config.context.referenceRepositories.automaticDiscovery,
    };
  } catch {
    return DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION;
  }
};
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/repository-context-configuration.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing provider test**

Create `tests/unit/context-source-provider.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type {
  ContextCandidate,
  ContextDocument,
  ContextReference,
  ContextSource,
} from "~/domain/context/context-source.js";
import { ConfiguredContextSourceProvider } from "~/domain/context/context-source-provider.js";
import type {
  ContextSourceConfigurationRecord,
  ContextSourceConfigurationStore,
  CreateContextSourceConfigurationInput,
} from "~/domain/context/context-source-configuration.js";

const stub = (id: string): ContextSource => ({
  id: () => id,
  discover: (): Promise<ContextCandidate[]> => Promise.resolve([]),
  fetch: (reference: ContextReference): Promise<ContextDocument> =>
    Promise.resolve({ reference, sourceVersion: "1", content: "" }),
});

const record = (
  over: Partial<ContextSourceConfigurationRecord>,
): ContextSourceConfigurationRecord => ({
  id: "row",
  tenantId: "tenant",
  projectId: "project",
  sourceId: "backstage",
  kind: "backstage",
  enabled: true,
  endpoint: "https://backstage.test",
  secretName: null,
  settings: { kind: "backstage", primaryComponent: null, maxEntities: 50, includeOwnership: true },
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const storeOf = (rows: ContextSourceConfigurationRecord[]): ContextSourceConfigurationStore => ({
  put: (_input: CreateContextSourceConfigurationInput) => Promise.reject(new Error("unused")),
  list: () => Promise.resolve(rows),
  remove: () => Promise.resolve(false),
});

const providerOf = (
  rows: ContextSourceConfigurationRecord[],
  secrets: Record<string, string> = {},
): ConfiguredContextSourceProvider =>
  new ConfiguredContextSourceProvider({
    configurations: storeOf(rows),
    secrets: { read: (_tenantId, _projectId, name) => Promise.resolve(secrets[name] ?? null) },
    fixedSources: () => [stub("linear"), stub("repository")],
    factories: {
      backstage: (row) => stub(row.sourceId),
      mcp: (row) => stub(row.sourceId),
    },
  });

const scope = (over: Partial<{ backstageEnabled: boolean; automaticReferenceDiscovery: boolean }> = {}) => ({
  tenantId: "tenant",
  projectId: "project",
  contextConfiguration: {
    backstageEnabled: true,
    automaticReferenceDiscovery: false,
    ...over,
  },
});

describe("ConfiguredContextSourceProvider", () => {
  it("always registers the built-in sources", async () => {
    const registry = await providerOf([]).sourcesFor(scope());
    expect(registry.ids()).toEqual(["linear", "repository"]);
  });

  it("adds a configured Backstage source when the repository opts in", async () => {
    const registry = await providerOf([record({})]).sourcesFor(scope());
    expect(registry.ids()).toEqual(["backstage", "linear", "repository"]);
  });

  it("leaves Backstage out when the repository does not opt in", async () => {
    const registry = await providerOf([record({})]).sourcesFor(scope({ backstageEnabled: false }));
    expect(registry.ids()).toEqual(["linear", "repository"]);
  });

  it("leaves a disabled row out", async () => {
    const registry = await providerOf([record({ enabled: false })]).sourcesFor(scope());
    expect(registry.ids()).toEqual(["linear", "repository"]);
  });

  it("adds an MCP source without a repository switch, because SDD section 15 defines none", async () => {
    const rows = [
      record({
        sourceId: "docs",
        kind: "mcp",
        settings: {
          kind: "mcp",
          discoverTool: "search",
          fetchTool: "read",
          allowedTools: ["read", "search"],
          authority: "prose_documentation",
          maxCandidates: 20,
        },
      }),
    ];
    const registry = await providerOf(rows).sourcesFor(scope({ backstageEnabled: false }));
    expect(registry.ids()).toEqual(["docs", "linear", "repository"]);
  });

  it("leaves out a row whose named secret does not exist", async () => {
    const registry = await providerOf([record({ secretName: "MISSING" })]).sourcesFor(scope());
    expect(registry.ids()).toEqual(["linear", "repository"]);
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/context-source-provider.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 7: Write the provider**

Create `src/domain/context/context-source-provider.ts`:

```ts
import type { ContextSource } from "./context-source.js";
import { ContextSourceRegistry } from "./context-source-registry.js";
import type {
  ContextSourceConfigurationRecord,
  ContextSourceConfigurationStore,
  ContextSourceKind,
} from "./context-source-configuration.js";
import type { RepositoryContextConfiguration } from "./repository-context-configuration.js";

export interface ContextSourceScope {
  tenantId: string;
  projectId: string;
  contextConfiguration: RepositoryContextConfiguration;
}

/**
 * SDD section 17 fixes the source interface, so nothing here names a concrete source. The worker
 * supplies one factory per kind, and a factory lives beside its adapter.
 */
export type ContextSourceFactory = (
  record: ContextSourceConfigurationRecord,
  credential: string | null,
) => ContextSource;

export interface ContextSourceProvider {
  sourcesFor(scope: ContextSourceScope): Promise<ContextSourceRegistry>;
}

/** SDD section 30. A credential is read at the moment a source is built, and never stored. */
export interface ContextSourceSecretReader {
  read(tenantId: string, projectId: string, name: string): Promise<string | null>;
}

export interface ConfiguredContextSourceProviderOptions {
  configurations: ContextSourceConfigurationStore;
  secrets: ContextSourceSecretReader;
  /** The sources every Run has: Linear and the GitHub repositories of SDD section 17. */
  fixedSources: () => ContextSource[];
  factories: Record<ContextSourceKind, ContextSourceFactory>;
}

/**
 * Builds the context sources of one Run. SDD section 53 makes a source a per-Project record, so
 * the registry cannot be built once per worker. See controller decision 1.
 */
export class ConfiguredContextSourceProvider implements ContextSourceProvider {
  constructor(private readonly options: ConfiguredContextSourceProviderOptions) {}

  async sourcesFor(scope: ContextSourceScope): Promise<ContextSourceRegistry> {
    const registry = new ContextSourceRegistry(this.options.fixedSources());
    const records = await this.options.configurations.list(scope.tenantId, scope.projectId);

    for (const record of records) {
      if (!record.enabled) continue;
      // SDD section 19. Backstage needs the administrator endpoint and the repository opt in.
      // See controller decision 4.
      if (record.kind === "backstage" && !scope.contextConfiguration.backstageEnabled) continue;

      let credential: string | null = null;
      if (record.secretName !== null) {
        credential = await this.options.secrets.read(
          scope.tenantId,
          scope.projectId,
          record.secretName,
        );
        // A source that needs a credential and has none must not run without one. Leaving it out
        // degrades the Run, which controller decision 13 permits, and it never sends an
        // unauthenticated request in its place.
        if (credential === null) continue;
      }

      registry.register(this.options.factories[record.kind](record, credential));
    }

    return registry;
  }
}
```

- [ ] **Step 8: Run the provider test and watch it pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/context-source-provider.test.ts`
Expected: PASS.

- [ ] **Step 9: Extend the discovery request and the candidate**

In `src/domain/context/context-source.ts`, add to `ContextDiscoveryRequest`:

```ts
  /** SDD section 15. The `context` block of the primary repository, at the pinned SHA. */
  contextConfiguration: RepositoryContextConfiguration;
```

and add to `ContextCandidate`:

```ts
  /**
   * SDD section 20. A source that learns of a repository Factoree does not yet read reports it
   * here. The resolver decides whether it becomes a reference repository of the Run.
   */
  discoveredRepository?: { slug: string; url: string };
```

Import the type. Keep `discoveredRepository` optional, so no existing source changes.

- [ ] **Step 10: Move the sources into the resolve call**

In `src/domain/context/context-resolver.ts`:

- Delete `ContextResolverOptions` and the constructor. The class becomes `export class ContextResolver { async resolve(...) }`.
- Add to `ResolveContextInput`:

```ts
  /** The sources of this Run. SDD section 53 makes the list per Project. */
  sources: ContextSourceRegistry;
  contextConfiguration: RepositoryContextConfiguration;
```

- Replace `this.options.sources` with `input.sources` at both use sites.
- Pass `contextConfiguration: input.contextConfiguration` into `request`.

- [ ] **Step 11: Update the resolver call sites**

- `src/activities/context.activities.ts`: the dependency block gains `sources: ContextSourceProvider` and `repositoryReader: RepositoryReader`. Before `resolver.resolve`, insert:

```ts
    // SDD section 15 and controller decision 2. The `context` block governs discovery, and
    // discovery runs before the sandbox exists, so the file is read at the pinned primary SHA.
    const contextConfiguration = await readRepositoryContextConfiguration(
      dependencies.repositoryReader,
      input.primaryRepository.url,
      input.primaryRepository.ref,
    );
    const sources = await dependencies.sources.sourcesFor({
      tenantId: input.tenantId,
      projectId: input.projectId,
      contextConfiguration,
    });
```

and pass `sources` and `contextConfiguration` into `resolver.resolve`.

- `src/bin/worker.ts`: replace the fixed `ContextSourceRegistry` with a `ConfiguredContextSourceProvider`. The factories throw `new Error("not built yet")` for now; Tasks 5 and 8 fill them. `fixedSources` returns a fresh `LinearContextSource` and a fresh `RepositoryContextSource` on every call, because both hold per-discovery state. Pass `repositoryReader` into the activities.
- `tests/acceptance/support/resolve-fixture-context.ts`: build the registry inline and pass it, plus `contextConfiguration: DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION`. Add an optional `sources` and `contextConfiguration` parameter to `ResolveFixtureContextInput`, defaulted to today's behaviour, so AT-06, AT-07, and AT-09 stay unchanged and Task 10 can pass a Backstage source.
- `tests/unit/context-resolver.test.ts` and `tests/unit/resolve-context-activity.test.ts`: update the construction.

- [ ] **Step 12: Run the whole verification**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run verify`
Expected: exit 0, with 7 skipped tests.

- [ ] **Step 13: Commit**

Message: `refactor(context): build the context sources of a Run from its Project configuration`.

---

### Task 4: The Backstage Catalog port and its HTTP client

**Files:**
- Create: `src/adapters/backstage/backstage-catalog-client.ts`
- Test: `tests/unit/backstage-catalog-client.test.ts`

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces: `BackstageEntity`, `BackstageCatalogPort`, `BackstageCatalogClient`, `parseBackstageEntity`, `BackstageCatalogError`.

- [ ] **Step 1: Write the failing parser and client test**

Create `tests/unit/backstage-catalog-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  BackstageCatalogClient,
  parseBackstageEntity,
} from "~/adapters/backstage/backstage-catalog-client.js";

const ENTITY = {
  metadata: {
    uid: "uid-1",
    etag: "etag-1",
    name: "manuscript-service",
    namespace: "default",
    title: "Manuscript Service",
    description: "Stores manuscripts.",
    annotations: {
      "backstage.io/source-location": "url:https://github.com/acme/manuscript-service/tree/main/",
    },
  },
  kind: "Component",
  spec: {
    type: "service",
    owner: "team-a",
    system: "publishing",
    dependsOn: ["resource:default/manuscript-db"],
    providesApis: ["api:default/manuscript-api"],
    consumesApis: ["api:default/identity-api"],
  },
};

describe("parseBackstageEntity", () => {
  it("reads the SDD section 19 fields", () => {
    const entity = parseBackstageEntity(ENTITY);
    expect(entity).toEqual({
      ref: "component:default/manuscript-service",
      kind: "Component",
      namespace: "default",
      name: "manuscript-service",
      title: "Manuscript Service",
      description: "Stores manuscripts.",
      owner: "group:default/team-a",
      system: "system:default/publishing",
      dependsOn: ["resource:default/manuscript-db"],
      providesApis: ["api:default/manuscript-api"],
      consumesApis: ["api:default/identity-api"],
      repositorySlug: "acme/manuscript-service",
      repositoryUrl: "https://github.com/acme/manuscript-service",
      definition: null,
      sourceVersion: "etag-1",
    });
  });

  it("falls back to the uid when the catalog reports no etag", () => {
    const entity = parseBackstageEntity({ ...ENTITY, metadata: { ...ENTITY.metadata, etag: undefined } });
    expect(entity.sourceVersion).toBe("uid-1");
  });

  it("reads the definition of an API entity", () => {
    const entity = parseBackstageEntity({
      metadata: { uid: "uid-2", etag: "etag-2", name: "identity-api", namespace: "default" },
      kind: "API",
      spec: { type: "openapi", owner: "team-b", definition: "openapi: 3.0.0" },
    });
    expect(entity.definition).toBe("openapi: 3.0.0");
    expect(entity.ref).toBe("api:default/identity-api");
  });

  it("rejects a document that is not an entity", () => {
    expect(() => parseBackstageEntity({ kind: "Component" })).toThrow(/entity/);
  });
});

describe("BackstageCatalogClient", () => {
  it("asks for one entity by reference and sends the credential", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(ENTITY), { status: 200 }));
    const client = new BackstageCatalogClient({
      endpoint: "https://backstage.test/",
      token: "secret-token",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const entity = await client.getByRef("component:default/manuscript-service");
    expect(entity?.name).toBe("manuscript-service");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://backstage.test/api/catalog/entities/by-name/component/default/manuscript-service",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("reports null for an entity the catalog does not hold", async () => {
    const client = new BackstageCatalogClient({
      endpoint: "https://backstage.test",
      token: null,
      fetch: (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
    });
    expect(await client.getByRef("component:default/missing")).toBeNull();
  });

  it("finds the entity of a repository through a filtered query, never a full listing", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [ENTITY] }), { status: 200 }));
    const client = new BackstageCatalogClient({
      endpoint: "https://backstage.test",
      token: null,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const entity = await client.findByRepositorySlug("acme/manuscript-service");
    expect(entity?.ref).toBe("component:default/manuscript-service");
    const [url] = fetchMock.mock.calls[0] as [string];
    // SDD section 18. The query is filtered and bounded. It is not a catalog dump.
    expect(url).toContain("filter=");
    expect(url).toContain("limit=");
  });

  it("keeps the token out of the error message", async () => {
    const client = new BackstageCatalogClient({
      endpoint: "https://backstage.test",
      token: "secret-token",
      fetch: (async () => new Response("denied", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(client.getByRef("component:default/a")).rejects.toThrow(/500/);
    await expect(client.getByRef("component:default/a")).rejects.not.toThrow(/secret-token/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/backstage-catalog-client.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the client**

Create `src/adapters/backstage/backstage-catalog-client.ts`:

```ts
/**
 * SDD section 19. The Backstage Catalog is a topology source. This client reads it over the
 * Backstage Catalog HTTP API. SDD section 14 keeps a provider client in `src/adapters`, so
 * nothing in `src/domain` imports this file except through the port below.
 */

/** The Backstage entity fields SDD section 19 names, in the shape the source needs. */
export interface BackstageEntity {
  /** `kind:namespace/name`, lower case. This is the stable reference of SDD section 21. */
  ref: string;
  kind: string;
  namespace: string;
  name: string;
  title: string | null;
  description: string | null;
  /** An entity reference, or null. */
  owner: string | null;
  /** An entity reference, or null. */
  system: string | null;
  dependsOn: string[];
  providesApis: string[];
  consumesApis: string[];
  /** The `owner/repo` slug of the source location, when the annotation gives one. */
  repositorySlug: string | null;
  /** The repository URL of the source location, without the tree path. */
  repositoryUrl: string | null;
  /** `spec.definition` of an API entity. */
  definition: string | null;
  /** SDD section 21 requires a source version. The catalog etag is that version. */
  sourceVersion: string;
}

export interface BackstageCatalogPort {
  getByRef(ref: string): Promise<BackstageEntity | null>;
  findByRepositorySlug(slug: string): Promise<BackstageEntity | null>;
}

export class BackstageCatalogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BackstageCatalogError";
  }
}

/** The longest one catalog request may take. A slow catalog must not hold a Run. */
export const BACKSTAGE_TIMEOUT_MS = 15_000;

/** SDD section 18. A filtered query never returns more than this. */
export const BACKSTAGE_QUERY_LIMIT = 5;

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/**
 * Backstage writes a relation target either as a full reference or as a bare name. A bare name
 * takes the default kind of the relation, which is how the catalog itself reads it.
 */
const normalizeRef = (value: string, defaultKind: string, namespace: string): string => {
  const lower = value.trim().toLowerCase();
  if (lower.includes(":")) return lower.includes("/") ? lower : lower.replace(":", `:${namespace}/`);
  return `${defaultKind}:${namespace}/${lower}`;
};

/**
 * `backstage.io/source-location` is written as `url:https://host/owner/repo/tree/<ref>/<path>`.
 * The slug is the first two path segments. Anything else yields null, and the caller then simply
 * has no repository for that entity.
 */
const sourceLocationOf = (
  annotations: Record<string, unknown>,
): { slug: string | null; url: string | null } => {
  const raw =
    asString(annotations["backstage.io/source-location"]) ??
    asString(annotations["backstage.io/managed-by-location"]);
  if (raw === null) return { slug: null, url: null };
  const withoutScheme = raw.startsWith("url:") ? raw.slice(4) : raw;
  let parsed: URL;
  try {
    parsed = new URL(withoutScheme);
  } catch {
    return { slug: null, url: null };
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  const owner = segments[0];
  const repository = segments[1];
  if (owner === undefined || repository === undefined) return { slug: null, url: null };
  const name = repository.replace(/\.git$/, "");
  return {
    slug: `${owner}/${name}`,
    url: `${parsed.protocol}//${parsed.host}/${owner}/${name}`,
  };
};

export const parseBackstageEntity = (document: unknown): BackstageEntity => {
  const entity = asRecord(document);
  const metadata = asRecord(entity["metadata"]);
  const spec = asRecord(entity["spec"]);
  const kind = asString(entity["kind"]);
  const name = asString(metadata["name"]);
  if (kind === null || name === null) {
    throw new BackstageCatalogError("the document is not a Backstage entity");
  }
  const namespace = asString(metadata["namespace"]) ?? "default";
  const sourceVersion = asString(metadata["etag"]) ?? asString(metadata["uid"]);
  if (sourceVersion === null) {
    // SDD section 21 requires a source version on every candidate. An entity without one cannot
    // be recorded with provenance, so it is not an entity Factoree can use.
    throw new BackstageCatalogError(`the entity "${kind}:${namespace}/${name}" has no version`);
  }
  const owner = asString(spec["owner"]);
  const system = asString(spec["system"]);
  const location = sourceLocationOf(asRecord(metadata["annotations"]));

  return {
    ref: `${kind.toLowerCase()}:${namespace}/${name}`,
    kind,
    namespace,
    name,
    title: asString(metadata["title"]),
    description: asString(metadata["description"]),
    owner: owner === null ? null : normalizeRef(owner, "group", namespace),
    system: system === null ? null : normalizeRef(system, "system", namespace),
    dependsOn: asStrings(spec["dependsOn"]).map((value) => normalizeRef(value, "component", namespace)),
    providesApis: asStrings(spec["providesApis"]).map((value) => normalizeRef(value, "api", namespace)),
    consumesApis: asStrings(spec["consumesApis"]).map((value) => normalizeRef(value, "api", namespace)),
    repositorySlug: location.slug,
    repositoryUrl: location.url,
    definition: asString(spec["definition"]),
    sourceVersion,
  };
};

export interface BackstageCatalogClientOptions {
  endpoint: string;
  /** SDD section 30. A static Backstage token, or null for an unauthenticated catalog. */
  token: string | null;
  fetch?: typeof fetch;
}

export class BackstageCatalogClient implements BackstageCatalogPort {
  private readonly endpoint: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: BackstageCatalogClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.fetch = options.fetch ?? fetch;
  }

  private async request(path: string): Promise<unknown | null> {
    const url = `${this.endpoint}${path}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.options.token !== null) headers["Authorization"] = `Bearer ${this.options.token}`;

    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(BACKSTAGE_TIMEOUT_MS),
      });
    } catch (error) {
      // SDD section 60. The message names the URL and never the header.
      throw new BackstageCatalogError(`the Backstage request to ${url} failed`, { cause: error });
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new BackstageCatalogError(
        `the Backstage request to ${url} answered ${response.status}`,
      );
    }
    try {
      return (await response.json()) as unknown;
    } catch (error) {
      throw new BackstageCatalogError(`the Backstage answer from ${url} is not JSON`, { cause: error });
    }
  }

  async getByRef(ref: string): Promise<BackstageEntity | null> {
    const match = /^([a-z0-9-]+):([^/]+)\/(.+)$/.exec(ref.trim().toLowerCase());
    if (match === null) return null;
    const [, kind, namespace, name] = match;
    const document = await this.request(
      `/api/catalog/entities/by-name/${encodeURIComponent(kind ?? "")}/${encodeURIComponent(namespace ?? "")}/${encodeURIComponent(name ?? "")}`,
    );
    return document === null ? null : parseBackstageEntity(document);
  }

  /**
   * SDD section 18 forbids unbounded retrieval. The query filters on the annotation and caps the
   * answer, so the catalog never streams its whole contents into Factoree.
   */
  async findByRepositorySlug(slug: string): Promise<BackstageEntity | null> {
    const parameters = new URLSearchParams();
    parameters.set("filter", `kind=component`);
    parameters.set("limit", String(BACKSTAGE_QUERY_LIMIT));
    parameters.set("fields", "kind,metadata,spec");
    const document = await this.request(`/api/catalog/entities/by-query?${parameters.toString()}`);
    const items = Array.isArray(asRecord(document)["items"])
      ? (asRecord(document)["items"] as unknown[])
      : [];
    for (const item of items) {
      let entity: BackstageEntity;
      try {
        entity = parseBackstageEntity(item);
      } catch {
        continue;
      }
      if (entity.repositorySlug === slug) return entity;
    }
    return null;
  }
}
```

Note for the implementer: the `filter` value in `findByRepositorySlug` must also carry the annotation, so the catalog does the matching. Use
`filter=kind=component,metadata.annotations.backstage.io/source-location` and keep the client-side slug comparison as the exact check. Write the filter so the test assertion on `filter=` and `limit=` holds.

- [ ] **Step 4: Run the test and watch it pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/backstage-catalog-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole verification and commit**

Message: `feat(backstage): add the Backstage Catalog port and its HTTP client`.

---

### Task 5: `BackstageContextSource`

**Files:**
- Create: `src/domain/context/backstage-source.ts`
- Test: `tests/unit/backstage-context-source.test.ts`

**Interfaces:**
- Consumes: `BackstageEntity`, `BackstageCatalogPort` (Task 4); `ContextCandidate`, `ContextDiscoveryRequest`, `DISCOVERY_PRIORITY` (existing); `BackstageSourceSettings` (Task 1).
- Produces: `BackstageContextSource`, `backstageEntityRef(sourceId, entityRef)`.

- [ ] **Step 1: Write the failing source test**

Create `tests/unit/backstage-context-source.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { BackstageCatalogPort, BackstageEntity } from "~/adapters/backstage/backstage-catalog-client.js";
import { BackstageContextSource } from "~/domain/context/backstage-source.js";
import { DISCOVERY_PRIORITY } from "~/domain/context/context-source.js";
import { DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION } from "~/domain/context/repository-context-configuration.js";

const entity = (over: Partial<BackstageEntity>): BackstageEntity => ({
  ref: "component:default/manuscript-service",
  kind: "Component",
  namespace: "default",
  name: "manuscript-service",
  title: null,
  description: null,
  owner: null,
  system: null,
  dependsOn: [],
  providesApis: [],
  consumesApis: [],
  repositorySlug: null,
  repositoryUrl: null,
  definition: null,
  sourceVersion: "etag-1",
  ...over,
});

const ROOT = entity({
  repositorySlug: "acme/manuscript-service",
  repositoryUrl: "https://github.com/acme/manuscript-service",
  owner: "group:default/team-a",
  system: "system:default/publishing",
  dependsOn: ["resource:default/manuscript-db"],
  consumesApis: ["api:default/identity-api"],
});

const IDENTITY_API = entity({
  ref: "api:default/identity-api",
  kind: "API",
  name: "identity-api",
  description: "The identity API.",
  definition: "openapi: 3.0.0",
  sourceVersion: "etag-api",
  repositorySlug: "acme/identity-service",
  repositoryUrl: "https://github.com/acme/identity-service",
});

const catalog = (entities: BackstageEntity[]): BackstageCatalogPort => ({
  getByRef: (ref) => Promise.resolve(entities.find((candidate) => candidate.ref === ref) ?? null),
  findByRepositorySlug: (slug) =>
    Promise.resolve(entities.find((candidate) => candidate.repositorySlug === slug) ?? null),
});

const request = (over: Partial<Parameters<BackstageContextSource["discover"]>[0]> = {}) => ({
  runId: "run-1",
  goal: "Retry a failed manuscript upload.",
  topics: ["manuscript", "identity"],
  primaryRepository: { slug: "acme/manuscript-service", url: "https://github.com/acme/manuscript-service.git", ref: "main" },
  referenceRepositories: [],
  workItemReferences: [],
  decisions: [],
  contextConfiguration: DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION,
  ...over,
});

const sourceOf = (entities: BackstageEntity[], over: Partial<{ maxEntities: number; includeOwnership: boolean; primaryComponent: string | null }> = {}) =>
  new BackstageContextSource({
    sourceId: "backstage",
    catalog: catalog(entities),
    settings: { kind: "backstage", primaryComponent: null, maxEntities: 50, includeOwnership: true, ...over },
  });

describe("BackstageContextSource", () => {
  it("offers the entity of the primary repository with full provenance", async () => {
    const [root] = await sourceOf([ROOT]).discover(request());
    expect(root?.reference).toEqual({
      sourceId: "backstage",
      ref: "backstage:component:default/manuscript-service",
      repository: null,
      sha: null,
      path: null,
    });
    expect(root?.sourceVersion).toBe("etag-1");
    // SDD section 19 and controller decision 5. The catalog never outranks code or an ADR.
    expect(root?.authority).toBe("declarative_catalog");
    expect(root?.reason).toBe(
      'the Backstage catalog entity of the primary repository "acme/manuscript-service"',
    );
    expect(root?.priority).toBe(DISCOVERY_PRIORITY.backstage_relation);
    expect(root?.suggestedClassification).toBe("reference");
  });

  it("offers a consumed API with the API relation priority and a topology reason", async () => {
    const candidates = await sourceOf([ROOT, IDENTITY_API]).discover(request());
    const api = candidates.find((candidate) => candidate.reference.ref === "backstage:api:default/identity-api");
    expect(api?.priority).toBe(DISCOVERY_PRIORITY.backstage_api_relation);
    expect(api?.reason).toBe(
      'the Backstage catalog records that "manuscript-service" consumes the API "identity-api"',
    );
    expect(api?.sourceVersion).toBe("etag-api");
    expect(api?.authority).toBe("declarative_catalog");
    expect(api?.topics).toContain("identity");
  });

  it("offers a dependency with the relation priority", async () => {
    const database = entity({ ref: "resource:default/manuscript-db", kind: "Resource", name: "manuscript-db", sourceVersion: "etag-db" });
    const candidates = await sourceOf([ROOT, database]).discover(request());
    const found = candidates.find((candidate) => candidate.reference.ref === "backstage:resource:default/manuscript-db");
    expect(found?.priority).toBe(DISCOVERY_PRIORITY.backstage_relation);
    expect(found?.reason).toBe(
      'the Backstage catalog records that "manuscript-service" depends on "manuscript-db"',
    );
  });

  it("leaves ownership out when the configuration turns it off", async () => {
    const team = entity({ ref: "group:default/team-a", kind: "Group", name: "team-a", sourceVersion: "etag-team" });
    const candidates = await sourceOf([ROOT, team], { includeOwnership: false }).discover(request());
    expect(candidates.map((candidate) => candidate.reference.ref)).not.toContain("backstage:group:default/team-a");
  });

  it("reports no candidate and no failure when the catalog holds no entity for the repository", async () => {
    expect(await sourceOf([]).discover(request())).toEqual([]);
  });

  it("stops at the entity cap", async () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      entity({ ref: `api:default/api-${index}`, kind: "API", name: `api-${index}`, sourceVersion: `etag-${index}` }),
    );
    const root = entity({ ...ROOT, consumesApis: many.map((candidate) => candidate.ref) });
    const candidates = await sourceOf([root, ...many], { maxEntities: 3 }).discover(request());
    expect(candidates).toHaveLength(3);
  });

  it("never asks the catalog for a listing when a primary component is configured", async () => {
    const calls: string[] = [];
    const source = new BackstageContextSource({
      sourceId: "backstage",
      catalog: {
        getByRef: (ref) => {
          calls.push(`getByRef ${ref}`);
          return Promise.resolve(ref === ROOT.ref ? ROOT : null);
        },
        findByRepositorySlug: () => {
          calls.push("findByRepositorySlug");
          return Promise.resolve(null);
        },
      },
      settings: { kind: "backstage", primaryComponent: "component:default/manuscript-service", maxEntities: 50, includeOwnership: true },
    });
    await source.discover(request());
    expect(calls).not.toContain("findByRepositorySlug");
  });

  it("reports a repository location only when the repository asked for automatic discovery", async () => {
    const off = await sourceOf([ROOT, IDENTITY_API]).discover(request());
    expect(off.every((candidate) => candidate.discoveredRepository === undefined)).toBe(true);

    const on = await sourceOf([ROOT, IDENTITY_API]).discover(
      request({ contextConfiguration: { backstageEnabled: true, automaticReferenceDiscovery: true } }),
    );
    const api = on.find((candidate) => candidate.reference.ref === "backstage:api:default/identity-api");
    expect(api?.discoveredRepository).toEqual({
      slug: "acme/identity-service",
      url: "https://github.com/acme/identity-service",
    });
  });

  it("keeps the Run alive when the catalog fails", async () => {
    const source = new BackstageContextSource({
      sourceId: "backstage",
      catalog: {
        getByRef: () => Promise.reject(new Error("catalog down")),
        findByRepositorySlug: () => Promise.reject(new Error("catalog down")),
      },
      settings: { kind: "backstage", primaryComponent: null, maxEntities: 50, includeOwnership: true },
    });
    expect(await source.discover(request())).toEqual([]);
  });

  it("serves the fetched document of an entity it offered", async () => {
    const source = sourceOf([ROOT, IDENTITY_API]);
    await source.discover(request());
    const document = await source.fetch({
      sourceId: "backstage",
      ref: "backstage:api:default/identity-api",
      repository: null,
      sha: null,
      path: null,
    });
    expect(document.content).toContain("identity-api");
    expect(document.content).toContain("openapi: 3.0.0");
    expect(document.sourceVersion).toBe("etag-api");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/backstage-context-source.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the source**

Create `src/domain/context/backstage-source.ts`:

```ts
import type {
  BackstageCatalogPort,
  BackstageEntity,
} from "~/adapters/backstage/backstage-catalog-client.js";
import type { BackstageSourceSettings } from "./context-source-configuration.js";
import type {
  ContextCandidate,
  ContextDiscoveryRequest,
  ContextDocument,
  ContextReference,
  ContextSource,
} from "./context-source.js";
import { DISCOVERY_PRIORITY } from "./context-source.js";

/** The stable reference of one catalog entity inside one Context Contract. */
export const backstageEntityRef = (entityRef: string): string => `backstage:${entityRef}`;

export interface BackstageContextSourceOptions {
  sourceId: string;
  catalog: BackstageCatalogPort;
  settings: BackstageSourceSettings;
}

const topicsIn = (text: string, topics: string[]): string[] => {
  const lower = text.toLowerCase();
  return topics.filter((topic) => lower.includes(topic));
};

/** The text a Context Item of this source carries. It is catalog metadata, never repository code. */
const renderEntity = (entity: BackstageEntity): string => {
  const lines = [
    `${entity.kind}: ${entity.name}`,
    entity.title === null ? null : `Title: ${entity.title}`,
    entity.description === null ? null : `Description: ${entity.description}`,
    entity.owner === null ? null : `Owner: ${entity.owner}`,
    entity.system === null ? null : `System: ${entity.system}`,
    entity.repositorySlug === null ? null : `Repository: ${entity.repositorySlug}`,
    entity.dependsOn.length === 0 ? null : `Depends on: ${entity.dependsOn.join(", ")}`,
    entity.providesApis.length === 0 ? null : `Provides APIs: ${entity.providesApis.join(", ")}`,
    entity.consumesApis.length === 0 ? null : `Consumes APIs: ${entity.consumesApis.join(", ")}`,
    entity.definition === null ? null : `Definition:\n${entity.definition}`,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
};

/**
 * SDD section 19. Backstage is a topology source: it helps Factoree decide where to look. SDD
 * section 18 gives an ownership or dependency relation priority 3 and an API relation priority 4,
 * and it forbids organization-wide unbounded retrieval, so discovery is one hop from the entity
 * of the primary repository and stops at a hard cap. See controller decisions 5 and 6.
 */
export class BackstageContextSource implements ContextSource {
  private readonly documents = new Map<string, { content: string; sourceVersion: string }>();

  constructor(private readonly options: BackstageContextSourceOptions) {}

  id(): string {
    return this.options.sourceId;
  }

  private candidate(
    entity: BackstageEntity,
    reason: string,
    priority: number,
    request: ContextDiscoveryRequest,
  ): ContextCandidate {
    const content = renderEntity(entity);
    const ref = backstageEntityRef(entity.ref);
    this.documents.set(ref, { content, sourceVersion: entity.sourceVersion });

    const candidate: ContextCandidate = {
      reference: { sourceId: this.id(), ref, repository: null, sha: null, path: null },
      sourceVersion: entity.sourceVersion,
      // SDD section 19 and SDD section 22. The catalog is declarative topology. It never
      // outranks executable code or an accepted architecture decision.
      authority: "declarative_catalog",
      reason,
      priority,
      topics: topicsIn(content, request.topics),
      sizeBytes: Buffer.byteLength(content, "utf8"),
      // The catalog explains where to look. The Implementer prompt does not need it preloaded,
      // and the Context Contract names it, so `reference` is the honest classification.
      suggestedClassification: "reference",
    };

    // SDD section 20 and controller decision 7. A repository location becomes a reference
    // repository only when the primary repository asked for automatic discovery.
    if (
      request.contextConfiguration.automaticReferenceDiscovery &&
      entity.repositorySlug !== null &&
      entity.repositoryUrl !== null &&
      entity.repositorySlug !== request.primaryRepository.slug
    ) {
      candidate.discoveredRepository = { slug: entity.repositorySlug, url: entity.repositoryUrl };
    }

    return candidate;
  }

  async discover(request: ContextDiscoveryRequest): Promise<ContextCandidate[]> {
    this.documents.clear();
    try {
      return await this.walk(request);
    } catch {
      // Controller decision 13. Backstage is not required for a Run to proceed, so a catalog
      // fault degrades the Run and never fails it.
      return [];
    }
  }

  private async walk(request: ContextDiscoveryRequest): Promise<ContextCandidate[]> {
    const root =
      this.options.settings.primaryComponent === null
        ? await this.options.catalog.findByRepositorySlug(request.primaryRepository.slug)
        : await this.options.catalog.getByRef(this.options.settings.primaryComponent);
    if (root === null) return [];

    const cap = this.options.settings.maxEntities;
    const candidates: ContextCandidate[] = [
      this.candidate(
        root,
        `the Backstage catalog entity of the primary repository "${request.primaryRepository.slug}"`,
        DISCOVERY_PRIORITY.backstage_relation,
        request,
      ),
    ];
    const seen = new Set([root.ref]);

    // One hop only. Each list keeps the order the catalog reported, so discovery is repeatable.
    const relations: Array<{ ref: string; reason: string; priority: number }> = [];
    for (const ref of root.dependsOn) {
      relations.push({
        ref,
        reason: `the Backstage catalog records that "${root.name}" depends on "${nameOf(ref)}"`,
        priority: DISCOVERY_PRIORITY.backstage_relation,
      });
    }
    for (const ref of root.providesApis) {
      relations.push({
        ref,
        reason: `the Backstage catalog records that "${root.name}" provides the API "${nameOf(ref)}"`,
        priority: DISCOVERY_PRIORITY.backstage_api_relation,
      });
    }
    for (const ref of root.consumesApis) {
      relations.push({
        ref,
        reason: `the Backstage catalog records that "${root.name}" consumes the API "${nameOf(ref)}"`,
        priority: DISCOVERY_PRIORITY.backstage_api_relation,
      });
    }
    if (this.options.settings.includeOwnership) {
      if (root.system !== null) {
        relations.push({
          ref: root.system,
          reason: `the Backstage catalog places "${root.name}" in the system "${nameOf(root.system)}"`,
          priority: DISCOVERY_PRIORITY.backstage_relation,
        });
      }
      if (root.owner !== null) {
        relations.push({
          ref: root.owner,
          reason: `the Backstage catalog records that "${nameOf(root.owner)}" owns "${root.name}"`,
          priority: DISCOVERY_PRIORITY.backstage_relation,
        });
      }
    }

    for (const relation of relations) {
      if (candidates.length >= cap) break;
      if (seen.has(relation.ref)) continue;
      seen.add(relation.ref);
      const entity = await this.options.catalog.getByRef(relation.ref);
      if (entity === null) continue;
      candidates.push(this.candidate(entity, relation.reason, relation.priority, request));
    }

    return candidates;
  }

  fetch(reference: ContextReference): Promise<ContextDocument> {
    const document = this.documents.get(reference.ref);
    if (document === undefined) {
      return Promise.reject(
        new Error(`The Backstage context source never offered "${reference.ref}".`),
      );
    }
    return Promise.resolve({
      reference,
      sourceVersion: document.sourceVersion,
      content: document.content,
    });
  }
}

/** The bare name of an entity reference, for a sentence a human reads. */
const nameOf = (ref: string): string => ref.slice(ref.lastIndexOf("/") + 1);
```

Move `nameOf` above its first use if the linter demands it.

- [ ] **Step 4: Run the test and watch it pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/backstage-context-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the factory**

In `src/bin/worker.ts`, replace the `backstage` factory placeholder:

```ts
    backstage: (record, credential) =>
      new BackstageContextSource({
        sourceId: record.sourceId,
        catalog: new BackstageCatalogClient({ endpoint: record.endpoint, token: credential }),
        settings: record.settings as BackstageSourceSettings,
      }),
```

- [ ] **Step 6: Run the whole verification and commit**

Message: `feat(backstage): discover context from the Backstage topology`.

---

### Task 6: A discovered repository becomes a pinned reference repository

**Files:**
- Modify: `src/domain/context/context-resolver.ts`
- Test: `tests/unit/context-resolver.test.ts` (extend)

**Interfaces:**
- Consumes: `ContextCandidate.discoveredRepository` (Task 3), `BackstageContextSource` (Task 5).
- Produces: `MAX_AUTOMATIC_REFERENCE_REPOSITORIES`, and the resolver behaviour below.

- [ ] **Step 1: Write the failing resolver tests**

Add to `tests/unit/context-resolver.test.ts`:

```ts
describe("automatic reference repository discovery", () => {
  it("pins a discovered repository and records why it is in the Run", async () => {
    // A stub source reports one discovered repository. The repository source then reads it in a
    // second pass, so it reaches the contract with an explicit SHA, as SDD section 20 requires.
    const reader = new FakeRepositoryReader({
      "https://git.test/acme/app.git": { sha: "a".repeat(40), files: { "README.md": "the app" } },
      "https://git.test/acme/library.git": { sha: "b".repeat(40), files: { "README.md": "the library" } },
    });
    const resolved = await new ContextResolver().resolve({
      runId: "run-1",
      goal: "Use the shared library.",
      acceptanceCriteria: ["The library is used."],
      primaryRepository: { slug: "acme/app", url: "https://git.test/acme/app.git", ref: "main" },
      referenceRepositories: [],
      workItemReferences: [],
      decisions: [],
      contextConfiguration: { backstageEnabled: true, automaticReferenceDiscovery: true },
      sources: new ContextSourceRegistry([
        new LinearContextSource(),
        new RepositoryContextSource({ reader }),
        discoveringSource({ slug: "acme/library", url: "https://git.test/acme/library.git" }),
      ]),
    });

    expect(resolved.contract.referenceRepositories).toContainEqual({
      repo: "acme/library",
      sha: "b".repeat(40),
      reason: "the Backstage catalog names this repository as a location of a related component",
    });
    expect(resolved.pinned.references.map((repository) => repository.slug)).toContain("acme/library");
  });

  it("does not add a discovered repository when the repository did not opt in", async () => {
    // Same fixture, automaticReferenceDiscovery false.
    // Expect: referenceRepositories is empty, and the reader never mirrored the library.
  });

  it("records a repository on another host as discoverable and never checks it out", async () => {
    // The discovered URL host differs from the primary host.
    // Expect: no entry in referenceRepositories, and the candidate item is still in the contract.
  });

  it("stops at three automatically discovered repositories", async () => {
    // Five discovered repositories.
    // Expect: exactly MAX_AUTOMATIC_REFERENCE_REPOSITORIES entries.
  });

  it("writes no duplicate item when the second pass repeats a reference", async () => {
    const refs = resolved.contract.items.map((item) => item.reference.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
```

Write out each pending body in full before you implement. `discoveringSource` is a local helper in the test file that returns a `ContextSource` whose `discover` reports one candidate per configured repository, each carrying `discoveredRepository`.

- [ ] **Step 2: Run and watch it fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/context-resolver.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the second discovery pass**

In `src/domain/context/context-resolver.ts`, after the first discovery loop and before the sort:

```ts
/**
 * SDD section 20 and controller decision 7. A repository a source discovers becomes a real
 * reference repository of the Run, with an explicit SHA, so the checkout and the Context
 * Contract name the same commit. Each one costs a mirror clone, so the count is bounded.
 */
export const MAX_AUTOMATIC_REFERENCE_REPOSITORIES = 3;
```

and inside `resolve`:

```ts
    // The primary host is the only host the workflow can rebuild a clone URL for, because it
    // composes `repositoryBaseUrl` with a slug. A repository elsewhere stays a recorded item.
    // See controller decision 8.
    const primaryHost = hostOf(input.primaryRepository.url);
    const known = new Set([
      input.primaryRepository.slug,
      ...input.referenceRepositories.map((repository) => repository.slug),
    ]);
    const discovered: RepositoryRef[] = [];
    if (input.contextConfiguration.automaticReferenceDiscovery) {
      for (const candidate of candidates) {
        if (discovered.length >= MAX_AUTOMATIC_REFERENCE_REPOSITORIES) break;
        const repository = candidate.discoveredRepository;
        if (repository === undefined) continue;
        if (known.has(repository.slug)) continue;
        if (hostOf(repository.url) !== primaryHost) continue;
        known.add(repository.slug);
        discovered.push({ slug: repository.slug, url: `${repository.url}.git`, ref: input.primaryRepository.ref });
      }
    }

    if (discovered.length > 0) {
      // The repository source reads the extra repositories in a second pass. It repeats the
      // primary, so the merge drops a reference it already holds. The reader caches one mirror
      // per URL, so the repeat costs no second clone.
      const second = await input.sources.get("repository").discover({
        ...request,
        referenceRepositories: discovered,
      });
      const seen = new Set(candidates.map((candidate) => candidate.reference.ref));
      for (const candidate of second) {
        if (seen.has(candidate.reference.ref)) continue;
        seen.add(candidate.reference.ref);
        candidates.push(candidate);
      }
    }
```

`hostOf` is a small local helper that returns `new URL(url).host` inside a `try`, and `null` on a failure. Two nulls are not equal, so a URL that does not parse never matches the primary host.

Then extend the contract build:

```ts
      referenceRepositories: [
        ...input.referenceRepositories.map((repository) => ({
          repo: repository.slug,
          sha: shaBySlug.get(repository.slug) ?? "",
          reason: "a configured reference repository",
        })),
        ...discovered.map((repository) => ({
          repo: repository.slug,
          sha: shaBySlug.get(repository.slug) ?? "",
          reason: "the Backstage catalog names this repository as a location of a related component",
        })),
      ],
```

Note that `shaBySlug` is built before the second pass today. Move its construction to after the merge, so a discovered repository has its SHA.

- [ ] **Step 4: Run the resolver tests and watch them pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/context-resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole verification and commit**

Message: `feat(context): pin a reference repository the topology discovered`.

---

### Task 7: The MCP client and the Action Policy tool gate

**Files:**
- Create: `src/adapters/mcp/mcp-json-rpc-client.ts`
- Modify: `src/domain/policy/action-policy.ts`
- Test: `tests/unit/mcp-json-rpc-client.test.ts`
- Test: `tests/unit/action-policy.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces: `McpToolPort`, `McpJsonRpcClient`, `McpError`, `ActionPolicy.decideMcpTool(name)`, `ActionPolicy.assertMcpTool(name)`, `ActionPolicyOverrides.mcpAllowedTools`.

- [ ] **Step 1: Write the failing policy tests**

Add to `tests/unit/action-policy.test.ts`:

```ts
describe("the MCP tool gate of SDD section 58", () => {
  it("denies every tool by default", () => {
    const policy = new ActionPolicy({});
    expect(policy.decideMcpTool("search_docs")).toBe("deny");
  });

  it("allows only a tool the Project allow-listed by name", () => {
    const policy = new ActionPolicy({ mcpAllowedTools: ["search_docs"] });
    expect(policy.decideMcpTool("search_docs")).toBe("allow");
    expect(policy.decideMcpTool("delete_everything")).toBe("deny");
  });

  it("treats a wildcard as a tool name, so it grants nothing broad", () => {
    const policy = new ActionPolicy({ mcpAllowedTools: ["*"] });
    expect(policy.decideMcpTool("search_docs")).toBe("deny");
  });

  it("throws with the tool name when a call is refused", () => {
    expect(() => new ActionPolicy({}).assertMcpTool("search_docs")).toThrow(/search_docs/);
  });
});
```

Match the real constructor shape of `ActionPolicy`; read the file first and follow it.

- [ ] **Step 2: Run and watch it fail, then implement the gate**

In `src/domain/policy/action-policy.ts`:

```ts
  /**
   * SDD section 58. MCP is an extension mechanism, not an unrestricted trust boundary. Every
   * tool call passes this decision, and an Implementer receives no organization-wide access by
   * default, because the allow list starts empty. A name is matched exactly: a pattern would
   * reintroduce the broad access the specification forbids. See controller decision 10.
   */
  decideMcpTool(name: string): ActionDecision {
    return this.overrides.mcpAllowedTools?.includes(name) === true ? "allow" : "deny";
  }

  assertMcpTool(name: string): void {
    if (this.decideMcpTool(name) === "deny") {
      throw new ActionPolicyError(
        `The Action Policy denies the MCP tool "${name}". SDD section 58 requires an explicit ` +
          "allow list, and this Project did not name the tool.",
      );
    }
  }
```

Add `mcpAllowedTools?: string[]` to `ActionPolicyOverrides`. Reuse the existing denial error type if the file already has one; do not add a second.

- [ ] **Step 3: Write the failing MCP client test**

Create `tests/unit/mcp-json-rpc-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { McpError, McpJsonRpcClient } from "~/adapters/mcp/mcp-json-rpc-client.js";

const answer = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

describe("McpJsonRpcClient", () => {
  it("initializes once and reuses the session header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } }, { "mcp-session-id": "session-1" }))
      .mockResolvedValueOnce(new Response("", { status: 202 }))
      .mockResolvedValueOnce(answer({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "hello" }] } }))
      .mockResolvedValueOnce(answer({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "again" }] } }));

    const client = new McpJsonRpcClient({
      endpoint: "https://mcp.test/rpc",
      token: "secret-token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(await client.callTool("search_docs", { query: "a" })).toBe("hello");
    expect(await client.callTool("search_docs", { query: "b" })).toBe("again");

    // One initialize, one initialized notification, two calls.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const last = fetchMock.mock.calls[3] as [string, RequestInit];
    expect((last[1].headers as Record<string, string>)["Mcp-Session-Id"]).toBe("session-1");
    expect((last[1].headers as Record<string, string>)["Authorization"]).toBe("Bearer secret-token");
  });

  it("reports a JSON-RPC error as an McpError", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer({ jsonrpc: "2.0", id: 1, result: {} }))
      .mockResolvedValueOnce(new Response("", { status: 202 }))
      .mockResolvedValueOnce(answer({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "no such tool" } }));
    const client = new McpJsonRpcClient({ endpoint: "https://mcp.test/rpc", token: null, fetch: fetchMock as unknown as typeof fetch });
    await expect(client.callTool("missing", {})).rejects.toBeInstanceOf(McpError);
    await expect(client.callTool("missing", {})).rejects.toThrow(/no such tool/);
  });

  it("reports a tool that answered isError as a failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer({ jsonrpc: "2.0", id: 1, result: {} }))
      .mockResolvedValueOnce(new Response("", { status: 202 }))
      .mockResolvedValueOnce(answer({ jsonrpc: "2.0", id: 2, result: { isError: true, content: [{ type: "text", text: "denied" }] } }));
    const client = new McpJsonRpcClient({ endpoint: "https://mcp.test/rpc", token: null, fetch: fetchMock as unknown as typeof fetch });
    await expect(client.callTool("search_docs", {})).rejects.toThrow(/denied/);
  });

  it("keeps the token out of an error message", async () => {
    const client = new McpJsonRpcClient({
      endpoint: "https://mcp.test/rpc",
      token: "secret-token",
      fetch: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(client.callTool("search_docs", {})).rejects.not.toThrow(/secret-token/);
  });
});
```

- [ ] **Step 4: Implement the client**

Create `src/adapters/mcp/mcp-json-rpc-client.ts`. It exports:

```ts
/** SDD section 17 and SDD section 10. One MCP server, reached over JSON-RPC 2.0 on HTTP. */
export interface McpToolPort {
  /** Calls one tool and returns the concatenated text content of the answer. */
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}
```

The class holds `endpoint`, `token`, an injected `fetch`, a monotonic request id, a lazy `initialize` promise, and the session header the server returned. Every request posts `{ jsonrpc: "2.0", id, method, params }` with headers `Content-Type: application/json`, `Accept: application/json, text/event-stream`, the optional `Authorization: Bearer <token>`, and the optional `Mcp-Session-Id`. `AbortSignal.timeout(MCP_TIMEOUT_MS)` bounds every call; `MCP_TIMEOUT_MS` is `15_000`. A non-2xx status, a body that is not JSON, a JSON-RPC `error` member, and a result with `isError: true` all throw `McpError`. No error message ever interpolates the token. The initialize handshake sends `initialize` with `{ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "factoree", version: "1" } }` and then the `notifications/initialized` notification, which carries no id and expects no body.

- [ ] **Step 5: Run both test files and watch them pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/mcp-json-rpc-client.test.ts tests/unit/action-policy.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole verification and commit**

Message: `feat(mcp): add the MCP JSON-RPC client and the SDD section 58 tool gate`.

---

### Task 8: `McpContextSource`

**Files:**
- Create: `src/domain/context/mcp-source.ts`
- Modify: `src/bin/worker.ts`
- Test: `tests/unit/mcp-context-source.test.ts`

**Interfaces:**
- Consumes: `McpToolPort` (Task 7), `ActionPolicy` (Task 7), `McpSourceSettings` (Task 1).
- Produces: `McpContextSource`.

- [ ] **Step 1: Write the failing source test**

Create `tests/unit/mcp-context-source.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ActionPolicy } from "~/domain/policy/action-policy.js";
import { McpContextSource } from "~/domain/context/mcp-source.js";
import { DISCOVERY_PRIORITY } from "~/domain/context/context-source.js";
import { DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION } from "~/domain/context/repository-context-configuration.js";

const SETTINGS = {
  kind: "mcp" as const,
  discoverTool: "search_docs",
  fetchTool: "read_doc",
  allowedTools: ["read_doc", "search_docs"],
  authority: "prose_documentation" as const,
  maxCandidates: 20,
};

const request = {
  runId: "run-1",
  goal: "Retry a failed notification.",
  topics: ["notification", "retry"],
  primaryRepository: { slug: "acme/app", url: "https://git.test/acme/app.git", ref: "main" },
  referenceRepositories: [],
  workItemReferences: [],
  decisions: [],
  contextConfiguration: DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION,
};

const ANSWER = JSON.stringify({
  items: [
    {
      ref: "runbook/notification-retry",
      title: "Notification retry runbook",
      sourceVersion: "2026-02-01T00:00:00Z",
      reason: "the internal runbook for notification retry",
      sizeBytes: 1200,
    },
  ],
});

const sourceOf = (calls: Array<{ name: string; args: unknown }>, answers: Record<string, string>, policy = new ActionPolicy({ mcpAllowedTools: SETTINGS.allowedTools })) =>
  new McpContextSource({
    sourceId: "docs",
    settings: SETTINGS,
    policy,
    tools: {
      callTool: (name, args) => {
        calls.push({ name, args });
        const answer = answers[name];
        return answer === undefined ? Promise.reject(new Error(`no answer for ${name}`)) : Promise.resolve(answer);
      },
    },
  });

describe("McpContextSource", () => {
  it("offers a candidate with the provenance SDD section 21 requires", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const [candidate] = await sourceOf(calls, { search_docs: ANSWER }).discover(request);
    expect(candidate?.reference).toEqual({
      sourceId: "docs",
      ref: "docs:runbook/notification-retry",
      repository: null,
      sha: null,
      path: null,
    });
    expect(candidate?.sourceVersion).toBe("2026-02-01T00:00:00Z");
    expect(candidate?.authority).toBe("prose_documentation");
    expect(candidate?.reason).toBe(
      'the MCP source "docs" reports: the internal runbook for notification retry',
    );
    expect(candidate?.priority).toBe(DISCOVERY_PRIORITY.scoped_semantic_search);
    expect(candidate?.suggestedClassification).toBe("reference");
    expect(candidate?.topics).toEqual(["notification"]);
    expect(calls[0]).toEqual({
      name: "search_docs",
      args: { goal: request.goal, topics: request.topics, repository: "acme/app" },
    });
  });

  it("refuses to call a tool the Action Policy denies, and reports no candidate", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const candidates = await sourceOf(calls, { search_docs: ANSWER }, new ActionPolicy({})).discover(request);
    expect(candidates).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("stops at the candidate cap", async () => {
    const many = JSON.stringify({
      items: Array.from({ length: 30 }, (_, index) => ({
        ref: `doc-${index}`,
        sourceVersion: "1",
        reason: "a document",
      })),
    });
    const candidates = await sourceOf([], { search_docs: many }).discover(request);
    expect(candidates).toHaveLength(SETTINGS.maxCandidates);
  });

  it("drops an item that has no reference or no source version", async () => {
    const broken = JSON.stringify({ items: [{ title: "no ref" }, { ref: "a", title: "no version" }] });
    expect(await sourceOf([], { search_docs: broken }).discover(request)).toEqual([]);
  });

  it("keeps the Run alive when the server fails", async () => {
    expect(await sourceOf([], {}).discover(request)).toEqual([]);
  });

  it("fetches a document through the fetch tool", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const source = sourceOf(calls, { search_docs: ANSWER, read_doc: "retry after ten minutes" });
    await source.discover(request);
    const document = await source.fetch({
      sourceId: "docs",
      ref: "docs:runbook/notification-retry",
      repository: null,
      sha: null,
      path: null,
    });
    expect(document.content).toBe("retry after ten minutes");
    expect(calls[1]).toEqual({ name: "read_doc", args: { ref: "runbook/notification-retry" } });
  });

  it("refuses a fetch for a reference it never offered", async () => {
    const source = sourceOf([], { search_docs: ANSWER });
    await source.discover(request);
    await expect(
      source.fetch({ sourceId: "docs", ref: "docs:other", repository: null, sha: null, path: null }),
    ).rejects.toThrow(/never offered/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then write the source**

Create `src/domain/context/mcp-source.ts`. The class:

- `id()` returns the configured `sourceId`.
- `discover` calls `policy.assertMcpTool(settings.discoverTool)` first. A denial and any transport fault yield `[]`, under controller decision 13; the denial is caught inside `discover`, so the policy never fails a Run.
- It calls `tools.callTool(settings.discoverTool, { goal, topics, repository })`, parses the answer as JSON, reads `items`, and drops any item without a non-empty `ref` and a non-empty `sourceVersion`.
- Each candidate has `reference.ref = `${sourceId}:${item.ref}``, `authority = settings.authority`, `reason = `the MCP source "${sourceId}" reports: ${item.reason}`` with a plain fallback reason when the server sends none, `priority = DISCOVERY_PRIORITY.scoped_semantic_search`, `topics` computed from the item title and reason against `request.topics`, `sizeBytes` from the item when it is a finite non-negative number and null otherwise, and `suggestedClassification = "reference"`.
- It stops at `settings.maxCandidates`.
- `fetch` looks the reference up in a map filled during `discover`, calls `policy.assertMcpTool(settings.fetchTool)`, calls the fetch tool with the raw item reference, and returns the text. An unknown reference rejects with "never offered", which the resolver already turns into a `discoverable` item rather than a Run failure.

- [ ] **Step 3: Run the test and watch it pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config vitest.config.ts tests/unit/mcp-context-source.test.ts`
Expected: PASS.

- [ ] **Step 4: Wire the factory**

In `src/bin/worker.ts`:

```ts
    mcp: (record, credential) => {
      const settings = record.settings as McpSourceSettings;
      return new McpContextSource({
        sourceId: record.sourceId,
        settings,
        // SDD section 58. The allow list of this Project is the whole permission.
        policy: new ActionPolicy({ mcpAllowedTools: settings.allowedTools }),
        tools: new McpJsonRpcClient({ endpoint: record.endpoint, token: credential }),
      });
    },
```

- [ ] **Step 5: Run the whole verification and commit**

Message: `feat(mcp): add the generic MCP context source`.

---

### Task 9: Read the Work Item labels through the Linear API

**Files:**
- Modify: `src/domain/runs/ports.ts`
- Modify: `src/adapters/linear/linear-agent-client.ts`
- Modify: `src/activities/linear.activities.ts`
- Modify: `src/workflows/agent-run.workflow.ts`
- Modify: `src/bin/worker.ts`
- Test: `tests/unit/linear-agent-client.test.ts` (extend)
- Test: `tests/workflow/...` the existing workflow test file that covers refinement (extend)

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces: `WorkItemPort.labels(issueId): Promise<string[]>`, the activity `fetchWorkItemLabels({ sessionId, issueId })`.

**Why this task is in Phase 5.** `DelegationService` sets `workItem.labels` to an empty list, because the Linear agent session webhook carries no label field. `capAutonomy` is correct and unit tested, but no high-risk label ever reaches it, so the SDD section 28 cap is dead in production and a `security` issue runs at the Project default level. The Phase 4 record carries this finding to Phase 5.

- [ ] **Step 1: Write the failing client test**

Add to `tests/unit/linear-agent-client.test.ts`:

```ts
describe("the Work Item labels of SDD section 28", () => {
  it("reads the label names of one issue", async () => {
    const client = new LinearAgentClient({
      createAgentActivity: () => Promise.resolve({}),
      issue: () => Promise.resolve({ labels: () => Promise.resolve({ nodes: [{ name: "security" }, { name: "backend" }] }) }),
    } as never);
    expect(await client.labels("issue-1")).toEqual(["security", "backend"]);
  });

  it("reports no label when the issue does not exist", async () => {
    const client = new LinearAgentClient({
      createAgentActivity: () => Promise.resolve({}),
      issue: () => Promise.resolve(null),
    } as never);
    expect(await client.labels("issue-1")).toEqual([]);
  });
});
```

Widen the `AgentActivityCreator` interface to a `LinearApi` interface that carries both `createAgentActivity` and `issue`, and keep the existing tests compiling.

- [ ] **Step 2: Implement the client method and the port**

Add `labels(issueId: string): Promise<string[]>` to a new `WorkItemPort` in `src/domain/runs/ports.ts`, and implement it on `LinearAgentClient` through `client.issue(id)` and `issue.labels()`. A null issue and a null label list both yield `[]`.

- [ ] **Step 3: Add the activity**

In `src/activities/linear.activities.ts`, add:

```ts
  /**
   * SDD section 28. The agent session webhook carries no label, so the cap needs a read against
   * the Linear API. An issue that no longer exists, and a transport fault the retry policy has
   * already exhausted, both yield no label, and the Run then runs at its Project default. The
   * cap must never invent a label it did not see.
   */
  async fetchWorkItemLabels(input: { sessionId: string; issueId: string }): Promise<string[]> {
    return await dependencies.workItems.labels(input.sessionId, input.issueId);
  },
```

The worker implements `workItems` with the same per-session client resolution `AgentSessionPort` already uses, so the workspace token is the token of the Run.

- [ ] **Step 4: Call it in the workflow**

In `src/workflows/agent-run.workflow.ts`, before the first `refineActivities.refine(...)` call, and only when `input.workItem.issueId !== null`, fetch the labels and merge them into the value `refinementInput()` uses:

```ts
      // SDD section 28. The webhook carries no label, so the labels come from the Linear API
      // before Refinement classifies the risk of this Work Item.
      let labels = input.workItem.labels;
      const issueId = input.workItem.issueId;
      if (issueId !== null) {
        labels = await activities.fetchWorkItemLabels({ sessionId: input.agentSessionId, issueId });
      }
```

`refinementInput()` must then use `labels` rather than `input.workItem.labels`. Read the function before you change it, and change nothing else in it.

- [ ] **Step 5: Extend the workflow test**

In the workflow test that covers refinement, add a case: the fake Linear activity reports `["security"]`, and the Run row ends with `autonomyLevel` `L2` while the Project default is `L3`. Assert the risk message reaches Linear as well, because `renderRisks` already describes a high-risk label.

- [ ] **Step 6: Run the whole verification and commit**

Message: `fix(runs): read the Work Item labels, so the SDD section 28 autonomy cap is live`.

---

### Task 10: The acceptance tests and the phase exit condition

**Files:**
- Create: `tests/acceptance/support/backstage-fixture-catalog.ts`
- Create: `tests/acceptance/support/mcp-fixture-server.ts`
- Create: `tests/acceptance/at-04-backstage-discovery.test.ts`
- Create: `tests/acceptance/at-36-mcp-source.test.ts`
- Create: `tests/acceptance/phase-05-exit.test.ts`
- Modify: `tests/acceptance/support/context-fixture-repository.ts`
- Modify: `tests/acceptance/support/resolve-fixture-context.ts`

**Interfaces:**
- Consumes: every earlier task.
- Produces: the phase exit evidence.

- [ ] **Step 1: Extend the repository fixture**

Add to `ContextFixtureOptions`:

```ts
  /**
   * The `.factoree/config.yaml` the primary repository carries. AT-04 turns the `context` block
   * on. The default is `CONTEXT_FIXTURE_CONFIG`, so every Phase 4 acceptance test is unchanged.
   */
  primaryConfig?: string;
```

and export:

```ts
export const CONTEXT_FIXTURE_CONFIG_WITH_TOPOLOGY = `version: 1

verify:
  commands:
    - name: check
      run: "true"

context:
  backstage:
    enabled: true
  referenceRepositories:
    automaticDiscovery: true
`;
```

- [ ] **Step 2: Write the Backstage fixture catalog**

Create `tests/acceptance/support/backstage-fixture-catalog.ts`. It exports a `BackstageCatalogPort` over a fixed set of entity documents, parsed through the real `parseBackstageEntity`, so the acceptance test exercises the real parser. The catalog holds:

- `component:default/webhook-service`, whose `backstage.io/source-location` names the primary fixture repository slug `acme/webhook-service`, which `consumesApis: ["api:default/notification-api"]` and `dependsOn: ["resource:default/webhook-queue"]`;
- `api:default/notification-api`, with a `spec.definition` that mentions notification retry, an etag `etag-notification-api`, and a source location naming the reference fixture repository `acme/notification-service`;
- `resource:default/webhook-queue`.

- [ ] **Step 3: Write AT-04**

Create `tests/acceptance/at-04-backstage-discovery.test.ts`:

```ts
/**
 * AT-04. A Backstage API dependency produces the expected Context Candidate with a
 * topology-based selection reason. The Run is the AT-02 fixture Work Item, and the catalog says
 * the primary component consumes the notification API.
 */
describe("AT-04 — Backstage discovery", () => {
  it("produces the API dependency as a Context Item with a topology reason and provenance", () => {
    const item = resolved.contract.items.find(
      (candidate) => candidate.reference.ref === "backstage:api:default/notification-api",
    );
    expect(item).toBeDefined();
    // SDD section 21. Source, stable reference, source version, authority, reason, class.
    expect(item?.reference.sourceId).toBe("backstage");
    expect(item?.sourceVersion).toBe("etag-notification-api");
    expect(item?.authority).toBe("declarative_catalog");
    expect(item?.reason).toBe(
      'the Backstage catalog records that "webhook-service" consumes the API "notification-api"',
    );
    expect(item?.classification).toBe("reference");

    // SDD section 18. The API relation is priority 4, below the two repository rules.
    const candidate = candidates.find(
      (entry) => entry.reference.ref === "backstage:api:default/notification-api",
    );
    expect(candidate?.priority).toBe(DISCOVERY_PRIORITY.backstage_api_relation);

    // SDD section 19. The catalog never outranks the accepted ADR of the same fixture.
    const adr = resolved.contract.items.find((entry) => entry.authority === "accepted_adr");
    expect(adr).toBeDefined();
    expect(
      resolved.contract.conflicts.some(
        (conflict) =>
          conflict.winnerRef === "backstage:api:default/notification-api" ||
          conflict.loserRef === "backstage:api:default/notification-api",
      ),
    ).toBe(false);

    // The human-readable contract explains the choice.
    expect(resolved.document).toContain("backstage:api:default/notification-api");
    expect(resolved.document).toContain("consumes the API");
  });

  it("leaves Backstage out when the repository does not enable it", async () => {
    const without = await resolveFixtureContext({ fixture, reader, runId: "run-at-04-off", sources: withBackstage, contextConfiguration: { backstageEnabled: false, automaticReferenceDiscovery: false } });
    expect(without.contract.items.some((item) => item.reference.sourceId === "backstage")).toBe(false);
  });
});
```

The `candidates` value comes from a direct call to the Backstage source over the same request, so the priority assertion sees the candidate before classification. Build the fixture and the resolution in `beforeAll`, following `at-07-resolvable-conflict.test.ts` exactly.

- [ ] **Step 4: Write the MCP fixture server**

Create `tests/acceptance/support/mcp-fixture-server.ts`. It starts a real Fastify server on port 0 that answers JSON-RPC over one POST route: `initialize` returns a protocol version and sets an `Mcp-Session-Id` header; `notifications/initialized` returns 202; `tools/call` answers `search_docs` with one item and `read_doc` with a text body. It exports `start(): Promise<{ url: string; close(): Promise<void>; calls: Array<{ method: string; tool: string | null }> }>`.

- [ ] **Step 5: Write AT-36**

Create `tests/acceptance/at-36-mcp-source.test.ts`:

```ts
/**
 * AT-36. A configured test MCP source supplies a Context Candidate with provenance. The server
 * is a real HTTP server, so the JSON-RPC client is exercised end to end.
 */
describe("AT-36 — the MCP context source", () => {
  it("supplies one candidate with full provenance and reaches the Context Contract", () => {
    const item = resolved.contract.items.find((candidate) => candidate.reference.sourceId === "docs");
    expect(item).toBeDefined();
    expect(item?.reference.ref).toBe("docs:runbook/notification-retry");
    expect(item?.sourceVersion).toBe("2026-02-01T00:00:00Z");
    expect(item?.authority).toBe("prose_documentation");
    expect(item?.reason).toContain('the MCP source "docs" reports:');
    expect(["required", "reference"]).toContain(item?.classification);
    expect(resolved.document).toContain("docs:runbook/notification-retry");
  });

  it("makes exactly the two allow-listed tool calls and no other", () => {
    expect(server.calls.filter((call) => call.tool !== null).map((call) => call.tool)).toEqual([
      "search_docs",
      "read_doc",
    ]);
  });

  it("refuses a tool the Project did not allow-list, and the Run still resolves", async () => {
    // SDD section 58. The same server, a settings block whose allow list names neither tool.
    const denied = await resolveWithMcp({ allowedTools: [] });
    expect(denied.contract.items.some((item) => item.reference.sourceId === "docs")).toBe(false);
    expect(denied.unresolvedConflict).toBeNull();
  });
});
```

The third case needs `parseContextSourceSettings` to be bypassed, because it always adds the two tools. Build the `McpContextSource` directly with an `ActionPolicy({ mcpAllowedTools: [] })`, which is the state the gate protects against.

- [ ] **Step 6: Write the phase exit test**

Create `tests/acceptance/phase-05-exit.test.ts`, in the shape of `phase-04-exit.test.ts`. It asserts the SDD section 69 sentence in one place:

```ts
/**
 * SDD section 69, Phase 5 exit: a fixture dependency can be discovered from Backstage with
 * provenance. One assertion block, over one resolution of the fixture Project.
 */
it("discovers a fixture dependency from Backstage with provenance", () => {
  const item = resolved.contract.items.find(
    (candidate) => candidate.reference.ref === "backstage:api:default/notification-api",
  );
  expect(item).toBeDefined();
  expect(item?.reference.sourceId).toBe("backstage");
  expect(item?.sourceVersion).toBe("etag-notification-api");
  expect(item?.authority).toBe("declarative_catalog");
  expect(item?.reason).toContain("the Backstage catalog records");
  expect(item?.classification).not.toBe("");
});

it("pins the reference repository the catalog named, at an explicit SHA", () => {
  // SDD section 20. Automatic discovery is on in this fixture.
  const reference = resolved.contract.referenceRepositories.find((repository) => repository.repo === "acme/notification-service");
  expect(reference?.sha).toMatch(/^[0-9a-f]{40}$/);
});
```

- [ ] **Step 7: Run the whole verification**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run verify`
Expected: exit 0, 7 skipped tests, and every new acceptance test passing.

- [ ] **Step 8: Commit**

Message: `test: prove AT-04, AT-36, and the Phase 5 exit condition`.

---

## Self-review notes

**Spec coverage.** Every Phase 5 sentence of SDD section 69 has a task: the Backstage topology integration is Tasks 4, 5, and 6; the generic MCP source is Tasks 7 and 8; the exit condition is Task 10. SDD section 53 gives the entity to Task 1. SDD section 59 gives the endpoints to Task 2. SDD section 58 is Task 7. AT-04 and AT-36 are Task 10. AT-37 is not built, because SDD section 69 gives skills to Phase 11.

**Carried findings this phase closes.** The dead autonomy cap (Task 9); `context.backstage.enabled` (Tasks 3 and 5); `context.referenceRepositories.automaticDiscovery` (Tasks 3 and 6); the unbuilt `ContextSourceConfiguration` (Task 1).

**Carried findings this phase does not close.** Every other entry in the Phase 4 record stays open, and the record must keep them.

**Type consistency.** `ContextSourceSettings` is the union Task 1 produces and Tasks 5 and 8 consume. `RepositoryContextConfiguration` is produced in Task 3 and consumed in Tasks 5, 6, and 8. `discoveredRepository` is added in Task 3, written in Task 5, and read in Task 6. `McpToolPort` is produced in Task 7 and consumed in Task 8. `ContextSourceProvider` is produced in Task 3 and wired in Tasks 5 and 8.

**Known risk.** Task 3 changes the `ContextResolver` constructor, which every Phase 4 context test uses. That task must update `tests/unit/context-resolver.test.ts`, `tests/unit/resolve-context-activity.test.ts`, and `tests/acceptance/support/resolve-fixture-context.ts` in the same commit, and must run the whole suite, not one file.
