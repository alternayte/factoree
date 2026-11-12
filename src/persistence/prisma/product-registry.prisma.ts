import type { RepositorySetupMarks } from "~/domain/setup/repository-setup.js";
import { Prisma } from "@prisma/client";
import { isAgentRunnerName, type AgentRunnerName } from "~/domain/products/agent-settings.js";
import type { FactoreePrismaClient } from "./client.js";
import { decryptSecret, encryptSecret } from "~/domain/policy/crypto.js";
import type {
  CreateProductInput,
  ProductPolicyUpdate,
  ProductRecord,
  ProductRegistry,
  ProductSettingsUpdate,
} from "~/domain/products/product-registry.js";
import type {
  RepositoryRecord,
  RepositoryRegistry,
  UpsertRepositoryInput,
} from "~/domain/products/repository-registry.js";
import type {
  ProjectSecretDescriptor,
  ProjectSecretKind,
  PutSecretOptions,
  SecretStore,
} from "~/domain/products/secret-store.js";
import { assertSecretKindAndMark, PROJECT_SECRET_KINDS } from "~/domain/products/secret-store.js";
import {
  SKILL_REGISTRY_KINDS,
  type SkillRegistryKind,
  type SkillRegistrySettings,
} from "~/domain/runs/skill-registry.js";
import type {
  InstallationInput,
  InstallationRecord,
  TenantRecord,
  TenantRegistry,
} from "~/domain/products/tenant-registry.js";

/**
 * The column holds free text, so a row written by an older release, or by hand, can name a kind
 * this release does not know. Such a row reads as `test`, the most restricted kind: it reaches an
 * agent session only with the injection mark, and the guard inspects it there.
 */
const asSecretKind = (value: string): ProjectSecretKind =>
  (PROJECT_SECRET_KINDS as readonly string[]).includes(value) ? (value as ProjectSecretKind) : "test";

type ProductRow = {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  linearTeamKey: string;
  linearTeamId: string;
  defaultAutonomy: string;
  riskCaps: Prisma.JsonValue | null;
  allowedDomains: string[];
  maxRunMinutes: number;
  organizationSkillsRepository: string | null;
  skillRegistryKind: string | null;
  skillRegistryUrl: string | null;
  skillRegistrySet: string | null;
  defaultRunner: string;
  model: string | null;
  runnerImplementer: string | null;
  runnerRefiner: string | null;
  runnerValidator: string | null;
  runnerReviewer: string | null;
  runnerSetup: string | null;
  modelImplementer: string | null;
  modelRefiner: string | null;
  modelValidator: string | null;
  modelReviewer: string | null;
  modelSetup: string | null;
  effortImplementer: string | null;
  effortRefiner: string | null;
  effortValidator: string | null;
  effortReviewer: string | null;
  effortSetup: string | null;
  silenceMinutes: number;
  refinerCriteriaLimit: number;
  repairMaxAttempts: number;
  sandboxRetentionHours: number;
  sandboxProviderIds: string[];
  maxConcurrentRuns: number;
  appChangeIssues: string;
  createdAt: Date;
  updatedAt: Date;
};

/** A stored caps value that is not a map of label to level reads as null, the SDD defaults. */
const toRiskCaps = (value: Prisma.JsonValue | null): Record<string, string> | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const caps: Record<string, string> = {};
  for (const [label, level] of Object.entries(value)) {
    if (typeof level === "string") caps[label] = level;
  }
  return caps;
};

/** A row with an unknown kind or no URL has no usable registry, so it reads as none. */
const toSkillRegistry = (kind: string | null, url: string | null, set: string | null): SkillRegistrySettings | null =>
  url !== null && (SKILL_REGISTRY_KINDS as readonly (string | null)[]).includes(kind)
    ? { kind: kind as SkillRegistryKind, url, set }
    : null;

/** A stored runner name that Factoree no longer implements reads as the default. */
const toRunner = (value: string | null): AgentRunnerName | null => (value !== null && isAgentRunnerName(value) ? value : null);

