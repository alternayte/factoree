import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentSessionEventSchema } from "~/adapters/linear/webhook-schemas.js";
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { AgentRunWorkflowInput } from "~/workflows/agent-run.workflow.js";
import { humanInputSignal, stopSignal } from "~/workflows/agent-run.workflow.js";
import type { ProductRecord, CreateProductInput, ProductRegistry } from "~/domain/products/product-registry.js";
import type {
  RepositoryRecord,
  RepositoryRegistry,
  UpsertRepositoryInput,
} from "~/domain/products/repository-registry.js";
import type { TenantRecord, TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { ProjectSecretDescriptor, SecretStore } from "~/domain/products/secret-store.js";
import { registerProductRoutes } from "~/http/admin/products.routes.js";
import { resolveProduct } from "~/domain/routing/resolve-product.js";
import { DiscoveryService } from "~/domain/products/discovery-service.js";
import type { RepositoryConfigFile, RepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";
import type { LinearTeamLookup } from "~/adapters/linear/team-lookup.js";
import type { Logger } from "~/telemetry/logger.js";
import { parseFactoreeConfig, FactoreeConfigPrivilegeError } from "~/domain/products/factoree-config.js";
import { buildSiblingCloner, SiblingCloneDeniedError } from "~/domain/runs/sibling-clone.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { FakeEvidenceStore } from "../support/fake-evidence-store.js";
import { createWorkflowHarness, waitFor, waitForStatus } from "../workflow/support/harness.js";

const event = (name: string) =>
  agentSessionEventSchema.parse(JSON.parse(readFileSync(`tests/fixtures/linear/${name}.json`, "utf8")));

const logger = createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined });

