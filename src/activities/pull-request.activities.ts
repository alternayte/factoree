import { createHash } from "node:crypto";
import type { Logger } from "~/telemetry/logger.js";
import { eventHeadSha, type PullRequestEvent } from "~/domain/pull-requests/pull-request-event.js";
import {
  droppedFindingReply,
  MAX_FINDINGS,
  MAX_PLAIN_COMMENTS,
  MAX_REVIEWER_FOLLOW_UPS,
  reviewerLimitNotice,
  reviewerVerdictOfEvent,
  type PrFollowUpInput,
  type PrFollowUpTrigger,
  type PrReviewFinding,
  type PullRequestReviewPort,
  type TriagedFinding,
} from "~/domain/pull-requests/pr-follow-up.js";
import type { PrReviewer } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import type { WorkItemPort } from "~/domain/runs/ports.js";
import { agentRunProductInput } from "~/domain/runs/agent-run-product.js";
import { buildPrFollowUpWorkflowId, parseWorkflowId } from "~/temporal/workflow-id.js";
import type { AgentRunWorkflowInput } from "~/workflows/agent-run.workflow.js";
import type {
  PublishedPullRequest,
  PullRequestOriginFacts,
  PullRequestStore,
  RecordPublishedPullRequestInput,
} from "~/domain/pull-requests/pull-request-store.js";
import { MAX_CONFLICT_FILES, type BringCurrentInput } from "~/domain/pull-requests/bring-current.js";
import type { PullRequestCloseHandler } from "~/domain/runs/pull-request-close.js";
import type { PullRequestState } from "~/domain/runs/issue-status.js";
import type { AutoMergeState } from "~/domain/pull-requests/pull-request-store.js";
import type { ProductRecord, ProductRegistry } from "~/domain/products/product-registry.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";
import {
  decideAutoMerge,
  gateGaps,
  mergeabilityOf,
  mergeMethodOf,
  openChangeRequests,
  unmetConditions,
  type AutoMergeGate,
  type AutoMergePort,
  type BringCurrentReason,
  type Mergeability,
} from "~/domain/pull-requests/auto-merge.js";

export interface PullRequestActivityDependencies {
  pullRequests: PullRequestStore;
  close: Pick<PullRequestCloseHandler, "closeOfRecord">;
  logger: Logger;
  /** docs/specs/pr-review-merge-and-deploy.md. The GitHub calls of the L4 merge. */
  autoMerge: AutoMergePort;
  products: Pick<ProductRegistry, "findById">;
  agentSession: Pick<AgentSessionPort, "respond">;
  /** docs/specs/pr-review-merge-and-deploy.md, slice 3. The review reads and the replies on GitHub. */
  reviews: PullRequestReviewPort;
  repositories: Pick<RepositoryRegistry, "listByProduct">;
  workItems: WorkItemPort;
  /** The GitHub web URL from the install settings. */
  repositoryBaseUrl: () => Promise<string>;
  productPageUrl?: ((productId: string) => string) | undefined;
}

/** What one event of the PR workflow asks for: nothing, or one PR follow-up run. */
export type PullRequestFollowUpPlan =
  | { kind: "none"; reason: string }
  | { kind: "start"; workflowId: string; input: AgentRunWorkflowInput };

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
};

/**
 * The plain comments of a pull request that started nothing: each COMMENTED review, newest last.
 * The PR reviewer's own reviews on the head it fails are its findings, not plain comments.
 */
const plainCommentLines = (events: readonly PullRequestEvent[], exclude: { login: string; sha: string } | null): string[] => {
  const reviews = new Map<number, string>();
  for (const event of events) {
    if (event.kind !== "review" || event.state !== "commented" || event.action === "dismissed") continue;
    if (exclude !== null && event.reviewerLogin.toLowerCase() === exclude.login && event.commitSha === exclude.sha) continue;
    const at = event.commitSha === null ? "" : ` on ${event.commitSha.slice(0, 12)}`;
    const body = event.body === null || event.body.trim() === "" ? "left review comments on the changed lines." : oneLine(event.body, 300);
    reviews.set(event.reviewId, `${event.reviewerLogin}${at}: ${body}`);
  }
  return [...reviews.values()].slice(-MAX_PLAIN_COMMENTS);
};

