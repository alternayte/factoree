import type { SandboxMinimum } from "~/domain/settings/install-settings.js";
import type { RepositoryMembership } from "./membership.js";

export interface RepositoryRecord {
  id: string;
  tenantId: string;
  productId: string;
  fullName: string;
  defaultBranch: string;
  configSha: string;
  requestedSecretNames: string[];
  /** The Linear project names `.factoree/config.yaml` declares under `identity.linear.projects`. */
  linearProjects: string[];
  discoveredAt: Date;
  lastSeenAt: Date;
  /** Set when the configuration file disappears. Null while discovery still sees the file. */
  absentSince: Date | null;
  /** The installation that granted access to this repository. A clone or a push mints its token against it. */
  githubInstallationId: string;
  /** docs/specs/repository-setup-and-services.md. Why a build-ahead marked it for setup, or null. */
  needsSetupReason?: string | null;
  /** docs/specs/repository-membership.md. Only an accepted repository is a member of its product. */
  membership: RepositoryMembership;
  /** The display name of the admin who decided, or null for an acceptance no person made. */
  membershipDecidedBy: string | null;
  membershipDecidedAt: Date | null;
  /** docs/specs/sandbox-memory-and-size.md. The `sandbox` minimum discovery last read, or null. */
  sandboxMinimum?: SandboxMinimum | null;
}

export interface UpsertRepositoryInput {
  tenantId: string;
  productId: string;
  fullName: string;
  defaultBranch: string;
  configSha: string;
  requestedSecretNames: string[];
  linearProjects: string[];
  githubInstallationId: string;
  /** docs/specs/sandbox-memory-and-size.md. The `sandbox` minimum of the config, or null. */
  sandboxMinimum?: SandboxMinimum | null;
  /**
   * docs/specs/repository-membership.md. Set only when the claim is new to the product. Absent, the
   * row keeps its decision.
   */
  membership?: RepositoryMembership;
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
  /**
   * docs/specs/repository-membership.md. Records an admin decision on the claim of one repository of
   * one product. Null when the repository does not claim that product.
   */
  decideMembership(input: {
    tenantId: string;
    productId: string;
    repositoryId: string;
    membership: "accepted" | "rejected";
    decidedBy: string | null;
    at: Date;
  }): Promise<RepositoryRecord | null>;
}
