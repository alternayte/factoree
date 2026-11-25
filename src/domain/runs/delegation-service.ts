import { metrics } from "~/telemetry/metrics.js";
import { buildDraftWorkflowId, buildFollowUpWorkflowId, buildWorkflowId, isPrFollowUpWorkflowId } from "~/temporal/workflow-id.js";
import { isTerminalRunStatus, type RunStatus } from "~/domain/runs/run-status.js";
import { noFollowUpLine, renderFollowUpDescription, takesFollowUp } from "~/domain/runs/run-recovery.js";
import type { RunViewReader } from "~/domain/runs/run-view.js";
import type { Logger } from "~/telemetry/logger.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import type { WebhookLog } from "~/domain/runs/run-repository.js";
import type { RunStopLog, StopRequest } from "~/domain/runs/run-stop.js";
import type { BlockerWait } from "~/domain/runs/blocker-wait.js";
import type { DrainMode } from "~/domain/runs/drain-mode.js";
import type { PullRequestStore } from "~/domain/pull-requests/pull-request-store.js";
import type { OpenDeployFailure } from "~/domain/pull-requests/deploys.js";
import type { PullRequestLinearReplyEvent } from "~/domain/pull-requests/pull-request-event.js";
import {
  decideDraft,
  DRAFT_IN_PROGRESS_LINE,
  DRAFT_STARTED_LINE,
  draftPublishedLine,
  isDraftCommand,
  type DraftRequest,
  type RunDraftStore,
} from "~/domain/runs/run-draft.js";

/**
 * Specification section 9. Posts a refusal reason on the agent session that raised it, so a
 * routing failure, an unconfigured tenant, or an unusable slug reaches the human waiting in
 * Linear, not only Linear's delivery log. The workspace id resolves the token, because no Run
 * row exists yet to resolve it from.
 */
export interface RefusalNotifier {
  postFailure(workspaceId: string, sessionId: string, message: string): Promise<void>;
  /** docs/specs/run-recovery.md. A plain answer on the agent session, not a failure. */
  postResponse(workspaceId: string, sessionId: string, message: string): Promise<void>;
}

/** docs/specs/run-recovery.md. What the delegation reads of the earlier runs of a session. */
export interface SessionRuns {
  findByAgentSession(
    tenantId: string,
    agentSessionId: string,
  ): Promise<{ id: string; status: RunStatus; temporalWorkflowId: string } | null>;
  /** docs/specs/change-sets.md. The targets of a run, whose pull requests a reply is pointed to. */
  listRunTargets(tenantId: string, runId: string): Promise<Array<{ repositoryId: string; pullRequestUrl: string | null }>>;
  /** docs/specs/change-sets.md. The last patch of each target of a run. */
  lastPatches(tenantId: string, runId: string): Promise<Array<{ repositoryFullName: string; patchBase64: string }>>;
}
import type { AgentSessionEvent } from "~/adapters/linear/webhook-schemas.js";
import { classifyAgentSessionEvent } from "~/adapters/linear/webhook-schemas.js";
import type {
  AgentRunProductInput,
  AgentRunWorkItemInput,
  AgentRunWorkflowInput,
} from "~/workflows/agent-run.workflow.js";
import { resolveProduct } from "~/domain/routing/resolve-product.js";
import { assertRepositorySlug } from "~/domain/products/repository-url.js";
import { agentRunProductInput } from "~/domain/runs/agent-run-product.js";
import { ignoresImages } from "~/domain/products/model-vision.js";
import { awaitsAcceptance, isMember } from "~/domain/products/membership.js";

export interface WorkflowStarter {
  start(input: { workflowId: string; args: [AgentRunWorkflowInput] }): Promise<void>;
  // Both signal methods report false if the workflow is not running.
  signalStop(workflowId: string, request?: StopRequest): Promise<boolean>;
  signalHumanInput(workflowId: string, body: string): Promise<boolean>;
  /**
   * docs/specs/draft-of-failed-run.md. Starts the draft workflow of one failed run. It reports
   * false when that workflow already runs.
   */
  startDraft(input: { workflowId: string; tenantId: string; runId: string }): Promise<boolean>;
}

