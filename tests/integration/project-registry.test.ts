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

describe("project registry", () => {
  it("creates and lists a project inside one tenant", async () => {
    const tenant = await tenants.ensureTenant("ws-1", "Workspace One");
    const project = await projects.create({
      tenantId: tenant.id,
      key: "demo",
      name: "Demo",
      primaryRepository: "acme/demo",
      linearTeamId: "team-1",
    });
    expect(project.maxRunMinutes).toBe(90);
    expect(project.defaultAutonomy).toBe("L2");
    expect(project.defaultBranch).toBe("main");
    expect(await projects.list(tenant.id)).toHaveLength(1);
    expect(await projects.findByLinearTeam(tenant.id, "team-1")).not.toBeNull();
  });

  it("does not return another tenant project", async () => {
    const first = await tenants.ensureTenant("ws-2", "Workspace Two");
    const second = await tenants.ensureTenant("ws-3", "Workspace Three");
    const project = await projects.create({
      tenantId: first.id,
      key: "one",
      name: "One",
      primaryRepository: "acme/one",
    });
    expect(await projects.findById(second.id, project.id)).toBeNull();
    expect(await projects.list(second.id)).toHaveLength(0);
    expect(await projects.update(second.id, project.id, { name: "Stolen" })).toBeNull();
    expect(await projects.remove(second.id, project.id)).toBe(false);
  });

  it("stores a secret encrypted and reads it back", async () => {
    const tenant = await tenants.ensureTenant("ws-4", "Workspace Four");
    const project = await projects.create({
      tenantId: tenant.id,
      key: "secrets",
      name: "Secrets",
      primaryRepository: "acme/secrets",
    });
    await secrets.put(tenant.id, project.id, "GITHUB_TOKEN", "ghp_value_for_test_1234567890");
    const stored = await prisma.projectSecret.findFirstOrThrow({ where: { projectId: project.id } });
    expect(stored.valueCipher).not.toContain("ghp_value_for_test_1234567890");
    expect(await secrets.get(tenant.id, project.id, "GITHUB_TOKEN")).toBe("ghp_value_for_test_1234567890");
    expect(await secrets.listNames(tenant.id, project.id)).toEqual(["GITHUB_TOKEN"]);
    // SDD section 30. A secret carries no injection mark unless the operator sets one.
    expect(await secrets.list(tenant.id, project.id)).toEqual([
      { name: "GITHUB_TOKEN", injectIntoImplementer: false },
    ]);
  });

  it("keeps the injection mark of a secret the operator marked", async () => {
    const tenant = await tenants.ensureTenant("ws-4b", "Workspace Four B");
    const project = await projects.create({
      tenantId: tenant.id,
      key: "injected",
      name: "Injected",
      primaryRepository: "acme/injected",
    });
    await secrets.put(tenant.id, project.id, "FIXTURE_URL", "http://localhost:9999", {
      injectIntoImplementer: true,
    });
    await secrets.put(tenant.id, project.id, "GITHUB_TOKEN", "ghp_value_for_test_1234567890");
    expect(await secrets.list(tenant.id, project.id)).toEqual([
      { name: "FIXTURE_URL", injectIntoImplementer: true },
      { name: "GITHUB_TOKEN", injectIntoImplementer: false },
    ]);
  });

  it("does not return a secret to another tenant", async () => {
    const owner = await tenants.ensureTenant("ws-5", "Workspace Five");
    const other = await tenants.ensureTenant("ws-6", "Workspace Six");
    const project = await projects.create({
      tenantId: owner.id,
      key: "guard",
      name: "Guard",
      primaryRepository: "acme/guard",
    });
    await secrets.put(owner.id, project.id, "TOKEN", "value-1234567890");
    expect(await secrets.get(other.id, project.id, "TOKEN")).toBeNull();
    expect(await secrets.listNames(other.id, project.id)).toEqual([]);
  });

  it("stores the installation access token encrypted", async () => {
    await tenants.putInstallation({
      linearWorkspaceId: "ws-7",
      workspaceName: "Workspace Seven",
      accessToken: "lin_oauth_abcdefghijklmnopqrstuvwxyz012345",
    });
    const row = await prisma.linearInstallation.findFirstOrThrow({ where: { linearWorkspaceId: "ws-7" } });
    expect(row.accessTokenCipher).not.toContain("lin_oauth_abcdefghijklmnopqrstuvwxyz012345");
    expect(await tenants.getInstallationToken("ws-7")).toBe("lin_oauth_abcdefghijklmnopqrstuvwxyz012345");
  });
});
