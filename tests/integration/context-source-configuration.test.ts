import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import {
  PrismaProjectRegistry,
  PrismaTenantRegistry,
} from "~/persistence/prisma/project-registry.prisma.js";
import { PrismaContextSourceConfigurationStore } from "~/persistence/prisma/context-source-configuration.prisma.js";
import type { ProjectRecord, TenantRecord } from "~/domain/projects/project-registry.js";

let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let tenants: PrismaTenantRegistry;
let projects: PrismaProjectRegistry;
let tenant: TenantRecord;
let otherTenant: TenantRecord;
let project: ProjectRecord;

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  tenants = new PrismaTenantRegistry(prisma, "b".repeat(64));
  projects = new PrismaProjectRegistry(prisma);
  tenant = await tenants.ensureTenant("ws-context-source", "Context Source Workspace");
  otherTenant = await tenants.ensureTenant("ws-context-source-other", "Context Source Other");
  project = await projects.create({
    tenantId: tenant.id,
    key: "ctx",
    name: "Context",
    primaryRepository: "acme/ctx",
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
      projectId: project.id,
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

    const listed = await store.list(tenant.id, project.id);
    expect(listed.map((row) => row.sourceId)).toEqual(["backstage"]);

    // SDD section 52. Another tenant sees nothing, even with the right project id.
    expect(await store.list(otherTenant.id, project.id)).toEqual([]);
    expect(await store.remove(otherTenant.id, project.id, "backstage")).toBe(false);
    expect(await store.remove(tenant.id, project.id, "backstage")).toBe(true);
    expect(await store.list(tenant.id, project.id)).toEqual([]);
  });

  it("replaces the row of the same source identifier rather than adding a second", async () => {
    const store = new PrismaContextSourceConfigurationStore(prisma);
    await store.put({
      tenantId: tenant.id,
      projectId: project.id,
      sourceId: "backstage",
      kind: "backstage",
      endpoint: "https://a.test",
    });
    const second = await store.put({
      tenantId: tenant.id,
      projectId: project.id,
      sourceId: "backstage",
      kind: "backstage",
      endpoint: "https://b.test",
    });
    expect(second.endpoint).toBe("https://b.test");
    expect(await store.list(tenant.id, project.id)).toHaveLength(1);
  });

  it("refuses an endpoint that carries a credential anywhere", async () => {
    // SDD section 60. A token hides in the userinfo, in a query string, or in a fragment, and
    // every one of them would reach an error message and the Context Contract.
    const store = new PrismaContextSourceConfigurationStore(prisma);
    const put = (endpoint: string) =>
      store.put({
        tenantId: tenant.id,
        projectId: project.id,
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
    await store.remove(tenant.id, project.id, "backstage");
  });

  it("refuses settings that do not belong to the kind", async () => {
    const store = new PrismaContextSourceConfigurationStore(prisma);
    await expect(
      store.put({
        tenantId: tenant.id,
        projectId: project.id,
        sourceId: "docs",
        kind: "mcp",
        endpoint: "https://a.test",
        settings: {},
      }),
    ).rejects.toThrow(/discoverTool/);
  });
});
