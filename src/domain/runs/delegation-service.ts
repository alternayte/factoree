import { metrics } from "~/telemetry/metrics.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import type { Logger } from "~/telemetry/logger.js";
import type { TenantRegistry } from "~/domain/projects/project-registry.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import type { WebhookLog } from "~/domain/runs/run-repository.js";
import type { AgentSessionEvent } from "~/adapters/linear/webhook-schemas.js";
import { classifyAgentSessionEvent } from "~/adapters/linear/webhook-schemas.js";
import type {
  AgentRunProductInput,
  AgentRunWorkItemInput,
  AgentRunWorkflowInput,
} from "~/workflows/agent-run.workflow.js";
import { resolveProduct } from "~/domain/routing/resolve-product.js";
import { assertRepositorySlug } from "~/domain/projects/repository-url.js";
import { DEFAULT_PROJECT_DEFAULTS } from "~/domain/runs/project-runtime-config.js";

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
  | { kind: "ignored"; reason: string }
  | { kind: "unconfigured"; reason: string }
  | { kind: "blocked_routing"; reason: string };

export interface DelegationDependencies {
  tenants: TenantRegistry;
  products: ProductRegistry;
  repositories: RepositoryRegistry;
  webhookLog: WebhookLog;
  starter: WorkflowStarter;
  logger: Logger;
  repositoryBaseUrl: string;
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
      return { kind: "unconfigured", reason: `no tenant for Linear workspace ${event.organizationId}` };
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
    if (command.kind === "stop") {
      const signalled = await this.dependencies.starter.signalStop(workflowId);
      metrics.humanInterventions.inc({ tenant_id: tenantId, project_id: "" });
      return signalled ? { kind: "stopped", workflowId } : { kind: "not_running", workflowId };
    }
    if (command.kind === "prompt") {
      const signalled = await this.dependencies.starter.signalHumanInput(workflowId, command.body);
      metrics.humanInterventions.inc({ tenant_id: tenantId, project_id: "" });
      return signalled ? { kind: "prompt_forwarded", workflowId } : { kind: "not_running", workflowId };
    }

    const teamId = event.agentSession.issue?.teamId ?? null;
    const outcome = resolveProduct(await this.dependencies.products.list(tenantId), teamId);
    if (outcome.kind === "refused") {
      await this.dependencies.webhookLog.remove(deliveryId);
      // Specification section 9. A refusal never guesses, and it names what an operator must fix.
      return { kind: "blocked_routing", reason: outcome.reason };
    }
    const product = outcome.product;
    const repositories = await this.dependencies.repositories.listByProduct(product.id);

    // SDD section 7 and SDD section 8. The Work Item text travels as the author wrote it. The
    // workflow refines it, resolves the context, and derives the sandbox from the pinned SHAs.
    const workItem: AgentRunWorkItemInput = {
      issueId: event.agentSession.issueId ?? event.agentSession.issue?.id ?? null,
      title: event.agentSession.issue?.title ?? "",
      description: event.agentSession.issue?.description ?? "",
      url: event.agentSession.issue?.url ?? null,
      labels: [],
    };

    // SDD section 15 and section 16. The Product owns the default autonomy level and the
    // organization skills repository. Every other runtime value comes from
    // `.factoree/config.yaml` inside the target repository, so nothing here reads it.
    const workflowProduct: AgentRunProductInput = {
      productId: product.id,
      productSlug: product.slug,
      defaultAutonomy: product.defaultAutonomy,
      repositories: repositories.map((repository) => ({
        id: repository.id,
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch,
      })),
      repositoryBaseUrl: this.dependencies.repositoryBaseUrl,
      stagingRead: DEFAULT_PROJECT_DEFAULTS.stagingRead,
      spriteRetentionHours: DEFAULT_PROJECT_DEFAULTS.spriteRetentionHours,
      organizationSkillsRepository: product.organizationSkillsRepository,
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
      return {
        kind: "unconfigured",
        reason: `product ${product.slug} has an unusable repository: ${String(error)}`,
      };
    }

    await this.dependencies.starter.start({
      workflowId,
      args: [
        {
          tenantId,
          workspaceId: event.organizationId,
          projectId: product.id,
          linearIssueId: event.agentSession.issueId ?? event.agentSession.issue?.id ?? null,
          agentSessionId: event.agentSession.id,
          autonomyLevel: product.defaultAutonomy,
          maxRunMinutes: product.maxRunMinutes,
          workItem,
          product: workflowProduct,
        },
      ],
    });

    return { kind: "started", agentSessionId: event.agentSession.id, workflowId };
  }
}
