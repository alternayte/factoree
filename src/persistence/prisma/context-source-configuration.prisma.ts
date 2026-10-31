import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  ContextSourceConfigurationRecord,
  ContextSourceConfigurationStore,
  ContextSourceKind,
  CreateContextSourceConfigurationInput,
} from "~/domain/context/context-source-configuration.js";
import {
  CONTEXT_SOURCE_KINDS,
  ContextSourceConfigurationError,
  assertContextSourceEndpoint,
  assertContextSourceId,
  parseContextSourceSettings,
} from "~/domain/context/context-source-configuration.js";

/**
 * A stored string column is guarded rather than cast, the way the Phase 4 context store guards
 * every column it reads back.
 */
const asKind = (value: string): ContextSourceKind => {
  if ((CONTEXT_SOURCE_KINDS as readonly string[]).includes(value)) return value as ContextSourceKind;
  throw new ContextSourceConfigurationError(`"${value}" is not a context source kind.`);
};

interface Row {
  id: string;
  tenantId: string;
  productId: string;
  sourceId: string;
  kind: string;
  enabled: boolean;
  endpoint: string;
  secretName: string | null;
  settings: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const toRecord = (row: Row): ContextSourceConfigurationRecord => {
  const kind = asKind(row.kind);
  return {
    id: row.id,
    tenantId: row.tenantId,
    productId: row.productId,
    sourceId: row.sourceId,
    kind,
    enabled: row.enabled,
    endpoint: row.endpoint,
    secretName: row.secretName,
    settings: parseContextSourceSettings(kind, row.settings),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

export class PrismaContextSourceConfigurationStore implements ContextSourceConfigurationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async put(
    input: CreateContextSourceConfigurationInput,
  ): Promise<ContextSourceConfigurationRecord> {
    assertContextSourceId(input.sourceId);
    const settings = parseContextSourceSettings(input.kind, input.settings);
    assertContextSourceEndpoint(input.sourceId, input.endpoint);
    const data = {
      tenantId: input.tenantId,
      productId: input.productId,
      sourceId: input.sourceId,
      kind: input.kind,
      enabled: input.enabled ?? true,
      endpoint: input.endpoint,
      secretName: input.secretName ?? null,
      settings: settings as unknown as Prisma.InputJsonValue,
    };
    const row = await this.prisma.contextSourceConfiguration.upsert({
      where: { productId_sourceId: { productId: input.productId, sourceId: input.sourceId } },
      create: data,
      update: data,
    });
    return toRecord(row);
  }

  async list(tenantId: string, productId: string): Promise<ContextSourceConfigurationRecord[]> {
    const rows = await this.prisma.contextSourceConfiguration.findMany({
      where: { tenantId, productId },
      orderBy: { sourceId: "asc" },
    });
    return rows.map((row) => toRecord(row as Row));
  }

  async remove(tenantId: string, productId: string, sourceId: string): Promise<boolean> {
    const result = await this.prisma.contextSourceConfiguration.deleteMany({
      where: { tenantId, productId, sourceId },
    });
    return result.count > 0;
  }

  async lastReads(tenantId: string, productId: string): Promise<Map<string, Date>> {
    // A Context Item exists only when its source answered, so the newest one of a source is the
    // last read that reached a contract. The tenant filter is part of the query, SDD section 52.
    const groups = await this.prisma.contextItem.groupBy({
      by: ["sourceId"],
      where: { tenantId, contextContract: { run: { tenantId, productId } } },
      _max: { createdAt: true },
    });
    const reads = new Map<string, Date>();
    for (const group of groups) {
      if (group._max.createdAt !== null) reads.set(group.sourceId, group._max.createdAt);
    }
    return reads;
  }
}
