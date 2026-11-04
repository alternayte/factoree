import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";
import { PrismaAgentSessionStore } from "~/persistence/prisma/agent-session.prisma.js";
import {
  PrismaProductRegistry,
  PrismaRepositoryRegistry,
  PrismaSecretStore,
  PrismaTenantRegistry,
} from "~/persistence/prisma/product-registry.prisma.js";
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { buildServer, type ServerDependencies } from "~/http/server.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { seedAdminKey, testAuth, testServerEnv, TEST_MASTER_KEY, unusedSetupCalls } from "./support/admin-access.js";
import type { LinearTeamLookup } from "~/adapters/linear/team-lookup.js";
import { DiscoveryService } from "~/domain/products/discovery-service.js";
import type { RepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";

let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let app: ReturnType<typeof buildServer>;
let serverOptions: ServerDependencies;
let tenants: PrismaTenantRegistry;
let token: string;
let auth: { authorization: string };

// Every workspace the tests name, except the one a test names to prove a stranger is refused.
const WORKSPACES = ["ws-context", "ws-context-other", "ws-1", "ws-admin", "ws-bad-skills", "ws-claim", "ws-fields", "ws-github-bind", "ws-github-owner", "ws-github-thief", "ws-kind", "ws-other", "ws-owner", "ws-refuse", "ws-remove", "ws-remove-other", "ws-remove-owner", "ws-repos", "ws-run-owner", "ws-run-sessions", "ws-secret", "ws-skills", "ws-sessions", "ws-sessions-other"];

// The route resolves a team key through Linear. This test double never calls the network: it
// answers a team for a key it was told to resolve, and null for one it was told to refuse.
const fakeLinearTeams = (refuseKeys: string[] = []): LinearTeamLookup => ({
  resolveTeamKey: (_tenantId, teamKey) =>
    Promise.resolve(refuseKeys.includes(teamKey) ? null : { id: `team-${teamKey.toLowerCase()}`, key: teamKey }),
  resolveTeamId: (_tenantId, teamId) => Promise.resolve({ id: teamId, key: teamId.toUpperCase() }),
});

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  tenants = new PrismaTenantRegistry(prisma, TEST_MASTER_KEY);
  const logger = createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined });
  const access = testAuth(prisma, logger);
  token = (await seedAdminKey(prisma, access.auth, { workspaces: WORKSPACES })).key;
  auth = { authorization: `Bearer ${token}` };
  serverOptions = {
    env: testServerEnv,
    version: "test",
    logger,
    prisma,
    settings: access.settings,
    auth: access.auth,
    setup: unusedSetupCalls,
    tenants,
    products: new PrismaProductRegistry(prisma),
    repositories: new PrismaRepositoryRegistry(prisma),
    linearTeams: fakeLinearTeams(["NOPE"]),
    secrets: new PrismaSecretStore(prisma, TEST_MASTER_KEY),
    runs: new PrismaRunRepository(prisma),
    delegation: new DelegationService({
      tenants,
      products: new PrismaProductRegistry(prisma),
      repositories: new PrismaRepositoryRegistry(prisma),
      webhookLog: new PrismaWebhookLog(prisma),
      starter: { start: vi.fn(() => Promise.resolve(undefined)), signalStop: vi.fn(() => Promise.resolve(true)), signalHumanInput: vi.fn(() => Promise.resolve(true)) },
      refusalNotifier: { postFailure: () => Promise.resolve(undefined) },
      logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
      repositoryBaseUrl: () => Promise.resolve("https://github.com"),
    }),
    // This test drives the Products administration route, which never exercises the GitHub
    // webhook route. These doubles only satisfy the shape `buildServer` now requires.
    discovery: new DiscoveryService(
      { listInstallationRepositories: () => Promise.reject(new Error("unused")), readConfig: () => Promise.reject(new Error("unused")) } satisfies RepositoryDiscoveryClient,
      new PrismaProductRegistry(prisma),
      new PrismaRepositoryRegistry(prisma),
      fakeLinearTeams(["NOPE"]),
      createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
    ),
    startInstallationSync: () => Promise.reject(new Error("unused")),
    recordPullRequestPreview: () => Promise.reject(new Error("unused")),
  };
  app = buildServer(serverOptions);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await stop();
});


