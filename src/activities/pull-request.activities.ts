import { createHash } from "node:crypto";
import type { Logger } from "~/telemetry/logger.js";
import type { PullRequestEvent } from "~/domain/pull-requests/pull-request-event.js";
import {
  automaticLimitNotice,
  type DecisionEvent,
  type HumanDecision,
  type ReviewAppFinding,
  droppedFindingReply,
  droppedUnthreadedReply,
  findingPlace,
  MAX_FINDINGS,
  type PrChangeSet,
  type PrFollowUpInput,
  type PrFollowUpTrigger,
  type PrReviewFinding,
  type PullRequestReviewPort,
  type TriagedFinding,
} from "~/domain/pull-requests/pr-follow-up.js";
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
  reviewAppHoldNotice,
  unmetConditions,
  type AutoMergeGate,
  type AutoMergePort,
  type BringCurrentReason,
  type Mergeability,
} from "~/domain/pull-requests/auto-merge.js";
import {
  deployFailureNotice,
  deployKeyOf,
  deployResultOf,
  deploySuccessNotice,
  type DeployPort,
  type FailedDeployIssueMove,
  type PullRequestDeployRecord,
} from "~/domain/pull-requests/deploys.js";
import type { ProofPackDeploy } from "~/domain/evidence/proof-pack.js";
import {
  CHANGE_SET_STATUS_CONTEXT,
  changeSetStatusKey,
  decideChangeSetStatuses,
  providersNotMerged,
  type ChangeSet,
  type ChangeSetStore,
  type CommitStatusPort,
} from "~/domain/pull-requests/change-set-status.js";
import type { AmendProofPackActivityInput } from "./evidence.activities.js";
import {
  actingCheckRunsOf,
  actionsJobIdOf,
  failedCiChecks,
  logTailOf,
  reviewAppHolds,
  reviewAppsOf,
  reviewAppVerdict,
  unansweredThreadsOf,
  unthreadedFindingFingerprintText,
  type CheckOnCommit,
  type CiFinding,
  type ReviewAppHold,
  type ReviewThreadOnGitHub,
} from "~/domain/pull-requests/review-apps.js";

export interface PullRequestActivityDependencies {
  pullRequests: PullRequestStore;
  close: Pick<PullRequestCloseHandler, "closeOfRecord" | "afterFailedDeploy">;
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
  /** docs/specs/pr-review-merge-and-deploy.md, slice 5. The GitHub reads of the deploy report. */
  deploys: DeployPort;
  /** docs/specs/change-sets.md, slices 8 and 9. The pull requests of a change set. */
  changeSets: ChangeSetStore;
  /** docs/specs/change-sets.md, slice 8. The `factoree/change-set` commit status. */
  commitStatuses: CommitStatusPort;
  /** docs/specs/pr-feedback-loop.md. The slug of Factoree's own GitHub App, from the install settings. */
  factoreeAppSlug?: () => Promise<string | null>;
  /** DI-21.208. Redacts a CI job log before it leaves the control plane. */
  redactText?: (text: string) => string;
}

/**
 * Slice 5, DI-21.122. What one deployment status did for a merged pull request: nothing, or a
 * recorded deploy result with the notice for Linear and the amendment of the proof pack.
 */
export type TakeDeploymentOutput =
  | { kind: "none"; reason: string }
  | { kind: "recorded"; notice: string; sessionId: string; amend: AmendProofPackActivityInput };

/** DI-21.122. The deploys of a pull request, as the proof pack lists them. */
const proofPackDeploys = (deploys: readonly PullRequestDeployRecord[]): ProofPackDeploy[] =>
  deploys.map((deploy) => ({
    environment: deploy.environment,
    state: deploy.state,
    sha: deploy.sha,
    previousSha: deploy.previousSha,
    logUrl: deploy.logUrl,
    environmentUrl: deploy.environmentUrl,
    resolved: deploy.resolvedAt !== null,
  }));

/**
 * What one event of the PR workflow asks for: nothing, or one PR follow-up run. `changeSet` marks a
 * set run, which takes the set first (DI-21.158).
 */
export type PullRequestFollowUpPlan =
  | { kind: "none"; reason: string }
  | { kind: "start"; workflowId: string; input: AgentRunWorkflowInput; changeSet?: boolean };

/** DI-21.158. A PR workflow that held the set longer than this died with it, so another one may take it. */
/**
 * docs/specs/pr-feedback-loop.md, DI-21.212. The review apps that hold back an L4 merge of one head:
 * the apps of the pull request, other than Factoree and the product deny list, whose checks did not
 * all pass, or that have no check and an unanswered open thread.
 */
const reviewAppHoldsOn = async (
  dependencies: PullRequestActivityDependencies,
  record: PublishedPullRequest,
  productId: string,
  headSha: string,
  installationId: string,
): Promise<ReviewAppHold[]> => {
  const product = await dependencies.products.findById(record.tenantId, productId);
  const self = (await dependencies.factoreeAppSlug?.()) ?? null;
  const reviews = await dependencies.reviews.reviews(record.repositoryFullName, record.number, installationId);
  const apps = reviewAppsOf(reviews, self, product?.reviewAppDenyList ?? []);
  if (apps.length === 0) return [];
  const checks = await dependencies.reviews.checksOnCommit(record.repositoryFullName, headSha, installationId);
  const threads = apps.some((app) => reviewAppVerdict(checks, app) === "none")
    ? await dependencies.reviews.reviewThreads(record.repositoryFullName, record.number, installationId)
    : [];
  return reviewAppHolds({ apps, checks, threads, factoreeSlug: self });
};

/** DI-21.214. The SHA-256 fingerprint of a review app finding with no thread. */
const fingerprintOf = (finding: ReviewAppFinding): string =>
  createHash("sha256").update(unthreadedFindingFingerprintText(finding)).digest("hex");

const CHANGE_SET_LOCK_STALE_MS = 24 * 60 * 60_000;

/**
 * docs/specs/change-sets.md, slice 9, DI-21.159. The members of a set run: every open pull request of
 * the set at its head and verified base, and every merged one at its merge commit. A closed pull
 * request leaves the set. The answer is null when fewer than two members stay, and a problem when an
 * open member holds no verified base. `base` replaces the base of the pull request a base update
 * brings current.
 */
