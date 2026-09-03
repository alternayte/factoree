import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import {
  PrismaProjectRegistry,
  PrismaSecretStore,
  PrismaTenantRegistry,
} from "~/persistence/prisma/project-registry.prisma.js";

const key = "b".repeat(64);
let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let tenants: PrismaTenantRegistry;
let projects: PrismaProjectRegistry;
let secrets: PrismaSecretStore;

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  tenants = new PrismaTenantRegistry(prisma, key);
  projects = new PrismaProjectRegistry(prisma);
  secrets = new PrismaSecretStore(prisma, key);
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
