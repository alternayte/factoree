import { buildWorkflowId } from "~/temporal/workflow-id.js";
import type { Logger } from "~/telemetry/logger.js";
import type { ProjectRegistry, TenantRegistry } from "~/domain/projects/project-registry.js";
import type { WebhookLog } from "~/domain/runs/run-repository.js";
import type { AgentSessionEvent } from "~/adapters/linear/webhook-schemas.js";
import { classifyAgentSessionEvent } from "~/adapters/linear/webhook-schemas.js";
import type { AgentRunWorkflowInput } from "~/workflows/agent-run.workflow.js";

export interface WorkflowStarter {
  start(input: { workflowId: string; args: [AgentRunWorkflowInput] }): Promise<void>;
  signalStop(workflowId: string): Promise<void>;
  signalHumanInput(workflowId: string, body: string): Promise<void>;
}

export type DelegationOutcome =
  | { kind: "started"; runId: string; workflowId: string }
  | { kind: "duplicate" }
  | { kind: "stopped"; workflowId: string }
  | { kind: "prompt_forwarded"; workflowId: string }
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
      return { kind: "unconfigured", reason: `no tenant for Linear workspace ${event.organizationId}` };
    }

    const workflowId = buildWorkflowId(event.organizationId, event.agentSession.id);
    const command = classifyAgentSessionEvent(event);

    if (command.kind === "ignore") return { kind: "ignored", reason: command.reason };
    if (command.kind === "stop") {
      await this.dependencies.starter.signalStop(workflowId);
      return { kind: "stopped", workflowId };
    }
    if (command.kind === "prompt") {
      await this.dependencies.starter.signalHumanInput(workflowId, command.body);
      return { kind: "prompt_forwarded", workflowId };
    }

    const teamId = event.agentSession.issue?.teamId;
    const project = teamId
      ? await this.dependencies.projects.findByLinearTeam(tenant.id, teamId)
      : await this.dependencies.projects.findDefaultForTenant(tenant.id);
    if (!project) {
      return { kind: "unconfigured", reason: `no project for Linear team ${teamId ?? "unknown"}` };
    }

    await this.dependencies.starter.start({
      workflowId,
      args: [
        {
          tenantId: tenant.id,
          workspaceId: event.organizationId,
          projectId: project.id,
          linearIssueId: event.agentSession.issueId ?? event.agentSession.issue?.id ?? null,
          agentSessionId: event.agentSession.id,
          autonomyLevel: project.defaultAutonomy,
          maxRunMinutes: project.maxRunMinutes,
        },
      ],
    });

    return { kind: "started", runId: event.agentSession.id, workflowId };
  }
}