const setRunOf = (
  set: ChangeSet,
  base?: { pullRequestId: string; baseSha: string },
): { changeSet: PrChangeSet } | { problem: string } | null => {
  const members: PrChangeSet["members"] = [];
  for (const member of set.members) {
    const record = member.record;
    if (record === null) return { problem: `Factoree holds no record of ${member.url} yet.` };
    if (record.state === "closed") continue;
    const baseSha =
      record.state === "merged" ? record.mergeCommitSha : base !== undefined && base.pullRequestId === record.id ? base.baseSha : record.verifiedBaseSha;
    if (baseSha === null) {
      return { problem: record.state === "merged" ? `Factoree holds no merge commit of ${record.url}.` : `Factoree holds no verified base of ${record.url}.` };
    }
    members.push({
      pullRequestId: record.id,
      repositoryId: record.repositoryId,
      repositoryFullName: record.repositoryFullName,
      number: record.number,
      url: record.url,
      headBranch: record.headBranch,
      headSha: record.headSha,
      baseSha,
      baseBranch: record.baseBranch,
      state: record.state === "merged" ? "merged" : "open",
      contractRevision: record.contractRevision,
      // DI-21.104. An unknown level never takes auto-merge, and neither does L3.
      autonomyLevel: record.autonomyLevel ?? "L3",
    });
  }
  if (members.length < 2) return null;
  const inSet = (name: string) => members.some((member) => member.repositoryFullName.toLowerCase() === name.toLowerCase());
  return { changeSet: { members, edges: set.edges.filter((edge) => inSet(edge.provider) && inSet(edge.consumer)) } };
};

/** DI-21.160. The PR reviewer follow-up runs of a whole set: each counted run id once. */
const setReviewerFollowUps = (set: ChangeSet): number => {
  const keys = new Set(set.members.flatMap((member) => member.record?.reviewerFollowUpKeys ?? []));
  return Math.max(keys.size, ...set.members.map((member) => member.record?.reviewerFollowUps ?? 0));
};

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
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
  /** Slice 5, DI-21.121. The time of the merge, as an ISO string, or null when the pull request did not merge. */
  mergedAt?: string | null;
  /** docs/specs/change-sets.md, DI-21.155. True when the pull request belongs to a change set of two or more. */
  changeSet?: boolean;
}

