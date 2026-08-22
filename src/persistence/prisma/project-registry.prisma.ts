import type { FactoreePrismaClient } from "./client.js";
import { decryptSecret, encryptSecret } from "~/domain/policy/crypto.js";
import type {
  CreateProjectInput,
  InstallationInput,
  ProjectRecord,
  ProjectRegistry,
  TenantRecord,
  TenantRegistry,
  UpdateProjectInput,
} from "~/domain/projects/project-registry.js";
import type {
  ProjectSecretDescriptor,
  PutSecretOptions,
  SecretStore,
} from "~/domain/projects/secret-store.js";

type ProjectRow = {
  id: string;
  tenantId: string;
  key: string;
  name: string;
  primaryRepository: string;
  referenceRepositories: string[];
  linearTeamId: string | null;
  defaultAutonomy: string;
  maxRunMinutes: number;
  createdAt: Date;
  updatedAt: Date;
};

const toProject = (row: ProjectRow): ProjectRecord => ({ ...row });

export class PrismaProjectRegistry implements ProjectRegistry {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async create(input: CreateProjectInput): Promise<ProjectRecord> {
    const row = await this.prisma.project.create({
      data: {
        tenantId: input.tenantId,
        key: input.key,
        name: input.name,
        primaryRepository: input.primaryRepository,
        referenceRepositories: input.referenceRepositories ?? [],
        ...(input.linearTeamId === undefined ? {} : { linearTeamId: input.linearTeamId }),
        ...(input.defaultAutonomy === undefined ? {} : { defaultAutonomy: input.defaultAutonomy }),
        ...(input.maxRunMinutes === undefined ? {} : { maxRunMinutes: input.maxRunMinutes }),
      },
    });
    return toProject(row);
  }

  async list(tenantId: string): Promise<ProjectRecord[]> {
    const rows = await this.prisma.project.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
    return rows.map(toProject);
  }

  async findById(tenantId: string, id: string): Promise<ProjectRecord | null> {
    const row = await this.prisma.project.findFirst({ where: { id, tenantId } });
    return row ? toProject(row) : null;
  }

  async findByLinearTeam(tenantId: string, linearTeamId: string): Promise<ProjectRecord | null> {
    const row = await this.prisma.project.findFirst({ where: { tenantId, linearTeamId } });
    return row ? toProject(row) : null;
  }

  async findDefaultForTenant(tenantId: string): Promise<ProjectRecord | null> {
    const rows = await this.prisma.project.findMany({ where: { tenantId }, take: 2 });
    return rows.length === 1 && rows[0] ? toProject(rows[0]) : null;
  }

  async update(tenantId: string, id: string, input: UpdateProjectInput): Promise<ProjectRecord | null> {
    const existing = await this.findById(tenantId, id);
    if (!existing) return null;
    const row = await this.prisma.project.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.primaryRepository === undefined ? {} : { primaryRepository: input.primaryRepository }),
        ...(input.referenceRepositories === undefined ? {} : { referenceRepositories: input.referenceRepositories }),
        ...(input.linearTeamId === undefined ? {} : { linearTeamId: input.linearTeamId }),
        ...(input.defaultAutonomy === undefined ? {} : { defaultAutonomy: input.defaultAutonomy }),
        ...(input.maxRunMinutes === undefined ? {} : { maxRunMinutes: input.maxRunMinutes }),
      },
    });
    return toProject(row);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const existing = await this.findById(tenantId, id);
    if (!existing) return false;
    await this.prisma.project.delete({ where: { id } });
    return true;
  }
}

export class PrismaSecretStore implements SecretStore {
  constructor(private readonly prisma: FactoreePrismaClient, private readonly keyHex: string) {}

