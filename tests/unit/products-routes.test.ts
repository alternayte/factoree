import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { registerProductRoutes } from "~/http/admin/products.routes.js";
import type { CreateProductInput, ProductRecord, ProductRegistry } from "~/domain/products/product-registry.js";
import type {
  RepositoryRecord,
  RepositoryRegistry,
  UpsertRepositoryInput,
} from "~/domain/products/repository-registry.js";
import type { TenantRecord, TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { LinearTeamLookup } from "~/adapters/linear/team-lookup.js";
import type { ProjectSecretDescriptor, PutSecretOptions, SecretStore } from "~/domain/products/secret-store.js";

const TENANT: TenantRecord = { id: "tenant-1", linearWorkspaceId: "ws-1", name: "Acme" };

/** Keeps everything in memory, keyed by tenant, the way the real registry keys by tenant. */
class FakeTenantRegistry implements TenantRegistry {
  ensureTenant(): Promise<TenantRecord> {
    return Promise.resolve(TENANT);
  }
  findByWorkspace(linearWorkspaceId: string): Promise<TenantRecord | null> {
    return Promise.resolve(linearWorkspaceId === TENANT.linearWorkspaceId ? TENANT : null);
  }
  putInstallation(): Promise<TenantRecord> {
    throw new Error("not used by this route");
  }
  getInstallationToken(): Promise<string | null> {
    throw new Error("not used by this route");
  }
  getInstallation(): Promise<null> {
    throw new Error("not used by this route");
  }
  findByGitHubInstallation(): Promise<TenantRecord | null> {
    throw new Error("not used by this route");
  }
  putGitHubInstallation(): Promise<void> {
    throw new Error("not used by this route");
  }
}

class FakeProductRegistry implements ProductRegistry {
  readonly rows = new Map<string, ProductRecord>();
  private counter = 0;

  create(input: CreateProductInput): Promise<ProductRecord> {
    this.counter += 1;
    const record: ProductRecord = {
      id: `p${this.counter}`,
      tenantId: input.tenantId,
      slug: input.slug,
      name: input.name,
      status: "pending",
      linearTeamKey: input.linearTeamKey,
      linearTeamId: input.linearTeamId,
      defaultAutonomy: "L2",
      maxRunMinutes: input.maxRunMinutes ?? 90,
      organizationSkillsRepository: input.organizationSkillsRepository ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.set(record.id, record);
    return Promise.resolve(record);
  }

  list(tenantId: string): Promise<ProductRecord[]> {
    return Promise.resolve([...this.rows.values()].filter((row) => row.tenantId === tenantId));
  }

  findById(tenantId: string, id: string): Promise<ProductRecord | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row && row.tenantId === tenantId ? row : null);
  }

  findBySlug(): Promise<ProductRecord | null> {
    throw new Error("not used by this route");
  }

  findByLinearTeamId(): Promise<ProductRecord | null> {
    throw new Error("not used by this route");
  }

  activate(tenantId: string, id: string, defaultAutonomy: string): Promise<ProductRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return Promise.resolve(null);
    const updated = { ...row, status: "active" as const, defaultAutonomy };
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }

  renameLinearTeamKey(): Promise<ProductRecord | null> {
    throw new Error("not used by this route");
  }

  updateOrganizationSkillsRepository(
    tenantId: string,
    id: string,
    organizationSkillsRepository: string | null,
  ): Promise<ProductRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return Promise.resolve(null);
    const updated = { ...row, organizationSkillsRepository };
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }
}

class FakeRepositoryRegistry implements RepositoryRegistry {
  readonly rows: RepositoryRecord[] = [];

  upsert(input: UpsertRepositoryInput): Promise<RepositoryRecord> {
    const record: RepositoryRecord = {
      id: `r${this.rows.length + 1}`,
      tenantId: input.tenantId,
      productId: input.productId,
      fullName: input.fullName,
      defaultBranch: input.defaultBranch,
      configSha: input.configSha,
      requestedSecretNames: input.requestedSecretNames,
      discoveredAt: new Date(),
      lastSeenAt: new Date(),
      absentSince: null,
    };
    this.rows.push(record);
    return Promise.resolve(record);
  }

  listByProduct(productId: string): Promise<RepositoryRecord[]> {
    return Promise.resolve(this.rows.filter((row) => row.productId === productId));
  }

  findByFullName(): Promise<RepositoryRecord | null> {
    throw new Error("not used by this route");
  }

  markAbsent(): Promise<void> {
    throw new Error("not used by this route");
  }
}

class FakeSecretStore implements SecretStore {
  readonly values = new Map<string, { value: string; options?: PutSecretOptions }>();

  put(tenantId: string, productId: string, name: string, value: string, options?: PutSecretOptions): Promise<void> {
    this.values.set(`${tenantId}:${productId}:${name}`, { value, ...(options ? { options } : {}) });
    return Promise.resolve();
  }

  get(tenantId: string, productId: string, name: string): Promise<string | null> {
    return Promise.resolve(this.values.get(`${tenantId}:${productId}:${name}`)?.value ?? null);
  }

