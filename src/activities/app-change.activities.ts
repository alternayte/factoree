import type { ProductRegistry } from "~/domain/products/product-registry.js";
import {
  appChangeIssueText,
  outcomeOf,
  planAppChangeIssues,
  pullRequestOf,
  roundEnded,
  type AppChangeIssuePort,
  type AppChangeIssueStore,
} from "~/domain/setup/app-change-issues.js";
import { setupWorkflowId, type RepositorySetupRecord, type RepositorySetupStore } from "~/domain/setup/repository-setup.js";
import type { Logger } from "~/telemetry/logger.js";

export interface AppChangeActivityDependencies {
  setups: RepositorySetupStore;
  appChangeIssues: AppChangeIssueStore;
  products: Pick<ProductRegistry, "findById">;
  /** The Linear issue port of the tenant's workspace. */
  linearIssues: (tenantId: string) => Promise<AppChangeIssuePort>;
  /** The state of a pull request, read with an installation token of the repository. */
  pullRequestState: (slug: string, number: number, githubInstallationId: string) => Promise<"open" | "merged" | "closed" | null>;
  logger: Logger;
}

/** A follow-up setup the workflow starts: its row exists, its workflow does not yet. */
export interface FollowUpSetup {
  setupId: string;
  workflowId: string;
}

/**
 * docs/specs/setup-app-change-issues.md. One push to the default branch of a repository. Factoree
 * marks a merged setup, creates its app-change issues, records how each open issue ended, and
 * returns the follow-up setup of each round that ended.
 */
export const createAppChangeActivities = (dependencies: AppChangeActivityDependencies) => {
  const stateOf = async (url: string, githubInstallationId: string) => {
    const pullRequest = pullRequestOf(url);
    return pullRequest === null ? null : dependencies.pullRequestState(pullRequest.slug, pullRequest.number, githubInstallationId);
  };

  const createIssues = async (setup: RepositorySetupRecord): Promise<void> => {
    const changes = setup.report?.appChanges ?? [];
    if (changes.length === 0) return;
    const product = await dependencies.products.findById(setup.tenantId, setup.productId);
    if (product === null) return;
    const stored = await dependencies.appChangeIssues.listForRepository(setup.tenantId, setup.repositoryFullName);
    const plan = planAppChangeIssues(changes, stored, product.appChangeIssues);
    if (plan.length === 0) return;
    const linear = await dependencies.linearIssues(setup.tenantId);
    for (const issueChanges of plan) {
      const text = appChangeIssueText({ repositoryFullName: setup.repositoryFullName, changes: issueChanges, setupPullRequestUrl: setup.pullRequestUrl });
      const issue = await linear.createDelegatedIssue({ teamId: product.linearTeamId, ...text });
      await dependencies.appChangeIssues.create({
        tenantId: setup.tenantId,
        productId: setup.productId,
        setupId: setup.id,
        repositoryFullName: setup.repositoryFullName,
        changes: issueChanges,
        linearIssueId: issue.id,
        linearIssueIdentifier: issue.identifier,
      });
      dependencies.logger.info("app-change issue created", { setup_id: setup.id, issue: issue.identifier, step: "app_change_issue" });
    }
  };

  return {
    async afterSetupPush(input: { tenantId: string; repositoryFullName: string }): Promise<{ followUps: FollowUpSetup[] }> {
      const open = await dependencies.setups.latestOpenPullRequest(input.tenantId, input.repositoryFullName);
      if (open !== null && open.pullRequestUrl !== null && (await stateOf(open.pullRequestUrl, open.githubInstallationId)) === "merged") {
        // DI-21.20. A newer setup report supersedes the app changes of this one: its agent saw
        // the repository later, and its own issues or its own merge cover what is still needed.
        const newest = await dependencies.setups.previousWithReport(open.productId, open.repositoryFullName, new Date());
        // The issues come first. A retry after a failed create then finds the stored ones and
        // skips their changes, and the status still reads open until every issue exists.
        if (newest === null || newest.id === open.id) await createIssues(open);
        await dependencies.setups.update(open.id, { status: "merged" });
      }

      const rows = await dependencies.appChangeIssues.listForRepository(input.tenantId, input.repositoryFullName);
      const now = new Date();
      for (const row of rows) {
        if (row.outcome !== null) continue;
        const run = await dependencies.appChangeIssues.latestRun(row.tenantId, row.linearIssueId);
        const setup = run?.pullRequestUrl ? await dependencies.setups.findById(row.setupId) : null;
        const state = run?.pullRequestUrl && setup !== null ? await stateOf(run.pullRequestUrl, setup.githubInstallationId) : null;
        const outcome = outcomeOf(run, state);
        if (outcome === null) continue;
        await dependencies.appChangeIssues.setOutcome(row.id, outcome, now);
        row.outcome = outcome;
      }

      const followUps: FollowUpSetup[] = [];
      for (const setupId of new Set(rows.map((row) => row.setupId))) {
        if (!roundEnded(rows.filter((row) => row.setupId === setupId))) continue;
        const setup = await dependencies.setups.findById(setupId);
        if (setup === null || setup.followUpSetupId !== null) continue;
        const workflowId = setupWorkflowId(setup.tenantId, setup.repositoryFullName);
        const next = await dependencies.setups.create({
          tenantId: setup.tenantId,
          productId: setup.productId,
          repositoryFullName: setup.repositoryFullName,
          githubInstallationId: setup.githubInstallationId,
          workflowId,
        });
        await dependencies.setups.update(setup.id, { followUpSetupId: next.id });
        dependencies.logger.info("follow-up setup created", { setup_id: setup.id, follow_up_setup_id: next.id, step: "app_change_round" });
        followUps.push({ setupId: next.id, workflowId });
      }
      return { followUps };
    },

    /**
     * DI-21.20. A setup that ended `unchanged` opens no pull request, so no merge ever creates its
     * app-change issues. Factoree creates them when the setup ends.
     */
    async createSetupAppChangeIssues(input: { setupId: string }): Promise<void> {
      const setup = await dependencies.setups.findById(input.setupId);
      if (setup !== null) await createIssues(setup);
    },

    /** A follow-up setup whose workflow could not start, because another setup of the repository runs. */
    async refuseFollowUpSetup(input: { setupId: string }): Promise<void> {
      await dependencies.setups.update(input.setupId, {
        status: "failed",
        failureMessage: "Another setup of this repository was running, so Factoree did not start this follow-up setup.",
        endedAt: new Date(),
      });
    },
  };
};
