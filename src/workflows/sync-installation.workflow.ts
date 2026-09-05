import { log, proxyActivities } from "@temporalio/workflow";
import type { Activities } from "~/activities/index.js";

/**
 * Specification section 10. The webhook answers GitHub in seconds. This workflow does the slow
 * work. Temporal owns it, so a restart does not lose a sync in progress.
 */
const CONCURRENCY = 4;

export interface SyncInstallationWorkflowInput {
  tenantId: string;
  githubInstallationId: string;
}

export interface SyncInstallationWorkflowOutput {
  registered: number;
  skipped: number;
  conflicted: number;
}

const activities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, initialInterval: "1 second", backoffCoefficient: 2, maximumInterval: "1 minute" },
});

/**
 * Runs `fn` over `items`, at most `limit` calls in flight at once. A failed call does not stop
 * the pool: the workflow records the failure and continues with the rest, because one bad
 * repository must not cost the installation the whole sync.
 */
const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<(R | null)[]> => {
  const results: (R | null)[] = new Array<R | null>(items.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index] as T);
      } catch (error) {
        // The activity already exhausted its retry policy. This repository does not
        // participate in the count, but every other repository still gets its turn.
        log.warn("a repository sync failed after every retry", { error: String(error) });
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
};

/**
 * Specification section 10. Reads every repository a GitHub App installation grants, then syncs
 * each one's `.factoree/config.yaml` declaration. Keyed by the installation id in
 * `buildSyncInstallationWorkflowId`, so a repeated `installation` webhook joins the run already
 * in flight rather than starting a second one.
 */
export const syncInstallationWorkflow = async (
  input: SyncInstallationWorkflowInput,
): Promise<SyncInstallationWorkflowOutput> => {
  const repositories = await activities.listInstallationRepositories({
    githubInstallationId: input.githubInstallationId,
  });

  const outcomes = await mapWithConcurrency(repositories, CONCURRENCY, (repository) =>
    activities.syncOneRepository({
      tenantId: input.tenantId,
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      githubInstallationId: input.githubInstallationId,
    }),
  );

  let registered = 0;
  let skipped = 0;
  let conflicted = 0;
  for (const outcome of outcomes) {
    if (outcome === null) continue;
    if (outcome.kind === "registered") registered += 1;
    else if (outcome.kind === "skipped") skipped += 1;
    else conflicted += 1;
  }

  return { registered, skipped, conflicted };
};

/** Keys the workflow by installation, so a redelivered `installation` event joins the running sync. */
export const buildSyncInstallationWorkflowId = (githubInstallationId: string): string =>
  `github-installation-sync:${githubInstallationId}`;
