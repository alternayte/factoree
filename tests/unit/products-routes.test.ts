import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { registerProductRoutes } from "~/http/admin/products.routes.js";
import type {
  CopyProductInput,
  CreateProductInput,
  ProductRecord, ProductRegistry, ProductSettingsUpdate } from "~/domain/products/product-registry.js";
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
      defaultRunner: "opencode",
      model: null,
      runners: { implementer: null, refiner: null, validator: null, reviewer: null, setup: null },
      models: { implementer: null, refiner: null, validator: null, reviewer: null, setup: null },
      effort: { implementer: null, refiner: null, validator: null, reviewer: null, setup: null },
      silenceMinutes: 10,
      refinerCriteriaLimit: 20,
      repairMaxAttempts: 2,
      sandboxRetentionHours: 24,
      sandboxProviderIds: [],
      maxConcurrentRuns: 2, appChangeIssues: "one_per_change", reviewAppDenyList: [], automaticFollowUpLimit: 3, productGoal: null, keepTranscripts: false, retroRetentionDays: 30, webResearch: false,
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

  findByLinearTeamId(tenantId: string, linearTeamId: string): Promise<ProductRecord | null> {
    const row = [...this.rows.values()].find((p) => p.tenantId === tenantId && p.linearTeamId === linearTeamId);
    return Promise.resolve(row ?? null);
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
    const set = <T extends object>(update: T | undefined) =>
      Object.fromEntries(Object.entries(update ?? {}).filter(([, value]) => value !== undefined));
    const updated: ProductRecord = {
      ...row,
      ...(settings.defaultRunner === undefined ? {} : { defaultRunner: settings.defaultRunner }),
      ...(settings.model === undefined ? {} : { model: settings.model }),
      runners: { ...row.runners, ...set(settings.runners) },
      models: { ...row.models, ...set(settings.models) },
      effort: { ...row.effort, ...set(settings.effort) },
      ...(settings.silenceMinutes === undefined ? {} : { silenceMinutes: settings.silenceMinutes }),
      ...(settings.refinerCriteriaLimit === undefined ? {} : { refinerCriteriaLimit: settings.refinerCriteriaLimit }),
      ...(settings.repairMaxAttempts === undefined ? {} : { repairMaxAttempts: settings.repairMaxAttempts }),
      ...(settings.sandboxRetentionHours === undefined ? {} : { sandboxRetentionHours: settings.sandboxRetentionHours }),
      ...(settings.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: settings.maxConcurrentRuns }),
      ...(settings.sandboxProviderIds === undefined ? {} : { sandboxProviderIds: settings.sandboxProviderIds }),
      ...(settings.reviewAppDenyList === undefined ? {} : { reviewAppDenyList: settings.reviewAppDenyList }),
      ...(settings.automaticFollowUpLimit === undefined ? {} : { automaticFollowUpLimit: settings.automaticFollowUpLimit }),
    };
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }

  copy(tenantId: string, sourceId: string, input: CopyProductInput): Promise<ProductRecord | null> {
    const source = this.rows.get(sourceId);
    if (!source || source.tenantId !== tenantId) return Promise.resolve(null);
    this.counter += 1;
    const record: ProductRecord = { ...source, ...input, id: `p${this.counter}`, status: "pending" };
    this.rows.set(record.id, record);
    return Promise.resolve(record);
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
      membership: "accepted",
      membershipDecidedBy: null,
      membershipDecidedAt: null,
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

  decideMembership(input: { tenantId: string; productId: string; repositoryId: string; membership: "accepted" | "rejected"; decidedBy: string | null; at: Date }): Promise<RepositoryRecord | null> {
    const row = this.rows.find((r) => r.id === input.repositoryId && r.tenantId === input.tenantId && r.productId === input.productId);
    if (row === undefined) return Promise.resolve(null);
    row.membership = input.membership;
    row.membershipDecidedBy = input.decidedBy;
    row.membershipDecidedAt = input.at;
    return Promise.resolve(row);
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

  // docs/specs/product-copy.md. The copy is pending on a free team, and a taken team creates nothing.
  it("copies a product to a free Linear team and refuses a team another product holds", async () => {
    const { app, products } = build({});
    const create = (slug: string, linearTeamKey: string) =>
      app.inject({ method: "POST", url: "/admin/products", payload: { linearWorkspaceId: "ws-1", slug, name: slug, linearTeamKey } });
    const source = (await create("source", "SRC")).json<ProductRecord>();
    await create("other", "OTH");
    await app.inject({
      method: "POST",
      url: `/admin/products/${source.id}/activate?linearWorkspaceId=ws-1`,
      payload: { defaultAutonomy: "L3" },
    });
    const copy = (linearTeamKey: string, slug: string) =>
      app.inject({
        method: "POST",
        url: `/admin/products/${source.id}/copy?linearWorkspaceId=ws-1`,
        payload: { slug, name: "Copy", linearTeamKey },
      });

    const taken = await copy("OTH", "copy");
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ error: 'Linear team "OTH" is already claimed by Product "other".' });
    expect(products.rows.size).toBe(2);

    const created = await copy("CPY", "copy");
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ slug: "copy", status: "pending", linearTeamId: "team-cpy", defaultAutonomy: "L3" });
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

  // docs/specs/pr-review-merge-and-deploy.md. L4 is a level an operator sets, and a cap may name it.
  it("accepts L4 as the default and as a risk cap", async () => {
    const { app, products } = build({});
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      payload: { linearWorkspaceId: "ws-1", slug: "merge", name: "Merge", linearTeamKey: "MRG" },
    });
    const product = created.json<{ id: string }>();

    const accepted = await app.inject({
      method: "PUT",
      url: `/admin/products/${product.id}?linearWorkspaceId=ws-1`,
      payload: { defaultAutonomy: "L4", riskCaps: { payments: "L2", docs: "L4" } },
    });

    expect(accepted.statusCode).toBe(200);
    expect(products.rows.get(product.id)?.defaultAutonomy).toBe("L4");
    expect(products.rows.get(product.id)?.riskCaps).toEqual({ payments: "L2", docs: "L4" });
  });

  // docs/specs/pr-feedback-loop.md, DI-21.203. The deny list holds GitHub App slugs, and the limit its bounds.
  it("stores the review app deny list in lower case once each, and refuses a slug or a limit GitHub cannot hold", async () => {
    const { app } = build({});
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      payload: { linearWorkspaceId: "ws-1", slug: "review", name: "Review", linearTeamKey: "REV" },
    });
    const product = created.json<{ id: string }>();
    const put = (payload: Record<string, unknown>) =>
      app.inject({ method: "PUT", url: `/admin/products/${product.id}?linearWorkspaceId=ws-1`, payload });

    const set = await put({ reviewAppDenyList: [" Noisy-Bot ", "coderabbitai", "noisy-bot"], automaticFollowUpLimit: 5 });
    expect(set.statusCode).toBe(200);
    expect(set.json<{ reviewAppDenyList: string[]; automaticFollowUpLimit: number }>()).toMatchObject({
      reviewAppDenyList: ["coderabbitai", "noisy-bot"],
      automaticFollowUpLimit: 5,
    });

    expect((await put({ reviewAppDenyList: ["noisy bot"] })).statusCode).toBe(422);
    expect((await put({ automaticFollowUpLimit: 0 })).statusCode).toBe(422);
    expect((await put({ automaticFollowUpLimit: 21 })).statusCode).toBe(422);

    const cleared = await put({ reviewAppDenyList: [] });
    expect(cleared.json<{ reviewAppDenyList: string[] }>().reviewAppDenyList).toEqual([]);
  });

  // docs/specs/claude-code-runner.md. A model or an effort of one runner means nothing to the other.
  it("refuses a model and an effort that do not fit the runner a role resolves to, and changes nothing", async () => {
    const { app, products } = build({});
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      payload: { linearWorkspaceId: "ws-1", slug: "mix", name: "Mix", linearTeamKey: "MIX" },
    });
    const product = created.json<{ id: string }>();
    const url = `/admin/products/${product.id}?linearWorkspaceId=ws-1`;

    const refused = await app.inject({
      method: "PUT",
      url,
      payload: { runners: { implementer: "claude" }, models: { implementer: "deepseek/deepseek-chat" }, effort: { implementer: "ultra" } },
    });
    expect(refused.statusCode).toBe(422);
    expect(Object.keys(refused.json<{ error: { fieldErrors: Record<string, string[]> } }>().error.fieldErrors).sort()).toEqual([
      "effort.implementer",
      "models.implementer",
    ]);
    expect(products.rows.get(product.id)?.runners.implementer).toBeNull();

    // A claude override takes no opencode default model, so it saves with the CLI default.
    await app.inject({ method: "PUT", url, payload: { model: "deepseek/deepseek-chat" } });
    const saved = await app.inject({ method: "PUT", url, payload: { runners: { implementer: "claude" }, effort: { implementer: "high" } } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ runners: { implementer: string } }>().runners.implementer).toBe("claude");
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
