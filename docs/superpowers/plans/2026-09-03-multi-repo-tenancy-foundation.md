# Multi-repository tenancy foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `Project` entity with a `Product` and `Repository` pair, so several Linear teams and several repositories per team route correctly and stay isolated.

**Architecture:** A `Product` is the business unit and owns the policy surface. A `Repository` is one repository and owns mechanics only. A repository declares its own binding in `.factoree/config.yaml`, and Factoree discovers it through GitHub App events. Routing reads the Linear team of an issue, resolves exactly one `Product`, and refuses otherwise. A `RunTarget` child entity carries per-target facts, so a single-target Run is one row and a Change Set later needs no migration.

**Tech Stack:** TypeScript on Node 24, ESM with the `~/` path alias and `.js` import suffixes, Prisma 7 on PostgreSQL, Temporal, Fastify, zod 4, vitest 4, testcontainers.

**Spec:** `docs/superpowers/specs/2026-09-03-multi-repo-tenancy-design.md`

**Scope:** This plan covers spec sections 5 to 13, 17, 19, and 20, and acceptance tests AT-38 to AT-43 and AT-46 to AT-48. Change Sets, which are spec sections 14 to 16 and tests AT-44 and AT-45, follow in a second plan once this one lands.

## Global Constraints

- Node 24. `"type": "module"`. Every relative import ends in `.js`.
- Internal imports use the `~/` alias, for example `~/domain/products/product-registry.js`.
- Every zod object schema that parses `.factoree/config.yaml` uses `.strict()`. An unknown key must fail validation.
- Prose in comments follows STE100. No contractions. No `-ing` forms outside a technical name.
- Backward compatibility is not required. The product is not in production.
- A `Product` slug is claimed, not assigned. A repository never writes a `Product` field.
- Autonomy levels are exactly `L0`, `L1`, `L2`, `L3`, `L4`.
- Unit tests run with `npx vitest run <path> --config vitest.config.ts`.
- Integration tests run with `npx vitest run <path> --config vitest.integration.config.ts`.
- The full gate is `npm run verify`.

---

### Task 1: Add the Product, Repository, RunTarget, and ProductSecret models

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_product_and_repository/migration.sql` (generated)
- Test: `tests/integration/product-registry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `Product`, `Repository`, `RunTarget`, `ProductSecret`. `Product` fields: `id`, `tenantId`, `slug`, `name`, `status`, `linearTeamKey`, `linearTeamId`, `defaultAutonomy`, `maxRunMinutes`, `createdAt`, `updatedAt`. `Repository` fields: `id`, `tenantId`, `productId`, `fullName`, `defaultBranch`, `configSha`, `requestedSecretNames`, `discoveredAt`, `lastSeenAt`, `absentSince`.

The old `Project` and `ProjectSecret` models stay in place for now. Task 11 removes them, once nothing reads them. This keeps the build green at every task boundary.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/product-registry.test.ts`. Follow the container setup that `tests/integration/project-registry.test.ts` already uses, and copy its `beforeAll` block verbatim.

```typescript
import { describe, expect, it } from "vitest";

