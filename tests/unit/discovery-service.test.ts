import { describe, expect, it } from "vitest";
import { DiscoveryService } from "~/domain/products/discovery-service.js";
import type { CreateProductInput, ProductRecord, ProductRegistry } from "~/domain/products/product-registry.js";
import type {
  RepositoryRecord,
  RepositoryRegistry,
  UpsertRepositoryInput,
} from "~/domain/products/repository-registry.js";
import type { RepositoryConfigFile, RepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";
import type { LinearTeamLookup } from "~/adapters/linear/team-lookup.js";
import type { Logger, LogFields } from "~/telemetry/logger.js";

/** Builds a valid `.factoree/config.yaml` document naming one Product slug and one team key. */
const configFor = (slug: string, teamKey: string): string =>
  `version: 1\nidentity:\n  product: ${slug}\n  linear:\n    teamKey: ${teamKey}\nverify:\n  commands:\n    - name: test\n      run: npm test\n`;

/** An in-memory ProductRegistry fake, keyed by tenant and slug or tenant and team id. */
class FakeProductRegistry implements ProductRegistry {
  private readonly rows: ProductRecord[] = [];
  private counter = 0;

  create(input: CreateProductInput): Promise<ProductRecord> {
    this.counter += 1;
    const record: ProductRecord = {
      id: `product-${String(this.counter)}`,
      tenantId: input.tenantId,
      slug: input.slug,
      name: input.name,
      status: "pending",
      linearTeamKey: input.linearTeamKey,
      linearTeamId: input.linearTeamId,
      defaultAutonomy: "L0",
      maxRunMinutes: input.maxRunMinutes ?? 60,
      organizationSkillsRepository: input.organizationSkillsRepository ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.push(record);
    return Promise.resolve(record);
  }

  list(tenantId: string): Promise<ProductRecord[]> {
    return Promise.resolve(this.rows.filter((row) => row.tenantId === tenantId));
  }

  findById(tenantId: string, id: string): Promise<ProductRecord | null> {
    return Promise.resolve(this.rows.find((row) => row.tenantId === tenantId && row.id === id) ?? null);
  }

  findBySlug(tenantId: string, slug: string): Promise<ProductRecord | null> {
    return Promise.resolve(this.rows.find((row) => row.tenantId === tenantId && row.slug === slug) ?? null);
  }

  findByLinearTeamId(tenantId: string, linearTeamId: string): Promise<ProductRecord | null> {
    return Promise.resolve(
      this.rows.find((row) => row.tenantId === tenantId && row.linearTeamId === linearTeamId) ?? null,
    );
  }

  activate(tenantId: string, id: string, defaultAutonomy: string): Promise<ProductRecord | null> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (row === undefined) return Promise.resolve(null);
    row.status = "active";
    row.defaultAutonomy = defaultAutonomy;
    return Promise.resolve(row);
  }

  renameLinearTeamKey(tenantId: string, id: string, linearTeamKey: string): Promise<ProductRecord | null> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (row === undefined) return Promise.resolve(null);
    row.linearTeamKey = linearTeamKey;
    return Promise.resolve(row);
  }

  updateOrganizationSkillsRepository(
    tenantId: string,
    id: string,
    organizationSkillsRepository: string | null,
  ): Promise<ProductRecord | null> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (row === undefined) return Promise.resolve(null);
    row.organizationSkillsRepository = organizationSkillsRepository;
    return Promise.resolve(row);
  }
}

/** An in-memory RepositoryRegistry fake, keyed by tenant and full name. */
class FakeRepositoryRegistry implements RepositoryRegistry {
  private readonly rows: RepositoryRecord[] = [];
  private counter = 0;

  upsert(input: UpsertRepositoryInput): Promise<RepositoryRecord> {
    const existing = this.rows.find((row) => row.tenantId === input.tenantId && row.fullName === input.fullName);
    if (existing !== undefined) {
      existing.productId = input.productId;
      existing.defaultBranch = input.defaultBranch;
      existing.configSha = input.configSha;
      existing.requestedSecretNames = input.requestedSecretNames;
      existing.lastSeenAt = new Date();
      existing.absentSince = null;
      return Promise.resolve(existing);
    }
    this.counter += 1;
    const record: RepositoryRecord = {
      id: `repository-${String(this.counter)}`,
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

  findByFullName(tenantId: string, fullName: string): Promise<RepositoryRecord | null> {
    return Promise.resolve(this.rows.find((row) => row.tenantId === tenantId && row.fullName === fullName) ?? null);
  }

  markAbsent(tenantId: string, fullName: string, at: Date): Promise<void> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.fullName === fullName);
    if (row !== undefined) row.absentSince = at;
    return Promise.resolve();
  }
}

/** A GitHub discovery client fake. Serves a fixed configuration per repository full name. */
class FakeDiscoveryClient implements RepositoryDiscoveryClient {
  constructor(private readonly configByRepository: Record<string, string | null>) {}

