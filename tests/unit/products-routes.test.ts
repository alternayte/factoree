import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { registerProductRoutes } from "~/http/admin/products.routes.js";
import type { CreateProductInput, ProductRecord, ProductRegistry, ProductSettingsUpdate } from "~/domain/products/product-registry.js";
import type {
  RepositoryRecord,
  RepositoryRegistry,
  UpsertRepositoryInput,
} from "~/domain/products/repository-registry.js";
import type { TenantRecord, TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { LinearTeamLookup } from "~/adapters/linear/team-lookup.js";
import type { ProjectSecretDescriptor, PutSecretOptions, SecretStore } from "~/domain/products/secret-store.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";

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
  putGitHubInstallation(): Promise<"bound"> {
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
      riskCaps: null,
      allowedDomains: [],
      maxRunMinutes: input.maxRunMinutes ?? 90,
      organizationSkillsRepository: input.organizationSkillsRepository ?? null,
      skillRegistry: null,
      model: null,
      effort: { implementer: null, refiner: null, validator: null, reviewer: null, setup: null },
      silenceMinutes: 10,
      sandboxRetentionHours: 24,
      maxConcurrentRuns: 2, appChangeIssues: "one_per_change",
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

  updateSkillRegistry(tenantId: string, id: string, skillRegistry: ProductRecord["skillRegistry"]): Promise<ProductRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return Promise.resolve(null);
    const updated = { ...row, skillRegistry };
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }

  update(
    tenantId: string,
    id: string,
    fields: { name?: string; maxRunMinutes?: number },
  ): Promise<ProductRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return Promise.resolve(null);
    const updated = {
      ...row,
      ...(fields.name === undefined ? {} : { name: fields.name }),
      ...(fields.maxRunMinutes === undefined ? {} : { maxRunMinutes: fields.maxRunMinutes }),
    };
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }

  readonly policyChanges: Array<{ field: string; newValue: unknown }> = [];

  updatePolicy(
    tenantId: string,
    id: string,
    policy: { defaultAutonomy?: string; riskCaps?: Record<string, string> },
  ): Promise<ProductRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return Promise.resolve(null);
    if (policy.defaultAutonomy !== undefined && policy.defaultAutonomy !== row.defaultAutonomy) {
      this.policyChanges.push({ field: "defaultAutonomy", newValue: policy.defaultAutonomy });
    }
    if (policy.riskCaps !== undefined) this.policyChanges.push({ field: "riskCaps", newValue: policy.riskCaps });
    const updated = {
      ...row,
      ...(policy.defaultAutonomy === undefined ? {} : { defaultAutonomy: policy.defaultAutonomy }),
      ...(policy.riskCaps === undefined ? {} : { riskCaps: policy.riskCaps }),
    };
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }

  updateSettings(tenantId: string, id: string, settings: ProductSettingsUpdate): Promise<ProductRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return Promise.resolve(null);
    const effort = Object.fromEntries(Object.entries(settings.effort ?? {}).filter(([, value]) => value !== undefined));
    const updated: ProductRecord = {
      ...row,
      ...(settings.model === undefined ? {} : { model: settings.model }),
      effort: { ...row.effort, ...effort },
      ...(settings.silenceMinutes === undefined ? {} : { silenceMinutes: settings.silenceMinutes }),
      ...(settings.sandboxRetentionHours === undefined ? {} : { sandboxRetentionHours: settings.sandboxRetentionHours }),
      ...(settings.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: settings.maxConcurrentRuns }),
    };
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }

  remove(tenantId: string, id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return Promise.resolve(false);
    this.rows.delete(id);
    return Promise.resolve(true);
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
      linearProjects: input.linearProjects,
      requestedSecretNames: input.requestedSecretNames,
      discoveredAt: new Date(),
      lastSeenAt: new Date(),
      absentSince: null,
      githubInstallationId: input.githubInstallationId,
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

/** F6. Reports a Run count per Product, so a test can assert the delete route's refusal. */
class FakeRunRepository {
  readonly runCountByProduct = new Map<string, number>();
  countByProduct(_tenantId: string, productId: string): Promise<number> {
    return Promise.resolve(this.runCountByProduct.get(productId) ?? 0);
  }
}

const build = (
  options: {
    teamKeyResolves?: boolean;
    checkSkillRegistry?: (settings: { set: string | null }, key: string) => Promise<{ skills: number }>;
  } = {},
) => {
  const products = new FakeProductRegistry();
  const repositories = new FakeRepositoryRegistry();
  const secrets = new FakeSecretStore();
  const tenants = new FakeTenantRegistry();
  const linearTeams = new FakeLinearTeamLookup(options.teamKeyResolves ?? true);
  const runs = new FakeRunRepository();

  const app: FastifyInstance = Fastify({ logger: false });
  registerProductRoutes(app, {
    products,
    repositories,
    tenants,
    secrets,
    linearTeams,
    runs: runs as unknown as RunRepository,
    ...(options.checkSkillRegistry === undefined ? {} : { checkSkillRegistry: options.checkSkillRegistry }),
  });

  return { app, products, repositories, secrets, runs };
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
      riskCaps: null,
      allowedDomains: [],
    });
  });

  it("raises the default level and sets risk caps, and records each change (autonomy-levels.md)", async () => {
    const { app, products } = build({});
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      payload: { linearWorkspaceId: "ws-1", slug: "caps", name: "Caps", linearTeamKey: "CAP" },
    });
    const product = created.json<{ id: string }>();

    const raised = await app.inject({
      method: "PUT",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-1`,
      payload: { defaultAutonomy: "L3", riskCaps: { Payments: "L2", "database-migration": "L3" } },
    });

    expect(raised.statusCode).toBe(200);
    expect(raised.json<{ defaultAutonomy: string; riskCaps: Record<string, string> }>()).toMatchObject({
      defaultAutonomy: "L3",
      riskCaps: { payments: "L2", "database-migration": "L3" },
    });
    expect(products.policyChanges.map((change) => change.field)).toEqual(["defaultAutonomy", "riskCaps"]);
  });

  it("refuses L4 with 422 and changes nothing, because Version 1 never merges", async () => {
    const { app, products } = build({});
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      payload: { linearWorkspaceId: "ws-1", slug: "merge", name: "Merge", linearTeamKey: "MRG" },
    });
    const product = created.json<{ id: string }>();
    const before = products.rows.get(product.id)?.defaultAutonomy;

    const refused = await app.inject({
      method: "PUT",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-1`,
      payload: { defaultAutonomy: "L4" },
    });

    expect(refused.statusCode).toBe(422);
    expect(products.policyChanges).toEqual([]);
    expect(products.rows.get(product.id)?.defaultAutonomy).toBe(before);
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
      linearProjects: [],
      githubInstallationId: "install-1",
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

  it("F6: refuses to delete a Product that owns at least one Run, and deletes nothing", async () => {
    const { app, products, runs } = build({});
    const product = await products.create({
      tenantId: TENANT.id,
      slug: "owns-runs",
      name: "Owns runs",
      linearTeamKey: "OWN",
      linearTeamId: "team-own",
    });
    runs.runCountByProduct.set(product.id, 3);

    const response = await app.inject({
      method: "DELETE",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-1`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("3 Runs");

    const stillThere = await app.inject({
      method: "GET",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-1`,
    });
    expect(stillThere.statusCode).toBe(200);
  });

  it("F6: deletes a Product that owns no Runs", async () => {
    const { app, products, runs } = build({});
    const product = await products.create({
      tenantId: TENANT.id,
      slug: "no-runs",
      name: "No runs",
      linearTeamKey: "NOR",
      linearTeamId: "team-nor",
    });
    runs.runCountByProduct.set(product.id, 0);

    const response = await app.inject({
      method: "DELETE",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-1`,
    });
    expect(response.statusCode).toBe(204);

    const gone = await app.inject({
      method: "GET",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-1`,
    });
    expect(gone.statusCode).toBe(404);
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

  // docs/specs/skill-registry.md. A wrong registry fails at save time, not in a run.
  describe("the skill registry setting", () => {
    const createProduct = async (app: FastifyInstance): Promise<string> => {
      const created = await app.inject({
        method: "POST",
        url: "/admin/products",
        payload: { linearWorkspaceId: "ws-1", slug: "shop", name: "Shop", linearTeamKey: "SHP" },
      });
      return created.json<{ id: string }>().id;
    };
    const save = (app: FastifyInstance, id: string, set: string | null) =>
      app.inject({
        method: "PUT",
        url: `/admin/products/${id}?linearWorkspaceId=ws-1`,
        payload: { skillRegistry: { kind: "skael", url: "https://skael.test", set } },
      });

    it("refuses a set that does not resolve and keeps the old setting", async () => {
      const { app, secrets, products } = build({
        checkSkillRegistry: (settings) =>
          settings.set === "go-tools" ? Promise.resolve({ skills: 3 }) : Promise.reject(new Error("Skael answered 404")),
      });
      const id = await createProduct(app);
      await secrets.put("tenant-1", id, "SKILL_REGISTRY_KEY", "sk-1");
      expect((await save(app, id, "go-tools")).statusCode).toBe(200);

      const refused = await save(app, id, "missing");

      expect(refused.statusCode).toBe(422);
      expect(refused.json<{ error: string }>().error).toContain("404");
      expect((await products.findById("tenant-1", id))?.skillRegistry).toEqual({
        kind: "skael",
        url: "https://skael.test",
        set: "go-tools",
      });
    });

    it("warns when every released skill is more than a run lists", async () => {
      const { app, secrets } = build({ checkSkillRegistry: () => Promise.resolve({ skills: 70 }) });
      const id = await createProduct(app);
      await secrets.put("tenant-1", id, "SKILL_REGISTRY_KEY", "sk-1");

      const saved = await save(app, id, null);

      expect(saved.statusCode).toBe(200);
      expect(saved.json<{ skillRegistryWarning: string }>().skillRegistryWarning).toContain("70 released skills");
    });

    it("refuses the registry key with the injection mark", async () => {
      const { app } = build();
      const id = await createProduct(app);
      const response = await app.inject({
        method: "PUT",
        url: `/admin/products/${id}/secrets/SKILL_REGISTRY_KEY?linearWorkspaceId=ws-1`,
        payload: { value: "sk-1", kind: "test", injectIntoImplementer: true },
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