describe("product and repository schema", () => {
  it("rejects two Products that claim one Linear team in one tenant", async () => {
    const tenant = await prisma.tenant.create({
      data: { linearWorkspaceId: "ws-1", name: "Acme" },
    });
    await prisma.product.create({
      data: {
        tenantId: tenant.id,
        slug: "checkout-platform",
        name: "Checkout",
        status: "active",
        linearTeamKey: "PAY",
        linearTeamId: "team-pay",
      },
    });

    await expect(
      prisma.product.create({
        data: {
          tenantId: tenant.id,
          slug: "other-platform",
          name: "Other",
          status: "pending",
          linearTeamKey: "PAY",
          linearTeamId: "team-pay",
        },
      }),
    ).rejects.toThrow();
  });

  it("holds several repositories under one Product", async () => {
    const tenant = await prisma.tenant.create({
      data: { linearWorkspaceId: "ws-2", name: "Acme" },
    });
    const product = await prisma.product.create({
      data: {
        tenantId: tenant.id,
        slug: "checkout",
        name: "Checkout",
        status: "active",
        linearTeamKey: "CHK",
        linearTeamId: "team-chk",
      },
    });
    await prisma.repository.create({
      data: {
        tenantId: tenant.id,
        productId: product.id,
        fullName: "acme/checkout-api",
        defaultBranch: "main",
        configSha: "4f21c9e",
      },
    });
    await prisma.repository.create({
      data: {
        tenantId: tenant.id,
        productId: product.id,
        fullName: "acme/checkout-web",
        defaultBranch: "main",
        configSha: "88a0f2b",
      },
    });

    const rows = await prisma.repository.findMany({ where: { productId: product.id } });
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/product-registry.test.ts --config vitest.integration.config.ts`
Expected: FAIL. `prisma.product` is undefined, because the model does not exist.

- [ ] **Step 3: Add the models**

Append to `prisma/schema.prisma`, and add the two back-relations named in the comments to `Tenant` and to `Run`.

```prisma
model Product {
  id             String   @id @default(uuid())
  tenantId       String
  tenant         Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  slug           String
  name           String
  // "pending" until an operator supplies secrets and activates it. A pending Product runs at L0.
  status         String   @default("pending")
  linearTeamKey  String
  linearTeamId   String
  defaultAutonomy String  @default("L0")
  maxRunMinutes  Int      @default(90)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  repositories   Repository[]
  secrets        ProductSecret[]

  @@unique([tenantId, slug])
  // One Linear team maps to at most one Product. This constraint makes the routing rule of
  // specification section 9 satisfiable at the database level.
  @@unique([tenantId, linearTeamId])
  @@index([tenantId])
}

model Repository {
  id                   String   @id @default(uuid())
  tenantId             String
  productId            String
  product              Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  fullName             String
  defaultBranch        String   @default("main")
  // The commit of `.factoree/config.yaml` that discovery last read.
  configSha            String
  // Names only. A value never reaches this column.
  requestedSecretNames String[] @default([])
  discoveredAt         DateTime @default(now())
  lastSeenAt           DateTime @default(now())
  // Set when the configuration file disappears. The row stays, so the Run history survives.
  absentSince          DateTime?
  runTargets           RunTarget[]

  @@unique([tenantId, fullName])
  @@index([productId])
}

model ProductSecret {
  id          String   @id @default(uuid())
  tenantId    String
  productId   String
  product     Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  name        String
  valueCipher String
  injectIntoImplementer Boolean @default(false)
  kind        String   @default("test")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([productId, name])
  @@index([tenantId])
}

model RunTarget {
  id              String     @id @default(uuid())
  runId           String
  run             Run        @relation(fields: [runId], references: [id], onDelete: Cascade)
  repositoryId    String
  repository      Repository @relation(fields: [repositoryId], references: [id])
  // "primary" or "secondary". A single-target Run holds one primary row.
  role            String     @default("primary")
  selectionReason String
  baseSha         String?
  patchSha256     String?
  commitSha       String?
  pullRequestUrl  String?
  mergeOrder      Int        @default(1)
  createdAt       DateTime   @default(now())

  @@unique([runId, repositoryId])
  @@index([runId])
}
```

Add `products Product[]` to `Tenant`, and `targets RunTarget[]` to `Run`.

- [ ] **Step 4: Generate the migration and run the test**

Run: `npx prisma migrate dev --name add_product_and_repository`
Run: `npx vitest run tests/integration/product-registry.test.ts --config vitest.integration.config.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/integration/product-registry.test.ts
git commit -m "feat(db): add the Product, Repository, RunTarget, and ProductSecret models"
```

---

### Task 2: Product and Repository registries

**Files:**
- Create: `src/domain/products/product-registry.ts`
- Create: `src/domain/products/repository-registry.ts`
- Create: `src/persistence/prisma/product-registry.prisma.ts`
- Test: `tests/integration/product-registry.test.ts` (extend)

**Interfaces:**
- Consumes: the Prisma models from Task 1.
- Produces:
  - `ProductRecord { id; tenantId; slug; name; status: "pending" | "active"; linearTeamKey; linearTeamId; defaultAutonomy; maxRunMinutes; createdAt; updatedAt }`
  - `RepositoryRecord { id; tenantId; productId; fullName; defaultBranch; configSha; requestedSecretNames: string[]; discoveredAt; lastSeenAt; absentSince: Date | null }`
  - `ProductRegistry { create(input): Promise<ProductRecord>; list(tenantId): Promise<ProductRecord[]>; findById(tenantId, id): Promise<ProductRecord | null>; findBySlug(tenantId, slug): Promise<ProductRecord | null>; findByLinearTeamId(tenantId, linearTeamId): Promise<ProductRecord | null>; activate(tenantId, id, defaultAutonomy): Promise<ProductRecord | null>; renameLinearTeamKey(tenantId, id, linearTeamKey): Promise<ProductRecord | null> }`
  - `RepositoryRegistry { upsert(input): Promise<RepositoryRecord>; listByProduct(productId): Promise<RepositoryRecord[]>; findByFullName(tenantId, fullName): Promise<RepositoryRecord | null>; markAbsent(tenantId, fullName, at: Date): Promise<void> }`

There is no `findDefaultForTenant`, and no method returns a row through `findFirst` on a non-unique column.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/product-registry.test.ts`.

```typescript
describe("PrismaProductRegistry", () => {
  it("finds a Product by its Linear team id, and never falls back", async () => {
    const tenant = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-3", name: "Acme" } });
    const products = new PrismaProductRegistry(prisma);
    await products.create({
      tenantId: tenant.id,
      slug: "checkout",
      name: "Checkout",
      linearTeamKey: "CHK",
      linearTeamId: "team-chk",
    });

    expect(await products.findByLinearTeamId(tenant.id, "team-chk")).not.toBeNull();
    expect(await products.findByLinearTeamId(tenant.id, "team-missing")).toBeNull();
  });

  it("creates a Product pending, at autonomy L0", async () => {
    const tenant = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-4", name: "Acme" } });
    const products = new PrismaProductRegistry(prisma);
    const product = await products.create({
      tenantId: tenant.id,
      slug: "billing",
      name: "billing",
      linearTeamKey: "BIL",
      linearTeamId: "team-bil",
    });

    expect(product.status).toBe("pending");
    expect(product.defaultAutonomy).toBe("L0");

    const active = await products.activate(tenant.id, product.id, "L3");
    expect(active?.status).toBe("active");
    expect(active?.defaultAutonomy).toBe("L3");
  });

  it("upserts a Repository by tenant and full name", async () => {
    const tenant = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-5", name: "Acme" } });
    const products = new PrismaProductRegistry(prisma);
    const repositories = new PrismaRepositoryRegistry(prisma);
    const product = await products.create({
      tenantId: tenant.id,
      slug: "checkout",
      name: "Checkout",
      linearTeamKey: "CH2",
      linearTeamId: "team-ch2",
    });

    await repositories.upsert({
      tenantId: tenant.id,
      productId: product.id,
      fullName: "acme/api",
      defaultBranch: "main",
      configSha: "aaa",
      requestedSecretNames: ["STRIPE_TEST_KEY"],
    });
    const second = await repositories.upsert({
      tenantId: tenant.id,
      productId: product.id,
      fullName: "acme/api",
      defaultBranch: "main",
      configSha: "bbb",
      requestedSecretNames: [],
    });

    expect(second.configSha).toBe("bbb");
    expect(await repositories.listByProduct(product.id)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/product-registry.test.ts --config vitest.integration.config.ts`
Expected: FAIL. `PrismaProductRegistry` is not exported.

- [ ] **Step 3: Write the registries**

Create `src/domain/products/product-registry.ts` with the record and interface shapes from the Interfaces block above. Create `src/domain/products/repository-registry.ts` likewise. Then create `src/persistence/prisma/product-registry.prisma.ts`. Model the class shape on `src/persistence/prisma/project-registry.prisma.ts`, and keep the same `toRecord` row-mapping style.

```typescript
export class PrismaProductRegistry implements ProductRegistry {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async create(input: CreateProductInput): Promise<ProductRecord> {
    const row = await this.prisma.product.create({
      data: {
        tenantId: input.tenantId,
        slug: input.slug,
        name: input.name,
        linearTeamKey: input.linearTeamKey,
        linearTeamId: input.linearTeamId,
      },
    });
    return toProduct(row);
  }

  // The column pair carries a unique constraint, so this reads one row or none. There is no
  // fallback to a tenant default, because specification section 9 forbids a guess.
  async findByLinearTeamId(tenantId: string, linearTeamId: string): Promise<ProductRecord | null> {
    const row = await this.prisma.product.findUnique({
      where: { tenantId_linearTeamId: { tenantId, linearTeamId } },
    });
    return row ? toProduct(row) : null;
  }

  async activate(tenantId: string, id: string, defaultAutonomy: string): Promise<ProductRecord | null> {
    const existing = await this.findById(tenantId, id);
    if (!existing) return null;
    const row = await this.prisma.product.update({
      where: { id },
      data: { status: "active", defaultAutonomy },
    });
    return toProduct(row);
  }
}
```

Write `findById`, `findBySlug`, `list`, and `renameLinearTeamKey` in the same style. Write `PrismaRepositoryRegistry` with `upsert` keyed on `tenantId_fullName`, which also clears `absentSince` and sets `lastSeenAt`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/integration/product-registry.test.ts --config vitest.integration.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/products src/persistence/prisma/product-registry.prisma.ts tests/integration/product-registry.test.ts
git commit -m "feat(products): add the Product and Repository registries"
```

---

### Task 3: The identity block and the privilege guard in the repository configuration

**Files:**
- Create: `src/domain/products/factoree-config.ts` (moved from `src/domain/projects/factoree-config.ts`)
- Modify: every importer of the old path
- Test: `tests/unit/factoree-config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FactoreeConfig` gains `identity: { product: string; linear: { teamKey: string } }` and `secrets: { require: string[] }`. New export `PRIVILEGE_KEYS: readonly string[]`, and `FactoreeConfigPrivilegeError` with a `key` property naming the offending key.

The `policy` block is removed. A repository must not carry an autonomy level at all, because the `Product` owns it.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/factoree-config.test.ts`.

```typescript
it("parses the identity block and the requested secret names", () => {
  const config = parseFactoreeConfig(`
version: 1
identity:
  product: checkout-platform
  linear:
    teamKey: PAY
verify:
  commands:
    - name: test
      run: npm test
secrets:
  require:
    - STRIPE_TEST_KEY
`);

  expect(config.identity.product).toBe("checkout-platform");
  expect(config.identity.linear.teamKey).toBe("PAY");
  expect(config.secrets.require).toEqual(["STRIPE_TEST_KEY"]);
});

it("fails, and names the key, when the file sets an autonomy level", () => {
  expect(() =>
    parseFactoreeConfig(`
version: 1
identity:
  product: checkout-platform
  linear:
    teamKey: PAY
verify:
  commands:
    - name: test
      run: npm test
policy:
  defaultAutonomy: L4
`),
  ).toThrowError(/policy/);
});

it("fails when the file supplies a secret value", () => {
  expect(() =>
    parseFactoreeConfig(`
version: 1
identity:
  product: checkout-platform
  linear:
    teamKey: PAY
verify:
  commands:
    - name: test
      run: npm test
secrets:
  values:
    STRIPE_TEST_KEY: sk_live_abc
`),
  ).toThrowError(/secrets.values/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/factoree-config.test.ts --config vitest.config.ts`
Expected: FAIL. `identity` is an unknown key, and the `policy` case throws a generic strict-mode error rather than one that names the key.

- [ ] **Step 3: Implement**

Move the file with `git mv src/domain/projects/factoree-config.ts src/domain/products/factoree-config.ts`, and update every importer. Then edit the schema.

```typescript
/**
 * Keys a repository must never set. The file lives inside a repository that Factoree agents
 * write to, so it must never raise a privilege. Specification section 6 fixes this list.
 */
export const PRIVILEGE_KEYS = [
  "policy",
  "autonomy",
  "actionPolicy",
  "riskCaps",
  "redaction",
  "secrets.values",
] as const;

export class FactoreeConfigPrivilegeError extends RunConfigurationError {
  constructor(readonly key: string) {
    super(`.factoree/config.yaml must not set ${key}. The Product owns it.`);
  }
}

const identitySchema = z
  .object({
    product: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lower case letters, digits, or hyphen"),
    linear: z
      .object({ teamKey: z.string().min(1).max(10).regex(/^[A-Za-z][A-Za-z0-9]*$/) })
      .strict(),
  })
  .strict();
```

Add `identity: identitySchema` and `secrets: z.object({ require: z.array(z.string().min(1)).default([]) }).strict().default({ require: [] })` to the top-level schema, and delete the `policy` block.

Before the zod parse, walk the raw parsed YAML and throw `FactoreeConfigPrivilegeError` for any key in `PRIVILEGE_KEYS`. This must run first, so the error names the key rather than reporting a generic unknown-key failure.

```typescript
const assertNoPrivilegeKey = (raw: unknown): void => {
  if (typeof raw !== "object" || raw === null) return;
  const record = raw as Record<string, unknown>;
  for (const key of PRIVILEGE_KEYS) {
    const [head, tail] = key.split(".");
    if (head === undefined) continue;
    const value = record[head];
    if (value === undefined) continue;
    if (tail === undefined) throw new FactoreeConfigPrivilegeError(key);
    if (typeof value === "object" && value !== null && tail in (value as Record<string, unknown>)) {
      throw new FactoreeConfigPrivilegeError(key);
    }
  }
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/factoree-config.test.ts --config vitest.config.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS, which proves every importer of the moved file is updated.

- [ ] **Step 5: Commit**

```bash
git add -A src tests/unit/factoree-config.test.ts
git commit -m "feat(config): add the identity block and reject privilege keys"
```

---

### Task 4: The routing module

**Files:**
- Create: `src/domain/routing/resolve-product.ts`
- Create: `src/domain/routing/select-targets.ts`
- Test: `tests/unit/routing.test.ts`

**Interfaces:**
- Consumes: `ProductRecord` and `RepositoryRecord` from Task 2.
- Produces:
  - `type RoutingOutcome = { kind: "routed"; product: ProductRecord } | { kind: "refused"; reason: string }`
  - `resolveProduct(products: ProductRecord[], linearTeamId: string | null): RoutingOutcome`
  - `type TargetOutcome = { kind: "selected"; repository: RepositoryRecord; reason: string; notify: boolean } | { kind: "ambiguous"; candidates: RepositoryRecord[] }`
  - `selectTarget(repositories: RepositoryRecord[], proposal: { fullName: string; reason: string; confident: boolean } | null): TargetOutcome`

Both functions are pure. They perform no input and no output, so they are cheap to test exhaustively.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/routing.test.ts`.

```typescript
import { describe, expect, it } from "vitest";
import { resolveProduct } from "~/domain/routing/resolve-product.js";
import { selectTarget } from "~/domain/routing/select-targets.js";

const product = (id: string, linearTeamId: string) =>
  ({
    id,
    tenantId: "tenant-1",
    slug: id,
    name: id,
    status: "active" as const,
    linearTeamKey: "PAY",
    linearTeamId,
    defaultAutonomy: "L3",
    maxRunMinutes: 90,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

const repository = (fullName: string) =>
  ({
    id: fullName,
    tenantId: "tenant-1",
    productId: "checkout",
    fullName,
    defaultBranch: "main",
    configSha: "aaa",
    requestedSecretNames: [],
    discoveredAt: new Date(),
    lastSeenAt: new Date(),
    absentSince: null,
  });

describe("resolveProduct", () => {
  it("routes to the one Product that claims the team", () => {
    const outcome = resolveProduct([product("checkout", "team-pay")], "team-pay");
    expect(outcome).toEqual({ kind: "routed", product: expect.objectContaining({ id: "checkout" }) });
  });

  it("refuses when no Product claims the team", () => {
    const outcome = resolveProduct([product("checkout", "team-pay")], "team-other");
    expect(outcome.kind).toBe("refused");
  });

  it("refuses when two Products claim the team", () => {
    const outcome = resolveProduct([product("a", "team-pay"), product("b", "team-pay")], "team-pay");
    expect(outcome.kind).toBe("refused");
  });

  it("refuses when the issue carries no team", () => {
    const outcome = resolveProduct([product("checkout", "team-pay")], null);
    expect(outcome.kind).toBe("refused");
  });
});

describe("selectTarget", () => {
  it("selects the sole member with no proposal and no notice", () => {
    const outcome = selectTarget([repository("acme/api")], null);
    expect(outcome).toEqual({
      kind: "selected",
      repository: expect.objectContaining({ fullName: "acme/api" }),
      reason: "sole member",
      notify: false,
    });
  });

  it("selects a confident proposal, and asks for a notice", () => {
    const outcome = selectTarget([repository("acme/api"), repository("acme/web")], {
      fullName: "acme/web",
      reason: "the change is in the checkout form",
      confident: true,
    });
    expect(outcome).toMatchObject({ kind: "selected", notify: true });
  });

  it("reports ambiguity when the proposal is not confident", () => {
    const outcome = selectTarget([repository("acme/api"), repository("acme/web")], {
      fullName: "acme/web",
      reason: "unsure",
      confident: false,
    });
    expect(outcome.kind).toBe("ambiguous");
  });

  it("reports ambiguity when the proposal names a repository outside the Product", () => {
    const outcome = selectTarget([repository("acme/api")], {
      fullName: "acme/unknown",
      reason: "guess",
      confident: true,
    });
    expect(outcome.kind).toBe("ambiguous");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/routing.test.ts --config vitest.config.ts`
Expected: FAIL. Neither module exists.

- [ ] **Step 3: Implement**

```typescript
// src/domain/routing/resolve-product.ts
/**
 * Specification section 9. One step, and every other case refuses. The team key is on every
 * Linear issue, so no fallback chain is needed. A refusal names what an operator must fix.
 */
export const resolveProduct = (products: ProductRecord[], linearTeamId: string | null): RoutingOutcome => {
  if (linearTeamId === null) {
    return { kind: "refused", reason: "the work item carries no Linear team" };
  }
  const matches = products.filter((candidate) => candidate.linearTeamId === linearTeamId);
  const first = matches[0];
  if (first === undefined) {
    return { kind: "refused", reason: `no Product claims Linear team ${linearTeamId}` };
  }
  if (matches.length > 1) {
    return {
      kind: "refused",
      reason: `${matches.length} Products claim Linear team ${linearTeamId}: ${matches
        .map((candidate) => candidate.slug)
        .join(", ")}`,
    };
  }
  return { kind: "routed", product: first };
};
```

```typescript
// src/domain/routing/select-targets.ts
/**
 * Specification section 10. A sole member needs no decision. A confident proposal proceeds and
 * posts a notice. Every other case is ambiguous, and the human decides.
 */
export const selectTarget = (
  repositories: RepositoryRecord[],
  proposal: { fullName: string; reason: string; confident: boolean } | null,
): TargetOutcome => {
  const present = repositories.filter((candidate) => candidate.absentSince === null);
  const sole = present[0];
  if (present.length === 1 && sole !== undefined) {
    return { kind: "selected", repository: sole, reason: "sole member", notify: false };
  }
  if (proposal === null || !proposal.confident) return { kind: "ambiguous", candidates: present };
  const chosen = present.find((candidate) => candidate.fullName === proposal.fullName);
  if (chosen === undefined) return { kind: "ambiguous", candidates: present };
  return { kind: "selected", repository: chosen, reason: proposal.reason, notify: true };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/routing.test.ts --config vitest.config.ts`
Expected: PASS, nine tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/routing tests/unit/routing.test.ts
git commit -m "feat(routing): resolve a Product by Linear team and select one target"
```

---

### Task 5: The GitHub discovery client

**Files:**
- Create: `src/adapters/github/repository-discovery-client.ts`
- Test: `tests/unit/repository-discovery-client.test.ts`

**Interfaces:**
- Consumes: the existing GitHub client style in `src/adapters/github/`.
- Produces: `RepositoryDiscoveryClient { listInstallationRepositories(installationId: string): Promise<Array<{ fullName: string; defaultBranch: string }>>; readConfig(fullName: string, ref: string): Promise<{ content: string; sha: string } | null> }`, and a `GitHubRepositoryDiscoveryClient` implementation. `readConfig` returns `null` when the file is absent, and throws on any other failure.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/repository-discovery-client.test.ts`, using a stub `fetch`, in the style of `tests/unit/github-pull-requests.test.ts`.

```typescript
it("returns null when the configuration file is absent", async () => {
  const client = new GitHubRepositoryDiscoveryClient({
    token: "t",
    fetch: () => Promise.resolve(new Response("", { status: 404 })),
  });

  expect(await client.readConfig("acme/api", "main")).toBeNull();
});

it("returns the decoded content and the blob sha", async () => {
  const body = JSON.stringify({
    sha: "4f21c9e",
    content: Buffer.from("version: 1\n").toString("base64"),
    encoding: "base64",
  });
  const client = new GitHubRepositoryDiscoveryClient({
    token: "t",
    fetch: () => Promise.resolve(new Response(body, { status: 200 })),
  });

  expect(await client.readConfig("acme/api", "main")).toEqual({ content: "version: 1\n", sha: "4f21c9e" });
});

it("throws on a failure that is not a missing file", async () => {
  const client = new GitHubRepositoryDiscoveryClient({
    token: "t",
    fetch: () => Promise.resolve(new Response("", { status: 500 })),
  });

  await expect(client.readConfig("acme/api", "main")).rejects.toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/repository-discovery-client.test.ts --config vitest.config.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement**

`readConfig` requests `GET /repos/{fullName}/contents/.factoree/config.yaml?ref={ref}`. A 404 returns `null`. A 200 decodes the base64 content. Any other status throws with the status and the repository name in the message. `listInstallationRepositories` requests `GET /installation/repositories` and follows pagination through the `link` header.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/repository-discovery-client.test.ts --config vitest.config.ts`
Expected: PASS, three tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github/repository-discovery-client.ts tests/unit/repository-discovery-client.test.ts
git commit -m "feat(github): read the repository configuration and list installation repositories"
```

---

### Task 6: The discovery service

**Files:**
- Create: `src/domain/products/discovery-service.ts`
- Test: `tests/unit/discovery-service.test.ts`

**Interfaces:**
- Consumes: `RepositoryDiscoveryClient` (Task 5), `ProductRegistry` and `RepositoryRegistry` (Task 2), `parseFactoreeConfig` and `FactoreeConfigPrivilegeError` (Task 3).
- Produces: `DiscoveryService` with `syncRepository(tenantId: string, fullName: string, defaultBranch: string): Promise<DiscoveryOutcome>` and `markAbsent(tenantId: string, fullName: string): Promise<void>`, where

```typescript
type DiscoveryOutcome =
  | {
      kind: "registered";
      repositoryId: string;
      productId: string;
      productCreated: boolean;
      // Set when the stored Linear team key no longer matches Linear. The binding survives,
      // because the team id is stable. Specification section 9 requires a warning, not a failure.
      drift?: "linear_team_key_renamed";
    }
  | { kind: "skipped"; reason: string }
  | { kind: "conflict"; reason: string };
```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/discovery-service.test.ts` with in-memory fakes for both registries.

```typescript
it("creates a pending Product at L0 for an unknown slug", async () => {
  const { service, products } = build({ config: configFor("checkout-platform", "PAY") });

  const outcome = await service.syncRepository("tenant-1", "acme/api", "main");

  expect(outcome).toMatchObject({ kind: "registered", productCreated: true });
  const product = await products.findBySlug("tenant-1", "checkout-platform");
  expect(product?.status).toBe("pending");
  expect(product?.defaultAutonomy).toBe("L0");
});

it("attaches a second repository to the same Product", async () => {
  const { service, repositories } = build({ config: configFor("checkout-platform", "PAY") });

  await service.syncRepository("tenant-1", "acme/api", "main");
  const outcome = await service.syncRepository("tenant-1", "acme/web", "main");

  expect(outcome).toMatchObject({ kind: "registered", productCreated: false });
  expect(await repositories.findByFullName("tenant-1", "acme/web")).not.toBeNull();
});

it("refuses a second Product that claims a team another Product already claims", async () => {
  const { service } = build({
    configByRepository: {
      "acme/api": configFor("checkout-platform", "PAY"),
      "acme/other": configFor("other-platform", "PAY"),
    },
  });

  await service.syncRepository("tenant-1", "acme/api", "main");
  const outcome = await service.syncRepository("tenant-1", "acme/other", "main");

  expect(outcome.kind).toBe("conflict");
});

it("keeps the binding, and records the drift, when the team key is renamed", async () => {
  const { service, products } = build({ config: configFor("checkout-platform", "PAY") });
  await service.syncRepository("tenant-1", "acme/api", "main");
  const before = await products.findBySlug("tenant-1", "checkout-platform");

  // The Linear stub now answers "PAYMENTS" for the same team id, and the repository file still
  // names the old key. The id is stable, so the binding must survive.
  const outcome = await service.syncRepository("tenant-1", "acme/api", "main", { teamKeyNow: "PAYMENTS" });

  expect(outcome).toMatchObject({ kind: "registered", drift: "linear_team_key_renamed" });
  const after = await products.findBySlug("tenant-1", "checkout-platform");
  expect(after?.id).toBe(before?.id);
  expect(after?.linearTeamKey).toBe("PAYMENTS");
});

it("skips a repository whose configuration file is absent", async () => {
  const { service } = build({ config: null });

  expect(await service.syncRepository("tenant-1", "acme/api", "main")).toMatchObject({ kind: "skipped" });
});

it("reports a conflict when the file sets a privilege key", async () => {
  const { service } = build({ config: "version: 1\npolicy:\n  defaultAutonomy: L4\n" });

  const outcome = await service.syncRepository("tenant-1", "acme/api", "main");

  expect(outcome.kind).toBe("conflict");
  expect(outcome).toMatchObject({ reason: expect.stringContaining("policy") });
});
```

Write `configFor(slug, teamKey)` in the test file, returning a valid YAML document with an `identity` block, one `verify` command, and nothing else.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/discovery-service.test.ts --config vitest.config.ts`
Expected: FAIL. `DiscoveryService` does not exist.

- [ ] **Step 3: Implement**

`syncRepository` reads the configuration at the default branch. A `null` read returns `skipped`. A `FactoreeConfigPrivilegeError` returns `conflict`, and the reason names the key. Otherwise it resolves the Linear team key to an id, then:

- If a `Product` with the slug exists, and its `linearTeamId` matches, upsert the `Repository` against it.
- If no `Product` with the slug exists, and no other `Product` claims that team, create it pending at L0, then upsert.
- If another `Product` already claims that team, return `conflict` naming both slugs, and write no row. This keeps the routing rule of specification section 9 satisfiable.

Resolution of the team key to an id runs through the Linear client on every sync. When the id
matches a stored `Product` but the key differs, call `renameLinearTeamKey`, log a warning, and
return `drift: "linear_team_key_renamed"`. The binding never breaks, because the id is stable.
A repository file that still names the old key therefore keeps working.

`markAbsent` sets `absentSince` and leaves the row in place.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/discovery-service.test.ts --config vitest.config.ts`
Expected: PASS, six tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/products/discovery-service.ts tests/unit/discovery-service.test.ts
git commit -m "feat(discovery): register repositories and create pending Products"
```

---

### Task 7: The GitHub webhook route

**Files:**
- Create: `src/http/github-webhook.routes.ts`
- Modify: `src/http/` server registration, next to the Linear webhook route
- Test: `tests/unit/github-webhook-routes.test.ts`

**Interfaces:**
- Consumes: `DiscoveryService` (Task 6).
- Produces: `registerGitHubWebhookRoutes(app, dependencies: { discovery: DiscoveryService; tenants: TenantRegistry; verifySignature: (raw: string, signature: string) => boolean })`, serving `POST /webhooks/github`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/github-webhook-routes.test.ts`, in the style of the existing Linear webhook route test.

```typescript
it("rejects a request with a bad signature", async () => {
  const { app } = build({ signatureValid: false });
  const response = await app.inject({ method: "POST", url: "/webhooks/github", payload: {} });
  expect(response.statusCode).toBe(401);
});

it("syncs each repository that an installation adds", async () => {
  const { app, synced } = build({});
  await app.inject({
    method: "POST",
    url: "/webhooks/github",
    headers: { "x-github-event": "installation_repositories" },
    payload: {
      installation: { id: 42, account: { login: "acme" } },
      repositories_added: [{ full_name: "acme/api", default_branch: "main" }],
    },
  });
  expect(synced).toEqual([["acme/api", "main"]]);
});

it("syncs a push that touches the configuration file, and ignores one that does not", async () => {
  const { app, synced } = build({});
  const push = (files: string[]) => ({
    method: "POST" as const,
    url: "/webhooks/github",
    headers: { "x-github-event": "push" },
    payload: {
      ref: "refs/heads/main",
      repository: { full_name: "acme/api", default_branch: "main" },
      commits: [{ modified: files, added: [], removed: [] }],
    },
  });

  await app.inject(push(["src/index.ts"]));
  expect(synced).toEqual([]);

  await app.inject(push([".factoree/config.yaml"]));
  expect(synced).toEqual([["acme/api", "main"]]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/github-webhook-routes.test.ts --config vitest.config.ts`
Expected: FAIL. The route module does not exist.

- [ ] **Step 3: Implement**

Verify the signature first and answer 401 on failure. Parse the body with a strict zod schema per event name. Handle `installation`, `installation_repositories`, and `push`. A push syncs only when its ref equals the repository default branch and some commit adds, modifies, or removes `.factoree/config.yaml`. A removal calls `markAbsent`. Always answer 200 after the work, so GitHub does not redeliver a handled event.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/github-webhook-routes.test.ts --config vitest.config.ts`
Expected: PASS, four assertions across three tests.

- [ ] **Step 5: Commit**

```bash
git add src/http tests/unit/github-webhook-routes.test.ts
git commit -m "feat(http): sync repositories from GitHub App events"
```

---

### Task 8: Re-parent the secret store to Product

**Files:**
- Modify: `src/domain/projects/secret-store.ts` → `src/domain/products/secret-store.ts`
- Modify: `src/persistence/prisma/project-registry.prisma.ts` (the `PrismaSecretStore` class)
- Test: `tests/integration/secret-store.test.ts`

**Interfaces:**
- Consumes: `ProductSecret` from Task 1, `RepositoryRecord.requestedSecretNames` from Task 2.
- Produces: `SecretStore` methods take a `productId` where they took a `projectId`. New export `assertRequestedSecretsExist(requested: string[], available: string[]): void`, which throws `MissingSecretError` naming every absent name.

- [ ] **Step 1: Write the failing test**

```typescript
it("fails, and names every absent secret, when a repository requests one the Product lacks", () => {
  expect(() => assertRequestedSecretsExist(["A", "B"], ["A"])).toThrowError(/B/);
});

it("passes when every requested secret exists", () => {
  expect(() => assertRequestedSecretsExist(["A"], ["A", "B"])).not.toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/secret-store.test.ts --config vitest.integration.config.ts`
Expected: FAIL. `assertRequestedSecretsExist` is not exported.

- [ ] **Step 3: Implement**

Move the module with `git mv`, rename `projectId` to `productId` throughout, point `PrismaSecretStore` at `prisma.productSecret`, and add the assertion. Update every importer.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/secret-store.test.ts --config vitest.integration.config.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "refactor(secrets): re-parent the secret store to Product"
```

---

### Task 9: Route delegation through the Product

**Files:**
- Modify: `src/domain/runs/delegation-service.ts:93-125`
- Test: `tests/unit/delegation-service.test.ts`

**Interfaces:**
- Consumes: `resolveProduct` (Task 4), `ProductRegistry` and `RepositoryRegistry` (Task 2).
- Produces: `DelegationOutcome` gains `{ kind: "blocked_routing"; reason: string }`. `AgentRunProjectInput` becomes `AgentRunProductInput { productId: string; productSlug: string; defaultAutonomy: string; repositories: Array<{ id: string; fullName: string; defaultBranch: string }>; repositoryBaseUrl: string; stagingRead: boolean; spriteRetentionHours: number; organizationSkillsRepository: string | null }`.

`primaryRepository` and `referenceRepositories` leave this type. The workflow selects the target in Task 10.

- [ ] **Step 1: Write the failing test**

Replace the `projects` fake in `tests/unit/delegation-service.test.ts` with `products` and `repositories` fakes, then add:

```typescript
it("blocks routing when no Product claims the team", async () => {
  const { service } = build({ products: [] });

  const outcome = await service.handle(event("assigned"), "delivery-1");

  expect(outcome).toMatchObject({ kind: "blocked_routing" });
});

it("blocks routing when two Products claim the team", async () => {
  const { service } = build({ products: [productFor("a"), productFor("b")] });

  const outcome = await service.handle(event("assigned"), "delivery-2");

  expect(outcome).toMatchObject({ kind: "blocked_routing" });
});

it("passes every member repository to the workflow", async () => {
  const { service, starter } = build({});

  await service.handle(event("assigned"), "delivery-3");

  const input = starter.start.mock.calls[0][0].args[0];
  expect(input.product.repositories.map((entry) => entry.fullName)).toEqual(["acme/api", "acme/web"]);
});
```

Write `productFor(slug)` in the test file, returning a `ProductRecord` whose `linearTeamId` matches the team in `tests/fixtures/linear/assigned.json`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/delegation-service.test.ts --config vitest.config.ts`
Expected: FAIL. The service still calls `findByLinearTeam` and `findDefaultForTenant`.

- [ ] **Step 3: Implement**

Replace the routing block:

```typescript
    const teamId = event.agentSession.issue?.teamId ?? null;
    const outcome = resolveProduct(await this.dependencies.products.list(tenantId), teamId);
    if (outcome.kind === "refused") {
      await this.dependencies.webhookLog.remove(deliveryId);
      // Specification section 9. A refusal never guesses, and it names what an operator must fix.
      return { kind: "blocked_routing", reason: outcome.reason };
    }
    const product = outcome.product;
    const repositories = await this.dependencies.repositories.listByProduct(product.id);
```

Build `AgentRunProductInput` from the `Product` and its repositories. Keep the existing slug assertion, and apply it to every member repository.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/delegation-service.test.ts --config vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/runs/delegation-service.ts tests/unit/delegation-service.test.ts
git commit -m "feat(runs): route delegation through the Product"
```

---

### Task 10: Target selection and the RunTarget row in the workflow

**Files:**
- Modify: `src/workflows/agent-run.workflow.ts`
- Modify: `src/activities/run.activities.ts`
- Test: `tests/workflow/target-selection.test.ts`

**Interfaces:**
- Consumes: `selectTarget` (Task 4), `AgentRunProductInput` (Task 9).
- Produces: activities `recordRunTarget(input: { runId: string; repositoryId: string; selectionReason: string; mergeOrder: number }): Promise<string>` and `postTargetNotice(input: { runId: string; fullName: string; reason: string }): Promise<void>`. Run statuses gain `BLOCKED_ROUTING`, `BLOCKED_TARGET`, and `BLOCKED_STALE_SET`.

- [ ] **Step 1: Write the failing test**

Create `tests/workflow/target-selection.test.ts`, using the Temporal test environment in the style of the existing workflow tests.

```typescript
it("selects the sole member and posts no notice", async () => {
  const { result, activities } = await runWorkflow({ repositories: ["acme/api"] });

  expect(activities.recordRunTarget).toHaveBeenCalledWith(
    expect.objectContaining({ selectionReason: "sole member", mergeOrder: 1 }),
  );
  expect(activities.postTargetNotice).not.toHaveBeenCalled();
  expect(result.status).not.toBe("BLOCKED_TARGET");
});

it("posts a notice for a confident target among several members", async () => {
  const { activities } = await runWorkflow({
    repositories: ["acme/api", "acme/web"],
    proposal: { fullName: "acme/web", reason: "the change is in the checkout form", confident: true },
  });

  expect(activities.postTargetNotice).toHaveBeenCalledWith(
    expect.objectContaining({ fullName: "acme/web" }),
  );
});

it("blocks on an ambiguous target and resumes on a human reply", async () => {
  const { handle, result } = await runWorkflowUntilBlocked({
    repositories: ["acme/api", "acme/web"],
    proposal: null,
  });

  expect(result.status).toBe("BLOCKED_TARGET");
  await handle.signal("humanInput", "use acme/web");
  await expect(handle.result()).resolves.toMatchObject({ status: expect.not.stringMatching("BLOCKED_TARGET") });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/workflow/target-selection.test.ts --config vitest.workflow.config.ts`
Expected: FAIL. The workflow has no target selection step.

- [ ] **Step 3: Implement**

Add the step after refinement and before the Validation Contract freeze. Refinement supplies the proposal when the `Product` holds several repositories. Call `selectTarget`. On `selected`, call `recordRunTarget` with `mergeOrder: 1`, and call `postTargetNotice` when `notify` is true. On `ambiguous`, set the status to `BLOCKED_TARGET`, post the candidate list in Linear, and wait for the existing `humanInput` signal.

After the target is fixed, re-read `.factoree/config.yaml` at the base commit, record its SHA on the Run, and fail the Run when its identity block names a different `Product` than routing used.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/workflow/target-selection.test.ts --config vitest.workflow.config.ts`
Expected: PASS, three tests.

- [ ] **Step 5: Commit**

```bash
git add src/workflows src/activities tests/workflow/target-selection.test.ts
git commit -m "feat(workflow): select the target repository and record a RunTarget"
```

---

### Task 11: The Products administration API

**Files:**
- Create: `src/http/admin/products.routes.ts`
- Delete: `src/http/admin/projects.routes.ts`
- Test: `tests/unit/products-routes.test.ts`

**Interfaces:**
- Consumes: `ProductRegistry`, `RepositoryRegistry`, `TenantRegistry`, a Linear team lookup `resolveTeamKey(tenantId: string, teamKey: string): Promise<{ id: string } | null>`.
- Produces: `registerProductRoutes(app, dependencies)`, serving `POST /admin/products`, `GET /admin/products`, `GET /admin/products/:id`, `POST /admin/products/:id/activate`, and `GET /admin/products/:id/repositories`.

There is no route that creates, updates, or deletes a repository. Discovery owns those rows.

- [ ] **Step 1: Write the failing test**

```typescript
it("accepts a team key and never requires a team id", async () => {
  const { app } = build({});

  const response = await app.inject({
    method: "POST",
    url: "/admin/products",
    payload: {
      linearWorkspaceId: "ws-1",
      slug: "checkout-platform",
      name: "Checkout",
      linearTeamKey: "PAY",
    },
  });

  expect(response.statusCode).toBe(201);
  expect(response.json()).toMatchObject({ linearTeamKey: "PAY", linearTeamId: "team-pay" });
});

it("rejects a body that carries a team id", async () => {
  const { app } = build({});

  const response = await app.inject({
    method: "POST",
    url: "/admin/products",
    payload: {
      linearWorkspaceId: "ws-1",
      slug: "checkout-platform",
      name: "Checkout",
      linearTeamKey: "PAY",
      linearTeamId: "team-pay",
    },
  });

  expect(response.statusCode).toBe(400);
});

it("answers 404, and names the key, when the team key resolves to no team", async () => {
  const { app } = build({ teamKeyResolves: false });

  const response = await app.inject({
    method: "POST",
    url: "/admin/products",
    payload: { linearWorkspaceId: "ws-1", slug: "s", name: "n", linearTeamKey: "NOPE" },
  });

  expect(response.statusCode).toBe(404);
  expect(response.json().error).toContain("NOPE");
});

it("exposes repositories read only", async () => {
  const { app } = build({});
  const response = await app.inject({ method: "POST", url: "/admin/products/p1/repositories", payload: {} });
  expect(response.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/products-routes.test.ts --config vitest.config.ts`
Expected: FAIL. The route module does not exist.

- [ ] **Step 3: Implement**

Write the routes. The create schema is `.strict()`, so a body that carries `linearTeamId` fails with 400. Resolve the team key through `resolveTeamKey`, and answer 404 with the key in the message when it resolves to nothing. Delete `src/http/admin/projects.routes.ts` and its registration, and register the new routes in its place.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/products-routes.test.ts --config vitest.config.ts`
Expected: PASS, four tests.

- [ ] **Step 5: Commit**

```bash
git add -A src/http tests/unit/products-routes.test.ts
git commit -m "feat(admin): serve Products by team key and expose repositories read only"
```

---

### Task 12: Remove Project, ProjectSecret, and the guessing lookups

**Files:**
- Modify: `prisma/schema.prisma`
- Delete: `src/domain/projects/project-registry.ts`, `src/persistence/prisma/project-registry.prisma.ts`
- Delete: `tests/integration/project-registry.test.ts`
- Create: `prisma/migrations/<timestamp>_drop_project/migration.sql` (generated)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. This task removes the old path so no caller can reach it.

- [ ] **Step 1: Prove nothing reads the old names**

Run: `grep -rn "findDefaultForTenant\|findByLinearTeam\|primaryRepository\|referenceRepositories\|ProjectRegistry\|ProjectSecret" src tests`
Expected: no match outside the files this task deletes. Fix any remaining caller before continuing.

- [ ] **Step 2: Delete the modules and the models**

Delete the two source files and the old integration test. Remove `Project`, `ProjectSecret`, `Run.primaryRepository`, and their relations from `prisma/schema.prisma`. Move `PrismaSecretStore` into `src/persistence/prisma/product-registry.prisma.ts` if Task 8 left it in the deleted file.

- [ ] **Step 3: Generate the migration**

Run: `npx prisma migrate dev --name drop_project`
Expected: the migration drops both tables and the column.

- [ ] **Step 4: Run the full gate**

Run: `npm run verify`
Expected: PASS. Lint, typecheck, unit tests, build, integration tests, and workflow tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(db): remove Project, ProjectSecret, and the fallback lookups"
```

---

### Task 13: The Routing section of the Proof Pack

**Files:**
- Modify: `src/domain/publishing/` proof pack builder
- Test: `tests/unit/proof-pack.test.ts`

**Interfaces:**
- Consumes: `RunTarget` rows from Task 1, the sibling evidence records that Task 14 writes.
- Produces: a `### Routing` section in the rendered Proof Pack.

- [ ] **Step 1: Write the failing test**

```typescript
it("renders the Routing section with the product, the team, and every target", () => {
  const markdown = renderProofPack({
    ...baseInput,
    routing: {
      productSlug: "checkout-platform",
      linearTeamKey: "PAY",
      targets: [
        { fullName: "acme/checkout-api", baseSha: "4f21c9e", pullRequestUrl: "https://github.com/acme/checkout-api/pull/812", mergeOrder: 1 },
      ],
      siblingsRead: [{ fullName: "acme/checkout-events", commitSha: "1b7d004" }],
      selectionReason: "sole member",
    },
  });

  expect(markdown).toContain("### Routing");
  expect(markdown).toContain("Product: checkout-platform");
  expect(markdown).toContain("Linear team: PAY");
  expect(markdown).toContain("acme/checkout-api @ 4f21c9e -> PR #812");
  expect(markdown).toContain("acme/checkout-events @ 1b7d004");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/proof-pack.test.ts --config vitest.config.ts`
Expected: FAIL. The section is absent.

- [ ] **Step 3: Implement**

Render the section in the order that specification section 18 fixes: `Product`, `Linear team`, `Targets`, `Merge order`, `Sibling repositories read`, `Selection reason`. Omit the `Merge order` line when there is one target.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/proof-pack.test.ts --config vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/publishing tests/unit/proof-pack.test.ts
git commit -m "feat(proof-pack): render the Routing section"
```

---

### Task 14: The gated sibling clone

**Files:**
- Modify: `src/domain/policy/action-policy.ts`
- Modify: `src/adapters/sandbox/`
- Test: `tests/unit/action-policy.test.ts`, `tests/unit/sibling-clone.test.ts`

**Interfaces:**
- Consumes: `AgentRunProductInput.repositories` (Task 9).
- Produces: action `clone_sibling`. Sandbox method `cloneSibling(input: { fullName: string; runId: string; role: string }): Promise<{ path: string; commitSha: string }>`, which writes an evidence record of kind `sibling_read`.

- [ ] **Step 1: Write the failing test**

```typescript
it("allows a read-only clone of a member repository", () => {
  expect(decide({ action: "clone_sibling", fullName: "acme/web", members: ["acme/api", "acme/web"] })).toBe("allow");
});

it("denies a clone of a repository outside the Product", () => {
  expect(decide({ action: "clone_sibling", fullName: "acme/other", members: ["acme/api", "acme/web"] })).toBe("deny");
});

it("denies a write to a sibling", () => {
  expect(decide({ action: "write_sibling", fullName: "acme/web", members: ["acme/api", "acme/web"] })).toBe("deny");
});
```

```typescript
it("writes an evidence record naming the repository, the commit, and the role", async () => {
  const { sandbox, evidence } = build({ members: ["acme/api", "acme/web"] });

  await sandbox.cloneSibling({ fullName: "acme/web", runId: "run-1", role: "implementer" });

  expect(evidence.records).toEqual([
    expect.objectContaining({ kind: "sibling_read", fullName: "acme/web", role: "implementer" }),
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/action-policy.test.ts tests/unit/sibling-clone.test.ts --config vitest.config.ts`
Expected: FAIL. The action and the method do not exist.

- [ ] **Step 3: Implement**

Add the two actions to the policy table, with `clone_sibling` allowed only when the repository is a member of the Run's `Product`. Implement `cloneSibling`, which clones read-only into a directory outside the target working tree, then writes the evidence record.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/action-policy.test.ts tests/unit/sibling-clone.test.ts --config vitest.config.ts`
Expected: PASS, four tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/policy src/adapters/sandbox tests/unit
git commit -m "feat(sandbox): clone a sibling repository read-only, and record the access"
```

---

### Task 15: Acceptance tests AT-38 to AT-43 and AT-46 to AT-48

**Files:**
- Create: `tests/acceptance/at-38-to-48-tenancy.test.ts`
- Modify: `docs/sdd.md` section 64, to add the test names

**Interfaces:**
- Consumes: every module this plan builds.
- Produces: no new interface. This task proves the specification.

- [ ] **Step 1: Write the failing tests**

One `it` per acceptance test, named exactly as the specification names it.

```typescript
it("AT-38 resolves a team key to one Product, and the id never leaves Factoree", async () => { /* ... */ });
it("AT-39 refuses with BLOCKED_ROUTING when two Products claim one team", async () => { /* ... */ });
it("AT-40 fails validation, by key name, when a repository file sets autonomy", async () => { /* ... */ });
it("AT-41 creates a pending Product at L0 for an unknown product slug", async () => { /* ... */ });
it("AT-42 proceeds and posts a Linear notice for a confident single target", async () => { /* ... */ });
it("AT-43 blocks with BLOCKED_TARGET on an ambiguous target, and resumes on a reply", async () => { /* ... */ });
it("AT-46 clones a sibling read-only and writes an evidence record", async () => { /* ... */ });
it("AT-47 denies a clone outside the Product", async () => { /* ... */ });
it("AT-48 keeps the binding, and records the drift, when a team key is renamed", async () => { /* ... */ });
```

Each body drives the real module rather than a mock of it. AT-48 renames the key on the Linear stub, runs discovery, and asserts the `Product` keeps its id and reports the drift.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/acceptance/at-38-to-48-tenancy.test.ts --config vitest.integration.config.ts`
Expected: FAIL, nine tests.

- [ ] **Step 3: Fill any gap the tests expose**

Every module already exists. Fix what the acceptance tests find, in the module that owns the behaviour, never in the test.

- [ ] **Step 4: Run the full gate**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/acceptance/at-38-to-48-tenancy.test.ts docs/sdd.md
git commit -m "test: prove the tenancy acceptance criteria AT-38 to AT-48"
```

---

## What this plan does not do

Change Sets are the second plan: several writable targets, patch integrity per target, `BLOCKED_STALE_SET`, linked pull requests with a merge order, one review over the whole set, and acceptance tests AT-44 and AT-45. Task 1 already creates `RunTarget` with `mergeOrder`, and Task 10 already writes one row per Run, so the second plan adds repetition rather than a migration.

Per-Product Run concurrency has no control today, and this plan adds none. It needs its own design.
