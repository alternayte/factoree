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
    // The endpoint must be a URL an operator can repair now, not a fault inside a Run.
    let endpoint: URL;
    try {
      endpoint = new URL(input.endpoint);
    } catch {
      throw new ContextSourceConfigurationError(
        `The endpoint "${input.endpoint}" is not a valid URL.`,
      );
    }
    // SDD section 60. A credential in the userinfo of the endpoint would reach a log line, an
    // error message, and the Context Contract. The token belongs in a Product secret, which the
    // source reads through `secretName`. The message never echoes the credential.
    if (endpoint.username !== "" || endpoint.password !== "") {
      throw new ContextSourceConfigurationError(
        `The endpoint of the context source "${input.sourceId}" carries a user name or a ` +
          "password. Remove the credential from the URL, and name a Product secret instead.",
      );
    }
    // A configuration endpoint is a base address. A query string or a fragment carries no base
    // address, and it is where a token outside the userinfo hides. The message names the problem
    // and never echoes the value.
    if (endpoint.search !== "" || endpoint.hash !== "") {
      throw new ContextSourceConfigurationError(
        `The endpoint of the context source "${input.sourceId}" carries a query string or a ` +
          "fragment. An endpoint is a base address, and a credential belongs in a Product secret.",
      );
    }
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
}