  listInstallationRepositories() {
    return Promise.resolve([]);
  }

  readConfig(fullName: string): Promise<RepositoryConfigFile | null> {
    const content = this.configByRepository[fullName] ?? null;
    if (content === null) return Promise.resolve(null);
    return Promise.resolve({ content, sha: `sha-${fullName}` });
  }
}

/** A Logger fake that records each call. It writes nothing to a stream. */
class FakeLogger implements Logger {
  readonly warnCalls: Array<{ message: string; fields?: LogFields }> = [];

  debug(): void {}

  info(): void {}

  warn(message: string, fields?: LogFields): void {
    this.warnCalls.push(fields === undefined ? { message } : { message, fields });
  }

  error(): void {}

  child(): Logger {
    return this;
  }
}

/** A Linear team lookup fake. `teamKeyNow` lets a test simulate a rename in Linear. */
class FakeLinearTeamLookup implements LinearTeamLookup {
  teamKeyNow = "PAY";
  private readonly teamId = "team-pay";

  resolveTeamKey(_tenantId: string, teamKey: string): Promise<{ id: string; key: string } | null> {
    if (teamKey !== "PAY" && teamKey !== this.teamKeyNow) return Promise.resolve(null);
    return Promise.resolve({ id: this.teamId, key: this.teamKeyNow });
  }

  resolveTeamId(_tenantId: string, teamId: string): Promise<{ id: string; key: string } | null> {
    if (teamId !== this.teamId) return Promise.resolve(null);
    return Promise.resolve({ id: this.teamId, key: this.teamKeyNow });
  }
}

interface BuildOptions {
  config?: string | null;
  configByRepository?: Record<string, string | null>;
}

const build = (options: BuildOptions) => {
  const products = new FakeProductRegistry();
  const repositories = new FakeRepositoryRegistry();
  const linear = new FakeLinearTeamLookup();
  const logger = new FakeLogger();
  const configByRepository = options.configByRepository ?? { "acme/api": options.config ?? null };
  const discoveryClient = new FakeDiscoveryClient(configByRepository);
  const service = new DiscoveryService(discoveryClient, products, repositories, linear, logger);
  return { service, products, repositories, linear, logger };
};

describe("DiscoveryService.syncRepository", () => {
  it("creates a pending Product at L0 for an unknown slug", async () => {
    const { service, products } = build({ config: configFor("checkout-platform", "PAY") });

    const outcome = await service.syncRepository("tenant-1", "acme/api", "main");

    expect(outcome).toMatchObject({ kind: "registered", productCreated: true });
    const product = await products.findBySlug("tenant-1", "checkout-platform");
    expect(product?.status).toBe("pending");
    expect(product?.defaultAutonomy).toBe("L0");
  });

  it("attaches a second repository to the same Product", async () => {
    const { service, repositories } = build({
      configByRepository: {
        "acme/api": configFor("checkout-platform", "PAY"),
        "acme/web": configFor("checkout-platform", "PAY"),
      },
    });

    await service.syncRepository("tenant-1", "acme/api", "main");
    const outcome = await service.syncRepository("tenant-1", "acme/web", "main");

    expect(outcome).toMatchObject({ kind: "registered", productCreated: false });
    expect(await repositories.findByFullName("tenant-1", "acme/web")).not.toBeNull();
  });

  it("refuses a second Product that claims a team another Product already claims", async () => {
    const { service, products, repositories } = build({
      configByRepository: {
        "acme/api": configFor("checkout-platform", "PAY"),
        "acme/other": configFor("other-platform", "PAY"),
      },
    });

    await service.syncRepository("tenant-1", "acme/api", "main");
    const outcome = await service.syncRepository("tenant-1", "acme/other", "main");

    expect(outcome.kind).toBe("conflict");
    // The refusal must write no row. A regression that writes one and still returns "conflict"
    // defeats the routing rule of specification section 9.
    const allProducts = await products.list("tenant-1");
    expect(allProducts.find((product) => product.slug === "other-platform")).toBeUndefined();
    expect(await repositories.findByFullName("tenant-1", "acme/other")).toBeNull();
  });

  it("keeps the binding, and records the drift, when the team key is renamed", async () => {
    const { service, products, linear } = build({ config: configFor("checkout-platform", "PAY") });
    await service.syncRepository("tenant-1", "acme/api", "main");
    const before = await products.findBySlug("tenant-1", "checkout-platform");

    // The Linear stub now answers "PAYMENTS" for the same team id, and the repository file still
    // names the old key. The id is stable, so the binding must survive.
    linear.teamKeyNow = "PAYMENTS";
    const outcome = await service.syncRepository("tenant-1", "acme/api", "main");

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
    if (outcome.kind !== "conflict") throw new Error("unreachable: asserted above");
    expect(outcome.reason).toEqual(expect.stringContaining("policy"));
  });
});