export type DelegationOutcome =
  | { kind: "started"; agentSessionId: string; workflowId: string }
  | { kind: "waiting_for_blockers"; workflowId: string }
  | { kind: "held_for_update"; workflowId: string }
  | { kind: "duplicate" }
  | { kind: "stopped"; workflowId: string }
  | { kind: "prompt_forwarded"; workflowId: string }
  | { kind: "not_running"; workflowId: string }
  | { kind: "follow_up_refused"; status: string }
  | { kind: "draft"; outcome: DraftOutcome["kind"] }
  | { kind: "ignored"; reason: string }
  | { kind: "unconfigured"; reason: string }
  | { kind: "blocked_routing"; reason: string };

/** The answer to a Linear reply after a failed PR follow-up run. */
export const PR_FOLLOW_UP_REPLY_LINE =
  "This run followed up its pull request, and that pull request is no longer open, so a reply here starts no new run.";

/** docs/specs/draft-of-failed-run.md. The answer to one draft request. */
export type DraftOutcome =
  | { kind: "not_found" }
  | { kind: "refused"; reason: string }
  | { kind: "published"; pullRequestUrl: string }
  | { kind: "started"; workflowId: string }
  | { kind: "in_progress"; workflowId: string };

/** The line Factoree answers a draft request with on the agent session. */
const draftLine = (outcome: DraftOutcome): string => {
  switch (outcome.kind) {
    case "not_found":
      return "Factoree found no run to publish as a draft.";
    case "refused":
      return outcome.reason;
    case "published":
      return draftPublishedLine(outcome.pullRequestUrl);
    case "started":
      return DRAFT_STARTED_LINE;
    case "in_progress":
      return DRAFT_IN_PROGRESS_LINE;
  }
};

export interface DelegationDependencies {
  tenants: TenantRegistry;
  products: ProductRegistry;
  repositories: RepositoryRegistry;
  webhookLog: WebhookLog;
  starter: WorkflowStarter;
  refusalNotifier: RefusalNotifier;
  logger: Logger;
  /** The GitHub web URL from the install settings, read for each delegation. */
  repositoryBaseUrl: () => Promise<string>;
  /** docs/specs/run-recovery.md. The earlier runs of a session, for a reply after a failed run. */
  sessionRuns?: SessionRuns | undefined;
  runViews?: RunViewReader | undefined;
  /**
   * docs/specs/repository-setup-and-services.md. The product page of the Factoree UI, where an
   * operator sets up a repository.
   */
  productPageUrl?: ((productId: string) => string) | undefined;
  /** Issue #45. Records who stopped a Run and from where. */
  stops?: RunStopLog | undefined;
  /** docs/specs/draft-of-failed-run.md. The facts and the record of a draft of a failed run. */
  drafts?: RunDraftStore | undefined;
  /** docs/specs/blocked-by-wait.md. The hold of a blocked work item, its stop and its reply. */
  blockerWait?: Pick<BlockerWait, "hold" | "stop" | "answerReply"> | undefined;
  /** docs/specs/drain-mode.md. While drain mode is on, a new run waits as a row for the update. */
  drainMode?: Pick<DrainMode, "hold"> | undefined;
  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 5, DI-21.124. The failed deploys of a session. A
   * reply after one starts a follow-up run.
   */
  deployFailures?: Pick<PullRequestStore, "openDeployFailure" | "markDeployFollowedUp"> | undefined;
  /**
   * docs/specs/pr-feedback-loop.md, DI-21.211. Sends a reply to the PR workflow of the open pull
   * request of the session. It answers the workflow id, or null when no pull request of the session is open.
   */
  pullRequestReplies?: { byAgentSession(tenantId: string, agentSessionId: string, event: PullRequestLinearReplyEvent): Promise<string | null> } | undefined;
}

export class DelegationService {
  constructor(private readonly dependencies: DelegationDependencies) {}

