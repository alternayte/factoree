import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaProductRegistry, PrismaTenantRegistry } from "~/persistence/prisma/product-registry.prisma.js";
import { PrismaContextSourceConfigurationStore } from "~/persistence/prisma/context-source-configuration.prisma.js";
import type { ProductRecord } from "~/domain/products/product-registry.js";
import type { TenantRecord } from "~/domain/products/tenant-registry.js";

let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let tenants: PrismaTenantRegistry;
let products: PrismaProductRegistry;
let tenant: TenantRecord;
let otherTenant: TenantRecord;
let product: ProductRecord;

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  tenants = new PrismaTenantRegistry(prisma, "b".repeat(64));
  products = new PrismaProductRegistry(prisma);
  tenant = await tenants.ensureTenant("ws-context-source", "Context Source Workspace");
  otherTenant = await tenants.ensureTenant("ws-context-source-other", "Context Source Other");
  product = await products.create({
    tenantId: tenant.id,
    slug: "ctx",
    name: "Context",
    linearTeamKey: "CTX",
    linearTeamId: "team-ctx",
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  await stop();
});

describe("PrismaContextSourceConfigurationStore", () => {
  it("writes, reads back, and removes one configuration inside one tenant", async () => {
    const store = new PrismaContextSourceConfigurationStore(prisma);
    const created = await store.put({
      tenantId: tenant.id,
      productId: product.id,
      sourceId: "backstage",
      kind: "backstage",
      endpoint: "https://backstage.example.test",
      secretName: "BACKSTAGE_TOKEN",
      settings: { maxEntities: 10 },
    });
    expect(created.settings).toEqual({
      kind: "backstage",
      primaryComponent: null,
      maxEntities: 10,
      includeOwnership: true,
    });

    const listed = await store.list(tenant.id, product.id);
    expect(listed.map((row) => row.sourceId)).toEqual(["backstage"]);

    // SDD section 52. Another tenant sees nothing, even with the right product id.
    expect(await store.list(otherTenant.id, product.id)).toEqual([]);
    expect(await store.remove(otherTenant.id, product.id, "backstage")).toBe(false);
    expect(await store.remove(tenant.id, product.id, "backstage")).toBe(true);
    expect(await store.list(tenant.id, product.id)).toEqual([]);
  });

  it("replaces the row of the same source identifier rather than adding a second", async () => {
    const store = new PrismaContextSourceConfigurationStore(prisma);
    await store.put({
      tenantId: tenant.id,
      productId: product.id,
      sourceId: "backstage",
      kind: "backstage",
      endpoint: "https://a.test",
    });
    const second = await store.put({
      tenantId: tenant.id,
      productId: product.id,
      sourceId: "backstage",
      kind: "backstage",
      endpoint: "https://b.test",
    });
    expect(second.endpoint).toBe("https://b.test");
    expect(await store.list(tenant.id, product.id)).toHaveLength(1);
  });

  it("refuses an endpoint that carries a credential anywhere", async () => {
    // SDD section 60. A token hides in the userinfo, in a query string, or in a fragment, and
    // every one of them would reach an error message and the Context Contract.
    const store = new PrismaContextSourceConfigurationStore(prisma);
    const put = (endpoint: string) =>
      store.put({
        tenantId: tenant.id,
        productId: product.id,
        sourceId: "backstage",
        kind: "backstage",
        endpoint,
      });
    await expect(put("https://operator:token@a.test")).rejects.toThrow(/user name or a password/);
    await expect(put("https://a.test/rpc?token=SECRET")).rejects.toThrow(/query string or a fragment/);
    await expect(put("https://a.test/rpc#token=SECRET")).rejects.toThrow(/query string or a fragment/);
    // The message never echoes the value.
    await expect(put("https://a.test/rpc?token=SECRET")).rejects.not.toThrow(/SECRET/);
    await expect(put("https://operator:token@a.test")).rejects.not.toThrow(/operator/);
    // A plain base address still passes.
    expect((await put("https://a.test/api")).endpoint).toBe("https://a.test/api");
    await store.remove(tenant.id, product.id, "backstage");
  });

  it("refuses settings that do not belong to the kind", async () => {
    const store = new PrismaContextSourceConfigurationStore(prisma);
    await expect(
      store.put({
        tenantId: tenant.id,
        productId: product.id,
        sourceId: "docs",
        kind: "mcp",
        endpoint: "https://a.test",
        settings: {},
      }),
    ).rejects.toThrow(/discoverTool/);
  });
});
