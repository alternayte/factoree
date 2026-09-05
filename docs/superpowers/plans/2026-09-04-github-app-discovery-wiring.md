# GitHub App discovery wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Run possible, by wiring GitHub App discovery into the running server and retiring the per-Product `GITHUB_TOKEN` secret.

**Architecture:** A `GitHubTokenProvider` port mirrors the existing `LinearTokenProvider`. One App-backed adapter signs a JWT with the App private key, exchanges it for an installation access token, and caches it per installation. Every GitHub adapter takes the provider and an installation id rather than a fixed token. A verified webhook starts a Temporal workflow that reads every granted repository.

**Tech Stack:** TypeScript on Node 24, ESM with the `~/` path alias and `.js` import suffixes, Prisma 7 on PostgreSQL, Temporal, Fastify, zod 4, vitest 4, testcontainers, `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-09-04-github-app-discovery-wiring-design.md`

## Global Constraints

- Node 24. `"type": "module"`. Every relative import ends in `.js`. Internal imports use the `~/` alias.
- Prose in comments follows ASD-STE100: active voice, no contractions, no `-ing` forms outside a technical name, modals limited to `must` for an obligation and `can` for a possibility. `shall`, `should`, `may`, `might`, `would`, and `could` are forbidden, including inside SQL and YAML comments. One action per sentence. No two actions joined by "and" in one sentence. 25 words or fewer per descriptive sentence.
- **A token never reaches a log, an error message, an evidence record, or the Proof Pack.** An error carries the HTTP status and the installation id.
- **A token is never stored at construction.** The provider takes the installation id on every call.
- **Mint per operation, never per Run.** A Run can outlive a one-hour token.
- Every route request schema and every webhook body schema uses `.strict()`.
- Lookups use `findUnique` on a unique column. A `findFirst` on a non-unique column is a defect.
- The gate is `npm run verify`, run in the **foreground**. It runs lint, typecheck, unit, build, integration, and workflow tests, and it must exit 0. Do not substitute a partial command: a partial gate let two regressions hide for five tasks on the preceding branch.
- If a failure appears in an area you did not touch, check it against the merge base in a worktree before calling it pre-existing. When a test exercises a built artifact, build first.

---

### Task 1: Configuration for the App

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Test: `tests/unit/env.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Env` gains `GITHUB_APP_ID: string`, `GITHUB_APP_PRIVATE_KEY: string` (base64-encoded PEM), and `GITHUB_WEBHOOK_SECRET: string`. All three are required.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/env.test.ts`, following the style already there.

```typescript
it("requires the three GitHub App values", () => {
  const base = validEnv();
  expect(() => loadEnv({ ...base, GITHUB_APP_ID: undefined })).toThrow();
  expect(() => loadEnv({ ...base, GITHUB_APP_PRIVATE_KEY: undefined })).toThrow();
  expect(() => loadEnv({ ...base, GITHUB_WEBHOOK_SECRET: undefined })).toThrow();
});

it("rejects a private key that is not base64", () => {
  expect(() => loadEnv({ ...validEnv(), GITHUB_APP_PRIVATE_KEY: "not base64!" })).toThrow();
});

it("accepts a base64 private key", () => {
  const pem = Buffer.from("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n").toString("base64");
  expect(loadEnv({ ...validEnv(), GITHUB_APP_PRIVATE_KEY: pem }).GITHUB_APP_PRIVATE_KEY).toBe(pem);
});
```

Read the existing test file first. If it has no `validEnv()` helper, write one that returns a complete valid environment, and use it in your three cases only.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/env.test.ts --config vitest.config.ts`
Expected: FAIL. The schema does not know the three keys, so a missing one does not throw.

- [ ] **Step 3: Implement**

Add to the schema in `src/config/env.ts`, beside the other GitHub values:

```typescript
  // SDD section 30. The App identity. Factoree signs a short JWT with the private key. It
  // exchanges that JWT for a token scoped to one installation. The token reads a repository
  // before Factoree knows which Product the repository names.
  GITHUB_APP_ID: z.string().min(1),
  // A PEM holds several lines. An environment file carries one line reliably, so the value is
  // base64. Factoree decodes it at load. Nothing reaches the filesystem.
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64 with no line break"),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
```