  async handleAgentSessionEvent(event: AgentSessionEvent, deliveryId: string): Promise<DelegationOutcome> {
    const tenant = await this.dependencies.tenants.findByWorkspace(event.organizationId);
    const isNew = await this.dependencies.webhookLog.recordIfNew({
      tenantId: tenant?.id ?? null,
      deliveryId,
      eventType: `${event.type}.${event.action}`,
    });
    if (!isNew) {
      this.dependencies.logger.info("duplicate webhook ignored", {
        step: "receive",
        ...(tenant?.id === undefined ? {} : { tenant_id: tenant.id }),
      });
      return { kind: "duplicate" };
    }
    if (!tenant) {
      // Release the marker, so that configuring the workspace and redelivering works.
      await this.dependencies.webhookLog.remove(deliveryId);
      const reason = `no tenant for Linear workspace ${event.organizationId}`;
      // Specification section 9. This refusal must reach the human too, not only Linear's
      // delivery log.
      await this.dependencies.refusalNotifier.postFailure(
        event.organizationId,
        event.agentSession.id,
        reason,
      );
      return { kind: "unconfigured", reason };
    }

    try {
      return await this.dispatch(event, tenant.id, deliveryId);
    } catch (error) {
      // The marker is written first, to serialize concurrent duplicate deliveries. If the
      // work after it fails, release the marker so a Linear redelivery is not lost.
      await this.dependencies.webhookLog.remove(deliveryId);
      throw error;
    }
  }

