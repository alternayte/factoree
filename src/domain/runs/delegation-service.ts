import { metrics } from "~/telemetry/metrics.js";
import { buildFollowUpWorkflowId, buildWorkflowId } from "~/temporal/workflow-id.js";
import { isTerminalRunStatus, type RunStatus } from "~/domain/runs/run-status.js";
import { noFollowUpLine, renderFollowUpDescription, takesFollowUp } from "~/domain/runs/run-recovery.js";
import type { RunViewReader } from "~/domain/runs/run-view.js";
import type { Logger } from "~/telemetry/logger.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import type { WebhookLog } from "~/domain/runs/run-repository.js";

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
  ): Promise<{ id: string; status: RunStatus; temporalWorkflowId: string; pullRequestUrl: string | null } | null>;
  lastPatch(tenantId: string, runId: string): Promise<string | null>;
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
import { DEFAULT_PROJECT_DEFAULTS } from "~/domain/runs/project-runtime-config.js";
import { ignoresImages } from "~/domain/products/model-vision.js";

export interface WorkflowStarter {
  start(input: { workflowId: string; args: [AgentRunWorkflowInput] }): Promise<void>;
  // Both signal methods report false if the workflow is not running.
  signalStop(workflowId: string): Promise<boolean>;
  signalHumanInput(workflowId: string, body: string): Promise<boolean>;
}

export type DelegationOutcome =
  | { kind: "started"; agentSessionId: string; workflowId: string }
  | { kind: "duplicate" }
  | { kind: "stopped"; workflowId: string }
  | { kind: "prompt_forwarded"; workflowId: string }
  | { kind: "not_running"; workflowId: string }
  | { kind: "follow_up_refused"; status: string }
  | { kind: "ignored"; reason: string }
  | { kind: "unconfigured"; reason: string }
  | { kind: "blocked_routing"; reason: string };

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
      const signalled = await this.dependencies.starter.signalStop(target);
      metrics.humanInterventions.inc({ tenant_id: tenantId, product_id: "" });
      return signalled ? { kind: "stopped", workflowId: target } : { kind: "not_running", workflowId: target };
    }
    let followUp: { failedRunId: string; reply: string; browserAssertions: string[] } | null = null;
    if (command.kind === "prompt") {
      if (latest === null || !isTerminalRunStatus(latest.status)) {
        const target = latest?.temporalWorkflowId ?? workflowId;
        const signalled = await this.dependencies.starter.signalHumanInput(target, command.body);
        metrics.humanInterventions.inc({ tenant_id: tenantId, product_id: "" });
        return signalled ? { kind: "prompt_forwarded", workflowId: target } : { kind: "not_running", workflowId: target };
      }
      if (!takesFollowUp(latest.status)) {
        await this.dependencies.refusalNotifier.postResponse(
          event.organizationId,
          event.agentSession.id,
          noFollowUpLine(latest.status, latest.pullRequestUrl),
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
    if (!repositories.some((repository) => repository.absentSince === null) && this.dependencies.productPageUrl !== undefined) {
      await this.dependencies.webhookLog.remove(deliveryId);
      const reason =
        `The product ${product.slug} has no repository yet, so Factoree can change nothing. ` +
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
          : await this.followUpDescription(tenantId, description, followUp.failedRunId, followUp.reply),
      url: event.agentSession.issue?.url ?? null,
      labels: [],
    };

    // SDD section 15 and section 16. The Product owns the default autonomy level and the
    // organization skills repository. Every other runtime value comes from
    // `.factoree/config.yaml` inside the target repository, so nothing here reads it.
    // docs/specs/autonomy-levels.md. A pending Product can investigate and report, nothing
    // more, whatever level its row holds.
    const defaultAutonomy = product.status === "pending" ? "L0" : product.defaultAutonomy;
    const workflowProduct: AgentRunProductInput = {
      productId: product.id,
      productSlug: product.slug,
      defaultAutonomy,
      riskCaps: product.riskCaps,
      allowedDomains: product.allowedDomains,
      repositories: repositories.map((repository) => ({
        id: repository.id,
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch,
        absentSince: repository.absentSince === null ? null : repository.absentSince.toISOString(),
        githubInstallationId: repository.githubInstallationId,
        linearProjects: repository.linearProjects,
      })),
      repositoryBaseUrl: await this.dependencies.repositoryBaseUrl(),
      stagingRead: DEFAULT_PROJECT_DEFAULTS.stagingRead,
      // docs/specs/release-0-1-0.md. Retention is a Product setting.
      spriteRetentionHours: product.sandboxRetentionHours,
      organizationSkillsRepository: product.organizationSkillsRepository,
      // docs/specs/skill-registry.md. The key stays in the secret store. Only the settings travel.
      skillRegistry: product.skillRegistry,
    };

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

    const runWorkflowId =
      followUp === null ? workflowId : buildFollowUpWorkflowId(event.organizationId, event.agentSession.id, followUp.failedRunId);
    await this.dependencies.starter.start({
      workflowId: runWorkflowId,
      args: [
        {
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
            : { followUpOfRunId: followUp.failedRunId, followUpBrowserAssertions: followUp.browserAssertions }),
          // docs/specs/work-item-images-and-links.md. The run reads the comments created up to this
          // delegation, or up to the reply of a follow-up run (DI-21.39). A reply "ignore the
          // images" skips the image check of the follow-up run.
          delegatedAt: new Date(event.webhookTimestamp ?? Date.now()).toISOString(),
          ...(followUp !== null && ignoresImages(followUp.reply) ? { ignoreImages: true } : {}),
        },
      ],
    });

    return { kind: "started", agentSessionId: event.agentSession.id, workflowId: runWorkflowId };
  }

  /** docs/specs/run-recovery.md. The issue text plus the reply and the facts of the failed run. */
  private async followUpDescription(tenantId: string, description: string, failedRunId: string, reply: string): Promise<string> {
    const detail = (await this.dependencies.runViews?.detail(tenantId, failedRunId)) ?? null;
    const patch = (await this.dependencies.sessionRuns?.lastPatch(tenantId, failedRunId)) ?? null;
    return renderFollowUpDescription({
      description,
      reply,
      failedRunId,
      run: { assertions: detail?.assertions ?? [], findings: detail?.findings ?? [] },
      previousPatch: patch === null ? null : Buffer.from(patch, "base64").toString("utf8"),
    });
  }
}
