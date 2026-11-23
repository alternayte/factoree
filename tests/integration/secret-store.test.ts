import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaProductRegistry, PrismaSecretStore } from "~/persistence/prisma/product-registry.prisma.js";

const key = "b".repeat(64);
let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let products: PrismaProductRegistry;
let secrets: PrismaSecretStore;

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  products = new PrismaProductRegistry(prisma);
  secrets = new PrismaSecretStore(prisma, key);
});

afterAll(async () => {
  await prisma.$disconnect();
  await stop();
});

describe("the Product secret store", () => {
  it("stores a secret encrypted and reads it back", async () => {
    const tenant = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-secrets-1", name: "Acme" } });
    const product = await products.create({
      tenantId: tenant.id,
      slug: "secrets",
      name: "Secrets",
      linearTeamKey: "SEC",
      linearTeamId: "team-secrets-1",
    });
    await secrets.put(tenant.id, product.id, "GITHUB_TOKEN", "ghp_value_for_test_1234567890");
    const stored = await prisma.productSecret.findFirstOrThrow({ where: { productId: product.id } });
    expect(stored.valueCipher).not.toContain("ghp_value_for_test_1234567890");
    expect(await secrets.get(tenant.id, product.id, "GITHUB_TOKEN")).toBe("ghp_value_for_test_1234567890");
    expect(await secrets.listNames(tenant.id, product.id)).toEqual(["GITHUB_TOKEN"]);
    // SDD section 30. A secret carries no injection mark unless the operator sets one.
    expect(await secrets.list(tenant.id, product.id)).toEqual([
      { name: "GITHUB_TOKEN", injectIntoImplementer: false, kind: "test" },
    ]);
  });

  it("keeps the injection mark of a secret the operator marked", async () => {
    const tenant = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-secrets-2", name: "Acme" } });
    const product = await products.create({
      tenantId: tenant.id,
      slug: "injected",
      name: "Injected",
      linearTeamKey: "INJ",
      linearTeamId: "team-secrets-2",
    });
    await secrets.put(tenant.id, product.id, "FIXTURE_URL", "http://localhost:9999", {
      injectIntoImplementer: true,
    });
    await secrets.put(tenant.id, product.id, "GITHUB_TOKEN", "ghp_value_for_test_1234567890");
    expect(await secrets.list(tenant.id, product.id)).toEqual([
      { name: "FIXTURE_URL", injectIntoImplementer: true, kind: "test" },
      { name: "GITHUB_TOKEN", injectIntoImplementer: false, kind: "test" },
    ]);
  });

  it("does not return a secret to another tenant", async () => {
    const owner = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-secrets-3", name: "Acme" } });
    const other = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-secrets-4", name: "Acme" } });
    const product = await products.create({
      tenantId: owner.id,
      slug: "guard",
      name: "Guard",
      linearTeamKey: "GRD",
      linearTeamId: "team-secrets-3",
    });
    await secrets.put(owner.id, product.id, "TOKEN", "value-1234567890");
    expect(await secrets.get(other.id, product.id, "TOKEN")).toBeNull();
    expect(await secrets.listNames(other.id, product.id)).toEqual([]);
  });

  it("refuses a secret for a Product outside the tenant", async () => {
    const owner = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-secrets-5", name: "Acme" } });
    const other = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-secrets-6", name: "Acme" } });
    const product = await products.create({
      tenantId: owner.id,
      slug: "isolated",
      name: "Isolated",
      linearTeamKey: "ISO",
      linearTeamId: "team-secrets-4",
    });
    await expect(secrets.put(other.id, product.id, "TOKEN", "value-1234567890")).rejects.toThrow(
      "product not found for tenant",
    );
  });
});

// docs/specs/product-copy.md. The copy shares no row with its source, and its secrets decrypt.
describe("a product copy", () => {
  it("copies settings, secrets, host credentials and context sources, and links nothing", async () => {
    const tenant = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-copy-1", name: "Acme" } });
    const source = await products.create({
      tenantId: tenant.id,
      slug: "source",
      name: "Source",
      linearTeamKey: "SRC",
      linearTeamId: "team-src",
    });
    await products.activate(tenant.id, source.id, "L2");
    await products.updatePolicy(tenant.id, source.id, { riskCaps: { billing: "L1" }, allowedDomains: ["api.example.com"] });
    await products.updateSettings(tenant.id, source.id, { model: "anthropic/claude-sonnet-4-5", maxConcurrentRuns: 3 });
    await secrets.put(tenant.id, source.id, "API_TOKEN", "s3cret", { kind: "test" });
    await prisma.hostCredential.create({
      data: { tenantId: tenant.id, productId: source.id, position: 0, kind: "header", host: "npm.example.com", headerName: "Authorization", secretName: "API_TOKEN" },
    });
    await prisma.contextSourceConfiguration.create({
      data: { tenantId: tenant.id, productId: source.id, sourceId: "docs", kind: "http", endpoint: "https://docs.example.com", secretName: "API_TOKEN", settings: { depth: 2 } },
    });
    await prisma.repository.create({
      data: { tenantId: tenant.id, productId: source.id, fullName: "acme/source", configSha: "abc", githubInstallationId: "1" },
    });

    const copy = await products.copy(tenant.id, source.id, {
      slug: "copy",
      name: "Copy",
      linearTeamKey: "CPY",
      linearTeamId: "team-cpy",
    });

    expect(copy).toMatchObject({
      status: "pending",
      slug: "copy",
      linearTeamId: "team-cpy",
      defaultAutonomy: "L2",
      riskCaps: { billing: "L1" },
      allowedDomains: ["api.example.com"],
      model: "anthropic/claude-sonnet-4-5",
      maxConcurrentRuns: 3,
    });
    const copyId = copy!.id;
    expect(await secrets.get(tenant.id, copyId, "API_TOKEN")).toBe("s3cret");
    expect(await prisma.hostCredential.count({ where: { productId: copyId, host: "npm.example.com", secretName: "API_TOKEN" } })).toBe(1);
    expect(await prisma.contextSourceConfiguration.findFirst({ where: { productId: copyId } })).toMatchObject({ sourceId: "docs", settings: { depth: 2 } });
    expect(await prisma.repository.count({ where: { productId: copyId } })).toBe(0);
    expect(await prisma.productPolicyChange.findMany({ where: { productId: copyId } })).toMatchObject([
      { field: "copiedFrom", newValue: { productId: source.id, slug: "source" } },
    ]);

    await secrets.put(tenant.id, copyId, "API_TOKEN", "changed", { kind: "test" });
    await products.updateSettings(tenant.id, copyId, { maxConcurrentRuns: 1 });
    expect(await secrets.get(tenant.id, source.id, "API_TOKEN")).toBe("s3cret");
    expect((await products.findById(tenant.id, source.id))?.maxConcurrentRuns).toBe(3);

    expect(await products.copy(tenant.id, "missing", { slug: "x", name: "X", linearTeamKey: "X", linearTeamId: "team-x" })).toBeNull();
    await expect(
      products.copy(tenant.id, source.id, { slug: "other", name: "Other", linearTeamKey: "CPY", linearTeamId: "team-cpy" }),
    ).rejects.toThrow();
    expect(await prisma.product.count({ where: { tenantId: tenant.id } })).toBe(2);
  });
});
