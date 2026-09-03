import type { FactoreePrismaClient } from "./client.js";
import { decryptSecret, encryptSecret } from "~/domain/policy/crypto.js";
import type {
  CreateProductInput,
  ProductRecord,
  ProductRegistry,
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
  maxRunMinutes: number;
  organizationSkillsRepository: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const toProduct = (row: ProductRow): ProductRecord => ({
  ...row,
  status: row.status === "active" ? "active" : "pending",
});

type RepositoryRow = {
  id: string;
  tenantId: string;
  productId: string;
  fullName: string;
  defaultBranch: string;
  configSha: string;
  requestedSecretNames: string[];
  discoveredAt: Date;
  lastSeenAt: Date;
  absentSince: Date | null;
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
}

export class PrismaRepositoryRegistry implements RepositoryRegistry {
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
      },
      update: {
        productId: input.productId,
        defaultBranch: input.defaultBranch,
        configSha: input.configSha,
        requestedSecretNames: input.requestedSecretNames,
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

  async findByFullName(tenantId: string, fullName: string): Promise<RepositoryRecord | null> {
    const row = await this.prisma.repository.findUnique({
      where: { tenantId_fullName: { tenantId, fullName } },
    });
    return row ? toRepository(row) : null;
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
