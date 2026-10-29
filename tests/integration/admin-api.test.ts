import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaWebhookLog } from "~/persistence/prisma/webhook-log.prisma.js";
import {
  PrismaProductRegistry,
  PrismaRepositoryRegistry,
  PrismaSecretStore,
  PrismaTenantRegistry,
} from "~/persistence/prisma/product-registry.prisma.js";
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { buildServer } from "~/http/server.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { Env } from "~/config/env.js";
import type { LinearTeamLookup } from "~/adapters/linear/team-lookup.js";
import { DiscoveryService } from "~/domain/products/discovery-service.js";
import type { RepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";

const token = "t".repeat(32);
const env = {
  DATABASE_URL: "",
  FACTOREE_SECRET_KEY: "c".repeat(64),
  ADMIN_API_TOKEN: token,
  LINEAR_WEBHOOK_SECRET: "webhook-secret",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: Buffer.from(
    "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  ).toString("base64"),
  GITHUB_WEBHOOK_SECRET: "github-webhook-secret",
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "factoree",
  PORT: 3000,
  LOG_LEVEL: "error",
  SANDBOX_ADAPTER: "local",
  SANDBOX_LOCAL_ROOT: "/tmp/factoree-sandboxes",
  GITHUB_BASE_URL: "https://github.com",
  GITHUB_API_BASE_URL: "https://api.github.com",
  FACTOREE_GIT_AUTHOR_NAME: "Factoree",
  FACTOREE_GIT_AUTHOR_EMAIL: "factoree@users.noreply.github.com",
  EVIDENCE_STORAGE: "filesystem",
  EVIDENCE_LOCAL_ROOT: "/tmp/factoree-evidence-test",
} satisfies Env;

let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let app: ReturnType<typeof buildServer>;
let tenants: PrismaTenantRegistry;

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
  tenants = new PrismaTenantRegistry(prisma, env.FACTOREE_SECRET_KEY);
  app = buildServer({
    env,
    logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
    prisma,
    tenants,
    products: new PrismaProductRegistry(prisma),
    repositories: new PrismaRepositoryRegistry(prisma),
    linearTeams: fakeLinearTeams(["NOPE"]),
    secrets: new PrismaSecretStore(prisma, env.FACTOREE_SECRET_KEY),
    runs: new PrismaRunRepository(prisma),
    delegation: new DelegationService({
      tenants,
      products: new PrismaProductRegistry(prisma),
      repositories: new PrismaRepositoryRegistry(prisma),
      webhookLog: new PrismaWebhookLog(prisma),
      starter: { start: vi.fn(() => Promise.resolve(undefined)), signalStop: vi.fn(() => Promise.resolve(true)), signalHumanInput: vi.fn(() => Promise.resolve(true)) },
      refusalNotifier: { postFailure: () => Promise.resolve(undefined) },
      logger: createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined }),
      repositoryBaseUrl: "https://github.com",
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
    verifyGitHubSignature: () => false,
    startInstallationSync: () => Promise.reject(new Error("unused")),
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
    const secrets = new PrismaSecretStore(prisma, env.FACTOREE_SECRET_KEY);
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

    const secrets = new PrismaSecretStore(prisma, env.FACTOREE_SECRET_KEY);
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

  it("answers 404 for a tenant that does not exist", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/admin/github-installations",
      headers: auth,
      payload: { linearWorkspaceId: "ws-no-such-tenant", githubInstallationId: "9002", accountLogin: "nobody" },
    });
    expect(response.statusCode).toBe(404);
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
