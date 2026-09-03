export interface RepositoryRecord {
  id: string;
  tenantId: string;
  productId: string;
  fullName: string;
  defaultBranch: string;
  configSha: string;
  requestedSecretNames: string[];
  discoveredAt: Date;
  lastSeenAt: Date;
  /** Set when the configuration file disappears. Null while discovery still sees the file. */
  absentSince: Date | null;
}

export interface UpsertRepositoryInput {
  tenantId: string;
  productId: string;
  fullName: string;
  defaultBranch: string;
  configSha: string;
  requestedSecretNames: string[];
}

/**
 * A Repository owns build mechanics under one Product. `upsert` keys on tenant and full name, so
 * discovery can run again over the same repository without creating a duplicate row.
 */
export interface RepositoryRegistry {
  upsert(input: UpsertRepositoryInput): Promise<RepositoryRecord>;
  listByProduct(productId: string): Promise<RepositoryRecord[]>;
  findByFullName(tenantId: string, fullName: string): Promise<RepositoryRecord | null>;
  /** Marks the row absent as of `at`. The row stays, so the Run history survives. */
  markAbsent(tenantId: string, fullName: string, at: Date): Promise<void>;
}