  private async dispatch(
    event: AgentSessionEvent,
    tenantId: string,
    deliveryId: string,
  ): Promise<DelegationOutcome> {
    const workflowId = buildWorkflowId(event.organizationId, event.agentSession.id);
    const command = classifyAgentSessionEvent(event);

    if (command.kind === "ignore") return { kind: "ignored", reason: command.reason };
    // docs/specs/run-recovery.md. A follow-up run shares the session, so the newest run of the
    // session owns its workflow.
    const latest = (await this.dependencies.sessionRuns?.findByAgentSession(tenantId, event.agentSession.id)) ?? null;
    if (command.kind === "stop") {
      const target = latest?.temporalWorkflowId ?? workflowId;
      const signalled = await this.stopRun({
        tenantId,
        runId: latest !== null && !isTerminalRunStatus(latest.status) ? latest.id : null,
        workflowId: target,
        request: { source: "linear" },
      });
      return signalled ? { kind: "stopped", workflowId: target } : { kind: "not_running", workflowId: target };
    }
    let followUp: { failedRunId: string; reply: string; browserAssertions: string[]; deploy?: OpenDeployFailure } | null = null;
    if (command.kind === "prompt") {
      // docs/specs/blocked-by-wait.md. No workflow exists yet to take the reply, so it gets one
      // fixed answer. A run that left the wait since the read takes the reply as before.
      if (
        latest !== null &&
        (latest.status === "WAITING_FOR_BLOCKERS" || latest.status === "WAITING_FOR_UPDATE") &&
        this.dependencies.blockerWait !== undefined &&
        (await this.dependencies.blockerWait.answerReply(tenantId, latest.id))
      ) {
        return { kind: "waiting_for_blockers", workflowId: latest.temporalWorkflowId };
      }
      if (latest === null || !isTerminalRunStatus(latest.status)) {
        const target = latest?.temporalWorkflowId ?? workflowId;
        const signalled = await this.dependencies.starter.signalHumanInput(target, command.body);
        metrics.humanInterventions.inc({ tenant_id: tenantId, product_id: "" });
        return signalled ? { kind: "prompt_forwarded", workflowId: target } : { kind: "not_running", workflowId: target };
      }
      // docs/specs/pr-feedback-loop.md, DI-21.211. While a pull request of the session is open, a reply
      // is a human decision on it: its PR workflow takes it, and a PR follow-up run follows it.
      if (this.dependencies.pullRequestReplies !== undefined && !isDraftCommand(command.body) && command.body.trim() !== "") {
        const routed = await this.dependencies.pullRequestReplies.byAgentSession(tenantId, event.agentSession.id, {
          kind: "linear_reply",
          deliveryId: `linear:${deliveryId}`,
          agentSessionId: event.agentSession.id,
          replyId: event.agentActivity?.id ?? deliveryId,
          authorName: command.author,
          body: command.body,
          url: event.agentSession.url ?? null,
        });
        if (routed !== null) {
          metrics.humanInterventions.inc({ tenant_id: tenantId, product_id: "" });
          return { kind: "prompt_forwarded", workflowId: routed };
        }
      }
      // docs/specs/pr-review-merge-and-deploy.md, slice 5, DI-21.124. A reply after a failed deploy
      // of the merged change starts a follow-up run with the failure as a finding. This extends
      // DI-19.04: a reply after READY_FOR_HUMAN with no failed deploy still starts nothing.
      const failedDeploy =
        this.dependencies.deployFailures === undefined || isDraftCommand(command.body)
          ? null
          : await this.dependencies.deployFailures.openDeployFailure(tenantId, event.agentSession.id);
      if (failedDeploy !== null) {
        followUp = { failedRunId: failedDeploy.runId, reply: command.body, browserAssertions: [], deploy: failedDeploy };
        metrics.humanInterventions.inc({ tenant_id: tenantId, product_id: "" });
      } else {
        // docs/specs/pr-review-merge-and-deploy.md. A PR follow-up run follows an open pull request,
        // and a review there starts the next one. A follow-up run of the issue would open a second pull
        // request for the same work item, and so would a draft of its patch.
        if (isPrFollowUpWorkflowId(latest.temporalWorkflowId) && (takesFollowUp(latest.status) || isDraftCommand(command.body))) {
          await this.dependencies.refusalNotifier.postResponse(event.organizationId, event.agentSession.id, PR_FOLLOW_UP_REPLY_LINE);
          return { kind: "follow_up_refused", status: latest.status };
        }
        // docs/specs/draft-of-failed-run.md. The command is the whole reply, so a real follow-up
        // reply never matches. The chosen option of the elicitation arrives as the same prompt.
        if (isDraftCommand(command.body)) {
          const outcome = await this.requestDraft({
            tenantId,
            runId: latest.id,
            request: { source: "linear", by: command.author },
          });
          await this.dependencies.refusalNotifier.postResponse(event.organizationId, event.agentSession.id, draftLine(outcome));
          return { kind: "draft", outcome: outcome.kind };
        }
        if (!takesFollowUp(latest.status)) {
          await this.dependencies.refusalNotifier.postResponse(
            event.organizationId,
            event.agentSession.id,
            noFollowUpLine(
              latest.status,
              ((await this.dependencies.sessionRuns?.listRunTargets(tenantId, latest.id)) ?? []).flatMap((target) =>
                target.pullRequestUrl === null ? [] : [target.pullRequestUrl],
              ),
            ),
          );
          return { kind: "follow_up_refused", status: latest.status };
        }
        const failed = (await this.dependencies.runViews?.detail(tenantId, latest.id)) ?? null;
        followUp = {
          failedRunId: latest.id,
          reply: command.body,
          browserAssertions: [
            ...new Set((failed?.assertions ?? []).filter((assertion) => assertion.method === "browser").map((assertion) => assertion.key)),
          ],
        };
        metrics.humanInterventions.inc({ tenant_id: tenantId, product_id: "" });
      }
    }

    const teamId = event.agentSession.issue?.teamId ?? null;
    const outcome = resolveProduct(await this.dependencies.products.list(tenantId), teamId);
    if (outcome.kind === "refused") {
      await this.dependencies.webhookLog.remove(deliveryId);
      // Specification section 9. A refusal never guesses, and it names what an operator must fix.
      // The reason must reach the human, not only Linear's delivery log, so Factoree posts it on
      // the agent session that raised it.
      await this.dependencies.refusalNotifier.postFailure(
        event.organizationId,
        event.agentSession.id,
        outcome.reason,
      );
      return { kind: "blocked_routing", reason: outcome.reason };
    }
    const product = outcome.product;
    const repositories = await this.dependencies.repositories.listByProduct(product.id);

    // docs/specs/repository-setup-and-services.md. A product with no repository can change none,
    // so the reply links the page where an operator sets one up, instead of an empty question.
    if (!repositories.some(isMember) && this.dependencies.productPageUrl !== undefined) {
      await this.dependencies.webhookLog.remove(deliveryId);
      // docs/specs/repository-membership.md. A claim no admin accepted is no member, and the reply says so.
      const waiting = repositories.filter(awaitsAcceptance).map((repository) => repository.fullName);
      const reason =
        waiting.length > 0
          ? `The product ${product.slug} has no accepted repository, so Factoree can change nothing. ` +
            `${waiting.join(", ")} ${waiting.length === 1 ? "claims" : "claim"} it and ${waiting.length === 1 ? "waits" : "wait"} for a Linear workspace admin to accept ${waiting.length === 1 ? "it" : "them"} on ${this.dependencies.productPageUrl(product.id)}, under Repositories. Then delegate the issue again.`
          : `The product ${product.slug} has no repository yet, so Factoree can change nothing. ` +
            `Set one up on ${this.dependencies.productPageUrl(product.id)}, under Repositories, then delegate the issue again.`;
      await this.dependencies.refusalNotifier.postFailure(event.organizationId, event.agentSession.id, reason);
      return { kind: "blocked_routing", reason };
    }

    // SDD section 7 and SDD section 8. The Work Item text travels as the author wrote it. The
    // workflow refines it, resolves the context, and derives the sandbox from the pinned SHAs.
    const description = event.agentSession.issue?.description ?? "";
    const workItem: AgentRunWorkItemInput = {
      issueId: event.agentSession.issueId ?? event.agentSession.issue?.id ?? null,
      title: event.agentSession.issue?.title ?? "",
      description:
        followUp === null
          ? description
          : await this.followUpDescription(tenantId, description, followUp.failedRunId, followUp.reply, followUp.deploy),
      url: event.agentSession.issue?.url ?? null,
      labels: [],
    };

    // SDD section 15 and section 16. The Product owns the default autonomy level and the
    // organization skills repository. Every other runtime value comes from
    // `.factoree/config.yaml` inside the target repository, so nothing here reads it.
    // docs/specs/autonomy-levels.md. A pending Product can investigate and report, nothing
    // more, whatever level its row holds.
    const defaultAutonomy = product.status === "pending" ? "L0" : product.defaultAutonomy;
    const workflowProduct: AgentRunProductInput = agentRunProductInput({
      product,
      defaultAutonomy,
      repositories,
      repositoryBaseUrl: await this.dependencies.repositoryBaseUrl(),
      productPageUrl: this.dependencies.productPageUrl === undefined ? null : this.dependencies.productPageUrl(product.id),
    });

    // An unusable slug must stop the Run here, and not inside the workflow, where the operator
    // sees only a failed Run. The workflow builds the real clone URL later.
    try {
      for (const repository of repositories) {
        assertRepositorySlug(repository.fullName);
      }
      if (product.organizationSkillsRepository !== null) {
        assertRepositorySlug(product.organizationSkillsRepository);
      }
    } catch (error) {
      await this.dependencies.webhookLog.remove(deliveryId);
      const reason = `product ${product.slug} has an unusable repository: ${String(error)}`;
      // Specification section 9. This refusal must reach the human too, not only Linear's
      // delivery log.
      await this.dependencies.refusalNotifier.postFailure(
        event.organizationId,
        event.agentSession.id,
        reason,
      );
      return { kind: "unconfigured", reason };
    }

    // DI-21.124. A follow-up of a failed deploy is keyed by the deploy, so a second failed deploy of the
    // same run gets its own follow-up run.
    const runWorkflowId =
      followUp === null
        ? workflowId
        : buildFollowUpWorkflowId(
            event.organizationId,
            event.agentSession.id,
            followUp.deploy === undefined ? followUp.failedRunId : `deploy-${followUp.deploy.id}`,
          );
    // docs/specs/change-sets.md, DI-21.131. A follow-up run starts from the set of the run it follows.
    // The human reply refines the work, it does not re-route it.
    const followUpTargets =
      followUp === null
        ? []
        : ((await this.dependencies.sessionRuns?.listRunTargets(tenantId, followUp.failedRunId)) ?? []).map((target) => target.repositoryId);
    const startInput: AgentRunWorkflowInput = {
      tenantId,
      workspaceId: event.organizationId,
      productId: product.id,
      linearIssueId: event.agentSession.issueId ?? event.agentSession.issue?.id ?? null,
      agentSessionId: event.agentSession.id,
      autonomyLevel: defaultAutonomy,
      maxRunMinutes: product.maxRunMinutes,
      workItem,
      product: workflowProduct,
      ...(followUp === null
        ? {}
        : { followUpOfRunId: followUp.failedRunId, followUpReply: followUp.reply, followUpBrowserAssertions: followUp.browserAssertions }),
      ...(followUpTargets.length === 0 ? {} : { followUpTargets }),
      ...(followUp?.deploy === undefined
        ? {}
        : {
            deployFailure: {
              environment: followUp.deploy.environment,
              sha: followUp.deploy.sha,
              previousSha: followUp.deploy.previousSha,
              logUrl: followUp.deploy.logUrl,
              pullRequestUrl: followUp.deploy.pullRequestUrl,
            },
          }),
      // docs/specs/work-item-images-and-links.md. The run reads the comments created up to this
      // delegation, or up to the reply of a follow-up run (DI-21.39). A reply "ignore the
      // images" skips the image check of the follow-up run.
      delegatedAt: new Date(event.webhookTimestamp ?? Date.now()).toISOString(),
      ...(followUp !== null && ignoresImages(followUp.reply) ? { ignoreImages: true } : {}),
    };

    // docs/specs/blocked-by-wait.md, DI-21.88. A delegation whose work item Linear marks as blocked
    // by an open issue starts no workflow. The run waits as a row, and the sweep starts it with
    // this input. A follow-up run answers a human reply, so it starts at once.
    if (followUp === null && this.dependencies.blockerWait !== undefined) {
      const held = await this.dependencies.blockerWait.hold({
        tenantId,
        productId: product.id,
        linearIssueId: startInput.linearIssueId,
        linearAgentSessionId: event.agentSession.id,
        temporalWorkflowId: runWorkflowId,
        autonomyLevel: defaultAutonomy,
        workItemTitle: workItem.title,
        workItemUrl: workItem.url,
        startInput,
      });
      if (held) return { kind: "waiting_for_blockers", workflowId: runWorkflowId };
    }

    // docs/specs/drain-mode.md. While drain mode is on, no new run starts: it waits as a row, and the
    // sweep starts it with this input once drain mode ends. A follow-up run waits too.
    const heldForUpdate =
      this.dependencies.drainMode !== undefined &&
      (await this.dependencies.drainMode.hold({
        tenantId,
        productId: product.id,
        linearIssueId: startInput.linearIssueId,
        linearAgentSessionId: event.agentSession.id,
        temporalWorkflowId: runWorkflowId,
        autonomyLevel: defaultAutonomy,
        workItemTitle: workItem.title,
        workItemUrl: workItem.url,
        startInput,
      }));
    if (!heldForUpdate) await this.dependencies.starter.start({ workflowId: runWorkflowId, args: [startInput] });
    // DI-21.124. The failed deploy took its reply. A failed mark never undoes the start, and the
    // workflow id keeps a second start of the same deploy out.
    if (followUp?.deploy !== undefined && this.dependencies.deployFailures !== undefined) {
      try {
        await this.dependencies.deployFailures.markDeployFollowedUp(tenantId, followUp.deploy.id, runWorkflowId);
      } catch (error) {
        this.dependencies.logger.error("the follow-up of a failed deploy was not recorded", { tenant_id: tenantId, error: String(error) });
      }
    }

    if (heldForUpdate) return { kind: "held_for_update", workflowId: runWorkflowId };
    return { kind: "started", agentSessionId: event.agentSession.id, workflowId: runWorkflowId };
  }