Add the same three keys to `.env.example`, with a comment naming where an operator finds each. Point at the spec's setup procedure.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/env.test.ts --config vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts .env.example tests/unit/env.test.ts
git commit -m "feat(config): require the GitHub App identity and webhook secret"
```

---

### Task 2: The token provider

**Files:**
- Create: `src/domain/products/github-token-provider.ts`
- Create: `src/adapters/github/app-token-provider.ts`
- Test: `tests/unit/app-token-provider.test.ts`

**Interfaces:**
- Consumes: `Env` from Task 1.
- Produces:
  - `GitHubTokenProvider { tokenForInstallation(githubInstallationId: string): Promise<string> }`
  - `class GitHubAppTokenProvider implements GitHubTokenProvider`, constructed with `{ appId: string; privateKeyBase64: string; apiBaseUrl?: string; fetch?: typeof fetch; now?: () => number }`.
  - `class GitHubAppAuthError extends Error`, carrying `status: number | null` and `githubInstallationId: string`.

Read `src/domain/projects/linear-token-provider.ts` first. It solves the same problem against Linear, and this file mirrors its shape.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { GitHubAppTokenProvider, GitHubAppAuthError } from "~/adapters/github/app-token-provider.js";

const privateKeyBase64 = (() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString("base64");
})();

const build = (overrides: { status?: number; expiresInMs?: number; now?: () => number } = {}) => {
  const calls: string[] = [];
  let minted = 0;
  const provider = new GitHubAppTokenProvider({
    appId: "123456",
    privateKeyBase64,
    fetch: ((url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (overrides.status !== undefined && overrides.status !== 201) {
        return Promise.resolve(new Response("", { status: overrides.status }));
      }
      minted += 1;
      const expiresAt = new Date((overrides.now?.() ?? 0) + (overrides.expiresInMs ?? 3_600_000));
      return Promise.resolve(
        new Response(JSON.stringify({ token: `ghs_token_${String(minted)}`, expires_at: expiresAt.toISOString() }), {
          status: 201,
        }),
      );
    }) as unknown as typeof fetch,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
  return { provider, calls, minted: () => minted };
};

describe("GitHubAppTokenProvider", () => {
  it("mints a token for one installation", async () => {
    const { provider, calls } = build({ now: () => 0 });

    expect(await provider.tokenForInstallation("42")).toBe("ghs_token_1");
    expect(calls[0]).toContain("/app/installations/42/access_tokens");
  });

  it("reuses a cached token while it has more than five minutes left", async () => {
    const { provider, minted } = build({ now: () => 0 });

    await provider.tokenForInstallation("42");
    await provider.tokenForInstallation("42");

    expect(minted()).toBe(1);
  });

  it("mints again when under five minutes remain", async () => {
    let clock = 0;
    const { provider, minted } = build({ now: () => clock, expiresInMs: 600_000 });

    await provider.tokenForInstallation("42");
    clock = 350_000;
    await provider.tokenForInstallation("42");

    expect(minted()).toBe(2);
  });

  it("keeps one installation's token away from another", async () => {
    const { provider } = build({ now: () => 0 });

    const first = await provider.tokenForInstallation("42");
    const second = await provider.tokenForInstallation("43");

    expect(first).not.toBe(second);
  });

  it("names the installation and the status on a failure, never the key", async () => {
    const { provider } = build({ status: 401 });

    const error = await provider.tokenForInstallation("42").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubAppAuthError);
    const message = (error as Error).message;
    expect(message).toContain("42");
    expect(message).toContain("401");
    expect(message).not.toContain(privateKeyBase64);
    expect(message).not.toContain("PRIVATE KEY");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/app-token-provider.test.ts --config vitest.config.ts`
Expected: FAIL. Neither module exists.

- [ ] **Step 3: Implement the port**

