import type { Logger } from "~/telemetry/logger.js";
import type { PullRequestEvent } from "~/domain/pull-requests/pull-request-event.js";
import type { PullRequestStore, RecordPublishedPullRequestInput } from "~/domain/pull-requests/pull-request-store.js";
import type { PullRequestCloseHandler } from "~/domain/runs/pull-request-close.js";
import type { PullRequestState } from "~/domain/runs/issue-status.js";
import type { AutoMergeState } from "~/domain/pull-requests/pull-request-store.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";
import {
  decideAutoMerge,
  gateGaps,
  mergeMethodOf,
  openChangeRequests,
  unmetConditions,
  type AutoMergePort,
} from "~/domain/pull-requests/auto-merge.js";

export interface PullRequestActivityDependencies {
  pullRequests: PullRequestStore;
  close: Pick<PullRequestCloseHandler, "closeOfRecord">;
  logger: Logger;
  /** docs/specs/pr-review-merge-and-deploy.md. The GitHub calls of the L4 merge. */
  autoMerge: AutoMergePort;
  products: Pick<ProductRegistry, "findById">;
  agentSession: Pick<AgentSessionPort, "respond">;
}

/**
 * What made the PR workflow steer auto-merge: the start of the workflow, a new head commit, an
 * auto-merge that GitHub reports off, or any other event of the pull request.
 */
export type AutoMergeTrigger = "start" | "new_head" | "auto_merge_disabled" | "event";

export interface SteerAutoMergeInput {
  tenantId: string;
  pullRequestId: string;
  trigger: AutoMergeTrigger;
  /** The head commit the event named. */
  eventHeadSha?: string | null;
}

const NEEDS_ATTENTION = "### Needs your attention";

export interface TakePullRequestEventOutput {
  isNew: boolean;
  state: PullRequestState;
  headSha: string;
}