  /**
   * SDD section 50, issue #45. The one stop path of a Run, for a Linear stop and for a Factoree UI
   * stop. It reports false when the workflow is not running. A Run that took the signal records
   * who stopped it and from where. A failed record never undoes a stop that reached the workflow.
   */
  async stopRun(input: { tenantId: string; runId: string | null; workflowId: string; request: StopRequest }): Promise<boolean> {
    const signalled = await this.dependencies.starter.signalStop(input.workflowId, input.request);
    metrics.humanInterventions.inc({ tenant_id: input.tenantId, product_id: "" });
    // docs/specs/blocked-by-wait.md. A waiting run has no workflow to signal, so the stop reaches
    // its row. The cancel records the stop and posts the stop message.
    if (!signalled && input.runId !== null && this.dependencies.blockerWait !== undefined) {
      return await this.dependencies.blockerWait.stop(input.tenantId, input.runId, input.request);
    }
    if (signalled && input.runId !== null && this.dependencies.stops !== undefined) {
      try {
        await this.dependencies.stops.record(input.tenantId, input.runId, input.request, new Date());
      } catch (error) {
        this.dependencies.logger.error("the stop of a run was not recorded", {
          tenant_id: input.tenantId,
          run_id: input.runId,
          error: String(error),
        });
      }
    }
    return signalled;
  }