const productFor = (slug: string, teamId = "team-1"): ProductRecord => ({
  id: `product-${slug}`,
  tenantId: "tenant-1",
  slug,
  name: slug,
  status: "active",
  linearTeamKey: "TEAM",
  linearTeamId: teamId,
  defaultAutonomy: "L2",
  riskCaps: null,
  allowedDomains: [],
  maxRunMinutes: 90,
  organizationSkillsRepository: null,
  skillRegistry: null,
  model: null,
  effort: { implementer: null, refiner: null, validator: null, reviewer: null, setup: null },
  silenceMinutes: 10,
  sandboxRetentionHours: 24,
  maxConcurrentRuns: 2,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const buildDelegationService = (options: { products: ProductRecord[]; repositories: RepositoryRecord[] }) => {
  const started: Array<{ workflowId: string; args: [AgentRunWorkflowInput] }> = [];
  const postedFailures: Array<{ workspaceId: string; sessionId: string; message: string }> = [];
  const service = new DelegationService({
    tenants: {
      findByWorkspace: () =>
        Promise.resolve({ id: "tenant-1", linearWorkspaceId: "workspace-123", name: "A" }),
      ensureTenant: () => Promise.resolve({ id: "tenant-1", linearWorkspaceId: "workspace-123", name: "A" }),
      putInstallation: () => Promise.resolve({ id: "tenant-1", linearWorkspaceId: "workspace-123", name: "A" }),
      getInstallationToken: () => Promise.resolve("token"),
    } as never,
    products: { list: () => Promise.resolve(options.products) } as never,
    repositories: {
      listByProduct: (productId: string) =>
        Promise.resolve(options.repositories.filter((r) => r.productId === productId)),
    } as never,
    webhookLog: {
      recordIfNew: () => Promise.resolve(true),
      remove: () => Promise.resolve(),
    },
    starter: {
      start: (input: { workflowId: string; args: [AgentRunWorkflowInput] }) => {
        started.push(input);
        return Promise.resolve();
      },
      signalStop: () => Promise.resolve(true),
      signalHumanInput: () => Promise.resolve(true),
    },
    refusalNotifier: {
      postFailure: (workspaceId: string, sessionId: string, message: string) => {
        postedFailures.push({ workspaceId, sessionId, message });
        return Promise.resolve();
      },
      postResponse: () => Promise.resolve(),
    },
    logger,
    repositoryBaseUrl: () => Promise.resolve("https://github.com"),
  });
  return { service, started, postedFailures };
};

describe("AT-38 to AT-41 and AT-48: routing and discovery", () => {
  it("AT-38 resolves a team key to one Product, and the id never leaves Factoree", async () => {
    // A human names a team by its key. Factoree resolves the key to the team id once, through
    // Linear, and keeps the id afterward, because a key rename never changes the id.
    const { app, products } = buildProductsApi();

    // 1. A create request carrying `linearTeamKey` succeeds, and the stored record carries both
    // the key and the id Linear resolved it to.
    const created = await app.inject({
      method: "POST",
      url: "/admin/products",
      payload: {
        linearWorkspaceId: "ws-1",
        slug: "checkout",
        name: "Checkout",
        linearTeamKey: "PAY",
      },
    });
    expect(created.statusCode).toBe(201);
    const product = created.json<{ id: string; linearTeamKey: string; linearTeamId: string }>();
    expect(product).toMatchObject({ linearTeamKey: "PAY", linearTeamId: "team-pay" });

    // 2. A create request carrying `linearTeamId` fails with 400. No caller ever supplies the
    // id; Factoree is the only party that ever writes it.
    const rejected = await app.inject({
      method: "POST",
      url: "/admin/products",
      payload: {
        linearWorkspaceId: "ws-1",
        slug: "billing",
        name: "Billing",
        linearTeamKey: "BILL",
        linearTeamId: "team-bill",
      },
    });
    expect(rejected.statusCode).toBe(400);
    // The rejected create wrote no row, so the id it tried to smuggle in never reached storage.
    expect(await products.findBySlug("tenant-1", "billing")).toBeNull();

    // 3. Routing afterward resolves by the stored id, not by the key. `resolveProduct` is the
    // function `DelegationService` calls to route a delegated Linear issue to its Product.
    const stored = await products.list("tenant-1");
    const outcome = resolveProduct(stored, "team-pay");
    expect(outcome.kind).toBe("routed");
    if (outcome.kind !== "routed") throw new Error("unreachable: asserted above");
    expect(outcome.product.id).toBe(product.id);
  });

  it("AT-39 refuses with BLOCKED_ROUTING when two Products claim one team", async () => {
    const { service, started, postedFailures } = buildDelegationService({
      products: [productFor("checkout", "team-1"), productFor("billing", "team-1")],
      repositories: [],
    });

    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-at-39");

    expect(outcome.kind).toBe("blocked_routing");
    expect(started).toHaveLength(0);
    // F4. Specification section 9 requires the reason and the missing binding to reach the
    // human as a Linear comment, not only Linear's delivery log.
    expect(postedFailures).toHaveLength(1);
    if (outcome.kind === "blocked_routing") expect(postedFailures[0]?.message).toBe(outcome.reason);
  });

  it("AT-40 fails validation, by key name, when a repository file sets autonomy", () => {
    const text = "version: 1\npolicy:\n  autonomy: L4\n";

    expect(() => parseFactoreeConfig(text)).toThrow(FactoreeConfigPrivilegeError);
    try {
      parseFactoreeConfig(text);
      expect.unreachable("parseFactoreeConfig must throw for a repository-set autonomy key");
    } catch (error) {
      expect(error).toBeInstanceOf(FactoreeConfigPrivilegeError);
      expect((error as FactoreeConfigPrivilegeError).key).toBe("policy");
      expect((error as Error).message).toContain("policy");
    }
  });

  it("AT-41 creates a pending Product at L0 for an unknown product slug", async () => {
    const { service, products } = buildDiscovery({
      config: configFor("checkout-platform", "PAY"),
    });

    const outcome = await service.syncRepository("tenant-1", "acme/api", "main", "install-1");

    expect(outcome).toMatchObject({ kind: "registered", productCreated: true });
    const product = await products.findBySlug("tenant-1", "checkout-platform");
    expect(product?.status).toBe("pending");
    expect(product?.defaultAutonomy).toBe("L0");
  });

  it("AT-48 keeps the binding, and records the drift, when a team key is renamed", async () => {
    const { service, products, linear } = buildDiscovery({
      config: configFor("checkout-platform", "PAY"),
    });
    await service.syncRepository("tenant-1", "acme/api", "main", "install-1");
    const before = await products.findBySlug("tenant-1", "checkout-platform");

    // The Linear stub renames the team key. The repository file still names the old key, and
    // the team id is stable, so the binding to the same Product must survive.
    linear.teamKeyNow = "PAYMENTS";
    const outcome = await service.syncRepository("tenant-1", "acme/api", "main", "install-1");

    expect(outcome).toMatchObject({ kind: "registered", drift: "linear_team_key_renamed" });
    const after = await products.findBySlug("tenant-1", "checkout-platform");
    expect(after?.id).toBe(before?.id);
    expect(after?.linearTeamKey).toBe("PAYMENTS");
  });
});

describe("AT-42 and AT-43: target selection inside the workflow", () => {
  let environment: TestWorkflowEnvironment;

  const harness = createWorkflowHarness(() => environment);
  const { productInput, recordRunTargetCalls, decisionCalls, start, runWorker, implementCalls, workItemInput } = harness;

  const twoRepositories = [
    { id: "repository-api", fullName: "acme/api", defaultBranch: "main", absentSince: null, githubInstallationId: "install-1", linearProjects: [] },
    { id: "repository-web", fullName: "acme/web", defaultBranch: "main", absentSince: null, githubInstallationId: "install-1", linearProjects: [] },
  ];

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  });

  afterAll(async () => {
    await environment.teardown();
  });

  it("AT-42 proceeds and posts a Linear notice for a confident single target", async () => {
    await runWorker(async () => {
      const handle = await start("ses-at-42", {
        product: { ...productInput, repositories: twoRepositories },
        // docs/specs/own-proposals-and-parallel-runs.md. The issue names the repository.
        workItem: { ...workItemInput, description: "## Goal\n\nFix the checkout form in acme/web.\n" },
      });

      await waitFor(
        () => implementCalls.filter((entry) => entry.runId === "run-ses-at-42").length === 1,
        "the Implementer of at-42",
      );

      expect(recordRunTargetCalls.filter((entry) => entry.runId === "run-ses-at-42")).toEqual([
        expect.objectContaining({ repositoryId: "repository-web", selectionReason: "the issue names acme/web" }),
      ]);
      expect(decisionCalls.filter((entry) => entry.runId === "run-ses-at-42").map((entry) => entry.decision)).toEqual([
        { kind: "target", statement: "chose acme/web", reason: "the issue names acme/web" },
      ]);

      await handle.signal(stopSignal);
      const result = await handle.result();
      expect(result.status).not.toBe("BLOCKED_TARGET");
    });
  });

  it("AT-43 blocks with BLOCKED_TARGET on an ambiguous target, and resumes on a reply", async () => {
    await runWorker(async () => {
      const handle = await start("ses-at-43", {
        product: { ...productInput, repositories: twoRepositories },
      });
      await waitForStatus(handle, "BLOCKED_TARGET");

      const blocked = await handle.query(harness.runStatusQuery);
      expect(blocked.status).toBe("BLOCKED_TARGET");
      expect(implementCalls.filter((entry) => entry.runId === "run-ses-at-43")).toEqual([]);

      await handle.signal(humanInputSignal, "use acme/web");

      const result = await handle.result();
      expect(result.status).not.toBe("BLOCKED_TARGET");
      expect(recordRunTargetCalls.filter((entry) => entry.runId === "run-ses-at-43")).toEqual([
        expect.objectContaining({ repositoryId: "repository-web" }),
      ]);
    });
  });
});