```typescript
// src/domain/products/github-token-provider.ts
/**
 * The GitHub credential of one installation. An implementation mints a short-lived token.
 * The caller passes the installation id on every call. No implementation holds a token at
 * construction, because a held token belongs to one installation and reads another.
 */
export interface GitHubTokenProvider {
  tokenForInstallation(githubInstallationId: string): Promise<string>;
}
```

- [ ] **Step 4: Implement the adapter**

Write `src/adapters/github/app-token-provider.ts`. The JWT is signed with `node:crypto`, not a new dependency. Factoree signs a payload it authors. It never parses a token from an untrusted source.

```typescript
import { createPrivateKey, createSign } from "node:crypto";
import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";

const DEFAULT_API_BASE_URL = "https://api.github.com";
/** Refresh under this margin. A long operation must not race the expiry boundary. */
const REFRESH_MARGIN_MS = 300_000;

export class GitHubAppAuthError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly githubInstallationId: string,
  ) {
    super(message);
    this.name = "GitHubAppAuthError";
  }
}

const base64Url = (input: Buffer): string =>
  input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

type CacheEntry = { token: string; expiresAtMs: number };

export class GitHubAppTokenProvider implements GitHubTokenProvider {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: GitHubAppTokenProviderOptions) {}

  async tokenForInstallation(githubInstallationId: string): Promise<string> {
    const now = this.options.now?.() ?? Date.now();
    const cached = this.cache.get(githubInstallationId);
    if (cached !== undefined && cached.expiresAtMs - now > REFRESH_MARGIN_MS) return cached.token;

    const minted = await this.mint(githubInstallationId, now);
    this.cache.set(githubInstallationId, minted);
    return minted.token;
  }

  /** Signs the App JWT. `iat` is backdated against clock skew. `exp` sits inside the ten-minute ceiling. */
  private signJwt(nowMs: number): string {
    const header = base64Url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const seconds = Math.floor(nowMs / 1000);
    const payload = base64Url(
      Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: this.options.appId })),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    signer.end();
    const key = createPrivateKey(Buffer.from(this.options.privateKeyBase64, "base64").toString("utf8"));
    return `${header}.${payload}.${base64Url(signer.sign(key))}`;
  }

  private async mint(githubInstallationId: string, nowMs: number): Promise<CacheEntry> {
    const base = (this.options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    const url = `${base}/app/installations/${githubInstallationId}/access_tokens`;
    const fetchImpl = this.options.fetch ?? fetch;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.signJwt(nowMs)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (response.status !== 201) {
      throw new GitHubAppAuthError(
        `the GitHub API answered ${String(response.status)} while it minted a token for installation ${githubInstallationId}`,
        response.status,
        githubInstallationId,
      );
    }
    const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
      throw new GitHubAppAuthError(
        `the GitHub API returned no token for installation ${githubInstallationId}`,
        null,
        githubInstallationId,
      );
    }
    return { token: body.token, expiresAtMs: Date.parse(body.expires_at) };
  }
}
```

Declare `GitHubAppTokenProviderOptions` above the class with the fields named in the Interfaces block.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/app-token-provider.test.ts --config vitest.config.ts`
Expected: PASS, five tests.

- [ ] **Step 6: Run the gate and commit**

Run: `npm run verify`
Expected: exit 0.

```bash
git add src/domain/products/github-token-provider.ts src/adapters/github/app-token-provider.ts tests/unit/app-token-provider.test.ts
git commit -m "feat(github): mint an installation access token behind a provider port"
```

---

### Task 3: Webhook signature verification

**Files:**
- Create: `src/adapters/github/webhook-verifier.ts`
- Test: `tests/unit/github-webhook-verifier.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `verifyGitHubSignature(input: { rawBody: Buffer | string; signature: string | undefined; secret: string }): { ok: true } | { ok: false; reason: "missing_signature" | "bad_signature" }`.

Read `src/adapters/linear/webhook-verifier.ts` first and mirror it. It already handles the trap that `Buffer.from(value, "hex")` stops at the first invalid pair rather than throwing, so a length check is what rejects a malformed signature.

