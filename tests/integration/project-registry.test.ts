import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDatabase } from "./support/database.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { PrismaProjectRegistry, PrismaTenantRegistry } from "~/persistence/prisma/project-registry.prisma.js";

const key = "b".repeat(64);
let prisma: FactoreePrismaClient;
let stop: () => Promise<void>;
let tenants: PrismaTenantRegistry;
let projects: PrismaProjectRegistry;

beforeAll(async () => {
  const database = await startDatabase();
  stop = database.stop;
  prisma = createPrismaClient(database.url);
  tenants = new PrismaTenantRegistry(prisma, key);
  projects = new PrismaProjectRegistry(prisma);
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

  it("stores and clears the organization skills repository of SDD section 16", async () => {
    const tenant = await tenants.ensureTenant("ws-8", "Workspace Eight");
    const project = await projects.create({
      tenantId: tenant.id,
      key: "skills-project",
      name: "Skills project",
      primaryRepository: "acme/app",
      organizationSkillsRepository: "acme/skills",
    });
    expect(project.organizationSkillsRepository).toBe("acme/skills");

    const updated = await projects.update(tenant.id, project.id, { organizationSkillsRepository: null });
    expect(updated?.organizationSkillsRepository).toBeNull();
  });

  it("defaults the organization skills repository to null", async () => {
    const tenant = await tenants.ensureTenant("ws-9", "Workspace Nine");
    const project = await projects.create({
      tenantId: tenant.id,
      key: "plain-project",
      name: "Plain project",
      primaryRepository: "acme/app",
    });
    expect(project.organizationSkillsRepository).toBeNull();
  });
});