/** docs/specs/pr-review-merge-and-deploy.md. The activities of publication and of the PR workflow. */
export const createPullRequestActivities = (dependencies: PullRequestActivityDependencies) => ({
  /**
   * D3, DI-21.99. Records the pull request a run published, and names its PR workflow. The agent run
   * starts that workflow with the answer.
   */
  async recordPullRequest(input: RecordPublishedPullRequestInput): Promise<{ pullRequestId: string; workflowId: string }> {
    const pullRequest = await dependencies.pullRequests.recordPublished(input);
    dependencies.logger.info("pull request recorded", {
      run_id: input.runId,
      pull_request: `${pullRequest.repositoryFullName}#${String(pullRequest.number)}`,
      step: "pull_request_record",
    });
    return { pullRequestId: pullRequest.id, workflowId: pullRequest.workflowId };
  },

  /** DI-21.100. Records one event once per delivery. */
  async takePullRequestEvent(input: { tenantId: string; pullRequestId: string; event: PullRequestEvent }): Promise<TakePullRequestEventOutput> {
    const { isNew, pullRequest } = await dependencies.pullRequests.recordEvent(input.tenantId, input.pullRequestId, input.event);
    dependencies.logger.info("pull request event taken", {
      pull_request: `${pullRequest.repositoryFullName}#${String(pullRequest.number)}`,
      event: input.event.kind,
      delivery_id: input.event.deliveryId,
      new: isNew,
      step: "pull_request_event",
    });
    return { isNew, state: pullRequest.state, headSha: pullRequest.headSha };
  },

  /**
   * DI-21.51, D3. A merge or a close: the record takes the state, and the origin run moves the issue.
   * A retry writes the same state and decides again, and the issue move holds only while the issue is
   * in the state Factoree set.
   */
  async closePullRequestOfRecord(input: {
    tenantId: string;
    pullRequestId: string;
    merged: boolean;
    mergeCommitSha: string | null;
  }): Promise<PullRequestState> {
    const pullRequest = await dependencies.pullRequests.markClosed(input.tenantId, input.pullRequestId, {
      merged: input.merged,
      mergeCommitSha: input.mergeCommitSha,
      closedAt: new Date(),
    });
    await dependencies.close.closeOfRecord({
      tenantId: input.tenantId,
      repositoryFullName: pullRequest.repositoryFullName,
      number: pullRequest.number,
      merged: input.merged,
      originRunId: pullRequest.originRunId,
    });
    return pullRequest.state;
  },

  /**
   * docs/specs/pr-review-merge-and-deploy.md, D5, DI-21.104 to DI-21.107. Turns GitHub auto-merge on
   * or off for an L4 pull request, from what GitHub answers now. A retry reads GitHub again and
   * decides again, so it never acts twice on one state.
   */
  async steerAutoMerge(input: SteerAutoMergeInput): Promise<{ state: AutoMergeState }> {
    const store = dependencies.pullRequests;
    const record = await store.find(input.tenantId, input.pullRequestId);
    if (record === null || record.state !== "open") return { state: record?.autoMerge ?? "off" };
    const label = `${record.repositoryFullName}#${String(record.number)}`;
    const log = { pull_request: label, step: "auto_merge", trigger: input.trigger };
    const facts = await store.steeringFacts(input.tenantId, input.pullRequestId);
    const say = async (body: string) => {
      try {
        await dependencies.agentSession.respond(facts.linearAgentSessionId, body);
      } catch (error) {
        // The Linear line is a notice. The auto-merge state is already written.
        dependencies.logger.warn("the auto-merge notice did not reach Linear", { ...log, error: String(error) });
      }
    };

    // DI-21.105. GitHub reports auto-merge off on the head Factoree turned it on for. Factoree did not
    // turn it off, because it writes its own off before GitHub reports it, so a human stopped it.
    if (input.trigger === "auto_merge_disabled" && record.autoMerge === "enabled" && input.eventHeadSha === record.verifiedHeadSha) {
      await store.setAutoMerge(input.tenantId, record.id, { state: "stopped", reason: "A human turned off auto-merge on this pull request." });
      dependencies.logger.info("a human turned off auto-merge", log);
      await say(`A human turned off auto-merge on ${record.url}. Factoree does not turn it on again for this pull request.`);
      return { state: "stopped" };
    }
    if (record.autonomyLevel !== "L4") return { state: record.autoMerge };

    const slug = record.repositoryFullName;
    const installationId = facts.githubInstallationId;
    const port = dependencies.autoMerge;
    const pullRequest = await port.pullRequest(slug, record.number, installationId);
    if (!pullRequest.open) return { state: record.autoMerge };
    let state = record.autoMerge;
    let reason = record.autoMergeReason;

    // The spec: a new head turns off the auto-merge Factoree turned on. It turns on again only when
    // every condition holds for the new head.
    if (input.trigger === "new_head" && state === "enabled" && pullRequest.autoMergeEnabled) {
      await port.disable(slug, pullRequest, installationId);
      pullRequest.autoMergeEnabled = false;
      state = "off";
      reason = `The head moved to ${pullRequest.headSha.slice(0, 12)}, so Factoree turned off auto-merge.`;
      await store.setAutoMerge(input.tenantId, record.id, { state, reason });
      dependencies.logger.info("auto-merge turned off for a new head", log);
    }
    // GitHub turned it off itself, for example after a push.
    if (state === "enabled" && !pullRequest.autoMergeEnabled) state = "off";

    // D5, DI-21.106. The gate is read when the pull request opens, and again when its base changes.
    if (record.autoMergeGateBase !== pullRequest.baseBranch) {
      const gaps = gateGaps(await port.gate(slug, pullRequest.baseBranch, installationId), slug, pullRequest.baseBranch);
      if (gaps.length > 0) {
        const before = await store.setAutoMerge(input.tenantId, record.id, { state: "unavailable", reason: gaps.join(" "), gateBase: pullRequest.baseBranch });
        dependencies.logger.info("the L4 gate failed", { ...log, gaps: gaps.length });
        if (before.autoMerge !== "unavailable") {
          await say(
            [
              NEEDS_ATTENTION,
              "",
              `The pull request ${record.url} runs at L4, but Factoree did not turn on auto-merge, so it stays open as at L3.`,
              ...gaps.map((gap) => `- ${gap}`),
            ].join("\n"),
          );
        }
        return { state: "unavailable" };
      }
      if (state === "unavailable") {
        state = "off";
        reason = null;
      }
      await store.setAutoMerge(input.tenantId, record.id, { state, reason, gateBase: pullRequest.baseBranch });
    }
    if (state === "unavailable") return { state };

    const product = await dependencies.products.findById(input.tenantId, facts.productId);
    const reviewer = product?.prReviewer ?? null;
    const verified = pullRequest.headSha === record.verifiedHeadSha;
    const reviewerVerdict = reviewer !== null && verified ? await port.reviewerVerdict(slug, pullRequest.headSha, reviewer, installationId) : null;
    const changeRequests = verified ? openChangeRequests(await port.reviews(slug, record.number, installationId)) : [];
    const unmet = unmetConditions({
      level: record.autonomyLevel,
      verifiedHeadSha: record.verifiedHeadSha,
      pullRequest,
      reviewer,
      reviewerVerdict,
      changeRequests,
    });
    const action = decideAutoMerge({ state, unmet, pullRequest });
    const write = async (next: AutoMergeState, nextReason: string | null) => {
      await store.setAutoMerge(input.tenantId, record.id, { state: next, reason: nextReason });
      return { state: next };
    };

    switch (action.kind) {
      case "none":
        return write(state, action.reason ?? (state === "enabled" ? reason : null));
      case "disable":
        await port.disable(slug, pullRequest, installationId);
        dependencies.logger.info("auto-merge turned off", log);
        return write("off", action.reason);
      case "enable":
      case "merge": {
        // The merge method is read when Factoree turns auto-merge on, because a repository can
        // change it after the gate read.
        const gate = await port.gate(slug, pullRequest.baseBranch, installationId);
        const method = mergeMethodOf(gate.settings);
        if (method === null) {
          await say(`${NEEDS_ATTENTION}\n\n${slug} allows no merge method, so Factoree did not turn on auto-merge for ${record.url}.`);
          return write("unavailable", `${slug} allows no merge method.`);
        }
        let merge = action.kind === "merge";
        if (!merge) {
          const outcome = await port.enable(slug, pullRequest, method, installationId);
          if (outcome.kind === "refused") {
            await say(
              `${NEEDS_ATTENTION}\n\nGitHub refused auto-merge for ${record.url}, so it stays open as at L3. GitHub said: ${outcome.message}`,
            );
            dependencies.logger.warn("GitHub refused auto-merge", { ...log, error: outcome.message });
            return write("unavailable", `GitHub refused auto-merge: ${outcome.message}`);
          }
          merge = outcome.kind === "clean";
          if (!merge) {
            dependencies.logger.info("auto-merge turned on", { ...log, method });
            await say(`Factoree turned on auto-merge (${method}) for ${record.url}. The repository rules decide when it merges.`);
            return write("enabled", `Factoree turned on auto-merge with ${method}.`);
          }
        }
        // DI-21.105. Every condition and every rule already holds, so GitHub merges at once.
        const merged = await port.merge(slug, record.number, pullRequest.headSha, method, installationId);
        if (merged.kind === "refused") {
          dependencies.logger.info("GitHub held the merge back", { ...log, error: merged.message });
          return write("off", `GitHub held the merge back: ${merged.message}`);
        }
        dependencies.logger.info("pull request merged", { ...log, method });
        return write("enabled", `Every condition and rule held, so Factoree merged with ${method}.`);
      }
    }
  },
});