- [ ] **Step 1: Write the failing test**

```typescript
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitHubSignature } from "~/adapters/github/webhook-verifier.js";

const SECRET = "a-test-secret";
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("verifyGitHubSignature", () => {
  it("accepts a signature computed over the same bytes", () => {
    const body = JSON.stringify({ action: "created" });
    expect(verifyGitHubSignature({ rawBody: body, signature: sign(body), secret: SECRET })).toEqual({ ok: true });
  });

  it("rejects a signature computed over different bytes", () => {
    const signed = JSON.stringify({ action: "created" });
    const sent = JSON.stringify({ action: "deleted" });
    expect(verifyGitHubSignature({ rawBody: sent, signature: sign(signed), secret: SECRET })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a missing signature", () => {
    expect(verifyGitHubSignature({ rawBody: "{}", signature: undefined, secret: SECRET })).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it("rejects a signature of the wrong length without throwing", () => {
    expect(verifyGitHubSignature({ rawBody: "{}", signature: "sha256=abcd", secret: SECRET })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a signature that carries no sha256 prefix", () => {
    const body = "{}";
    const raw = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifyGitHubSignature({ rawBody: body, signature: raw, secret: SECRET })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/github-webhook-verifier.test.ts --config vitest.config.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement**

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

export type GitHubSignatureFailure = "missing_signature" | "bad_signature";
export type GitHubSignatureResult = { ok: true } | { ok: false; reason: GitHubSignatureFailure };

const PREFIX = "sha256=";

export const verifyGitHubSignature = (input: {
  rawBody: Buffer | string;
  signature: string | undefined;
  secret: string;
}): GitHubSignatureResult => {
  if (input.signature === undefined) return { ok: false, reason: "missing_signature" };
  if (!input.signature.startsWith(PREFIX)) return { ok: false, reason: "bad_signature" };

  const expected = createHmac("sha256", input.secret)
    .update(typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : input.rawBody)
    .digest();
  // Buffer.from with hex encoding stops at the first invalid pair instead of throwing. The
  // length check is therefore what rejects a malformed signature. timingSafeEqual throws on a
  // length mismatch, so the check must come first.
  const provided = Buffer.from(input.signature.slice(PREFIX.length), "hex");
  if (provided.length !== expected.length) return { ok: false, reason: "bad_signature" };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/github-webhook-verifier.test.ts --config vitest.config.ts`
Expected: PASS, five tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github/webhook-verifier.ts tests/unit/github-webhook-verifier.test.ts
git commit -m "feat(github): verify a webhook signature in constant time"
```

---

### Task 4: A Repository knows its installation

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_repository_installation/migration.sql`
- Modify: `src/domain/products/repository-registry.ts`
- Modify: `src/persistence/prisma/product-registry.prisma.ts`
- Modify: `src/domain/products/discovery-service.ts`
- Test: `tests/integration/product-registry.test.ts`, `tests/unit/discovery-service.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RepositoryRecord` and `UpsertRepositoryInput` gain `githubInstallationId: string`. `DiscoveryService.syncRepository` gains a fourth parameter `githubInstallationId: string`, so the signature becomes `syncRepository(tenantId: string, fullName: string, defaultBranch: string, githubInstallationId: string)`.