/**
 * What made the PR workflow steer auto-merge: the start of the workflow, a new head commit, an
 * auto-merge that GitHub reports off, or any other event of the pull request.
 */
export type AutoMergeTrigger = "start" | "new_head" | "auto_merge_disabled" | "event" | "base_moved";

/** What one steer did, and the bring-current update it asks the PR workflow for (slice 4). */
export interface SteerAutoMergeOutput {
  state: AutoMergeState;
  bringCurrent?: BringCurrentReason;
}

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

/**
 * The workflow id and the input of a run that the PR workflow starts on its pull request: a PR
 * follow-up run or a bring-current run. It shares the agent session of the origin run (D6), and
 * reads the issue text from Linear, which is context only.
 */
const runStartOf = async (
  dependencies: PullRequestActivityDependencies,
  input: {
    tenantId: string;
    record: PublishedPullRequest;
    origin: PullRequestOriginFacts;
    product: ProductRecord;
    /** Hashed into the workflow id, so a retry of the plan names the same run. */
    key: string;
    log: Record<string, unknown>;
    extra: Pick<AgentRunWorkflowInput, "prFollowUp" | "bringCurrent">;
  },
): Promise<{ workflowId: string; input: AgentRunWorkflowInput }> => {
  const { origin, product, record } = input;
  const { workspaceId } = parseWorkflowId(origin.originWorkflowId);
  let title = origin.workItemTitle ?? "";
  let description = "";
  let url = origin.workItemUrl;
  if (origin.linearIssueId !== null) {
    try {
      const facts = await dependencies.workItems.facts(origin.linearAgentSessionId, origin.linearIssueId);
      title = facts.title ?? title;
      description = facts.description ?? "";
      url = facts.url ?? url;
    } catch (error) {
      // The issue text is context. The review or the update is the change, so the run still starts.
      dependencies.logger.warn("the issue text of the run was not read", { ...input.log, error: String(error) });
    }
  }
  const defaultAutonomy = product.status === "pending" ? "L0" : product.defaultAutonomy;
  const key = createHash("sha256").update(input.key).digest("hex").slice(0, 32);
  return {
    workflowId: buildPrFollowUpWorkflowId(workspaceId, origin.linearAgentSessionId, key),
    input: {
      tenantId: input.tenantId,
      workspaceId,
      productId: product.id,
      linearIssueId: origin.linearIssueId,
      agentSessionId: origin.linearAgentSessionId,
      autonomyLevel: defaultAutonomy,
      maxRunMinutes: product.maxRunMinutes,
      workItem: { issueId: origin.linearIssueId, title, description, url, labels: [] },
      product: agentRunProductInput({
        product,
        defaultAutonomy,
        repositories: await dependencies.repositories.listByProduct(product.id),
        repositoryBaseUrl: await dependencies.repositoryBaseUrl(),
        productPageUrl: dependencies.productPageUrl === undefined ? null : dependencies.productPageUrl(product.id),
      }),
      followUpOfRunId: record.verifiedRunId ?? record.originRunId,
      delegatedAt: new Date().toISOString(),
      ...input.extra,
    },
  };
};

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
   * docs/specs/pr-review-merge-and-deploy.md, slice 3, DI-21.108 and DI-21.109. Decides whether one
   * taken event starts a PR follow-up run, and builds its input. A failed PR reviewer check on the
   * current head starts one under the limit, with that app's review comments on that head as the
   * findings to triage. A "request changes" review from a human with write access starts one with
   * the review as a decision. Every other event starts nothing. A retry reads GitHub again, and the
   * check that started a triage is marked once, so a retry decides the same.
   */
  async planPullRequestFollowUp(input: { tenantId: string; pullRequestId: string; event: PullRequestEvent }): Promise<PullRequestFollowUpPlan> {
    const store = dependencies.pullRequests;
    const record = await store.find(input.tenantId, input.pullRequestId);
    if (record === null || record.state !== "open") return { kind: "none", reason: "the pull request is not open" };
    const event = input.event;
    if (event.kind !== "check_run" && event.kind !== "commit_status" && event.kind !== "review") return { kind: "none", reason: "no review event" };
    const label = `${record.repositoryFullName}#${String(record.number)}`;
    const log = { pull_request: label, step: "pr_follow_up", event: event.kind, delivery_id: event.deliveryId };
    const origin = await store.originFacts(input.tenantId, record.id);
    const product = await dependencies.products.findById(input.tenantId, origin.productId);
    if (product === null) return { kind: "none", reason: "the product is gone" };
    const installationId = origin.githubInstallationId;
    const slug = record.repositoryFullName;
    const say = async (body: string) => {
      try {
        await dependencies.agentSession.respond(origin.linearAgentSessionId, body);
      } catch (error) {
        dependencies.logger.warn("the PR follow-up notice did not reach Linear", { ...log, error: String(error) });
      }
    };

    let trigger: PrFollowUpTrigger;
    let reviewer: PrReviewer | null = null;
    let reviewerLogin: string | null = null;
    let findings: PrReviewFinding[];
    // DI-21.108. The failed check this event names. The record marks it once the plan is complete,
    // so a retry after a fault plans again, and a second delivery of the check starts nothing.
    let handledKey: string | null = null;
    if (event.kind === "review") {
      // The spec: only a "request changes" review from a human with write access is a decision. A
      // bot's verdict reaches Factoree through its check, and a COMMENTED review starts nothing.
      if (event.action !== "submitted" || event.state !== "changes_requested") return { kind: "none", reason: "no change request" };
      if (event.reviewerType !== "User") return { kind: "none", reason: "the reviewer is no human" };
      if (!(await dependencies.reviews.canWrite(slug, event.reviewerLogin, installationId))) {
        dependencies.logger.info("a change request from a user without write access starts nothing", { ...log, reviewer: event.reviewerLogin });
        return { kind: "none", reason: "the reviewer holds no write access" };
      }
      const review = await dependencies.reviews.review(slug, record.number, event.reviewId, installationId);
      if (review.findings.length === 0) {
        await say(`${review.reviewerLogin} requested changes on ${record.url} without a comment, so Factoree has nothing to act on and starts no run.`);
        return { kind: "none", reason: "the review holds no text" };
      }
      trigger = "human";
      reviewerLogin = review.reviewerLogin;
      findings = review.findings;
    } else {
      reviewer = product.prReviewer;
      if (reviewer === null) return { kind: "none", reason: "the product names no PR reviewer" };
      const verdict = reviewerVerdictOfEvent(event, reviewer);
      if (verdict === null) return { kind: "none", reason: "another check" };
      if (verdict === "pending") {
        dependencies.logger.info("the PR reviewer reviews the head", log);
        return { kind: "none", reason: "the review is in progress" };
      }
      if (verdict !== "failed") return { kind: "none", reason: `the PR reviewer check is ${verdict}` };
      const sha = eventHeadSha(event);
      // An old head has a newer commit on the branch already, and the newer commit gets its own check.
      if (sha !== record.headSha) return { kind: "none", reason: "the check names an old head" };
      handledKey = event.kind === "check_run" ? `check_run:${String(event.checkRunId)}` : `status:${sha}:${event.context}`;
      if (record.reviewerHandledKey === handledKey) return { kind: "none", reason: "the check already started a triage" };
      if (record.reviewerFollowUps >= MAX_REVIEWER_FOLLOW_UPS) {
        if (!(await store.markReviewerHandled(input.tenantId, record.id, handledKey))) return { kind: "none", reason: "the check was handled" };
        const notice = reviewerLimitNotice(record.url, reviewer.checkName);
        dependencies.logger.info("the PR reviewer follow-up limit holds", log);
        await say(notice);
        try {
          await dependencies.reviews.comment(slug, record.number, notice, installationId);
        } catch (error) {
          dependencies.logger.warn("the limit notice did not reach the pull request", { ...log, error: String(error) });
        }
        return { kind: "none", reason: "the PR reviewer follow-up limit holds" };
      }
      findings = await dependencies.reviews.reviewerFindings(slug, record.number, sha, reviewer.appSlug, installationId);
      if (findings.length === 0) {
        if (!(await store.markReviewerHandled(input.tenantId, record.id, handledKey))) return { kind: "none", reason: "the check was handled" };
        await say(
          `The PR reviewer check "${reviewer.checkName}" failed on ${record.url} at ${sha.slice(0, 12)}, and the PR reviewer left no review comment on that head. ` +
            "Factoree has no finding to triage, so it starts no run.",
        );
        return { kind: "none", reason: "the PR reviewer left no finding" };
      }
      trigger = "reviewer";
    }

    if (record.verifiedBaseSha === null) {
      dependencies.logger.warn("the pull request holds no verified base, so no PR follow-up run starts", log);
      await say(`Factoree cannot start a PR follow-up run on ${record.url}, because it holds no verified base for it.`);
      return { kind: "none", reason: "no verified base" };
    }
    const followUp: PrFollowUpInput = {
      pullRequestId: record.id,
      repositoryId: record.repositoryId,
      repositoryFullName: record.repositoryFullName,
      number: record.number,
      url: record.url,
      headBranch: record.headBranch,
      headSha: record.headSha,
      baseSha: record.verifiedBaseSha,
      baseBranch: record.baseBranch,
      contractRevision: record.contractRevision + 1,
      trigger,
      reviewer,
      reviewerLogin,
      findings: findings.slice(0, MAX_FINDINGS),
      omittedFindings: Math.max(0, findings.length - MAX_FINDINGS),
      plainComments: plainCommentLines(
        await store.listEvents(input.tenantId, record.id, "review"),
        reviewer === null ? null : { login: `${reviewer.appSlug}[bot]`, sha: record.headSha },
      ),
    };
    if (handledKey !== null && !(await store.markReviewerHandled(input.tenantId, record.id, handledKey))) {
      return { kind: "none", reason: "the check already started a triage" };
    }
    const start = await runStartOf(dependencies, {
      tenantId: input.tenantId,
      record,
      origin,
      product,
      key: `${record.id}\n${event.deliveryId}`,
      log,
      extra: { prFollowUp: followUp },
    });
    dependencies.logger.info("a PR follow-up run starts", { ...log, trigger, workflow_id: start.workflowId, findings: findings.length });
    return { kind: "start", ...start };
  },

  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.115. Reads whether the branch conflicts
   * with its base, as GitHub answers it now. `unknown` while GitHub computes it: the PR workflow
   * reads again later.
   */
  async readPullRequestMergeability(input: { tenantId: string; pullRequestId: string }): Promise<{ mergeability: Mergeability | "ended" }> {
    const record = await dependencies.pullRequests.find(input.tenantId, input.pullRequestId);
    if (record === null || record.state !== "open") return { mergeability: "ended" };
    const facts = await dependencies.pullRequests.steeringFacts(input.tenantId, input.pullRequestId);
    const pullRequest = await dependencies.autoMerge.pullRequest(record.repositoryFullName, record.number, facts.githubInstallationId);
    if (!pullRequest.open) return { mergeability: "ended" };
    return { mergeability: mergeabilityOf(pullRequest) };
  },

  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.117 and DI-21.118. Decides whether a
   * bring-current run starts, and builds its input. It starts only on the verified head, with a
   * frozen contract to replay, and once per head that an earlier update did not move.
   */
  async planBringCurrent(input: {
    tenantId: string;
    pullRequestId: string;
    reason: BringCurrentReason;
    /** The delivery that asked for the update, or `start`. It keys the run. */
    triggerKey: string;
  }): Promise<PullRequestFollowUpPlan> {
    const store = dependencies.pullRequests;
    const record = await store.find(input.tenantId, input.pullRequestId);
    if (record === null || record.state !== "open") return { kind: "none", reason: "the pull request is not open" };
    const label = `${record.repositoryFullName}#${String(record.number)}`;
    const log = { pull_request: label, step: "bring_current", reason: input.reason };
    if (record.verifiedHeadSha === null || record.headSha !== record.verifiedHeadSha) {
      dependencies.logger.info("the head is not the verified head, so Factoree does not bring it current", log);
      return { kind: "none", reason: "the head is not verified" };
    }
    if (record.bringCurrentHeadSha === record.headSha) return { kind: "none", reason: "an update of this head already pushed nothing" };
    if (record.verifiedBaseSha === null || record.verifiedRunId === null) return { kind: "none", reason: "no verified base" };
    const origin = await store.originFacts(input.tenantId, record.id);
    const product = await dependencies.products.findById(input.tenantId, origin.productId);
    if (product === null) return { kind: "none", reason: "the product is gone" };
    const bringCurrent: BringCurrentInput = {
      pullRequestId: record.id,
      repositoryId: record.repositoryId,
      repositoryFullName: record.repositoryFullName,
      number: record.number,
      url: record.url,
      headBranch: record.headBranch,
      headSha: record.headSha,
      baseSha: record.verifiedBaseSha,
      baseBranch: record.baseBranch,
      contractRunId: record.verifiedRunId,
      contractRevision: record.contractRevision,
      // DI-21.104. An unknown level never takes auto-merge, and neither does L3.
      autonomyLevel: record.autonomyLevel ?? "L3",
      reason: input.reason,
    };
    const start = await runStartOf(dependencies, {
      tenantId: input.tenantId,
      record,
      origin,
      product,
      key: `${record.id}\nbring-current\n${input.triggerKey}`,
      log,
      extra: { bringCurrent },
    });
    dependencies.logger.info("a bring-current run starts", { ...log, workflow_id: start.workflowId });
    return { kind: "start", ...start };
  },

  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.119. A conflict, or a failed check after
   * a clean update, starts a PR follow-up run with the conflict or the failure as a finding. It does
   * not count toward the limit of PR reviewer follow-up runs.
   */
  async planBaseUpdateFollowUp(input: {
    tenantId: string;
    pullRequestId: string;
    /** The head the bring-current run started from. */
    headSha: string;
    baseSha: string;
    conflicts: string[];
    failure: string | null;
    /** The workflow id of the bring-current run. It keys the PR follow-up run. */
    bringCurrentWorkflowId: string;
  }): Promise<PullRequestFollowUpPlan> {
    const store = dependencies.pullRequests;
    const record = await store.find(input.tenantId, input.pullRequestId);
    if (record === null || record.state !== "open") return { kind: "none", reason: "the pull request is not open" };
    if (record.headSha !== input.headSha) return { kind: "none", reason: "the head moved" };
    if (record.verifiedBaseSha === null) return { kind: "none", reason: "no verified base" };
    const label = `${record.repositoryFullName}#${String(record.number)}`;
    const log = { pull_request: label, step: "pr_follow_up", trigger: "base" };
    const origin = await store.originFacts(input.tenantId, record.id);
    const product = await dependencies.products.findById(input.tenantId, origin.productId);
    if (product === null) return { kind: "none", reason: "the product is gone" };
    const followUp: PrFollowUpInput = {
      pullRequestId: record.id,
      repositoryId: record.repositoryId,
      repositoryFullName: record.repositoryFullName,
      number: record.number,
      url: record.url,
      headBranch: record.headBranch,
      headSha: record.headSha,
      // The work starts at the new base, with the head merged into it.
      baseSha: input.baseSha,
      baseBranch: record.baseBranch,
      contractRevision: record.contractRevision + 1,
      trigger: "base",
      reviewer: null,
      reviewerLogin: null,
      findings: [],
      omittedFindings: 0,
      plainComments: plainCommentLines(await store.listEvents(input.tenantId, record.id, "review"), null),
      baseUpdate: {
        previousBaseSha: record.verifiedBaseSha,
        conflicts: input.conflicts.slice(0, MAX_CONFLICT_FILES),
        failure: input.failure,
      },
    };
    const start = await runStartOf(dependencies, {
      tenantId: input.tenantId,
      record,
      origin,
      product,
      key: `${record.id}\nbase\n${input.bringCurrentWorkflowId}`,
      log,
      extra: { prFollowUp: followUp },
    });
    dependencies.logger.info("a PR follow-up run starts", { ...log, workflow_id: start.workflowId, conflicts: input.conflicts.length });
    return { kind: "start", ...start };
  },

  /** DI-21.118. Records that a bring-current update of this head pushed nothing. */
  async markBringCurrentTried(input: { tenantId: string; pullRequestId: string; headSha: string }): Promise<void> {
    await dependencies.pullRequests.markBringCurrentTried(input.tenantId, input.pullRequestId, input.headSha);
  },

  /**
   * The spec: Factoree replies on the pull request to each finding the triage dropped, with the
   * reason. A reply that fails is logged, and the others still go.
   */
  async answerDroppedFindings(input: {
    tenantId: string;
    pullRequestId: string;
    findings: PrReviewFinding[];
    dropped: TriagedFinding[];
  }): Promise<{ answered: number }> {
    const record = await dependencies.pullRequests.find(input.tenantId, input.pullRequestId);
    if (record === null) return { answered: 0 };
    const origin = await dependencies.pullRequests.originFacts(input.tenantId, record.id);
    const byKey = new Map(input.findings.map((finding) => [finding.key, finding]));
    let answered = 0;
    for (const dropped of input.dropped) {
      const finding = byKey.get(dropped.key);
      if (finding === undefined) continue;
      try {
        await dependencies.reviews.reply(record.repositoryFullName, record.number, finding, droppedFindingReply(dropped), origin.githubInstallationId);
        answered += 1;
      } catch (error) {
        dependencies.logger.warn("the reply to a dropped finding did not reach the pull request", {
          pull_request: `${record.repositoryFullName}#${String(record.number)}`,
          finding: dropped.key,
          error: String(error),
          step: "triage",
        });
      }
    }
    return { answered };
  },

  /**
   * The spec, DI-21.114: counts one PR follow-up run from the PR reviewer, once its triage kept a
   * finding. The run id keys the count, so a retry after a successful write counts nothing.
   */
  async countReviewerFollowUp(input: { tenantId: string; pullRequestId: string; runId: string }): Promise<{ count: number }> {
    const record = await dependencies.pullRequests.find(input.tenantId, input.pullRequestId);
    if (record === null) throw new Error(`no pull request "${input.pullRequestId}" of tenant "${input.tenantId}"`);
    if (record.reviewerFollowUpKeys.includes(input.runId)) return { count: record.reviewerFollowUps };
    return { count: await dependencies.pullRequests.countReviewerFollowUp(input.tenantId, input.pullRequestId, input.runId) };
  },

  /**
   * docs/specs/pr-review-merge-and-deploy.md, D5, DI-21.104 to DI-21.107. Turns GitHub auto-merge on
   * or off for an L4 pull request, from what GitHub answers now. A retry reads GitHub again and
   * decides again, so it never acts twice on one state.
   */
  async steerAutoMerge(input: SteerAutoMergeInput): Promise<SteerAutoMergeOutput> {
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

    // docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.115. Just before an L4 merge, a branch
    // that conflicts, or that the base branch requires up to date and that is behind, is brought
    // current first. An auto-merge that is on already is checked when the base branch moved, because
    // GitHub then holds it back for ever.
    let gate: AutoMergeGate | null = null;
    const mergesSoon =
      action.kind === "enable" ||
      action.kind === "merge" ||
      (action.kind === "none" &&
        unmet.length === 0 &&
        state === "enabled" &&
        pullRequest.autoMergeEnabled &&
        (input.trigger === "base_moved" || input.trigger === "start"));
    if (mergesSoon) {
      if (mergeabilityOf(pullRequest) === "conflict") {
        dependencies.logger.info("the pull request conflicts with its base, so Factoree brings it current first", log);
        return { ...(await write(state, "The branch conflicts with its base, so Factoree brings it current first.")), bringCurrent: "conflict" };
      }
      gate = await port.gate(slug, pullRequest.baseBranch, installationId);
      if (gate.requiresUpToDate || pullRequest.mergeableState === "behind") {
        const behind =
          pullRequest.mergeableState === "behind" || (await port.behindBy(slug, pullRequest.baseBranch, pullRequest.headSha, installationId)) > 0;
        if (behind) {
          dependencies.logger.info("the base branch requires the branch up to date, so Factoree brings it current first", log);
          return {
            ...(await write(state, `The base branch ${pullRequest.baseBranch} requires the branch up to date, so Factoree brings it current first.`)),
            bringCurrent: "up_to_date",
          };
        }
      }
    }

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
        const method = mergeMethodOf((gate ?? (await port.gate(slug, pullRequest.baseBranch, installationId))).settings);
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