/** DI-21.155. What one pass over the statuses of a change set did. */
export interface SetChangeSetStatusesOutput {
  /** Each status Factoree set, as `<repository>#<number> <state>`. */
  set: string[];
  /** Each status that failed to reach GitHub, with the cause. */
  failed: string[];
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

/**
 * DI-21.208. One failed CI check as a finding: its output, its annotations, and the redacted tail of
 * its job log for a GitHub Actions check. A log or an annotation GitHub does not answer leaves only
 * that part out: the check output still names the failure.
 */
const ciFindingOf = async (
  dependencies: PullRequestActivityDependencies,
  slug: string,
  check: CheckOnCommit,
  installationId: string,
  log: Record<string, unknown>,
): Promise<CiFinding> => {
  let annotations: string[] = [];
  if (check.kind === "check_run" && check.id !== null) {
    try {
      annotations = (await dependencies.reviews.annotations(slug, check.id, installationId)).map(
        (annotation) =>
          `${annotation.path === null ? "" : `${annotation.path}${annotation.startLine === null ? "" : `:${String(annotation.startLine)}`}: `}` +
          `${annotation.title === null ? "" : `${annotation.title}: `}${annotation.message}`,
      );
    } catch (error) {
      dependencies.logger.warn("the annotations of a failed CI check were not read", { ...log, check: check.name, error: String(error) });
    }
  }
  let logTail: string | null = null;
  const jobId = check.kind === "check_run" && check.appSlug === "github-actions" ? actionsJobIdOf(check.detailsUrl) : null;
  if (jobId !== null) {
    try {
      const jobLog = await dependencies.reviews.jobLog(slug, jobId, installationId);
      if (jobLog !== null) {
        const tail = logTailOf(jobLog);
        logTail = dependencies.redactText === undefined ? tail : dependencies.redactText(tail);
      }
    } catch (error) {
      // An install that has not accepted Actions read answers 403 here.
      dependencies.logger.warn("the job log of a failed CI check was not read", { ...log, check: check.name, error: String(error) });
    }
  }
  return {
    key: check.kind === "check_run" ? `check-${String(check.id)}` : `status-${check.name}`,
    name: check.name,
    appSlug: check.appSlug,
    conclusion: check.conclusion ?? "failure",
    summary: [check.title, check.summary, check.text]
      .filter((part): part is string => part !== null && part.trim() !== "")
      .join("\n\n")
      .slice(0, 4_000),
    annotations: annotations.slice(0, 50),
    logTail,
    detailsUrl: check.detailsUrl,
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
    const changeSet = await dependencies.changeSets.changeSetOfPullRequest(input.tenantId, input.pullRequestId);
    return {
      isNew,
      state: pullRequest.state,
      headSha: pullRequest.headSha,
      mergedAt: pullRequest.state === "merged" && pullRequest.closedAt !== null ? pullRequest.closedAt.toISOString() : null,
      ...(changeSet === null ? {} : { changeSet: true }),
    };
  },

  /**
   * docs/specs/change-sets.md, slice 8, DI-21.155. Sets the `factoree/change-set` commit status on the
   * head of each open consumer pull request of the set, from the records of every pull request of
   * the set. A status equal to the last one Factoree set on that head is not set again. A set with no
   * safe order gets no status. A failed GitHub call costs only that status: the next event of the set
   * sets it again, and the activity then fails so that Temporal retries it.
   */
  async setChangeSetStatuses(input: { tenantId: string; pullRequestId?: string; originRunId?: string }): Promise<SetChangeSetStatusesOutput> {
    let changeSet: ChangeSet | null = null;
    if (input.pullRequestId !== undefined) changeSet = await dependencies.changeSets.changeSetOfPullRequest(input.tenantId, input.pullRequestId);
    else if (input.originRunId !== undefined) changeSet = await dependencies.changeSets.changeSetOfRun(input.tenantId, input.originRunId);
    if (changeSet === null) return { set: [], failed: [] };
    const set: string[] = [];
    const failed: string[] = [];
    for (const status of decideChangeSetStatuses(changeSet)) {
      const record = status.member.record;
      if (record === null) continue;
      const key = changeSetStatusKey(status);
      const name = `${status.member.repositoryFullName}#${String(status.member.number)}`;
      if (status.member.statusKey === key) continue;
      try {
        await dependencies.commitStatuses.setStatus(
          status.member.repositoryFullName,
          status.sha,
          { state: status.state, context: CHANGE_SET_STATUS_CONTEXT, description: status.description, targetUrl: status.targetUrl },
          status.member.githubInstallationId,
        );
        await dependencies.changeSets.markChangeSetStatus(input.tenantId, record.id, key);
        set.push(`${name} ${status.state}`);
        dependencies.logger.info("the change-set status was set", {
          pull_request: name,
          state: status.state,
          sha: status.sha,
          origin_run_id: changeSet.originRunId,
          step: "change_set_status",
        });
      } catch (error) {
        failed.push(`${name}: ${String(error)}`);
        dependencies.logger.warn("the change-set status did not reach GitHub", { pull_request: name, error: String(error), step: "change_set_status" });
      }
    }
    if (failed.length > 0) throw new Error(`Factoree could not set the change-set status on ${failed.join("; ")}`);
    return { set, failed };
  },

  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 5, DI-21.120 to DI-21.122. Takes one deployment
   * status of a merged pull request. A deploy result counts as a deploy of the run only when the
   * deployed commit is in the history of the base branch and holds the merge commit. A success counts
   * once per environment. A failure counts when the merge commit is in its commit range: after the
   * previous successful deploy of the environment, up to the failed commit. A failure moves the issue
   * back from completed. The answer carries the one Linear notice and the proof pack amendment, which
   * the PR workflow applies. Factoree never deploys, approves or dispatches a deploy, and reverts
   * nothing. DI-21.126: a retry of the same delivery answers the same outcome and notice.
   */
  async takeDeployment(input: { tenantId: string; pullRequestId: string; event: PullRequestEvent }): Promise<TakeDeploymentOutput> {
    const event = input.event;
    if (event.kind !== "deployment_status") return { kind: "none", reason: "no deployment status" };
    const result = deployResultOf(event.state);
    if (result === null) return { kind: "none", reason: `the deployment is ${event.state}` };
    const store = dependencies.pullRequests;
    const record = await store.find(input.tenantId, input.pullRequestId);
    if (record === null || record.state !== "merged" || record.mergeCommitSha === null) return { kind: "none", reason: "the pull request did not merge" };
    const mergeCommitSha = record.mergeCommitSha;
    const label = `${record.repositoryFullName}#${String(record.number)}`;
    const log = { pull_request: label, step: "deploy", environment: event.environment, deployment_id: event.deploymentId, state: result };
    const key = deployKeyOf({ state: result, environment: event.environment, deploymentId: String(event.deploymentId) });
    const deliveryId = event.deliveryId;
    const deploys = await store.listDeploys(input.tenantId, record.id);
    let row = deploys.find((deploy) => deployKeyOf(deploy) === key) ?? null;
    // DI-21.126. A retry of the delivery that recorded the row takes it again, so it answers the same
    // notice. Another delivery of the same key takes nothing.
    if (row !== null && row.deliveryId !== deliveryId) {
      return { kind: "none", reason: result === "success" ? "the environment holds the change already" : "the failed deployment is recorded already" };
    }
    const origin = await store.originFacts(input.tenantId, record.id);
    if (row === null) {
      if (deploys.some((deploy) => deploy.environment === event.environment && deploy.state === "success")) {
        return { kind: "none", reason: "the environment holds the change already" };
      }
      const slug = record.repositoryFullName;
      const installationId = origin.githubInstallationId;
      const port = dependencies.deploys;
      // DI-21.120. Only a commit of the base branch is a deploy. A deployment of a pull request head
      // is a preview, and so is any other branch.
      if (!(await port.contains(slug, event.sha, record.baseBranch, installationId))) {
        dependencies.logger.info("the deployed commit is not in the base branch, so it is no deploy of the run", log);
        return { kind: "none", reason: "the deployed commit is not in the base branch" };
      }
      if (!(await port.contains(slug, mergeCommitSha, event.sha, installationId))) {
        return { kind: "none", reason: "the deployed commit does not hold the merge commit" };
      }
      let previousSha: string | null = null;
      if (result === "failure") {
        previousSha = await port.previousSuccess(slug, event.environment, event.deploymentId, installationId);
        // The previous successful deploy held the change already, so the failure is not in its range.
        if (previousSha !== null && (await port.contains(slug, mergeCommitSha, previousSha, installationId))) {
          return { kind: "none", reason: "an earlier successful deploy holds the change" };
        }
      }
      const isNew = await store.recordDeploy({
        tenantId: input.tenantId,
        pullRequestId: record.id,
        runId: record.verifiedRunId ?? record.originRunId,
        environment: event.environment,
        state: result,
        deploymentId: String(event.deploymentId),
        sha: event.sha,
        previousSha,
        logUrl: event.logUrl,
        environmentUrl: event.environmentUrl,
        deliveryId,
      });
      if (!isNew) return { kind: "none", reason: "the deploy is recorded already" };
      row = (await store.listDeploys(input.tenantId, record.id)).find((deploy) => deployKeyOf(deploy) === key) ?? null;
      if (row === null) throw new Error(`the deploy ${key} of ${label} is not readable after its record`);
    }
    const deploy = row;
    // DI-21.126. The issue move is stored on the row before the notice, and a retry reads it. A
    // `moving` row tells the move that a first attempt may have moved the issue already.
    let issue: { move: FailedDeployIssueMove; stateName: string | null } | null = null;
    if (deploy.state === "failure") {
      if (deploy.issueMove !== null && deploy.issueMove !== "moving") {
        issue = { move: deploy.issueMove, stateName: deploy.issueStateName };
      } else {
        issue = await dependencies.close.afterFailedDeploy({
          tenantId: input.tenantId,
          originRunId: record.originRunId,
          moveStarted: deploy.issueMove === "moving",
          beforeMove: () => store.setDeployIssueMove(input.tenantId, deploy.id, "moving", null),
        });
        await store.setDeployIssueMove(input.tenantId, deploy.id, issue.move, issue.stateName);
      }
    }
    dependencies.logger.info("deploy recorded", { ...log, issue_move: issue?.move ?? "none" });
    const notice =
      deploy.state === "success"
        ? deploySuccessNotice({ environment: deploy.environment, sha: deploy.sha })
        : deployFailureNotice({
            environment: deploy.environment,
            sha: deploy.sha,
            previousSha: deploy.previousSha,
            logUrl: deploy.logUrl,
            pullRequestUrl: record.url,
            issueMove: issue?.move ?? "not_moved",
            issueStateName: issue?.stateName ?? null,
          });
    return {
      kind: "recorded",
      notice,
      sessionId: origin.linearAgentSessionId,
      amend: {
        tenantId: input.tenantId,
        productId: origin.productId,
        runId: deploy.runId,
        afterPublication: {
          amendedFor:
            deploy.state === "success"
              ? `the change is deployed to ${deploy.environment} at commit ${deploy.sha.slice(0, 12)}.`
              : `the deploy to ${deploy.environment} failed at commit ${deploy.sha.slice(0, 12)}.`,
          deploys: proofPackDeploys(await store.listDeploys(input.tenantId, record.id)),
        },
      },
    };
  },

  /**
   * docs/specs/pr-feedback-loop.md, DI-21.213. The proof pack lists no PR comment and no suggestion
   * of a passed check any more. A PR workflow from before the patch `no-comment-amendments` still
   * schedules this activity on replay, so it stays, and it amends nothing.
   */
  planProofPackAmendment(input: { tenantId: string; pullRequestId: string; event: PullRequestEvent }): Promise<{ amend: AmendProofPackActivityInput | null }> {
    dependencies.logger.info("a PR workflow from before no-comment-amendments planned a comment amendment, which amends nothing", {
      pull_request_id: input.pullRequestId,
      delivery_id: input.event.deliveryId,
      step: "proof_pack_amend",
    });
    return Promise.resolve({ amend: null });
  },

  /** Slice 5. One notice in the agent session of the origin run. */
  async postPullRequestNotice(input: { sessionId: string; body: string }): Promise<void> {
    await dependencies.agentSession.respond(input.sessionId, input.body);
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
    // docs/specs/change-sets.md, slice 9. A PR follow-up run on any open pull request of a set runs as a set.
    const changeSet = await dependencies.changeSets.changeSetOfPullRequest(input.tenantId, record.id);

    // docs/specs/pr-feedback-loop.md, DI-21.209. A history from before the settle takes only a
    // "request changes" review here. No product names a PR reviewer any more, so a check starts
    // nothing on this path: the settled plan acts on review apps.
    if (event.kind !== "review") return { kind: "none", reason: "no product names a PR reviewer" };
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
    const trigger: PrFollowUpTrigger = "human";
    const reviewerLogin = review.reviewerLogin;
    const findings = review.findings;

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
      reviewer: null,
      reviewerLogin,
      findings: findings.slice(0, MAX_FINDINGS),
      omittedFindings: Math.max(0, findings.length - MAX_FINDINGS),
    };
    const setRun = changeSet === null ? null : setRunOf(changeSet);
    if (setRun !== null && "problem" in setRun) {
      dependencies.logger.warn("the change set of the pull request cannot run as a set, so no PR follow-up run starts", { ...log, problem: setRun.problem });
      await say(`Factoree cannot start a PR follow-up run on ${record.url}, which runs as its whole change set. ${setRun.problem}`);
      return { kind: "none", reason: setRun.problem };
    }
    if (setRun !== null) followUp.changeSet = setRun.changeSet;
    const start = await runStartOf(dependencies, {
      tenantId: input.tenantId,
      record,
      origin,
      product,
      key: `${record.id}\n${event.deliveryId}`,
      log,
      extra: { prFollowUp: followUp },
    });
    dependencies.logger.info("a PR follow-up run starts", {
      ...log,
      trigger,
      workflow_id: start.workflowId,
      findings: findings.length,
      change_set: setRun === null ? 0 : setRun.changeSet.members.length,
    });
    return { kind: "start", ...start, ...(changeSet === null ? {} : { changeSet: true }) };
  },