describe("administration API", () => {
  it("reports health and readiness", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });

  it("rejects an administration request without the token", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/products?linearWorkspaceId=ws-1" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a wrong token of the same length and a token of a different length", async () => {
    const sameLength = await app.inject({
      method: "GET",
      url: "/admin/products?linearWorkspaceId=ws-1",
      headers: { authorization: `Bearer ${"x".repeat(token.length)}` },
    });
    expect(sameLength.statusCode).toBe(401);

    const otherLength = await app.inject({
      method: "GET",
      url: "/admin/products?linearWorkspaceId=ws-1",
      headers: { authorization: `Bearer ${token}extra` },
    });
    expect(otherLength.statusCode).toBe(401);
  });

  it("serves metrics only with the administration token", async () => {
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    const authorized = await app.inject({ method: "GET", url: "/metrics", headers: auth });
    expect(authorized.statusCode).toBe(200);
  });

  it("creates, reads, and activates a product by team key, and never requires a team id", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: {
        linearWorkspaceId: "ws-admin",
        workspaceName: "Admin",
        slug: "demo",
        name: "Demo",
        linearTeamKey: "DEMO",
      },
    });
    expect(created.statusCode).toBe(201);
    const product = created.json<{ id: string; linearTeamKey: string; linearTeamId: string; status: string }>();
    expect(product).toMatchObject({ linearTeamKey: "DEMO", linearTeamId: "team-demo", status: "pending" });

    const read = await app.inject({
      method: "GET",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-admin`,
      headers: auth,
    });
    expect(read.statusCode).toBe(200);

    const activated = await app.inject({
      method: "POST",
      url: `/admin/products/${product.id}/activate?linearWorkspaceId=ws-admin`,
      headers: auth,
      payload: { defaultAutonomy: "L3" },
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json<{ status: string; defaultAutonomy: string }>()).toMatchObject({
      status: "active",
      defaultAutonomy: "L3",
    });
  });

  it("answers 404, and names the key, when the team key resolves to no team", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-admin", slug: "s", name: "n", linearTeamKey: "NOPE" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toContain("NOPE");
  });

  it("rejects a body that carries a team id", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-admin", slug: "s2", name: "n2", linearTeamKey: "TID", linearTeamId: "team-tid" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("does not return a product of another tenant", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-owner", slug: "own", name: "Own", linearTeamKey: "OWN" },
    });
    const product = created.json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-other", slug: "oth", name: "Oth", linearTeamKey: "OTH" },
    });
    const stolen = await app.inject({
      method: "GET",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-other`,
      headers: auth,
    });
    expect(stolen.statusCode).toBe(404);
  });

  it("accepts and returns the organization skills repository on create, and changes it on update", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: {
        linearWorkspaceId: "ws-skills",
        slug: "skills",
        name: "Skills",
        linearTeamKey: "SKL",
        organizationSkillsRepository: "acme/skills",
      },
    });
    expect(created.statusCode).toBe(201);
    const product = created.json<{ id: string; organizationSkillsRepository: string | null }>();
    expect(product.organizationSkillsRepository).toBe("acme/skills");

    const updated = await app.inject({
      method: "PUT",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-skills`,
      headers: auth,
      payload: { organizationSkillsRepository: "acme/other-skills" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ organizationSkillsRepository: string }>().organizationSkillsRepository).toBe(
      "acme/other-skills",
    );
  });

  it("F8: changes the name and the maximum Run minutes on update", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-fields", slug: "fields", name: "Fields", linearTeamKey: "FLD" },
    });
    const product = created.json<{ id: string; maxRunMinutes: number }>();
    expect(product.maxRunMinutes).toBe(90);

    const updated = await app.inject({
      method: "PUT",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-fields`,
      headers: auth,
      payload: { name: "Renamed Fields", maxRunMinutes: 45 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ name: string; maxRunMinutes: number }>()).toMatchObject({
      name: "Renamed Fields",
      maxRunMinutes: 45,
    });
  });

  it("F8: answers 409, and names the claimant, when a create names a Linear team another Product already claims", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-claim", slug: "checkout", name: "Checkout", linearTeamKey: "PAY" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-claim", slug: "billing", name: "Billing", linearTeamKey: "PAY" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: string }>().error).toContain("checkout");
  });

  it("F6: removes a Product, so a typo-created pending Product does not persist forever", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-remove", slug: "remove-me", name: "Remove me", linearTeamKey: "RMV" },
    });
    const product = created.json<{ id: string }>();

    const removed = await app.inject({
      method: "DELETE",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-remove`,
      headers: auth,
    });
    expect(removed.statusCode).toBe(204);

    const gone = await app.inject({
      method: "GET",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-remove`,
      headers: auth,
    });
    expect(gone.statusCode).toBe(404);
  });

  it("F6: refuses to delete a Product that owns a Run, and the Product survives", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-run-owner", slug: "run-owner", name: "Run owner", linearTeamKey: "RUN" },
    });
    const product = created.json<{ id: string; tenantId: string }>();

    // F6 ruling: `Run.productId` carries `onDelete: Cascade` (prisma/schema.prisma:77), so a
    // Product that owns a Run must refuse deletion rather than silently destroy the Run and
    // the evidence behind every Proof Pack it produced.
    await prisma.run.create({
      data: {
        tenantId: product.tenantId,
        productId: product.id,
        linearAgentSessionId: "session-f6-run-owner",
        temporalWorkflowId: "workflow-f6-run-owner",
        status: "RECEIVED",
        autonomyLevel: "L2",
      },
    });

    const refused = await app.inject({
      method: "DELETE",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-run-owner`,
      headers: auth,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toContain("1 Run");

    const stillThere = await app.inject({
      method: "GET",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-run-owner`,
      headers: auth,
    });
    expect(stillThere.statusCode).toBe(200);
    expect(stillThere.json<{ id: string }>().id).toBe(product.id);
  });

  // docs/specs/agent-session-usage-and-hangs.md. The run route returns the agent sessions of the Run.
  it("returns the agent sessions of a Run with the Run", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-run-sessions", slug: "run-sessions", name: "Run sessions", linearTeamKey: "SES" },
    });
    const product = created.json<{ id: string; tenantId: string }>();
    const run = await prisma.run.create({
      data: {
        tenantId: product.tenantId,
        productId: product.id,
        linearAgentSessionId: "session-run-sessions",
        temporalWorkflowId: "workflow-run-sessions",
        status: "RECEIVED",
        autonomyLevel: "L2",
      },
    });
    await new PrismaAgentSessionStore(prisma).record({
      tenantId: product.tenantId,
      runId: run.id,
      role: "reviewer",
      attempt: 1,
      runner: "opencode",
      cliSessionId: "ses_review",
      model: "deepseek/deepseek-flash",
      effort: "low",
      usage: null,
      durationMs: 42_000,
      outcome: "hung",
      idempotencyKey: `run:${run.id}:reviewer:1`,
    });

    const response = await app.inject({
      method: "GET",
      url: `/admin/runs/${run.id}?linearWorkspaceId=ws-run-sessions`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ id: string; costUsd: number | null; sessions: Array<Record<string, unknown>> }>();
    expect(body.id).toBe(run.id);
    expect(body.costUsd).toBeNull();
    expect(body.sessions).toEqual([
      expect.objectContaining({ role: "reviewer", outcome: "hung", costUsd: null, durationMs: 42_000 }),
    ]);

    // docs/specs/run-visibility.md. The run list names the run, and a member reads it.
    const list = await app.inject({ method: "GET", url: "/admin/runs?linearWorkspaceId=ws-run-sessions", headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: Array<{ id: string; productSlug: string }>; nextCursor: string | null }>()).toEqual({
      items: [expect.objectContaining({ id: run.id, productSlug: "run-sessions" })],
      nextCursor: null,
    });
  });

  // docs/specs/run-visibility.md. A cursor page never repeats or skips a run.
  it("pages the run list newest first with a cursor", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-run-sessions", slug: "run-pages", name: "Run pages", linearTeamKey: "RPG" },
    });
    expect(created.json()).toMatchObject({ slug: "run-pages" });
    const product = created.json<{ id: string; tenantId: string }>();
    const ids: string[] = [];
    for (const index of [1, 2, 3]) {
      const row = await prisma.run.create({
        data: {
          tenantId: product.tenantId,
          productId: product.id,
          linearAgentSessionId: `session-run-pages-${index}`,
          temporalWorkflowId: `workflow-run-pages-${index}`,
          status: "FAILED",
          autonomyLevel: "L2",
          createdAt: new Date(Date.UTC(2026, 10, 4, 12, 0, index)),
        },
      });
      ids.push(row.id);
    }
    const page = async (cursor?: string) =>
      (
        await app.inject({
          method: "GET",
          url: `/admin/runs?linearWorkspaceId=ws-run-sessions&productId=${product.id}&limit=2${cursor === undefined ? "" : `&cursor=${cursor}`}`,
          headers: auth,
        })
      ).json<{ items: Array<{ id: string }>; nextCursor: string | null }>();

    const first = await page();
    expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    const second = await page(first.nextCursor ?? "");
    expect(second.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
  });

  it("F6: answers 404 for a Product of another tenant", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-remove-owner", slug: "own-remove", name: "Own", linearTeamKey: "OWR" },
    });
    const product = created.json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-remove-other", slug: "oth-remove", name: "Oth", linearTeamKey: "OTR" },
    });

    const stolen = await app.inject({
      method: "DELETE",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-remove-other`,
      headers: auth,
    });
    expect(stolen.statusCode).toBe(404);
  });

  it("refuses an organization skills repository that is not an owner and repository slug", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: {
        linearWorkspaceId: "ws-bad-skills",
        slug: "bad-skills",
        name: "Bad skills",
        linearTeamKey: "BAD",
        organizationSkillsRepository: "not-a-slug",
      },
    });
    expect(created.statusCode).toBe(400);
  });

  it("exposes repositories of a product read only, with no route to create, update, or delete one", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-repos", slug: "repos", name: "Repos", linearTeamKey: "REP" },
    });
    const product = created.json<{ id: string }>();

    const listed = await app.inject({
      method: "GET",
      url: `/admin/products/${product.id}/repositories?linearWorkspaceId=ws-repos`,
      headers: auth,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([]);

    const posted = await app.inject({
      method: "POST",
      url: `/admin/products/${product.id}/repositories`,
      headers: auth,
      payload: {},
    });
    expect(posted.statusCode).toBe(404);
  });

  it("stores a Product secret as ciphertext and reads it back through the secret store", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-secret", slug: "s-secret", name: "S", linearTeamKey: "SEC1" },
    });
    const product = created.json<{ id: string }>();
    const put = await app.inject({
      method: "PUT",
      url: `/admin/products/${product.id}/secrets/GITHUB_TOKEN?linearWorkspaceId=ws-secret`,
      headers: auth,
      payload: { value: "ghp_super_secret_value_12345678" },
    });
    expect(put.statusCode).toBe(204);
    const read = await app.inject({
      method: "GET",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-secret`,
      headers: auth,
    });
    expect(read.body).not.toContain("ghp_super_secret_value_12345678");

    const stored = await prisma.productSecret.findFirstOrThrow({ where: { productId: product.id } });
    expect(JSON.stringify(stored)).not.toContain("ghp_super_secret_value_12345678");
    const secrets = new PrismaSecretStore(prisma, TEST_MASTER_KEY);
    expect(await secrets.get(stored.tenantId, product.id, "GITHUB_TOKEN")).toBe(
      "ghp_super_secret_value_12345678",
    );

    const removed = await app.inject({
      method: "DELETE",
      url: `/admin/products/${product.id}/secrets/GITHUB_TOKEN?linearWorkspaceId=ws-secret`,
      headers: auth,
    });
    expect(removed.statusCode).toBe(204);
    const removedAgain = await app.inject({
      method: "DELETE",
      url: `/admin/products/${product.id}/secrets/GITHUB_TOKEN?linearWorkspaceId=ws-secret`,
      headers: auth,
    });
    expect(removedAgain.statusCode).toBe(404);
  });

  it("stores a runner credential and a repository read token by kind", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-kind", slug: "kind", name: "Kind", linearTeamKey: "KIND" },
    });
    const product = created.json<{ id: string }>();
    const query = `?linearWorkspaceId=ws-kind`;

    const runner = await app.inject({
      method: "PUT",
      url: `/admin/products/${product.id}/secrets/OPENCODE_API_KEY${query}`,
      headers: auth,
      payload: { value: "zen-value-0123456789", kind: "runner_credential" },
    });
    expect(runner.statusCode).toBe(204);

    const read = await app.inject({
      method: "PUT",
      url: `/admin/products/${product.id}/secrets/GITHUB_READ_TOKEN${query}`,
      headers: auth,
      payload: { value: "read-value-0123456789", kind: "repository_read" },
    });
    expect(read.statusCode).toBe(204);

    const secrets = new PrismaSecretStore(prisma, TEST_MASTER_KEY);
    const stored = await prisma.productSecret.findFirstOrThrow({
      where: { productId: product.id, name: "OPENCODE_API_KEY" },
    });
    const descriptors = await secrets.list(stored.tenantId, product.id);
    expect(descriptors).toEqual(
      expect.arrayContaining([
        { name: "OPENCODE_API_KEY", injectIntoImplementer: false, kind: "runner_credential" },
        { name: "GITHUB_READ_TOKEN", injectIntoImplementer: false, kind: "repository_read" },
      ]),
    );
  });

  it("refuses a credential that carries the injection mark, and one that holds a GitHub token", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers: auth,
      payload: { linearWorkspaceId: "ws-refuse", slug: "refuse", name: "Refuse", linearTeamKey: "REFU" },
    });
    const product = created.json<{ id: string }>();
    const query = `?linearWorkspaceId=ws-refuse`;

    const marked = await app.inject({
      method: "PUT",
      url: `/admin/products/${product.id}/secrets/OPENCODE_API_KEY${query}`,
      headers: auth,
      payload: { value: "zen-value", kind: "runner_credential", injectIntoImplementer: true },
    });
    expect(marked.statusCode).toBe(400);
    expect(marked.body).toContain("injection mark");

    const misfiled = await app.inject({
      method: "PUT",
      url: `/admin/products/${product.id}/secrets/MODEL_KEY${query}`,
      headers: auth,
      payload: { value: `ghp_${"a".repeat(36)}`, kind: "runner_credential" },
    });
    expect(misfiled.statusCode).toBe(400);
    expect(misfiled.body).toContain("GitHub or a Linear credential");
    // The message must name the secret and never its value. SDD section 60.
    expect(misfiled.body).not.toContain("a".repeat(36));

    await expect(
      prisma.productSecret.findFirst({ where: { productId: product.id } }),
    ).resolves.toBeNull();
  });
});

