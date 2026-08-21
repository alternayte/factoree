import { metrics } from "~/telemetry/metrics.js";
import { buildWorkflowId } from "~/temporal/workflow-id.js";
import type { Logger } from "~/telemetry/logger.js";
import type { ProjectRegistry, TenantRegistry } from "~/domain/projects/project-registry.js";
import type { WebhookLog } from "~/domain/runs/run-repository.js";
import type { AgentSessionEvent } from "~/adapters/linear/webhook-schemas.js";
import { classifyAgentSessionEvent } from "~/adapters/linear/webhook-schemas.js";
import type { AgentRunWorkflowInput } from "~/workflows/agent-run.workflow.js";

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
  | { kind: "unconfigured"; reason: string };

export interface DelegationDependencies {
  tenants: TenantRegistry;
  projects: ProjectRegistry;
  webhookLog: WebhookLog;
  starter: WorkflowStarter;
  logger: Logger;
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

    const teamId = event.agentSession.issue?.teamId;
    const project = teamId
      ? await this.dependencies.projects.findByLinearTeam(tenantId, teamId)
      : await this.dependencies.projects.findDefaultForTenant(tenantId);
    if (!project) {
      await this.dependencies.webhookLog.remove(deliveryId);
      return { kind: "unconfigured", reason: `no project for Linear team ${teamId ?? "unknown"}` };
    }

    await this.dependencies.starter.start({
      workflowId,
      args: [
        {
          tenantId,
          workspaceId: event.organizationId,
          projectId: project.id,
          linearIssueId: event.agentSession.issueId ?? event.agentSession.issue?.id ?? null,
          agentSessionId: event.agentSession.id,
          autonomyLevel: project.defaultAutonomy,
          maxRunMinutes: project.maxRunMinutes,
        },
      ],
    });

    return { kind: "started", agentSessionId: event.agentSession.id, workflowId };
  }
}