const toProduct = (row: ProductRow): ProductRecord => {
  const {
    defaultRunner,
    runnerImplementer,
    runnerRefiner,
    runnerValidator,
    runnerReviewer,
    runnerSetup,
    modelImplementer,
    modelRefiner,
    modelValidator,
    modelReviewer,
    modelSetup,
    effortImplementer,
    effortRefiner,
    effortValidator,
    effortReviewer,
    effortSetup,
    skillRegistryKind,
    skillRegistryUrl,
    skillRegistrySet,
    ...rest
  } = row;
  return {
    ...rest,
    skillRegistry: toSkillRegistry(skillRegistryKind, skillRegistryUrl, skillRegistrySet),
    riskCaps: toRiskCaps(row.riskCaps),
    status: row.status === "active" ? "active" : "pending",
    appChangeIssues: row.appChangeIssues === "one_for_all" ? "one_for_all" : "one_per_change",
    defaultRunner: toRunner(defaultRunner) ?? "opencode",
    runners: {
      implementer: toRunner(runnerImplementer),
      refiner: toRunner(runnerRefiner),
      validator: toRunner(runnerValidator),
      reviewer: toRunner(runnerReviewer),
      setup: toRunner(runnerSetup),
    },
    models: {
      implementer: modelImplementer,
      refiner: modelRefiner,
      validator: modelValidator,
      reviewer: modelReviewer,
      setup: modelSetup,
    },
    effort: {
      implementer: effortImplementer,
      refiner: effortRefiner,
      validator: effortValidator,
      reviewer: effortReviewer,
      setup: effortSetup,
    },
  };
};

type RepositoryRow = {
  id: string;
  tenantId: string;
  productId: string;
  fullName: string;
  defaultBranch: string;
  configSha: string;
  requestedSecretNames: string[];
  linearProjects: string[];
  discoveredAt: Date;
  lastSeenAt: Date;
  absentSince: Date | null;
  githubInstallationId: string;
};

const toRepository = (row: RepositoryRow): RepositoryRecord => ({ ...row });

export class PrismaProductRegistry implements ProductRegistry {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async create(input: CreateProductInput): Promise<ProductRecord> {
    const row = await this.prisma.product.create({
      data: {
        tenantId: input.tenantId,
        slug: input.slug,
        name: input.name,
        linearTeamKey: input.linearTeamKey,
        linearTeamId: input.linearTeamId,
        ...(input.maxRunMinutes === undefined ? {} : { maxRunMinutes: input.maxRunMinutes }),
        ...(input.organizationSkillsRepository === undefined
          ? {}
          : { organizationSkillsRepository: input.organizationSkillsRepository }),
      },
    });
    return toProduct(row);
  }

  async list(tenantId: string): Promise<ProductRecord[]> {
    const rows = await this.prisma.product.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
    return rows.map(toProduct);
  }

  async findById(tenantId: string, id: string): Promise<ProductRecord | null> {
    const row = await this.prisma.product.findFirst({ where: { id, tenantId } });
    return row ? toProduct(row) : null;
  }