describe("the GitHub installation binding endpoint", () => {
  it("binds an installation to a tenant, keyed by the numeric installation id", async () => {
    await tenants.ensureTenant("ws-github-bind", "GitHub Bind");

    const bound = await app.inject({
      method: "PUT",
      url: "/admin/github-installations",
      headers: auth,
      payload: { linearWorkspaceId: "ws-github-bind", githubInstallationId: "9001", accountLogin: "acme" },
    });
    expect(bound.statusCode).toBe(200);

    const row = await prisma.gitHubInstallation.findUniqueOrThrow({ where: { githubInstallationId: "9001" } });
    expect(row.accountLogin).toBe("acme");

    // A rename of the account never breaks the binding: the numeric id is the key.
    const rebound = await app.inject({
      method: "PUT",
      url: "/admin/github-installations",
      headers: auth,
      payload: { linearWorkspaceId: "ws-github-bind", githubInstallationId: "9001", accountLogin: "acme-renamed" },
    });
    expect(rebound.statusCode).toBe(200);
    const renamedRow = await prisma.gitHubInstallation.findUniqueOrThrow({
      where: { githubInstallationId: "9001" },
    });
    expect(renamedRow.accountLogin).toBe("acme-renamed");
  });

  it("refuses to move an installation that another tenant holds", async () => {
    await tenants.ensureTenant("ws-github-owner", "Owner");
    await tenants.ensureTenant("ws-github-thief", "Thief");
    const owned = await app.inject({
      method: "PUT",
      url: "/admin/github-installations",
      headers: auth,
      payload: { linearWorkspaceId: "ws-github-owner", githubInstallationId: "9010", accountLogin: "acme" },
    });
    expect(owned.statusCode).toBe(200);

    const moved = await app.inject({
      method: "PUT",
      url: "/admin/github-installations",
      headers: auth,
      payload: { linearWorkspaceId: "ws-github-thief", githubInstallationId: "9010", accountLogin: "acme" },
    });
    expect(moved.statusCode).toBe(409);
    const row = await prisma.gitHubInstallation.findUniqueOrThrow({ where: { githubInstallationId: "9010" } });
    const owner = await tenants.findByWorkspace("ws-github-owner");
    expect(row.tenantId).toBe(owner?.id);
  });

  it("refuses a workspace the caller is no member of, before any tenant lookup", async () => {
    // docs/specs/release-0-1-0.md. A key acts only in the workspaces of the person who made it.
    const response = await app.inject({
      method: "PUT",
      url: "/admin/github-installations",
      headers: auth,
      payload: { linearWorkspaceId: "ws-no-such-tenant", githubInstallationId: "9002", accountLogin: "nobody" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects a request without the administration token", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/admin/github-installations",
      payload: { linearWorkspaceId: "ws-github-bind", githubInstallationId: "9003", accountLogin: "acme" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("the context source endpoints of SDD section 59", () => {
  const contextWorkspace = "ws-context";
  const otherContextWorkspace = "ws-context-other";
  let productId: string;
  let otherTenantProductId: string;

  beforeAll(async () => {
    // SDD section 5 and section 7 put context sources on the Product, alongside secrets,
    // autonomy, risk caps, action policy, and redaction.
    const tenant = await tenants.ensureTenant(contextWorkspace, "Context");
    const products = new PrismaProductRegistry(prisma);
    const product = await products.create({
      tenantId: tenant.id,
      slug: "ctx",
      name: "Context",
      linearTeamKey: "CTX",
      linearTeamId: "team-ctx",
    });
    productId = product.id;

    const otherTenant = await tenants.ensureTenant(otherContextWorkspace, "Context Other");
    const otherProduct = await products.create({
      tenantId: otherTenant.id,
      slug: "ctxo",
      name: "Context Other",
      linearTeamKey: "CTXO",
      linearTeamId: "team-ctxo",
    });
    otherTenantProductId = otherProduct.id;
  });

  it("refuses an endpoint that carries a credential", async () => {
    // SDD section 60. The userinfo of the endpoint would reach a log line and an error message.
    const refused = await app.inject({
      method: "POST",
      url: `/admin/products/${productId}/context-sources?linearWorkspaceId=${contextWorkspace}`,
      headers: auth,
      payload: {
        sourceId: "backstage-credential",
        kind: "backstage",
        endpoint: "https://operator:catalog-token@backstage.example.test",
        settings: {},
      },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain("user name or a password");
    expect(refused.body).not.toContain("catalog-token");
  });

  it("creates, lists, and deletes one source", async () => {
    // The secret exists with a real value, so the assertion below has something to find. This
    // seeds the row through the Product administration secret route, on the same Product the
    // context source below belongs to.
    const secretPut = await app.inject({
      method: "PUT",
      url: `/admin/products/${productId}/secrets/BACKSTAGE_TOKEN?linearWorkspaceId=${contextWorkspace}`,
      headers: auth,
      payload: { value: "bs_super_secret_value_87654321" },
    });
    expect(secretPut.statusCode).toBe(204);

    const created = await app.inject({
      method: "POST",
      url: `/admin/products/${productId}/context-sources?linearWorkspaceId=${contextWorkspace}`,
      headers: auth,
      payload: {
        sourceId: "backstage",
        kind: "backstage",
        endpoint: "https://backstage.example.test",
        secretName: "BACKSTAGE_TOKEN",
        settings: { maxEntities: 10 },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ sourceId: string }>().sourceId).toBe("backstage");
    // SDD section 60. The response names the secret and never carries its value.
    expect(created.body).toContain("BACKSTAGE_TOKEN");
    expect(created.body).not.toContain("bs_super_secret_value_87654321");

    const listed = await app.inject({
      method: "GET",
      url: `/admin/products/${productId}/context-sources?linearWorkspaceId=${contextWorkspace}`,
      headers: auth,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain("bs_super_secret_value_87654321");
    expect(listed.json<{ sourceId: string }[]>().map((row) => row.sourceId)).toEqual(["backstage"]);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/admin/products/${productId}/context-sources/backstage?linearWorkspaceId=${contextWorkspace}`,
      headers: auth,
    });
    expect(deleted.statusCode).toBe(204);

    const deletedAgain = await app.inject({
      method: "DELETE",
      url: `/admin/products/${productId}/context-sources/backstage?linearWorkspaceId=${contextWorkspace}`,
      headers: auth,
    });
    expect(deletedAgain.statusCode).toBe(404);
  });

  it("refuses an invalid setting with 400 and names the key", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/admin/products/${productId}/context-sources?linearWorkspaceId=${contextWorkspace}`,
      headers: auth,
      payload: {
        sourceId: "docs",
        kind: "mcp",
        endpoint: "https://docs.example.test",
        settings: { discoverTool: "search", fetchTool: "read", catalogWide: true },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toMatch(/catalogWide/);
  });

  it("refuses a reserved source identifier with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/admin/products/${productId}/context-sources?linearWorkspaceId=${contextWorkspace}`,
      headers: auth,
      payload: {
        sourceId: "linear",
        kind: "mcp",
        endpoint: "https://docs.example.test",
        settings: { discoverTool: "search", fetchTool: "read" },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toMatch(/reserved/);
  });

  it("refuses a request without the administration token", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/admin/products/${productId}/context-sources?linearWorkspaceId=${contextWorkspace}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 404 for a product of another tenant", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/admin/products/${otherTenantProductId}/context-sources?linearWorkspaceId=${contextWorkspace}`,
      headers: auth,
    });
    expect(response.statusCode).toBe(404);
  });
});

// Issue 6. The product page shows the models and the efforts of the newest sessions.
describe("the agent sessions of a product", () => {
  let productId: string;
  let otherProductId: string;

  const runOf = async (tenantId: string, product: string, key: string) =>
    prisma.run.create({
      data: {
        tenantId,
        productId: product,
        linearAgentSessionId: `session-${key}`,
        temporalWorkflowId: `workflow-${key}`,
        status: "RECEIVED",
        autonomyLevel: "L2",
      },
    });

  const sessionOf = (tenantId: string, runId: string, role: "implementer" | "reviewer", model: string | null) =>
    new PrismaAgentSessionStore(prisma).record({
      tenantId,
      runId,
      role,
      attempt: 1,
      runner: "opencode",
      cliSessionId: null,
      model,
      effort: null,
      usage: null,
      durationMs: 1_000,
      outcome: "finished",
      idempotencyKey: `run:${runId}:${role}:1`,
    });

  beforeAll(async () => {
    const products = new PrismaProductRegistry(prisma);
    const tenant = await tenants.ensureTenant("ws-sessions", "Sessions");
    const product = await products.create({ tenantId: tenant.id, slug: "ses-a", name: "A", linearTeamKey: "SEA", linearTeamId: "team-sea" });
    const sibling = await products.create({ tenantId: tenant.id, slug: "ses-b", name: "B", linearTeamKey: "SEB", linearTeamId: "team-seb" });
    const other = await tenants.ensureTenant("ws-sessions-other", "Sessions other");
    const otherProduct = await products.create({ tenantId: other.id, slug: "ses-o", name: "O", linearTeamKey: "SEO", linearTeamId: "team-seo" });
    productId = product.id;
    otherProductId = otherProduct.id;
    const run = await runOf(tenant.id, product.id, "ses-a");
    await sessionOf(tenant.id, run.id, "implementer", "opencode/big-pickle");
    await sessionOf(tenant.id, run.id, "reviewer", null);
    const siblingRun = await runOf(tenant.id, sibling.id, "ses-b");
    await sessionOf(tenant.id, siblingRun.id, "implementer", "deepseek/deepseek-chat");
    const otherRun = await runOf(other.id, otherProduct.id, "ses-o");
    await sessionOf(other.id, otherRun.id, "implementer", "anthropic/claude");
  });

  it("returns the sessions of the product only, newest first, with the model each one ran", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/admin/products/${productId}/agent-sessions?linearWorkspaceId=ws-sessions`,
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Array<{ role: string; model: string | null }>>();
    expect(body.map((session) => [session.role, session.model])).toEqual([
      ["reviewer", null],
      ["implementer", "opencode/big-pickle"],
    ]);
  });

  it("answers 404 for a product of another tenant and 401 without a credential", async () => {
    const stolen = await app.inject({
      method: "GET",
      url: `/admin/products/${otherProductId}/agent-sessions?linearWorkspaceId=ws-sessions`,
      headers: auth,
    });
    expect(stolen.statusCode).toBe(404);
    const anonymous = await app.inject({
      method: "GET",
      url: `/admin/products/${productId}/agent-sessions?linearWorkspaceId=ws-sessions`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("refuses a limit outside 1 to 50", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/admin/products/${productId}/agent-sessions?linearWorkspaceId=ws-sessions&limit=500`,
      headers: auth,
    });
    expect(response.statusCode).toBe(400);
  });
});

// Issue 8. The test of a context source before it is saved, and the last read of a saved one.
describe("the context source test and the last read", () => {
  const workspace = "ws-context";
  const CREDENTIAL = "mcp_probe_credential_5551234";
  let productId: string;
  let otherTenantProductId: string;
  let mcp: Server;
  let mcpUrl: string;

  beforeAll(async () => {
    const products = new PrismaProductRegistry(prisma);
    const tenant = await tenants.ensureTenant(workspace, "Context");
    productId = (await products.create({ tenantId: tenant.id, slug: "ctx-test", name: "Ctx test", linearTeamKey: "CTT", linearTeamId: "team-ctt" })).id;
    const other = await tenants.ensureTenant("ws-context-other", "Context Other");
    otherTenantProductId = (await products.create({ tenantId: other.id, slug: "ctx-test-o", name: "O", linearTeamKey: "CTTO", linearTeamId: "team-ctto" })).id;

    // A hostile MCP server: its discover tool echoes the Authorization header in an item title,
    // and its broken tool echoes it in an error message.
    mcp = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      request.on("end", () => {
        const message = JSON.parse(raw) as { id?: number; method: string; params?: { name?: string } };
        const authorization = request.headers.authorization ?? "none";
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const reply = (body: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(body as object) }));
        };
        if (message.method === "initialize") return reply({ result: { protocolVersion: "2025-06-18", capabilities: {} } });
        if (message.params?.name === "broken") return reply({ error: { code: -32000, message: `denied for ${authorization}` } });
        const items = [{ ref: "doc-1", sourceVersion: "v1", title: `seen ${authorization}`, reason: "matches" }];
        return reply({ result: { content: [{ type: "text", text: JSON.stringify({ items }) }] } });
      });
    });
    await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
    mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
    await new Promise((resolve) => mcp.close(resolve));
  });

  const probe = (payload: Record<string, unknown>, target = productId) =>
    app.inject({
      method: "POST",
      url: `/admin/products/${target}/context-sources/test?linearWorkspaceId=${workspace}`,
      headers: auth,
      payload,
    });

  it("calls the discover tool and never returns the credential, typed or stored", async () => {
    const typed = await probe({
      sourceId: "docs",
      kind: "mcp",
      endpoint: mcpUrl,
      credential: CREDENTIAL,
      settings: { discoverTool: "search", fetchTool: "read" },
    });
    expect(typed.statusCode).toBe(200);
    expect(typed.json<{ ok: boolean; itemCount: number }>()).toMatchObject({ ok: true, itemCount: 1 });
    expect(typed.body).not.toContain(CREDENTIAL);

    const stored = await app.inject({
      method: "PUT",
      url: `/admin/products/${productId}/secrets/DOCS_MCP_TOKEN?linearWorkspaceId=${workspace}`,
      headers: auth,
      payload: { value: CREDENTIAL },
    });
    expect(stored.statusCode).toBe(204);
    const failed = await probe({
      sourceId: "docs",
      kind: "mcp",
      endpoint: mcpUrl,
      secretName: "DOCS_MCP_TOKEN",
      settings: { discoverTool: "broken", fetchTool: "read" },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json<{ ok: boolean; message: string }>()).toMatchObject({ ok: false });
    expect(failed.json<{ message: string }>().message).toContain("denied for Bearer");
    expect(failed.body).not.toContain(CREDENTIAL);
  });

  it("refuses what a save refuses, a missing secret, another tenant, and a caller with no credential", async () => {
    const badSettings = await probe({ sourceId: "docs", kind: "mcp", endpoint: mcpUrl, settings: { discoverTool: "search" } });
    expect(badSettings.statusCode).toBe(400);
    const userinfo = await probe({
      sourceId: "docs",
      kind: "mcp",
      endpoint: "https://user:pass@docs.example.test",
      settings: { discoverTool: "search", fetchTool: "read" },
    });
    expect(userinfo.statusCode).toBe(400);
    expect(userinfo.body).not.toContain("pass@");
    const missing = await probe({
      sourceId: "docs",
      kind: "mcp",
      endpoint: mcpUrl,
      secretName: "NO_SUCH_SECRET",
      settings: { discoverTool: "search", fetchTool: "read" },
    });
    expect(missing.statusCode).toBe(400);
    const foreign = await probe(
      { sourceId: "docs", kind: "mcp", endpoint: mcpUrl, settings: { discoverTool: "search", fetchTool: "read" } },
      otherTenantProductId,
    );
    expect(foreign.statusCode).toBe(404);
    const anonymous = await app.inject({
      method: "POST",
      url: `/admin/products/${productId}/context-sources/test?linearWorkspaceId=${workspace}`,
      payload: { sourceId: "docs", kind: "mcp", endpoint: mcpUrl, settings: { discoverTool: "search", fetchTool: "read" } },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("lists the time of the newest context contract that holds an item from the source", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/admin/products/${productId}/context-sources?linearWorkspaceId=${workspace}`,
      headers: auth,
      payload: { sourceId: "docs", kind: "mcp", endpoint: mcpUrl, settings: { discoverTool: "search", fetchTool: "read" } },
    });
    expect(created.statusCode).toBe(201);
    const listedBefore = await app.inject({
      method: "GET",
      url: `/admin/products/${productId}/context-sources?linearWorkspaceId=${workspace}`,
      headers: auth,
    });
    expect(listedBefore.json<Array<{ lastReadAt: string | null }>>()[0]?.lastReadAt).toBeNull();

    const tenant = await tenants.findByWorkspace(workspace);
    const run = await prisma.run.create({
      data: {
        tenantId: tenant!.id,
        productId,
        linearAgentSessionId: "session-ctx-read",
        temporalWorkflowId: "workflow-ctx-read",
        status: "RECEIVED",
        autonomyLevel: "L2",
      },
    });
    const readAt = new Date("2026-10-30T12:00:00.000Z");
    await prisma.contextContract.create({
      data: {
        tenantId: tenant!.id,
        runId: run.id,
        version: 1,
        sha256: "f".repeat(64),
        document: "{}",
        items: {
          create: [
            {
              tenantId: tenant!.id,
              sourceId: "docs",
              ref: "docs:doc-1",
              sourceVersion: "v1",
              authority: "prose_documentation",
              reason: "matches",
              classification: "reference",
              createdAt: readAt,
            },
          ],
        },
      },
    });

    const listed = await app.inject({
      method: "GET",
      url: `/admin/products/${productId}/context-sources?linearWorkspaceId=${workspace}`,
      headers: auth,
    });
    expect(listed.json<Array<{ sourceId: string; lastReadAt: string | null }>>()).toEqual([
      expect.objectContaining({ sourceId: "docs", lastReadAt: readAt.toISOString() }),
    ]);
  });

  // docs/specs/run-visibility.md. The Temporal UI is for a Linear workspace admin, and the path
  // tells nobody else that it exists.
  it("proxies /temporal for a workspace admin and answers 404 to everyone else", async () => {
    const upstream = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`temporal ui ${request.method ?? ""} ${request.url ?? ""}`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const proxied = buildServer({
      ...serverOptions,
      temporalUiUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    });
    try {
      await proxied.ready();
      const member = await seedAdminKey(prisma, testAuth(prisma, createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined })).auth, {
        workspaces: ["ws-temporal-member"],
        admin: false,
      });

      const asAdmin = await proxied.inject({ method: "GET", url: "/temporal/namespaces/default/workflows", headers: auth });
      expect(asAdmin.statusCode).toBe(200);
      expect(asAdmin.body).toBe("temporal ui GET /temporal/namespaces/default/workflows");
      expect(asAdmin.headers["content-security-policy"]).toBeUndefined();

      const asMember = await proxied.inject({
        method: "GET",
        url: "/temporal/namespaces/default/workflows",
        headers: { authorization: `Bearer ${member.key}` },
      });
      expect(asMember.statusCode).toBe(404);
      expect((await proxied.inject({ method: "GET", url: "/temporal" })).statusCode).toBe(404);
      expect((await proxied.inject({ method: "POST", url: "/temporal/api/v1/namespaces", headers: auth })).statusCode).toBe(404);

      // An install with no Temporal UI answers 404 to an admin too.
      expect((await app.inject({ method: "GET", url: "/temporal", headers: auth })).statusCode).toBe(404);
    } finally {
      await proxied.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
