import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import {
  PrismaProductRegistry,
  PrismaRepositoryRegistry,
} from "~/persistence/prisma/product-registry.prisma.js";

let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
});

afterAll(async () => {
  await prisma.$disconnect();
  await stop();
});

describe("product and repository schema", () => {
  it("rejects two Products that claim one Linear team in one tenant", async () => {
    const tenant = await prisma.tenant.create({
      data: { linearWorkspaceId: "ws-1", name: "Acme" },
    });
    await prisma.product.create({
      data: {
        tenantId: tenant.id,
        slug: "checkout-platform",
        name: "Checkout",
        status: "active",
        linearTeamKey: "PAY",
        linearTeamId: "team-pay",
      },
    });

    await expect(
      prisma.product.create({
        data: {
          tenantId: tenant.id,
          slug: "other-platform",
          name: "Other",
          status: "pending",
          linearTeamKey: "PAY",
          linearTeamId: "team-pay",
        },
      }),
    ).rejects.toThrow();
  });

  it("holds several repositories under one Product", async () => {
    const tenant = await prisma.tenant.create({
      data: { linearWorkspaceId: "ws-2", name: "Acme" },
    });
    const product = await prisma.product.create({
      data: {
        tenantId: tenant.id,
        slug: "checkout",
        name: "Checkout",
        status: "active",
        linearTeamKey: "CHK",
        linearTeamId: "team-chk",
      },
    });
    await prisma.repository.create({
      data: {
        tenantId: tenant.id,
        productId: product.id,
        fullName: "acme/checkout-api",
        defaultBranch: "main",
        configSha: "4f21c9e",
      },
    });
    await prisma.repository.create({
      data: {
        tenantId: tenant.id,
        productId: product.id,
        fullName: "acme/checkout-web",
        defaultBranch: "main",
        configSha: "88a0f2b",
      },
    });

    const rows = await prisma.repository.findMany({ where: { productId: product.id } });
    expect(rows).toHaveLength(2);
  });
});

describe("PrismaProductRegistry", () => {
  it("finds a Product by its Linear team id, and never falls back", async () => {
    const tenant = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-3", name: "Acme" } });
    const products = new PrismaProductRegistry(prisma);
    await products.create({
      tenantId: tenant.id,
      slug: "checkout",
      name: "Checkout",
      linearTeamKey: "CHK",
      linearTeamId: "team-chk",
    });

    expect(await products.findByLinearTeamId(tenant.id, "team-chk")).not.toBeNull();
    expect(await products.findByLinearTeamId(tenant.id, "team-missing")).toBeNull();
  });

  it("creates a Product pending, at autonomy L0", async () => {
    const tenant = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-4", name: "Acme" } });
    const products = new PrismaProductRegistry(prisma);
    const product = await products.create({
      tenantId: tenant.id,
      slug: "billing",
      name: "billing",
      linearTeamKey: "BIL",
      linearTeamId: "team-bil",
    });

    expect(product.status).toBe("pending");
    expect(product.defaultAutonomy).toBe("L0");

    const active = await products.activate(tenant.id, product.id, "L3");
    expect(active?.status).toBe("active");
    expect(active?.defaultAutonomy).toBe("L3");
  });

  it("upserts a Repository by tenant and full name", async () => {
    const tenant = await prisma.tenant.create({ data: { linearWorkspaceId: "ws-5", name: "Acme" } });
    const products = new PrismaProductRegistry(prisma);
    const repositories = new PrismaRepositoryRegistry(prisma);
    const product = await products.create({
      tenantId: tenant.id,
      slug: "checkout",
      name: "Checkout",
      linearTeamKey: "CH2",
      linearTeamId: "team-ch2",
    });

    await repositories.upsert({
      tenantId: tenant.id,
      productId: product.id,
      fullName: "acme/api",
      defaultBranch: "main",
      configSha: "aaa",
      requestedSecretNames: ["STRIPE_TEST_KEY"],
    });
    const second = await repositories.upsert({
      tenantId: tenant.id,
      productId: product.id,
      fullName: "acme/api",
      defaultBranch: "main",
      configSha: "bbb",
      requestedSecretNames: [],
    });

    expect(second.configSha).toBe("bbb");
    expect(await repositories.listByProduct(product.id)).toHaveLength(1);
  });
});