  async findBySlug(tenantId: string, slug: string): Promise<ProductRecord | null> {
    const row = await this.prisma.product.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
    });
    return row ? toProduct(row) : null;
  }

  // The column pair carries a unique constraint, so this reads one row or none. There is no
  // fallback to a tenant default, because specification section 9 forbids a guess.
  async findByLinearTeamId(tenantId: string, linearTeamId: string): Promise<ProductRecord | null> {
    const row = await this.prisma.product.findUnique({
      where: { tenantId_linearTeamId: { tenantId, linearTeamId } },
    });
    return row ? toProduct(row) : null;
  }

  async activate(tenantId: string, id: string, defaultAutonomy: string): Promise<ProductRecord | null> {
    const existing = await this.findById(tenantId, id);
    if (!existing) return null;
    const row = await this.prisma.product.update({
      where: { id },
      data: { status: "active", defaultAutonomy },
    });
    return toProduct(row);
  }

  async renameLinearTeamKey(
    tenantId: string,
    id: string,
    linearTeamKey: string,
  ): Promise<ProductRecord | null> {
    const existing = await this.findById(tenantId, id);
    if (!existing) return null;
    const row = await this.prisma.product.update({
      where: { id },
      data: { linearTeamKey },
    });
    return toProduct(row);
  }

  async updateOrganizationSkillsRepository(
    tenantId: string,
    id: string,
    organizationSkillsRepository: string | null,
  ): Promise<ProductRecord | null> {
    const existing = await this.findById(tenantId, id);
    if (!existing) return null;
    const row = await this.prisma.product.update({
      where: { id },
      data: { organizationSkillsRepository },
    });
    return toProduct(row);
  }

  async updateSkillRegistry(
    tenantId: string,
    id: string,
    skillRegistry: SkillRegistrySettings | null,
  ): Promise<ProductRecord | null> {
    const existing = await this.findById(tenantId, id);
    if (!existing) return null;
    const row = await this.prisma.product.update({
      where: { id },
      data: {
        skillRegistryKind: skillRegistry?.kind ?? null,
        skillRegistryUrl: skillRegistry?.url ?? null,
        skillRegistrySet: skillRegistry?.set ?? null,
      },
    });
    return toProduct(row);
  }

  async update(
    tenantId: string,
    id: string,
    fields: { name?: string; maxRunMinutes?: number },
  ): Promise<ProductRecord | null> {
    const existing = await this.findById(tenantId, id);
    if (!existing) return null;
    const row = await this.prisma.product.update({
      where: { id },
      data: {
        ...(fields.name === undefined ? {} : { name: fields.name }),
        ...(fields.maxRunMinutes === undefined ? {} : { maxRunMinutes: fields.maxRunMinutes }),
      },
    });
    return toProduct(row);
  }

  async updatePolicy(
    tenantId: string,
    id: string,
    policy: ProductPolicyUpdate,
  ): Promise<ProductRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.product.findFirst({ where: { id, tenantId } });
      if (existing === null) return null;
      const changes: Array<{ field: string; oldValue: Prisma.InputJsonValue | typeof Prisma.JsonNull; newValue: Prisma.InputJsonValue }> = [];
      if (policy.defaultAutonomy !== undefined && policy.defaultAutonomy !== existing.defaultAutonomy) {
        changes.push({ field: "defaultAutonomy", oldValue: existing.defaultAutonomy, newValue: policy.defaultAutonomy });
      }
      if (
        policy.riskCaps !== undefined &&
        JSON.stringify(policy.riskCaps) !== JSON.stringify(toRiskCaps(existing.riskCaps))
      ) {
        changes.push({
          field: "riskCaps",
          oldValue: existing.riskCaps ?? Prisma.JsonNull,
          newValue: policy.riskCaps,
        });
      }
      if (
        policy.allowedDomains !== undefined &&
        JSON.stringify(policy.allowedDomains) !== JSON.stringify(existing.allowedDomains)
      ) {
        changes.push({ field: "allowedDomains", oldValue: existing.allowedDomains, newValue: policy.allowedDomains });
      }
      const row = await tx.product.update({
        where: { id },
        data: {
          ...(policy.defaultAutonomy === undefined ? {} : { defaultAutonomy: policy.defaultAutonomy }),
          ...(policy.riskCaps === undefined ? {} : { riskCaps: policy.riskCaps }),
          ...(policy.allowedDomains === undefined ? {} : { allowedDomains: policy.allowedDomains }),
        },
      });
      for (const change of changes) {
        await tx.productPolicyChange.create({
          data: { tenantId, productId: id, field: change.field, oldValue: change.oldValue, newValue: change.newValue },
        });
      }
      return toProduct(row);
    });
  }

  async updateSettings(tenantId: string, id: string, settings: ProductSettingsUpdate): Promise<ProductRecord | null> {
    const data = Object.fromEntries(
      Object.entries({
        defaultRunner: settings.defaultRunner,
        model: settings.model,
        runnerImplementer: settings.runners?.implementer,
        runnerRefiner: settings.runners?.refiner,
        runnerValidator: settings.runners?.validator,
        runnerReviewer: settings.runners?.reviewer,
        runnerSetup: settings.runners?.setup,
        modelImplementer: settings.models?.implementer,
        modelRefiner: settings.models?.refiner,
        modelValidator: settings.models?.validator,
        modelReviewer: settings.models?.reviewer,
        modelSetup: settings.models?.setup,
        effortImplementer: settings.effort?.implementer,
        effortRefiner: settings.effort?.refiner,
        effortValidator: settings.effort?.validator,
        effortReviewer: settings.effort?.reviewer,
        effortSetup: settings.effort?.setup,
        silenceMinutes: settings.silenceMinutes,
        refinerCriteriaLimit: settings.refinerCriteriaLimit,
        repairMaxAttempts: settings.repairMaxAttempts,
        sandboxRetentionHours: settings.sandboxRetentionHours,
        sandboxProviderIds: settings.sandboxProviderIds,
        maxConcurrentRuns: settings.maxConcurrentRuns,
        appChangeIssues: settings.appChangeIssues,
      }).filter(([, value]) => value !== undefined),
    );
    const updated = await this.prisma.product.updateMany({ where: { tenantId, id }, data });
    if (updated.count === 0) return null;
    return this.findById(tenantId, id);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    // The tenant filter is part of the query. SDD section 52 forbids a write across the
    // boundary. `deleteMany` reports the count, so a wrong tenant or a wrong id answers false
    // rather than throwing.
    const removed = await this.prisma.product.deleteMany({ where: { id, tenantId } });
    return removed.count > 0;
  }
}

