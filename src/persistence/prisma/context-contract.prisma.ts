import type { PrismaClient } from "@prisma/client";
import type {
  ContextContractStore,
  SaveContextContractInput,
  StoredContextContract,
} from "~/domain/context/context-contract-store.js";
import type { ContextConflictRecord, SelectedContextItem } from "~/domain/context/conflicts.js";
import type { AuthorityClass, AuthorityDomain } from "~/domain/context/authority.js";
import { isAuthorityClass, isAuthorityDomain } from "~/domain/context/authority.js";
import type { ContextClassification } from "~/domain/context/context-source.js";
import { CONTEXT_CLASSIFICATIONS } from "~/domain/context/context-source.js";

const CLASSIFICATIONS = new Set<string>(CONTEXT_CLASSIFICATIONS);

/** The store throws this error when a column holds a value no domain list allows. */
export class ContextContractRowInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextContractRowInvalidError";
  }
}

/**
 * A column holds a plain string. The store guards the value it reads back, and never casts it.
 * Phase 3 left a bare cast on `Evidence.kind` and recorded that as a finding. This store does not
 * repeat the defect.
 */
const toAuthority = (value: string, ref: string): AuthorityClass => {
  if (!isAuthorityClass(value)) {
    throw new ContextContractRowInvalidError(
      `Context item "${ref}" holds the unknown authority class "${value}".`,
    );
  }
  return value;
};

const isClassification = (value: string): value is ContextClassification =>
  CLASSIFICATIONS.has(value);

const toClassification = (value: string, ref: string): ContextClassification => {
  if (!isClassification(value)) {
    throw new ContextContractRowInvalidError(
      `Context item "${ref}" holds the unknown classification "${value}".`,
    );
  }
  return value;
};

const toDomain = (value: string, key: string): AuthorityDomain => {
  if (!isAuthorityDomain(value)) {
    throw new ContextContractRowInvalidError(
      `Context conflict "${key}" holds the unknown authority domain "${value}".`,
    );
  }
  return value;
};

const toResolution = (value: string, key: string): ContextConflictRecord["resolution"] => {
  if (value !== "resolved" && value !== "unresolved") {
    throw new ContextContractRowInvalidError(
      `Context conflict "${key}" holds the unknown resolution "${value}".`,
    );
  }
  return value;
};

interface ItemRow {
  sourceId: string;
  ref: string;
  repository: string | null;
  sha: string | null;
  path: string | null;
  sourceVersion: string;
  authority: string;
  reason: string;
  classification: string;
  topics: string[];
  contentSha256: string | null;
}

interface ConflictRow {
  conflictKey: string;
  subject: string;
  authorityDomain: string;
  winnerRef: string | null;
  loserRef: string | null;
  reason: string;
  resolution: string;
}

interface ContractRow {
  id: string;
  tenantId: string;
  runId: string;
  version: number;
  sha256: string;
  document: string;
  createdAt: Date;
  items: ItemRow[];
  conflicts: ConflictRow[];
}

const toItem = (row: ItemRow): SelectedContextItem => ({
  reference: {
    sourceId: row.sourceId,
    ref: row.ref,
    repository: row.repository,
    sha: row.sha,
    path: row.path,
  },
  sourceVersion: row.sourceVersion,
  authority: toAuthority(row.authority, row.ref),
  reason: row.reason,
  classification: toClassification(row.classification, row.ref),
  topics: row.topics,
  contentSha256: row.contentSha256,
});

const toConflict = (row: ConflictRow): ContextConflictRecord => ({
  id: row.conflictKey,
  subject: row.subject,
  authorityDomain: toDomain(row.authorityDomain, row.conflictKey),
  winnerRef: row.winnerRef,
  loserRef: row.loserRef,
  reason: row.reason,
  resolution: toResolution(row.resolution, row.conflictKey),
});

const toStored = (row: ContractRow): StoredContextContract => ({
  id: row.id,
  tenantId: row.tenantId,
  runId: row.runId,
  version: row.version,
  sha256: row.sha256,
  document: row.document,
  items: row.items.map(toItem),
  conflicts: row.conflicts.map(toConflict),
  createdAt: row.createdAt,
});

export class PrismaContextContractStore implements ContextContractStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * SDD section 21. The contract is immutable, so an existing contract wins and the store writes
   * nothing. A Temporal activity retry therefore cannot produce a second version. Prisma writes
   * the contract, every item, and every conflict in one nested create, which runs in one
   * transaction.
   */
  async save(input: SaveContextContractInput): Promise<StoredContextContract> {
    const existing = await this.newestRow(input.runId);
    if (existing !== null) {
      // DI-21.143. Only a save that supersedes the newest contract adds a revision. A retry of it
      // finds the revision it wrote, which supersedes nothing it names.
      const superseded = input.supersedes !== undefined && existing.sha256 === input.supersedes && existing.sha256 !== input.sha256;
      if (!superseded) return toStored(existing);
    }

    try {
      const row = await this.prisma.contextContract.create({
        data: {
          tenantId: input.tenantId,
          runId: input.runId,
          revision: (existing?.revision ?? 0) + 1,
          version: input.contract.version,
          sha256: input.sha256,
          document: input.document,
          items: {
            create: input.contract.items.map((item) => ({
              tenantId: input.tenantId,
              sourceId: item.reference.sourceId,
              ref: item.reference.ref,
              repository: item.reference.repository,
              sha: item.reference.sha,
              path: item.reference.path,
              sourceVersion: item.sourceVersion,
              authority: item.authority,
              reason: item.reason,
              classification: item.classification,
              topics: item.topics,
              contentSha256: item.contentSha256,
            })),
          },
          conflicts: {
            create: input.contract.conflicts.map((conflict) => ({
              tenantId: input.tenantId,
              conflictKey: conflict.id,
              subject: conflict.subject,
              authorityDomain: conflict.authorityDomain,
              winnerRef: conflict.winnerRef,
              loserRef: conflict.loserRef,
              reason: conflict.reason,
              resolution: conflict.resolution,
            })),
          },
        },
        include: { items: true, conflicts: true },
      });
      return toStored(row);
    } catch (error) {
      // Two concurrent attempts can both miss the read above. The unique index on the run and the
      // revision decides the race. The loser reads the contract the winner wrote, and does not
      // fail the Run.
      const row = await this.newestRow(input.runId);
      if (row !== null && row.revision > (existing?.revision ?? 0)) return toStored(row);
      throw error;
    }
  }

  private newestRow(runId: string) {
    return this.prisma.contextContract.findFirst({
      where: { runId },
      orderBy: { revision: "desc" },
      include: { items: true, conflicts: true },
    });
  }

  async findByRun(tenantId: string, runId: string): Promise<StoredContextContract | null> {
    const row = await this.newestRow(runId);
    // SDD section 52. The read applies the tenant boundary as well as the write.
    if (row === null || row.tenantId !== tenantId) return null;
    return toStored(row);
  }
}