describe("AT-46 and AT-47: the gated sibling clone", () => {
  const REPOSITORIES = [
    { id: "1", fullName: "acme/api", defaultBranch: "main", absentSince: null, githubInstallationId: "install-1", linearProjects: [] },
    { id: "2", fullName: "acme/web", defaultBranch: "main", absentSince: null, githubInstallationId: "install-1", linearProjects: [] },
  ];

  const buildCloner = () => {
    const sandbox = new FakeSandbox();
    const evidence = new FakeEvidenceStore();
    sandbox.scriptExec(/rev-parse HEAD/, { stdout: "aaaabbbbccccddddeeeeffff0000111122223333\n" });
    const cloner = buildSiblingCloner({
      sandbox,
      ref: { id: "sbx-1", adapter: "fake", workspacePath: "/workspace" },
      evidence,
      tenantId: "tenant-1",
      repositories: REPOSITORIES,
      repositoryBaseUrl: "https://github.com",
    });
    return { sandbox, evidence, cloner };
  };

  it("AT-46 clones a sibling read-only and writes an evidence record", async () => {
    const { sandbox, evidence, cloner } = buildCloner();

    const result = await cloner.cloneSibling({ fullName: "acme/web", runId: "run-1", role: "implementer" });

    expect(result.path).not.toContain("/primary");
    expect(result.commitSha).toBe("aaaabbbbccccddddeeeeffff0000111122223333");
    const clones = sandbox.commands.filter((command) => command.args.includes("clone"));
    expect(clones).toHaveLength(1);
    expect(sandbox.commands.some((command) => command.file === "chmod" && command.args.includes(result.path))).toBe(
      true,
    );

    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]).toMatchObject({
      kind: "sibling_read",
      runId: "run-1",
      metadata: {
        fullName: "acme/web",
        commitSha: "aaaabbbbccccddddeeeeffff0000111122223333",
        role: "implementer",
      },
    });
  });

  it("AT-47 denies a clone outside the Product", async () => {
    const { sandbox, evidence, cloner } = buildCloner();

    await expect(
      cloner.cloneSibling({ fullName: "acme/other", runId: "run-1", role: "implementer" }),
    ).rejects.toThrow(SiblingCloneDeniedError);
    expect(sandbox.commands.filter((command) => command.args.includes("clone"))).toHaveLength(0);
    expect(evidence.rows).toHaveLength(0);
  });
});