export class PrismaRepositoryRegistry implements RepositoryRegistry, RepositorySetupMarks {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async upsert(input: UpsertRepositoryInput): Promise<RepositoryRecord> {
    const row = await this.prisma.repository.upsert({
      where: { tenantId_fullName: { tenantId: input.tenantId, fullName: input.fullName } },
      create: {
        tenantId: input.tenantId,
        productId: input.productId,
        fullName: input.fullName,
        defaultBranch: input.defaultBranch,
        configSha: input.configSha,
        requestedSecretNames: input.requestedSecretNames,
        linearProjects: input.linearProjects,
        githubInstallationId: input.githubInstallationId,
      },
      update: {
        productId: input.productId,
        defaultBranch: input.defaultBranch,
        configSha: input.configSha,
        requestedSecretNames: input.requestedSecretNames,
        githubInstallationId: input.githubInstallationId,
        lastSeenAt: new Date(),
        absentSince: null,
      },
    });
    return toRepository(row);
  }

  async listByProduct(productId: string): Promise<RepositoryRecord[]> {
    const rows = await this.prisma.repository.findMany({
      where: { productId },
      orderBy: { discoveredAt: "asc" },
    });
    return rows.map(toRepository);
  }

  /** docs/specs/run-speed.md. Every repository of the install that discovery still sees. */
  async listPresent(): Promise<RepositoryRecord[]> {
    const rows = await this.prisma.repository.findMany({
      where: { absentSince: null },
      orderBy: { discoveredAt: "asc" },
    });
    return rows.map(toRepository);
  }

  async findByFullName(tenantId: string, fullName: string): Promise<RepositoryRecord | null> {
    const row = await this.prisma.repository.findUnique({
      where: { tenantId_fullName: { tenantId, fullName } },
    });
    return row ? toRepository(row) : null;
  }

  async markNeedsSetup(tenantId: string, fullName: string, reason: string, at: Date): Promise<void> {
    await this.prisma.repository.updateMany({ where: { tenantId, fullName }, data: { needsSetupReason: reason.slice(0, 2000), needsSetupAt: at } });
  }

  async clearNeedsSetup(tenantId: string, fullName: string): Promise<void> {
    await this.prisma.repository.updateMany({ where: { tenantId, fullName, NOT: { needsSetupReason: null } }, data: { needsSetupReason: null, needsSetupAt: null } });
  }

  async markAbsent(tenantId: string, fullName: string, at: Date): Promise<void> {
    const existing = await this.findByFullName(tenantId, fullName);
    if (!existing) return;
    await this.prisma.repository.update({
      where: { tenantId_fullName: { tenantId, fullName } },
      data: { absentSince: at },
    });
  }
}