  listNames(): Promise<string[]> {
    throw new Error("not used by this route");
  }

  list(): Promise<ProjectSecretDescriptor[]> {
    throw new Error("not used by this route");
  }

  remove(tenantId: string, productId: string, name: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(`${tenantId}:${productId}:${name}`));
  }
}

class FakeLinearTeamLookup implements LinearTeamLookup {
  constructor(private readonly resolves: boolean) {}
  resolveTeamKey(_tenantId: string, teamKey: string): Promise<{ id: string; key: string } | null> {
    if (!this.resolves) return Promise.resolve(null);
    return Promise.resolve({ id: `team-${teamKey.toLowerCase()}`, key: teamKey });
  }
  resolveTeamId(): Promise<{ id: string; key: string } | null> {
    throw new Error("not used by this route");
  }
}

const build = (options: { teamKeyResolves?: boolean } = {}) => {
  const products = new FakeProductRegistry();
  const repositories = new FakeRepositoryRegistry();
  const secrets = new FakeSecretStore();
  const tenants = new FakeTenantRegistry();
  const linearTeams = new FakeLinearTeamLookup(options.teamKeyResolves ?? true);

  const app: FastifyInstance = Fastify({ logger: false });
  registerProductRoutes(app, { products, repositories, tenants, secrets, linearTeams });

  return { app, products, repositories, secrets };
};

describe("Products administration API", () => {
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
    expect(response.json<{ error: string }>().error).toContain("NOPE");
  });

  it("exposes repositories read only", async () => {
    const { app } = build({});
    const response = await app.inject({ method: "POST", url: "/admin/products/p1/repositories", payload: {} });
    expect(response.statusCode).toBe(404);
  });

  it("exposes the organization skills repository on create and on update", async () => {
    const { app } = build({});
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      payload: {
        linearWorkspaceId: "ws-1",
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
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-1`,
      payload: { organizationSkillsRepository: "acme/other-skills" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ organizationSkillsRepository: string }>().organizationSkillsRepository).toBe(
      "acme/other-skills",
    );
  });

  it("activates a product with a default autonomy", async () => {
    const { app } = build({});
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      payload: { linearWorkspaceId: "ws-1", slug: "act", name: "Act", linearTeamKey: "ACT" },
    });
    const product = created.json<{ id: string }>();

    const activated = await app.inject({
      method: "POST",
      url: `/admin/products/${product.id}/activate?linearWorkspaceId=ws-1`,
      payload: { defaultAutonomy: "L3" },
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json<{ status: string; defaultAutonomy: string }>()).toMatchObject({
      status: "active",
      defaultAutonomy: "L3",
    });
  });

  it("lists repositories of a product, read only", async () => {
    const { app, products, repositories } = build({});
    const product = await products.create({
      tenantId: TENANT.id,
      slug: "repos",
      name: "Repos",
      linearTeamKey: "REP",
      linearTeamId: "team-rep",
    });
    await repositories.upsert({
      tenantId: TENANT.id,
      productId: product.id,
      fullName: "acme/repos",
      defaultBranch: "main",
      configSha: "sha1",
      requestedSecretNames: [],
    });

    const response = await app.inject({
      method: "GET",
      url: `/admin/products/${product.id}/repositories?linearWorkspaceId=ws-1`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ fullName: string }[]>().map((row) => row.fullName)).toEqual(["acme/repos"]);
  });

  it("writes and removes a Product secret", async () => {
    const { app, products, secrets } = build({});
    const product = await products.create({
      tenantId: TENANT.id,
      slug: "secrets",
      name: "Secrets",
      linearTeamKey: "SEC",
      linearTeamId: "team-sec",
    });

    const put = await app.inject({
      method: "PUT",
      url: `/admin/products/${product.id}/secrets/GITHUB_TOKEN?linearWorkspaceId=ws-1`,
      payload: { value: "ghp_super_secret_value_12345678" },
    });
    expect(put.statusCode).toBe(204);
    expect(await secrets.get(TENANT.id, product.id, "GITHUB_TOKEN")).toBe("ghp_super_secret_value_12345678");

    const removed = await app.inject({
      method: "DELETE",
      url: `/admin/products/${product.id}/secrets/GITHUB_TOKEN?linearWorkspaceId=ws-1`,
    });
    expect(removed.statusCode).toBe(204);

    const removedAgain = await app.inject({
      method: "DELETE",
      url: `/admin/products/${product.id}/secrets/GITHUB_TOKEN?linearWorkspaceId=ws-1`,
    });
    expect(removedAgain.statusCode).toBe(404);
  });

  it("refuses a runner credential that holds a GitHub token", async () => {
    const { app, products } = build({});
    const product = await products.create({
      tenantId: TENANT.id,
      slug: "refuse",
      name: "Refuse",
      linearTeamKey: "REF",
      linearTeamId: "team-ref",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/admin/products/${product.id}/secrets/MODEL_KEY?linearWorkspaceId=ws-1`,
      payload: { value: `ghp_${"a".repeat(36)}`, kind: "runner_credential" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("GitHub or a Linear credential");
    expect(response.body).not.toContain("a".repeat(36));
  });
});