  /**
   * docs/specs/pr-feedback-loop.md, DI-21.209. Whether a review app check on the head still runs. The
   * PR workflow waits while one does, up to the upper wait. A pull request with no review app has
   * nothing pending.
   */
  async readReviewSettle(input: { tenantId: string; pullRequestId: string }): Promise<{ pending: boolean }> {
    const record = await dependencies.pullRequests.find(input.tenantId, input.pullRequestId);
    if (record === null || record.state !== "open") return { pending: false };
    const origin = await dependencies.pullRequests.originFacts(input.tenantId, record.id);
    const product = await dependencies.products.findById(input.tenantId, origin.productId);
    const self = (await dependencies.factoreeAppSlug?.()) ?? null;
    const installationId = origin.githubInstallationId;
    const reviews = await dependencies.reviews.reviews(record.repositoryFullName, record.number, installationId);
    const apps = reviewAppsOf(reviews, self, product?.reviewAppDenyList ?? []);
    if (apps.length === 0) return { pending: false };
    const checks = await dependencies.reviews.checksOnCommit(record.repositoryFullName, record.headSha, installationId);
    return { pending: apps.some((app) => reviewAppVerdict(checks, app) === "pending") };
  },

  /**
   * docs/specs/pr-feedback-loop.md, DI-21.211. Takes one event that may be a human decision. A GitHub
   * decision counts only from a human (account type User) with write access, and a mention gets 👀.
   * A Linear reply always counts: the agent session belongs to the issue's workspace. Factoree
   * comments on the pull request with a link to it, so GitHub readers see why the next commit came.
   */
  async acknowledgeHumanDecision(input: { tenantId: string; pullRequestId: string; event: DecisionEvent }): Promise<{ accepted: boolean }> {
    const record = await dependencies.pullRequests.find(input.tenantId, input.pullRequestId);
    if (record === null || record.state !== "open") return { accepted: false };
    const origin = await dependencies.pullRequests.originFacts(input.tenantId, record.id);
    const slug = record.repositoryFullName;
    const installationId = origin.githubInstallationId;
    const event = input.event;
    const log = { pull_request: `${slug}#${String(record.number)}`, step: "human_decision", event: event.kind, delivery_id: event.deliveryId };
    if (event.kind === "linear_reply") {
      const author = event.authorName ?? "A human";
      try {
        await dependencies.reviews.comment(
          slug,
          record.number,
          [
            `${author} replied in the Linear agent session${event.url === null ? "" : ` (${event.url})`}. Factoree takes the reply as a decision on this pull request:`,
            "",
            `> ${oneLine(event.body, 500)}`,
          ].join("\n"),
          installationId,
        );
      } catch (error) {
        dependencies.logger.warn("the link to the Linear reply did not reach the pull request", { ...log, error: String(error) });
      }
      return { accepted: true };
    }
    const login = event.kind === "review" ? event.reviewerLogin : event.authorLogin;
    const type = event.kind === "review" ? event.reviewerType : event.authorType;
    if (type !== "User") return { accepted: false };
    if (!(await dependencies.reviews.canWrite(slug, login, installationId))) {
      dependencies.logger.info("a decision from a user without write access starts nothing", { ...log, author: login });
      return { accepted: false };
    }
    if (event.kind === "comment" || event.kind === "review_comment") {
      try {
        await dependencies.reviews.react(slug, { kind: event.kind, commentId: event.commentId }, installationId);
      } catch (error) {
        dependencies.logger.warn("the 👀 reaction did not reach the comment", { ...log, error: String(error) });
      }
    }
    return { accepted: true };
  },

