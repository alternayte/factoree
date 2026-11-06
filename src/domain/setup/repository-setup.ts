import type { SetupReport } from "./setup-report.js";

/** docs/specs/repository-setup-and-services.md. The state of one setup run. */
export type RepositorySetupStatus = "queued" | "running" | "proposed" | "partial" | "failed" | "merged";

/** The usage of the setup agent session, in the shape a run records per role. */
export interface SetupSessionUsage {
  runner: string;
  model: string | null;
  effort: string | null;
  outcome: string;
  durationMs: number;
  tokens: number | null;
  costUsd: number | null;
  /**
   * The model calls of the session, its longest call, and the time it spent waiting on the model
   * and in tool calls, as AgentSessionUsage records them for a run. Absent in a record made
   * before they existed. DI-21.14.
   */
  turns?: number | null;
  longestTurnMs?: number | null;
  modelMs?: number | null;
  toolMs?: number | null;
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
  /** docs/specs/setup-app-change-issues.md. The setup started when this setup's app-change issues ended. */
  followUpSetupId: string | null;
  createdAt: Date;
  endedAt: Date | null;
}

export interface RepositorySetupStore {
  create(input: Pick<RepositorySetupRecord, "tenantId" | "productId" | "repositoryFullName" | "githubInstallationId" | "workflowId">): Promise<RepositorySetupRecord>;
  findById(id: string): Promise<RepositorySetupRecord | null>;
  /** The newest setup of each repository of the product. */
  latestByProduct(productId: string): Promise<RepositorySetupRecord[]>;
  /** DI-21.18. The newest setup of the repository before the given one that holds a report, or null. */
  previousWithReport(productId: string, repositoryFullName: string, before: Date): Promise<RepositorySetupRecord | null>;
  /** docs/specs/setup-app-change-issues.md. The newest setup of the repository whose pull request is open, or null. */
  latestOpenPullRequest(tenantId: string, repositoryFullName: string): Promise<RepositorySetupRecord | null>;
  update(
    id: string,
    patch: Partial<Pick<RepositorySetupRecord, "status" | "pullRequestUrl" | "report" | "failureMessage" | "sessionUsage" | "endedAt" | "followUpSetupId">>,
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