A Run holds a tenant and a target `Repository`. It holds no installation id, and a tenant can hold several installations. Without this column nothing tells `checkout` which installation to mint against.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/product-registry.test.ts`:

```typescript
it("records the installation that granted access to a repository", async () => {
  const tenant = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-inst", name: "Acme" } });
  const products = new PrismaProductRegistry(prisma);
  const repositories = new PrismaRepositoryRegistry(prisma);
  const product = await products.create({
    tenantId: tenant.id,
    slug: "checkout",
    name: "Checkout",
    linearTeamKey: "CHI",
    linearTeamId: "team-chi",
  });

  const row = await repositories.upsert({
    tenantId: tenant.id,
    productId: product.id,
    fullName: "acme/api",
    defaultBranch: "main",
    configSha: "aaa",
    requestedSecretNames: [],
    githubInstallationId: "42",
  });

  expect(row.githubInstallationId).toBe("42");
});
```

Append to `tests/unit/discovery-service.test.ts`:

```typescript
it("stores the installation that triggered the sync", async () => {
  const { service, repositories } = build({ config: configFor("checkout-platform", "PAY") });

  await service.syncRepository("tenant-1", "acme/api", "main", "42");

  const row = await repositories.findByFullName("tenant-1", "acme/api");
  expect(row?.githubInstallationId).toBe("42");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/discovery-service.test.ts --config vitest.config.ts`
Expected: FAIL. `syncRepository` takes three parameters.

- [ ] **Step 3: Implement**

Add to the `Repository` model in `prisma/schema.prisma`:

```prisma
  // The installation that granted access to this repository. Discovery knows it at sync time.
  // A clone or a push mints its token against this installation.
  githubInstallationId String
```

Generate the migration with `npx prisma migrate dev --name add_repository_installation`. The column is `NOT NULL` with no default, so put a comment at the top of the migration SQL saying the product is not in production and existing rows are removed rather than backfilled. Follow the style of `prisma/migrations/20260903220204_rename_run_project_id_to_product_id/migration.sql`.

Thread the field through `RepositoryRecord`, `UpsertRepositoryInput`, the Prisma implementation, and `DiscoveryService.syncRepository`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/discovery-service.test.ts --config vitest.config.ts`
Run: `npx vitest run tests/integration/product-registry.test.ts --config vitest.integration.config.ts`
Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

Run: `npm run verify`
Expected: exit 0. The GitHub webhook route calls `syncRepository`, so its tests need the new argument.

```bash
git add -A
git commit -m "feat(products): record the installation that granted a repository"
```

---

### Task 5: Every GitHub adapter takes the provider

**Files:**
- Modify: `src/adapters/github/repository-discovery-client.ts`
- Modify: `src/adapters/github/github-pull-requests.ts`
- Modify: `src/adapters/github/git-repository-reader.ts`
- Modify: `src/domain/runs/checkout.ts`
- Test: the existing test file of each

**Interfaces:**
- Consumes: `GitHubTokenProvider` from Task 2, `Repository.githubInstallationId` from Task 4.
- Produces: each adapter's options take `tokens: GitHubTokenProvider` in place of `token: string`. Each method that reaches GitHub takes the installation id it mints against.

This closes the defect the previous branch's final review found: a client holding one token at construction reads a second tenant's repositories.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/repository-discovery-client.test.ts`:

```typescript
it("mints a token for each installation it reads", async () => {
  const asked: string[] = [];
  const client = new GitHubRepositoryDiscoveryClient({
    tokens: {
      tokenForInstallation: (id: string) => {
        asked.push(id);
        return Promise.resolve(`ghs_${id}`);
      },
    },
    fetch: (() =>
      Promise.resolve(new Response(JSON.stringify({ repositories: [] }), { status: 200 }))) as unknown as typeof fetch,
  });

  await client.listInstallationRepositories("42");
  await client.listInstallationRepositories("43");

  expect(asked).toEqual(["42", "43"]);
});
```

`readConfig` also needs an installation id, so its signature becomes `readConfig(fullName: string, ref: string, githubInstallationId: string)`. Update the existing cases in that file accordingly.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/repository-discovery-client.test.ts --config vitest.config.ts`
Expected: FAIL. The options take `token`.

- [ ] **Step 3: Implement**

Replace the stored token in each adapter with a stored provider, and mint inside the request path:

```typescript
  private async request(url: string, githubInstallationId: string): Promise<Response> {
    const token = await this.tokens.tokenForInstallation(githubInstallationId);
    // The token is minted for this request. It is never stored on the instance, because a stored
    // token belongs to one installation and a later call can name another.
    return this.fetchImpl(url, { headers: { authorization: `Bearer ${token}`, ... } });
  }
```

`checkout.ts` mints immediately before the clone and passes the token through `credentialEnv`, as it already does. The URL stays free of a credential; `repository-url.ts` already builds it that way.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit --config vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

Run: `npm run verify`
Expected: exit 0.

```bash
git add -A
git commit -m "refactor(github): mint a token per call rather than hold one per client"
```

---

### Task 6: Retire the Product GITHUB_TOKEN

**Files:**
- Modify: `src/activities/publishing.activities.ts`
- Modify: `tools/local/bootstrap.sh`
- Modify: `.env.example`
- Test: `tests/unit/publishing-activities.test.ts`, `tests/integration/admin-api.test.ts`

**Interfaces:**
- Consumes: `GitHubTokenProvider` from Task 2, the adapters from Task 5.
- Produces: `GITHUB_TOKEN_SECRET` and its descriptor lookup leave `publishing.activities.ts`. The publish activity takes `tokens: GitHubTokenProvider` and the target repository's `githubInstallationId`.

- [ ] **Step 1: Write the failing test**

```typescript
it("publishes with a minted token and reads no Product secret", async () => {
  const secrets = { list: vi.fn(), get: vi.fn() };
  const { publish } = build({
    secrets,
    tokens: { tokenForInstallation: () => Promise.resolve("ghs_minted") },
  });

  await publish(validInput());

  expect(secrets.list).not.toHaveBeenCalled();
  expect(secrets.get).not.toHaveBeenCalled();
});

it("names the installation when a mint fails", async () => {
  const { publish } = build({
    tokens: {
      tokenForInstallation: (id: string) =>
        Promise.reject(new GitHubAppAuthError(`the GitHub API answered 401 ... installation ${id}`, 401, id)),
    },
  });

  await expect(publish(validInput())).rejects.toThrow(/42/);
});
```

Read the existing publishing test file first and follow its `build` and `validInput` conventions.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/publishing-activities.test.ts --config vitest.config.ts`
Expected: FAIL. The activity reads the secret store.

- [ ] **Step 3: Implement**

Delete `GITHUB_TOKEN_SECRET`, the descriptor lookup, the injection-mark check, and the `secrets.get` call. Mint instead.

Keep the secret-kind and injection-mark machinery itself. SDD section 30 governs test credentials and runner credentials, and those stay. One name leaves the store.

Remove `SETUP_GITHUB_TOKEN` from `bootstrap.sh` and from `.env.example`.

- [ ] **Step 4: Register every minted token with the Redactor**

Specification section 7 requires it, and no other task covers it.

A token must never reach output by design. The redactor is the guarantee that survives a later
edit by someone who does not know the rule. Register the minted token before it is used, at both
sites that mint one for a Run: the clone in `checkout.ts` and the publish in
`publishing.activities.ts`.

Read how a secret value reaches the redactor today. Follow that path rather than adding a second
mechanism.

Write a test that proves it:

```typescript
it("registers a minted token with the redactor before it is used", async () => {
  const { publish, redactor } = build({
    tokens: { tokenForInstallation: () => Promise.resolve("ghs_minted_secret_value") },
  });

  await publish(validInput());

  expect(redactor.redact("a line holding ghs_minted_secret_value")).not.toContain("ghs_minted_secret_value");
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/publishing-activities.test.ts --config vitest.config.ts`
Expected: PASS.

- [ ] **Step 6: Run the gate and commit**

Run: `npm run verify`
Expected: exit 0.

```bash
git add -A
git commit -m "refactor(publishing): publish with an installation token, not a Product secret"
```

---

### Task 7: The install-time sync workflow

**Files:**
- Create: `src/workflows/sync-installation.workflow.ts`
- Create: `src/workflows/index.ts`
- Modify: `src/bin/worker.ts:252`
- Modify: `src/activities/index.ts`
- Create: `src/activities/discovery.activities.ts`
- Test: `tests/workflow/sync-installation.test.ts`

**Interfaces:**
- Consumes: `RepositoryDiscoveryClient` and `DiscoveryService`.
- Produces: `syncInstallationWorkflow(input: { tenantId: string; githubInstallationId: string }): Promise<{ registered: number; skipped: number; conflicted: number }>`, and activities `listInstallationRepositories(input)` and `syncOneRepository(input)`.

The worker points `workflowsPath` at one file today. A second workflow needs a barrel, so create `src/workflows/index.ts` that re-exports both, and point `workflowsPath` at it.

- [ ] **Step 1: Write the failing test**

```typescript
it("registers the participating repositories and counts the rest", async () => {
  const { result } = await runSyncWorkflow({
    repositories: [
      { fullName: "acme/api", defaultBranch: "main" },
      { fullName: "acme/web", defaultBranch: "main" },
      { fullName: "acme/docs", defaultBranch: "main" },
    ],
    outcomes: {
      "acme/api": { kind: "registered" },
      "acme/web": { kind: "skipped", reason: "no configuration file" },
      "acme/docs": { kind: "conflict", reason: "another Product claims Linear team PAY" },
    },
  });

  expect(result).toEqual({ registered: 1, skipped: 1, conflicted: 1 });
});

it("reads every page of a paginated installation", async () => {
  const { synced } = await runSyncWorkflow({ repositoryCount: 250 });

  expect(synced).toHaveLength(250);
});
```

Follow the Temporal test-environment style already used in `tests/workflow/target-selection.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/workflow/sync-installation.test.ts --config vitest.workflow.config.ts`
Expected: FAIL. The workflow does not exist.

- [ ] **Step 3: Implement**

The workflow lists repositories, then syncs each with bounded concurrency. Keep all timing and rate logic in the activity, so the workflow stays deterministic.

```typescript
/**
 * Specification section 10. The webhook answers GitHub in seconds. This workflow does the slow
 * work. Temporal owns it, so a restart does not lose a sync in progress.
 */
const CONCURRENCY = 4;
```

The activity reads `x-ratelimit-remaining` and honours `retry-after` on a 403. Temporal's retry policy performs the backoff.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/workflow/sync-installation.test.ts --config vitest.workflow.config.ts`
Expected: PASS, two tests.

- [ ] **Step 5: Run the gate and commit**

Run: `npm run verify`
Expected: exit 0.

```bash
git add -A
git commit -m "feat(discovery): sync an installation's repositories in a durable workflow"
```

---

### Task 8: Mount the route

**Files:**
- Modify: `src/http/server.ts:67`
- Modify: `src/bin/api.ts`
- Modify: `src/http/webhooks/github.routes.ts`
- Test: `tests/unit/github-webhook-routes.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `discovery` and `verifyGitHubSignature` become required on `ServerDependencies`. The route starts `syncInstallationWorkflow` on an `installation` event.

Optionality is what let the route stay unmounted through fifteen tasks with no test noticing. A required field makes an unmounted route a compile error.

- [ ] **Step 1: Write the failing test**

```typescript
it("starts a sync when an installation is created", async () => {
  const { app, started } = build({});

  await app.inject({
    method: "POST",
    url: "/webhooks/github",
    headers: { "x-github-event": "installation" },
    payload: { action: "created", installation: { id: 42, account: { login: "acme" } } },
  });

  expect(started).toEqual([{ tenantId: "tenant-1", githubInstallationId: "42" }]);
});

it("starts no sync for an unbound installation", async () => {
  const { app, started, logger } = build({ tenantBound: false });

  const response = await app.inject({
    method: "POST",
    url: "/webhooks/github",
    headers: { "x-github-event": "installation" },
    payload: { action: "created", installation: { id: 99, account: { login: "other" } } },
  });

  expect(response.statusCode).toBe(200);
  expect(started).toEqual([]);
  expect(logger.warnCalls[0]?.fields).toMatchObject({ installation_id: "99" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/github-webhook-routes.test.ts --config vitest.config.ts`
Expected: FAIL. The route discards the `installation` event.

- [ ] **Step 3: Implement**

Make both dependencies required in `ServerDependencies`, construct them in `bin/api.ts`, and start the workflow from the `installation` handler. Key the workflow id on the installation id, so a repeated event joins the running sync rather than starting a second one.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/github-webhook-routes.test.ts --config vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

Run: `npm run verify`
Expected: exit 0.

```bash
git add -A
git commit -m "feat(http): mount the GitHub webhook route and start the installation sync"
```

---

### Task 9: Acceptance tests and documentation

**Files:**
- Create: `tests/acceptance/at-49-to-55-discovery.test.ts`
- Modify: `docs/sdd.md`, `docs/quickstart.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no new interface. This task proves the specification.

- [ ] **Step 1: Write the failing tests**

One `it` per acceptance test, named exactly as the specification names it:

```typescript
it("AT-49 syncs every granted repository of an installation", async () => { /* ... */ });
it("AT-50 answers 401 for a wrong webhook signature, and does no work", async () => { /* ... */ });
it("AT-51 warns for an unbound installation, does no work, and answers 200", async () => { /* ... */ });
it("AT-52 mints a token per installation, and never shares one between two", async () => { /* ... */ });
it("AT-53 clones and publishes with a minted token, and holds no Product GITHUB_TOKEN", async () => { /* ... */ });
it("AT-54 backs off on a rate limit, and completes the sync", async () => { /* ... */ });
it("AT-55 skips a repository without a configuration file, and does not fail", async () => { /* ... */ });
```

Each body drives the real module. An acceptance test that asserts a fake was called proves nothing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/acceptance/at-49-to-55-discovery.test.ts --config vitest.integration.config.ts`
Expected: some fail, some pass immediately because the behaviour already exists. Record which in your report.

- [ ] **Step 3: Fix any gap the tests expose**

Fix in the module that owns the behaviour, never in the test.

- [ ] **Step 4: Update the documentation**

Add the seven acceptance test names to `docs/sdd.md` section 64. Add the App setup procedure to `docs/quickstart.md`: creating the App, its three permissions, the `push` subscription, the private key, the tunnel for local testing, and the four environment values. Remove every mention of a `GITHUB_TOKEN` Product secret.

- [ ] **Step 5: Run the gate and commit**

Run: `npm run verify`
Expected: exit 0.

```bash
git add -A
git commit -m "test: prove the discovery wiring acceptance criteria AT-49 to AT-55"
```

---

### Task 10: Rename the last Project directory

**Files:**
- Modify: `src/domain/projects/` → `src/domain/products/`
- Modify: every importer

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This removes the last `Project` name from the source tree.

`src/domain/projects/` still holds `linear-token-provider.ts`, `redaction-loader.ts`, `repository-url.ts`, and `runner-credentials.ts`. Nothing in it concerns a `Project`, which no longer exists. The preceding branch renamed 259 identifiers for exactly this reason and left the directory.

- [ ] **Step 1: Move the files**

```bash
git mv src/domain/projects/linear-token-provider.ts src/domain/products/linear-token-provider.ts
git mv src/domain/projects/redaction-loader.ts src/domain/products/redaction-loader.ts
git mv src/domain/projects/repository-url.ts src/domain/products/repository-url.ts
git mv src/domain/projects/runner-credentials.ts src/domain/products/runner-credentials.ts
rmdir src/domain/projects
```

- [ ] **Step 2: Update every importer**

Run: `grep -rn "domain/projects" src tests`
Fix each hit. `npm run typecheck` is the proof that none was missed.

- [ ] **Step 3: Run the gate**

Run: `npm run verify`
Expected: exit 0.

- [ ] **Step 4: Confirm the name is gone**

Run: `grep -rn "domain/projects" src tests`
Expected: no match.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move the last modules out of the projects directory"
```

---

## Definition of done

A Linear issue delegated to a `Product` whose repository declares itself reaches a pull request, with no `GITHUB_TOKEN` anywhere in the `Product` secret store.

The preceding branch cannot satisfy that sentence. This plan must.

## What this plan does not do

An agent-facing tool that calls `cloneSibling`. The gate is built, tested, and unreachable.

Refinement proposing a target repository. Until it does, a `Product` with several repositories blocks on `BLOCKED_TARGET` once per Run and asks a human.

Each needs its own cycle, and neither depends on this work.