  async put(
    tenantId: string,
    projectId: string,
    name: string,
    value: string,
    options?: PutSecretOptions,
  ): Promise<void> {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, tenantId } });
    if (!project) throw new Error("project not found for tenant");
    const valueCipher = encryptSecret(value, this.keyHex);
    // The mark defaults to false. A secret an operator does not mark never reaches the
    // Implementer environment. SDD section 30 requires the injection to be explicit.
    const injectIntoImplementer = options?.injectIntoImplementer ?? false;
    await this.prisma.projectSecret.upsert({
      where: { projectId_name: { projectId, name } },
      create: { tenantId, projectId, name, valueCipher, injectIntoImplementer },
      update: { valueCipher, injectIntoImplementer },
    });
  }

  async get(tenantId: string, projectId: string, name: string): Promise<string | null> {
    const row = await this.prisma.projectSecret.findFirst({ where: { tenantId, projectId, name } });
    return row ? decryptSecret(row.valueCipher, this.keyHex) : null;
  }

  async listNames(tenantId: string, projectId: string): Promise<string[]> {
    const rows = await this.prisma.projectSecret.findMany({
      where: { tenantId, projectId },
      orderBy: { name: "asc" },
    });
    return rows.map((row) => row.name);
  }

  async list(tenantId: string, projectId: string): Promise<ProjectSecretDescriptor[]> {
    const rows = await this.prisma.projectSecret.findMany({
      where: { tenantId, projectId },
      orderBy: { name: "asc" },
    });
    return rows.map((row) => ({ name: row.name, injectIntoImplementer: row.injectIntoImplementer }));
  }

  async remove(tenantId: string, projectId: string, name: string): Promise<boolean> {
    const row = await this.prisma.projectSecret.findFirst({ where: { tenantId, projectId, name } });
    if (!row) return false;
    await this.prisma.projectSecret.delete({ where: { id: row.id } });
    return true;
  }
}

export class PrismaTenantRegistry implements TenantRegistry {
  constructor(private readonly prisma: FactoreePrismaClient, private readonly keyHex: string) {}

  async ensureTenant(linearWorkspaceId: string, name: string): Promise<TenantRecord> {
    const row = await this.prisma.tenant.upsert({
      where: { linearWorkspaceId },
      create: { linearWorkspaceId, name },
      update: {},
    });
    return { id: row.id, linearWorkspaceId: row.linearWorkspaceId, name: row.name };
  }

  async findByWorkspace(linearWorkspaceId: string): Promise<TenantRecord | null> {
    const row = await this.prisma.tenant.findUnique({ where: { linearWorkspaceId } });
    return row ? { id: row.id, linearWorkspaceId: row.linearWorkspaceId, name: row.name } : null;
  }

  async putInstallation(input: InstallationInput): Promise<TenantRecord> {
    const tenant = await this.ensureTenant(input.linearWorkspaceId, input.workspaceName);
    const accessTokenCipher = encryptSecret(input.accessToken, this.keyHex);
    const refreshTokenCipher =
      input.refreshToken === undefined ? null : encryptSecret(input.refreshToken, this.keyHex);
    await this.prisma.linearInstallation.upsert({
      where: { linearWorkspaceId: input.linearWorkspaceId },
      create: {
        tenantId: tenant.id,
        linearWorkspaceId: input.linearWorkspaceId,
        appUserId: input.appUserId ?? null,
        accessTokenCipher,
        refreshTokenCipher,
        expiresAt: input.expiresAt ?? null,
        scopes: input.scopes ?? [],
      },
      update: {
        appUserId: input.appUserId ?? null,
        accessTokenCipher,
        refreshTokenCipher,
        expiresAt: input.expiresAt ?? null,
        scopes: input.scopes ?? [],
      },
    });
    return tenant;
  }

  async getInstallationToken(linearWorkspaceId: string): Promise<string | null> {
    const row = await this.prisma.linearInstallation.findUnique({ where: { linearWorkspaceId } });
    return row ? decryptSecret(row.accessTokenCipher, this.keyHex) : null;
  }
}