export class PrismaSecretStore implements SecretStore {
  constructor(private readonly prisma: FactoreePrismaClient, private readonly keyHex: string) {}

  async put(
    tenantId: string,
    productId: string,
    name: string,
    value: string,
    options?: PutSecretOptions,
  ): Promise<void> {
    const product = await this.prisma.product.findFirst({ where: { id: productId, tenantId } });
    if (!product) throw new Error("product not found for tenant");
    const valueCipher = encryptSecret(value, this.keyHex);
    // The mark defaults to false. A secret an operator does not mark never reaches the
    // Implementer environment. SDD section 30 requires the injection to be explicit.
    const injectIntoImplementer = options?.injectIntoImplementer ?? false;
    const kind = options?.kind ?? "test";
    // The store is the last gate before the row exists. A credential that carries the injection
    // mark would reach the Implementer environment, and SDD section 30 forbids that.
    assertSecretKindAndMark(kind, injectIntoImplementer);
    await this.prisma.productSecret.upsert({
      where: { productId_name: { productId, name } },
      create: { tenantId, productId, name, valueCipher, injectIntoImplementer, kind },
      update: { valueCipher, injectIntoImplementer, kind },
    });
  }

  async get(tenantId: string, productId: string, name: string): Promise<string | null> {
    const row = await this.prisma.productSecret.findFirst({ where: { tenantId, productId, name } });
    return row ? decryptSecret(row.valueCipher, this.keyHex) : null;
  }

  async listNames(tenantId: string, productId: string): Promise<string[]> {
    const rows = await this.prisma.productSecret.findMany({
      where: { tenantId, productId },
      orderBy: { name: "asc" },
    });
    return rows.map((row) => row.name);
  }

  async list(tenantId: string, productId: string): Promise<ProjectSecretDescriptor[]> {
    const rows = await this.prisma.productSecret.findMany({
      where: { tenantId, productId },
      orderBy: { name: "asc" },
    });
    return rows.map((row) => ({
      name: row.name,
      injectIntoImplementer: row.injectIntoImplementer,
      kind: asSecretKind(row.kind),
    }));
  }

  async remove(tenantId: string, productId: string, name: string): Promise<boolean> {
    const row = await this.prisma.productSecret.findFirst({ where: { tenantId, productId, name } });
    if (!row) return false;
    await this.prisma.productSecret.delete({ where: { id: row.id } });
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

  async getInstallation(linearWorkspaceId: string): Promise<InstallationRecord | null> {
    const row = await this.prisma.linearInstallation.findUnique({
      where: { linearWorkspaceId },
      include: { tenant: true },
    });
    if (!row) return null;
    return {
      linearWorkspaceId: row.linearWorkspaceId,
      workspaceName: row.tenant.name,
      appUserId: row.appUserId,
      accessToken: decryptSecret(row.accessTokenCipher, this.keyHex),
      refreshToken:
        row.refreshTokenCipher === null ? null : decryptSecret(row.refreshTokenCipher, this.keyHex),
      expiresAt: row.expiresAt,
      scopes: row.scopes,
    };
  }

  async findByGitHubInstallation(githubInstallationId: string): Promise<TenantRecord | null> {
    const row = await this.prisma.gitHubInstallation.findUnique({
      where: { githubInstallationId },
      include: { tenant: true },
    });
    return row ? { id: row.tenant.id, linearWorkspaceId: row.tenant.linearWorkspaceId, name: row.tenant.name } : null;
  }

  async putGitHubInstallation(
    tenantId: string,
    githubInstallationId: string,
    accountLogin: string,
  ): Promise<"bound" | "held_by_another_tenant"> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.gitHubInstallation.findUnique({ where: { githubInstallationId } });
      // A rebind would silently give one tenant's repositories to another tenant.
      if (existing !== null && existing.tenantId !== tenantId) return "held_by_another_tenant";
      await tx.gitHubInstallation.upsert({
        where: { githubInstallationId },
        create: { tenantId, githubInstallationId, accountLogin },
        update: { accountLogin },
      });
      return "bound";
    });
  }
}
