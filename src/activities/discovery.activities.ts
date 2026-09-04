import { ApplicationFailure } from "@temporalio/activity";
import type { DiscoveredRepository, RepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";
import { GitHubApiError } from "~/adapters/github/github-pull-requests.js";
import type { DiscoveryOutcome, DiscoveryService } from "~/domain/products/discovery-service.js";
import type { Logger } from "~/telemetry/logger.js";

export interface ListInstallationRepositoriesActivityInput {
  githubInstallationId: string;
}

export interface SyncOneRepositoryActivityInput {
  tenantId: string;
  fullName: string;
  defaultBranch: string;
  githubInstallationId: string;
}

/** The workflow counts by kind alone. It never sees the repository id or the conflict reason. */
export interface SyncOneRepositoryActivityOutput {
  kind: DiscoveryOutcome["kind"];
}

export interface DiscoveryActivitiesDependencies {
  discoveryClient: RepositoryDiscoveryClient;
  discoveryService: DiscoveryService;
  logger: Logger;
}

/**
 * Turns a `GitHubApiError` into the failure Temporal's retry policy reacts to. GitHub answers a
 * real permission fault and a rate limit with the same status, 403, so the two must be told
 * apart by the headers, not the status alone.
 *
 * A rate limit, `x-ratelimit-remaining` at zero, becomes a retryable failure. Its `retry-after`
 * header, in seconds, becomes the delay before the next attempt, so Temporal waits exactly as
 * long as GitHub asks. A deterministic client fault, for example a 401 or a 403 that carries no
 * rate-limit header, becomes non-retryable, so a run does not spend its retry budget on a fault
 * no attempt can fix.
 */
const toApplicationFailure = (error: unknown): unknown => {
  if (!(error instanceof GitHubApiError)) return error;
  const remaining = error.headers?.["x-ratelimit-remaining"];
  if (error.status === 403 && remaining === "0") {
    const retryAfterSeconds = Number(error.headers?.["retry-after"]);
    return ApplicationFailure.create({
      message: error.message,
      type: "GITHUB_RATE_LIMITED",
      nonRetryable: false,
      nextRetryDelay: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? `${String(retryAfterSeconds)} seconds` : undefined,
    });
  }
  if (error.deterministic) {
    return ApplicationFailure.create({ message: error.message, type: "GITHUB_API_ERROR", nonRetryable: true });
  }
  return ApplicationFailure.create({ message: error.message, type: "GITHUB_API_ERROR", nonRetryable: false });
};

/**
 * Specification section 10. These activities hold every GitHub call and every clock read the
 * installation sync needs, so `syncInstallationWorkflow` stays deterministic.
 */
export const createDiscoveryActivities = (dependencies: DiscoveryActivitiesDependencies) => ({
  async listInstallationRepositories(
    input: ListInstallationRepositoriesActivityInput,
  ): Promise<DiscoveredRepository[]> {
    try {
      return await dependencies.discoveryClient.listInstallationRepositories(input.githubInstallationId);
    } catch (error) {
      throw toApplicationFailure(error);
    }
  },

  async syncOneRepository(input: SyncOneRepositoryActivityInput): Promise<SyncOneRepositoryActivityOutput> {
    try {
      const outcome = await dependencies.discoveryService.syncRepository(
        input.tenantId,
        input.fullName,
        input.defaultBranch,
        input.githubInstallationId,
      );
      return { kind: outcome.kind };
    } catch (error) {
      throw toApplicationFailure(error);
    }
  },
});

export type DiscoveryActivities = ReturnType<typeof createDiscoveryActivities>;
