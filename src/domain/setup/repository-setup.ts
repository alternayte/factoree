import type { SetupReport } from "./setup-report.js";

/** docs/specs/repository-setup-and-services.md. The state of one setup run. */
export type RepositorySetupStatus = "queued" | "running" | "proposed" | "partial" | "failed";

/** The usage of the setup agent session, in the shape a run records per role. */
export interface SetupSessionUsage {
  runner: string;
  model: string | null;
  effort: string | null;
  outcome: string;
  durationMs: number;
  tokens: number | null;
  costUsd: number | null;
}

export interface RepositorySetupRecord {
  id: string;
  tenantId: string;
  productId: string;
  repositoryFullName: string;
  githubInstallationId: string;
  workflowId: string;
  status: RepositorySetupStatus;
  pullRequestUrl: string | null;
  report: SetupReport | null;
  failureMessage: string | null;
  sessionUsage: SetupSessionUsage | null;
  createdAt: Date;
  endedAt: Date | null;
}

export interface RepositorySetupStore {
  create(input: Pick<RepositorySetupRecord, "tenantId" | "productId" | "repositoryFullName" | "githubInstallationId" | "workflowId">): Promise<RepositorySetupRecord>;
  findById(id: string): Promise<RepositorySetupRecord | null>;
  /** The newest setup of each repository of the product. */
  latestByProduct(productId: string): Promise<RepositorySetupRecord[]>;
  update(
    id: string,
    patch: Partial<Pick<RepositorySetupRecord, "status" | "pullRequestUrl" | "report" | "failureMessage" | "sessionUsage" | "endedAt">>,
  ): Promise<void>;
}

/** docs/specs/repository-setup-and-services.md. The repository marks a failed build-ahead sets. */
export interface RepositorySetupMarks {
  markNeedsSetup(tenantId: string, fullName: string, reason: string, at: Date): Promise<void>;
  clearNeedsSetup(tenantId: string, fullName: string): Promise<void>;
}

/** One setup per repository at a time, so a second start finds the running one. */
export const setupWorkflowId = (tenantId: string, repositoryFullName: string): string =>
  `repository-setup:${tenantId}:${repositoryFullName}`;

/** The id a setup sandbox carries where a run sandbox carries its run id. */
export const setupSandboxRunId = (setupId: string): string => `setup:${setupId}`;

/** The branch a setup pull request uses. */
export const setupBranchName = (setupId: string): string => `factoree/setup-${setupId}`;