  /**
   * docs/specs/draft-of-failed-run.md. The one path of a draft request, for the Linear reply, the
   * chosen option and the Factoree UI. A run that already published its draft answers with its pull
   * request, and a draft workflow that runs answers with its id, so a second request starts nothing.
   */
  async requestDraft(input: { tenantId: string; runId: string; request: DraftRequest }): Promise<DraftOutcome> {
    const drafts = this.dependencies.drafts;
    const facts = drafts === undefined ? null : await drafts.facts(input.tenantId, input.runId);
    if (drafts === undefined || facts === null) return { kind: "not_found" };
    const decision = decideDraft(facts);
    if (decision.kind === "refused") return { kind: "refused", reason: decision.reason };
    if (decision.kind === "published") return { kind: "published", pullRequestUrl: decision.pullRequestUrl };
    const workflowId = buildDraftWorkflowId(input.runId);
    const started = await this.dependencies.starter.startDraft({ workflowId, tenantId: input.tenantId, runId: input.runId });
    metrics.humanInterventions.inc({ tenant_id: input.tenantId, product_id: "" });
    if (!started) return { kind: "in_progress", workflowId };
    // DI-21.79. The request that started the workflow is the record. A failed write never undoes it.
    try {
      await drafts.recordRequest(input.tenantId, input.runId, input.request, new Date());
    } catch (error) {
      this.dependencies.logger.error("the draft request of a run was not recorded", {
        tenant_id: input.tenantId,
        run_id: input.runId,
        error: String(error),
      });
    }
    return { kind: "started", workflowId };
  }

  /** docs/specs/run-recovery.md. The issue text plus the reply and the facts of the failed run. */
  private async followUpDescription(
    tenantId: string,
    description: string,
    failedRunId: string,
    reply: string,
    deploy?: OpenDeployFailure,
  ): Promise<string> {
    const detail = (await this.dependencies.runViews?.detail(tenantId, failedRunId)) ?? null;
    // DI-21.124. The patch of a run whose deploy failed is merged into the base already.
    const patches = deploy === undefined ? ((await this.dependencies.sessionRuns?.lastPatches(tenantId, failedRunId)) ?? []) : [];
    return renderFollowUpDescription({
      description,
      reply,
      failedRunId,
      run: { assertions: detail?.assertions ?? [], findings: detail?.findings ?? [] },
      previousPatches: patches.map((entry) => ({
        repositoryFullName: entry.repositoryFullName,
        patch: Buffer.from(entry.patchBase64, "base64").toString("utf8"),
      })),
      ...(deploy === undefined ? {} : { deployFailure: deploy }),
    });
  }
}
