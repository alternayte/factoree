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