  /**
   * docs/specs/pr-feedback-loop.md, DI-21.206 to DI-21.210. Plans one PR follow-up run once the
   * reviews of the head settled. It reads every fact fresh: the review apps and their verdicts on the
   * head, the unanswered threads, annotations and review bodies of each app that acts, the CI checks
   * that failed on the head and pass on the base, and the human decisions the PR workflow held. A
   * run with no human decision counts toward the product limit of automatic follow-up runs.
   */
  async planSettledFollowUp(input: {
    tenantId: string;
    pullRequestId: string;
    decisions: DecisionEvent[];
    /** The delivery of the last event of the settle. It keys the run, so a retry names the same run. */
    settleKey: string;
  }): Promise<PullRequestFollowUpPlan> {
    const store = dependencies.pullRequests;
    const record = await store.find(input.tenantId, input.pullRequestId);
    if (record === null || record.state !== "open") return { kind: "none", reason: "the pull request is not open" };
    const slug = record.repositoryFullName;
    const label = `${slug}#${String(record.number)}`;
    const log = { pull_request: label, step: "pr_follow_up", settle: input.settleKey };
    const origin = await store.originFacts(input.tenantId, record.id);
    const product = await dependencies.products.findById(input.tenantId, origin.productId);
    if (product === null) return { kind: "none", reason: "the product is gone" };
    const installationId = origin.githubInstallationId;
    const self = (await dependencies.factoreeAppSlug?.()) ?? null;
    const say = async (body: string) => {
      try {
        await dependencies.agentSession.respond(origin.linearAgentSessionId, body);
      } catch (error) {
        dependencies.logger.warn("the PR follow-up notice did not reach Linear", { ...log, error: String(error) });
      }
    };

    /**
     * DI-21.212. A settled L4 head that review apps hold back, and that leaves Factoree nothing to act
     * on, needs a human: the post names each app once per head and set of apps.
     */
    const holdNotice = async (apps: readonly string[], checks: readonly CheckOnCommit[], threads: readonly ReviewThreadOnGitHub[]) => {
      if (record.autonomyLevel !== "L4" || record.verifiedHeadSha !== record.headSha) return;
      const holds = reviewAppHolds({ apps, checks, threads, factoreeSlug: self });
      if (holds.length === 0) return;
      const key = `${record.headSha}:${holds.map((hold) => `${hold.appSlug}=${hold.reason}`).join(",")}`;
      if (record.reviewAppNoticeKey === key || !(await store.markReviewAppNotice(input.tenantId, record.id, key))) return;
      const notice = reviewAppHoldNotice(record.url, holds);
      await say(notice);
      try {
        await dependencies.reviews.comment(slug, record.number, notice, installationId);
      } catch (error) {
        dependencies.logger.warn("the review app notice did not reach the pull request", { ...log, error: String(error) });
      }
    };

    // The human decisions, each once, oldest first.
    const decisions: HumanDecision[] = [];
    const add = (decision: HumanDecision) => {
      if (!decisions.some((known) => known.key === decision.key)) decisions.push(decision);
    };
    for (const event of input.decisions) {
      if (event.kind === "linear_reply") {
        add({ key: `linear-${event.replyId}`, source: "linear", author: event.authorName ?? "A human", body: event.body, path: null, line: null, commentId: null, url: event.url });
      } else if (event.kind === "comment") {
        add({ key: `issue-comment-${String(event.commentId)}`, source: "github", author: event.authorLogin, body: event.body, path: null, line: null, commentId: null, url: event.url });
      } else if (event.kind === "review_comment") {
        // GitHub takes a reply to the first comment of a thread only.
        add({
          key: `review-comment-${String(event.commentId)}`,
          source: "github",
          author: event.authorLogin,
          body: event.body,
          path: event.path,
          line: event.line,
          commentId: event.inReplyToId ?? event.commentId,
          url: event.url,
        });
      } else {
        const review = await dependencies.reviews.review(slug, record.number, event.reviewId, installationId);
        if (review.findings.length === 0) {
          await say(`${review.reviewerLogin} requested changes on ${record.url} without a comment, so Factoree has nothing to act on from that review.`);
          continue;
        }
        for (const finding of review.findings) {
          add({ key: finding.key, source: "github", author: review.reviewerLogin, body: finding.body, path: finding.path, line: finding.line, commentId: finding.commentId, url: null });
        }
      }
    }

    // DI-21.206, DI-21.207. The review apps and the findings of each one that acts.
    const reviews = await dependencies.reviews.reviews(slug, record.number, installationId);
    const apps = reviewAppsOf(reviews, self, product.reviewAppDenyList);
    const checks = await dependencies.reviews.checksOnCommit(slug, record.headSha, installationId);
    const threads = apps.length === 0 ? [] : await dependencies.reviews.reviewThreads(slug, record.number, installationId);
    const reviewAppFindings: ReviewAppFinding[] = [];
    const actingApps: string[] = [];
    // DI-21.214. A finding with no thread that Factoree answered starts nothing until its text changes.
    const answered = new Set(record.answeredFindingFingerprints);
    const unthreaded = (finding: ReviewAppFinding) => {
      const fingerprint = fingerprintOf(finding);
      if (answered.has(fingerprint) || reviewAppFindings.some((known) => known.fingerprint === fingerprint)) return;
      reviewAppFindings.push({ ...finding, fingerprint });
    };
    for (const app of apps) {
      const verdict = reviewAppVerdict(checks, app);
      const unanswered = unansweredThreadsOf(threads, app, self);
      if (!(verdict === "acts" || (verdict === "none" && unanswered.length > 0))) continue;
      actingApps.push(app);
      const bot = `${app}[bot]`;
      for (const thread of unanswered) {
        const first = thread.comments[0];
        if (first === undefined) continue;
        reviewAppFindings.push({
          key: `comment-${String(first.commentId)}`,
          appSlug: app,
          reviewId: 0,
          commentId: first.commentId,
          author: bot,
          path: thread.path,
          line: thread.line,
          body: thread.comments.map((comment) => (comment.authorLogin.toLowerCase() === bot ? comment.body : `${comment.authorLogin}: ${comment.body}`)).join("\n\n"),
        });
      }
      for (const run of actingCheckRunsOf(checks, app)) {
        const annotations = await dependencies.reviews.annotations(slug, run.id as number, installationId);
        annotations.forEach((annotation, index) => {
          unthreaded({
            key: `annotation-${String(run.id)}-${String(index)}`,
            appSlug: app,
            reviewId: 0,
            commentId: null,
            author: bot,
            path: annotation.path,
            line: annotation.startLine,
            body: annotation.title === null ? annotation.message : `${annotation.title}: ${annotation.message}`,
          });
        });
      }
      for (const review of reviews) {
        if (review.authorLogin.toLowerCase() !== bot || review.commitSha !== record.headSha || review.body.trim() === "") continue;
        unthreaded({ key: `review-${String(review.reviewId)}`, appSlug: app, reviewId: review.reviewId, commentId: null, author: bot, path: null, line: null, body: review.body.trim() });
      }
    }

    // DI-21.208. The CI checks that failed on the head and pass on the base.
    const base = record.verifiedBaseSha === null ? [] : await dependencies.reviews.checksOnCommit(slug, record.verifiedBaseSha, installationId);
    const ciFindings: CiFinding[] = [];
    for (const check of failedCiChecks({ head: checks, base, reviewApps: apps, factoreeSlug: self })) {
      ciFindings.push(await ciFindingOf(dependencies, slug, check, installationId, log));
    }

    const automatic = reviewAppFindings.length + ciFindings.length;
    const changeSet = await dependencies.changeSets.changeSetOfPullRequest(input.tenantId, record.id);
    if (decisions.length === 0) {
      if (automatic === 0) {
        await holdNotice(apps, checks, threads);
        return { kind: "none", reason: "nothing to act on" };
      }
      // DI-21.210. The product limit counts the automatic runs, per set in a change set (DI-21.160).
      const counted = changeSet === null ? record.reviewerFollowUps : setReviewerFollowUps(changeSet);
      if (counted >= product.automaticFollowUpLimit) {
        const key = `limit:${record.headSha}`;
        if (record.reviewerHandledKey === key || !(await store.markReviewerHandled(input.tenantId, record.id, key))) {
          return { kind: "none", reason: "the limit notice of this head was posted" };
        }
        const notice = automaticLimitNotice(record.url, product.automaticFollowUpLimit, [...actingApps, ...ciFindings.map((finding) => finding.name)], changeSet !== null);
        dependencies.logger.info("the automatic follow-up limit holds", log);
        await say(notice);
        try {
          await dependencies.reviews.comment(slug, record.number, notice, installationId);
        } catch (error) {
          dependencies.logger.warn("the limit notice did not reach the pull request", { ...log, error: String(error) });
        }
        return { kind: "none", reason: "the automatic follow-up limit holds" };
      }
    }
    if (record.verifiedBaseSha === null) {
      dependencies.logger.warn("the pull request holds no verified base, so no PR follow-up run starts", log);
      await say(`Factoree cannot start a PR follow-up run on ${record.url}, because it holds no verified base for it.`);
      return { kind: "none", reason: "no verified base" };
    }
    const carried = reviewAppFindings.slice(0, MAX_FINDINGS);
    const followUp: PrFollowUpInput = {
      pullRequestId: record.id,
      repositoryId: record.repositoryId,
      repositoryFullName: slug,
      number: record.number,
      url: record.url,
      headBranch: record.headBranch,
      headSha: record.headSha,
      baseSha: record.verifiedBaseSha,
      baseBranch: record.baseBranch,
      contractRevision: record.contractRevision + 1,
      trigger: decisions.length > 0 ? "human" : "automatic",
      omittedFindings: Math.max(0, reviewAppFindings.length - MAX_FINDINGS),
      reviewAppFindings: carried,
      ciFindings,
      decisions: decisions.slice(0, MAX_FINDINGS),
    };
    const setRun = changeSet === null ? null : setRunOf(changeSet);
    if (setRun !== null && "problem" in setRun) {
      dependencies.logger.warn("the change set of the pull request cannot run as a set, so no PR follow-up run starts", { ...log, problem: setRun.problem });
      await say(`Factoree cannot start a PR follow-up run on ${record.url}, which runs as its whole change set. ${setRun.problem}`);
      return { kind: "none", reason: setRun.problem };
    }
    if (setRun !== null) followUp.changeSet = setRun.changeSet;
    const start = await runStartOf(dependencies, {
      tenantId: input.tenantId,
      record,
      origin,
      product,
      key: `${record.id}\nsettle\n${input.settleKey}`,
      log,
      extra: { prFollowUp: followUp },
    });
    dependencies.logger.info("a PR follow-up run starts", {
      ...log,
      trigger: followUp.trigger,
      workflow_id: start.workflowId,
      review_apps: actingApps.join(","),
      review_app_findings: carried.length,
      ci_findings: ciFindings.length,
      decisions: decisions.length,
    });
    return { kind: "start", ...start, ...(changeSet === null ? {} : { changeSet: true }) };
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
    // docs/specs/change-sets.md, slice 9, DI-21.161. A merge that brings one pull request of a set
    // current gets the set check. An open sibling with a head that Factoree did not check would make
    // that check prove nothing, so the update waits for a set PR follow-up run.
    const changeSet = await dependencies.changeSets.changeSetOfPullRequest(input.tenantId, record.id);
    const setRun = changeSet === null ? null : setRunOf(changeSet);
    if (setRun !== null && "problem" in setRun) return { kind: "none", reason: setRun.problem };
    if (setRun !== null) {
      const unchecked = setRun.changeSet.members.filter(
        (member) => member.state === "open" && changeSet?.members.find((candidate) => candidate.record?.id === member.pullRequestId)?.record?.verifiedHeadSha !== member.headSha,
      );
      if (unchecked.length > 0) {
        dependencies.logger.info("a pull request of the change set holds a head Factoree did not check, so Factoree does not bring it current", {
          ...log,
          unchecked: unchecked.map((member) => member.url).join(", "),
        });
        return { kind: "none", reason: "a pull request of the change set holds an unchecked head" };
      }
      bringCurrent.changeSet = setRun.changeSet;
    }
    const start = await runStartOf(dependencies, {
      tenantId: input.tenantId,
      record,
      origin,
      product,
      key: `${record.id}\nbring-current\n${input.triggerKey}`,
      log,
      extra: { bringCurrent },
    });
    dependencies.logger.info("a bring-current run starts", { ...log, workflow_id: start.workflowId, change_set: setRun === null ? 0 : setRun.changeSet.members.length });
    return { kind: "start", ...start, ...(changeSet === null ? {} : { changeSet: true }) };
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
      baseUpdate: {
        previousBaseSha: record.verifiedBaseSha,
        conflicts: input.conflicts.slice(0, MAX_CONFLICT_FILES),
        failure: input.failure,
      },
    };
    // docs/specs/change-sets.md, slice 9. The base update of a set member runs as a set, with the new
    // base for the member it brings current.
    const changeSet = await dependencies.changeSets.changeSetOfPullRequest(input.tenantId, record.id);
    const setRun = changeSet === null ? null : setRunOf(changeSet, { pullRequestId: record.id, baseSha: input.baseSha });
    if (setRun !== null && "problem" in setRun) return { kind: "none", reason: setRun.problem };
    if (setRun !== null) followUp.changeSet = setRun.changeSet;
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
    return { kind: "start", ...start, ...(changeSet === null ? {} : { changeSet: true }) };
  },

  /** DI-21.118. Records that a bring-current update of this head pushed nothing. */
  async markBringCurrentTried(input: { tenantId: string; pullRequestId: string; headSha: string }): Promise<void> {
    await dependencies.pullRequests.markBringCurrentTried(input.tenantId, input.pullRequestId, input.headSha);
  },

  /**
   * The spec: Factoree replies on the pull request to each finding the triage dropped, with the
   * reason. A finding in a review thread gets its reply in the thread. DI-21.214: the dropped
   * findings with no thread (annotations and review bodies) of one triage get one combined comment,
   * and their fingerprints join the record, so a later plan skips them until their text changes. A
   * reply that fails is logged, and the others still go.
   */
  async answerDroppedFindings(input: {
    tenantId: string;
    pullRequestId: string;
    findings: Array<PrReviewFinding & { fingerprint?: string }>;
    dropped: TriagedFinding[];
  }): Promise<{ answered: number }> {
    const record = await dependencies.pullRequests.find(input.tenantId, input.pullRequestId);
    if (record === null) return { answered: 0 };
    const origin = await dependencies.pullRequests.originFacts(input.tenantId, record.id);
    const label = `${record.repositoryFullName}#${String(record.number)}`;
    const byKey = new Map(input.findings.map((finding) => [finding.key, finding]));
    let answered = 0;
    const unthreaded: Array<{ finding: PrReviewFinding & { fingerprint?: string }; dropped: TriagedFinding }> = [];
    for (const dropped of input.dropped) {
      const finding = byKey.get(dropped.key);
      if (finding === undefined) continue;
      if (finding.commentId === null) {
        unthreaded.push({ finding, dropped });
        continue;
      }
      try {
        await dependencies.reviews.reply(record.repositoryFullName, record.number, finding, droppedFindingReply(dropped), origin.githubInstallationId);
        answered += 1;
      } catch (error) {
        dependencies.logger.warn("the reply to a dropped finding did not reach the pull request", { pull_request: label, finding: dropped.key, error: String(error), step: "triage" });
      }
    }
    if (unthreaded.length > 0) {
      try {
        await dependencies.reviews.comment(
          record.repositoryFullName,
          record.number,
          droppedUnthreadedReply(unthreaded.map(({ finding, dropped }) => ({ author: finding.author, place: findingPlace(finding), body: finding.body, reason: dropped.reason }))),
          origin.githubInstallationId,
        );
        answered += unthreaded.length;
        const fingerprints = unthreaded.flatMap(({ finding }) => (finding.fingerprint === undefined ? [] : [finding.fingerprint]));
        await dependencies.pullRequests.addAnsweredFingerprints(input.tenantId, record.id, fingerprints);
      } catch (error) {
        dependencies.logger.warn("the reply to the dropped findings with no thread did not reach the pull request", {
          pull_request: label,
          findings: unthreaded.length,
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
   * docs/specs/change-sets.md, slice 9, DI-21.158. Takes the set for one set run of a PR workflow. Only
   * one set run runs at a time across the PR workflows of a set. A holder whose pull request ended,
   * or that held the set for a day, died with it, and the set passes on. The answer names the run of
   * the holder, which a close in the queue of another member stops. A pull request of no set needs
   * no lock.
   */
  async acquireChangeSetRun(input: {
    tenantId: string;
    pullRequestId: string;
    holderWorkflowId: string;
    /** The set run, or null while the holder still plans it. */
    runWorkflowId: string | null;
  }): Promise<{ acquired: boolean; heldBy: string | null }> {
    const changeSet = await dependencies.changeSets.changeSetOfPullRequest(input.tenantId, input.pullRequestId);
    if (changeSet === null) return { acquired: true, heldBy: null };
    const lock = await dependencies.changeSets.changeSetLock(input.tenantId, changeSet.originRunId);
    let replaces: string | null = null;
    if (lock.holder !== null && lock.holder !== input.holderWorkflowId) {
      const holder = changeSet.members.find((member) => member.workflowId === lock.holder);
      const stale =
        lock.at === null || Date.now() - lock.at.getTime() > CHANGE_SET_LOCK_STALE_MS || (holder !== undefined && holder.record !== null && holder.record.state !== "open");
      if (!stale) return { acquired: false, heldBy: lock.runWorkflowId };
      replaces = lock.holder;
      dependencies.logger.warn("a stale holder held the change set, so another PR workflow takes it", {
        origin_run_id: changeSet.originRunId,
        holder: lock.holder,
        step: "change_set_lock",
      });
    }
    const acquired = await dependencies.changeSets.acquireChangeSetLock(input.tenantId, changeSet.originRunId, {
      holder: input.holderWorkflowId,
      runWorkflowId: input.runWorkflowId,
      at: new Date(),
      replaces,
    });
    if (!acquired) return { acquired: false, heldBy: (await dependencies.changeSets.changeSetLock(input.tenantId, changeSet.originRunId)).runWorkflowId };
    dependencies.logger.info("a PR workflow took the change set for a set run", {
      origin_run_id: changeSet.originRunId,
      holder: input.holderWorkflowId,
      run: input.runWorkflowId,
      step: "change_set_lock",
    });
    return { acquired: true, heldBy: input.runWorkflowId };
  },

  /**
   * docs/specs/change-sets.md, slice 9, DI-21.162. A set run checked an open member that it changed
   * nothing on: its head becomes the verified head, with the run, its base and its level, while the
   * record still names that head.
   */
  async recordCheckedHead(input: {
    tenantId: string;
    pullRequestId: string;
    headSha: string;
    baseSha: string;
    runId: string;
    autonomyLevel: string;
  }): Promise<{ recorded: boolean }> {
    const recorded = await dependencies.changeSets.recordCheckedHead(input.tenantId, input.pullRequestId, {
      headSha: input.headSha,
      baseSha: input.baseSha,
      runId: input.runId,
      autonomyLevel: input.autonomyLevel,
    });
    if (!recorded) dependencies.logger.info("the head moved after the set run checked it, so it stays unverified", { pull_request_id: input.pullRequestId, step: "pull_request_record" });
    return { recorded };
  },

  /** DI-21.158. Gives the set back after a set run, and names the other PR workflows of the set, which wait for it. */
  async releaseChangeSetRun(input: { tenantId: string; pullRequestId: string; holderWorkflowId: string }): Promise<{ siblings: string[] }> {
    const changeSet = await dependencies.changeSets.changeSetOfPullRequest(input.tenantId, input.pullRequestId);
    if (changeSet === null) return { siblings: [] };
    await dependencies.changeSets.releaseChangeSetLock(input.tenantId, changeSet.originRunId, input.holderWorkflowId);
    return { siblings: changeSet.members.map((member) => member.workflowId).filter((workflowId) => workflowId !== input.holderWorkflowId) };
  },

  /**
   * DI-21.158. Whether another PR workflow of the set holds the set now, and its run. A PR workflow of
   * the set takes no event while it is held, so a push of the set run never reads as a human push.
   */
  async changeSetRunHolder(input: { tenantId: string; pullRequestId: string; holderWorkflowId: string }): Promise<{ held: boolean; runWorkflowId: string | null }> {
    const changeSet = await dependencies.changeSets.changeSetOfPullRequest(input.tenantId, input.pullRequestId);
    if (changeSet === null) return { held: false, runWorkflowId: null };
    const lock = await dependencies.changeSets.changeSetLock(input.tenantId, changeSet.originRunId);
    if (lock.holder === null || lock.holder === input.holderWorkflowId) return { held: false, runWorkflowId: null };
    const holder = changeSet.members.find((member) => member.workflowId === lock.holder);
    const stale =
      lock.at === null || Date.now() - lock.at.getTime() > CHANGE_SET_LOCK_STALE_MS || (holder !== undefined && holder.record !== null && holder.record.state !== "open");
    return stale ? { held: false, runWorkflowId: null } : { held: true, runWorkflowId: lock.runWorkflowId };
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

    const verified = pullRequest.headSha === record.verifiedHeadSha;
    // docs/specs/pr-feedback-loop.md, DI-21.212. At L4 every review app must pass the verified head.
    const reviewAppHolds = verified && record.autonomyLevel === "L4" ? await reviewAppHoldsOn(dependencies, record, facts.productId, pullRequest.headSha, installationId) : [];
    const changeRequests = verified ? openChangeRequests(await port.reviews(slug, record.number, installationId)) : [];
    const unmet = unmetConditions({
      level: record.autonomyLevel,
      verifiedHeadSha: record.verifiedHeadSha,
      pullRequest,
      reviewAppHolds,
      changeRequests,
    });
    // docs/specs/pr-review-merge-and-deploy.md, D7, DI-21.157. In a change set, a consumer pull request
    // takes auto-merge only after every provider pull request merged.
    const changeSet = await dependencies.changeSets.changeSetOfPullRequest(input.tenantId, record.id);
    const providersWaiting = changeSet === null ? null : providersNotMerged(changeSet, record.id);
    if (providersWaiting !== null) unmet.push(providersWaiting);
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