// --- Discovery fixtures, shared by AT-41 and AT-48 --------------------------------------------

/** Builds a valid `.factoree/config.yaml` document naming one Product slug and one team key. */
const configFor = (slug: string, teamKey: string): string =>
  `version: 1\nidentity:\n  product: ${slug}\n  linear:\n    teamKey: ${teamKey}\nverify:\n  commands:\n    - name: test\n      run: npm test\n`;

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
      riskCaps: null,
      allowedDomains: [],
      maxRunMinutes: input.maxRunMinutes ?? 60,
      organizationSkillsRepository: input.organizationSkillsRepository ?? null,
      skillRegistry: null,
      model: null,
      effort: { implementer: null, refiner: null, validator: null, reviewer: null, setup: null },
      silenceMinutes: 10,
      sandboxRetentionHours: 24,
      maxConcurrentRuns: 2,
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

  updateSkillRegistry(): Promise<ProductRecord | null> {
    return Promise.resolve(null);
  }

  updatePolicy(): Promise<ProductRecord | null> {
    return Promise.resolve(null);
  }

  updateSettings(): Promise<ProductRecord | null> {
    return Promise.resolve(null);
  }

  update(): Promise<ProductRecord | null> {
    throw new Error("not used by this test");
  }

  remove(): Promise<boolean> {
    throw new Error("not used by this test");
  }
}

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
      existing.githubInstallationId = input.githubInstallationId;
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
      githubInstallationId: input.githubInstallationId,
      linearProjects: [],
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

class FakeDiscoveryClient implements RepositoryDiscoveryClient {
  listFiles = (): Promise<[]> => Promise.resolve([]);
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

class FakeLogger implements Logger {
  debug(): void {}

  info(): void {}

  warn(): void {}

  error(): void {}

  child(): Logger {
    return this;
  }
}

/** A Linear team lookup fake. `teamKeyNow` lets AT-48 simulate a rename in Linear. */
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

const buildDiscovery = (options: { config: string }) => {
  const products = new FakeProductRegistry();
  const repositories = new FakeRepositoryRegistry();
  const linear = new FakeLinearTeamLookup();
  const discoveryLogger = new FakeLogger();
  const discoveryClient = new FakeDiscoveryClient({ "acme/api": options.config });
  const service = new DiscoveryService(discoveryClient, products, repositories, linear, discoveryLogger);
  return { service, products, repositories, linear };
};

// --- The administration API app, for AT-38 -------------------------------------------------

const TENANT: TenantRecord = { id: "tenant-1", linearWorkspaceId: "ws-1", name: "Acme" };

class FakeTenantRegistry implements TenantRegistry {
  ensureTenant(): Promise<TenantRecord> {
    return Promise.resolve(TENANT);
  }

  findByWorkspace(linearWorkspaceId: string): Promise<TenantRecord | null> {
    return Promise.resolve(linearWorkspaceId === TENANT.linearWorkspaceId ? TENANT : null);
  }

  putInstallation(): Promise<TenantRecord> {
    throw new Error("not used by AT-38");
  }

  getInstallationToken(): Promise<string | null> {
    throw new Error("not used by AT-38");
  }

  getInstallation(): Promise<null> {
    throw new Error("not used by AT-38");
  }

  findByGitHubInstallation(): Promise<TenantRecord | null> {
    throw new Error("not used by AT-38");
  }

  putGitHubInstallation(): Promise<"bound"> {
    throw new Error("not used by AT-38");
  }
}

class FakeSecretStore implements SecretStore {
  put(): Promise<void> {
    throw new Error("not used by AT-38");
  }

  get(): Promise<string | null> {
    throw new Error("not used by AT-38");
  }

  listNames(): Promise<string[]> {
    throw new Error("not used by AT-38");
  }

  list(): Promise<ProjectSecretDescriptor[]> {
    throw new Error("not used by AT-38");
  }

  remove(): Promise<boolean> {
    throw new Error("not used by AT-38");
  }
}

/** Builds the real `/admin/products` route, over the in-memory fakes above. */
const buildProductsApi = (): { app: FastifyInstance; products: FakeProductRegistry } => {
  const products = new FakeProductRegistry();
  const repositories = new FakeRepositoryRegistry();
  const tenants = new FakeTenantRegistry();
  const secrets = new FakeSecretStore();
  const linearTeams = new FakeLinearTeamLookup();

  const app = Fastify({ logger: false });
  registerProductRoutes(app, {
    products,
    repositories,
    tenants,
    secrets,
    linearTeams,
    // AT-38 to AT-41 and AT-48 do not exercise DELETE /admin/products/:id.
    runs: { countByProduct: () => Promise.resolve(0) } as never,
  });

  return { app, products };
};
