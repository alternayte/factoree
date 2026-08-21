import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { agentSessionEventSchema } from "~/adapters/linear/webhook-schemas.js";
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import type { AgentRunWorkflowInput } from "~/workflows/agent-run.workflow.js";

const event = (name: string) =>
  agentSessionEventSchema.parse(JSON.parse(readFileSync(`tests/fixtures/linear/${name}.json`, "utf8")));

const logger = createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined });

const project = {
  id: "project-1",
  tenantId: "tenant-1",
  key: "demo",
  name: "Demo",
  primaryRepository: "acme/demo",
  referenceRepositories: [],
  linearTeamId: "team-1",
  defaultAutonomy: "L2",
  maxRunMinutes: 90,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const build = (overrides: Partial<{ isNewDelivery: boolean; tenant: unknown; project: unknown }> = {}) => {
  const starter = {
    start: vi.fn((input: { workflowId: string; args: [AgentRunWorkflowInput] }) => Promise.resolve(void input)),
    signalStop: vi.fn(() => Promise.resolve(undefined)),
    signalHumanInput: vi.fn(() => Promise.resolve(undefined)),
  };
  const service = new DelegationService({
    tenants: {
      findByWorkspace: () =>
        Promise.resolve(
          overrides.tenant === undefined ? { id: "tenant-1", linearWorkspaceId: "workspace-123", name: "A" } : overrides.tenant,
        ),
      ensureTenant: () => Promise.resolve({ id: "tenant-1", linearWorkspaceId: "workspace-123", name: "A" }),
      putInstallation: () => Promise.resolve({ id: "tenant-1", linearWorkspaceId: "workspace-123", name: "A" }),
      getInstallationToken: () => Promise.resolve("token"),
    } as never,
    projects: {
      findByLinearTeam: () => Promise.resolve(overrides.project === undefined ? project : overrides.project),
      findDefaultForTenant: () => Promise.resolve(overrides.project === undefined ? project : overrides.project),
    } as never,
    webhookLog: { recordIfNew: () => Promise.resolve(overrides.isNewDelivery ?? true) },
    starter,
    logger,
  });
  return { service, starter };
};

describe("DelegationService", () => {
  it("starts one workflow for a delegation", async () => {
    const { service, starter } = build();
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-1");
    expect(outcome).toEqual({ kind: "started", runId: "session-1", workflowId: "linear:workspace-123:session-1" });
    expect(starter.start).toHaveBeenCalledTimes(1);
    const call = starter.start.mock.calls[0]?.[0] as unknown as { workflowId: string; args: [Record<string, unknown>] };
    expect(call.workflowId).toBe("linear:workspace-123:session-1");
    expect(call.args[0]).toMatchObject({
      tenantId: "tenant-1",
      projectId: "project-1",
      workspaceId: "workspace-123",
      agentSessionId: "session-1",
      linearIssueId: "issue-1",
      autonomyLevel: "L2",
      maxRunMinutes: 90,
    });
  });

  it("does not start a second workflow for a duplicate delivery", async () => {
    const { service, starter } = build({ isNewDelivery: false });
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-1");
    expect(outcome).toEqual({ kind: "duplicate" });
    expect(starter.start).not.toHaveBeenCalled();
  });

  it("signals stop for a stop event", async () => {
    const { service, starter } = build();
    const outcome = await service.handleAgentSessionEvent(event("agent-session-prompted-stop"), "delivery-2");
    expect(outcome).toEqual({ kind: "stopped", workflowId: "linear:workspace-123:session-1" });
    expect(starter.signalStop).toHaveBeenCalledWith("linear:workspace-123:session-1");
  });

  it("reports an unknown workspace instead of starting work", async () => {
    const { service, starter } = build({ tenant: null });
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-3");
    expect(outcome.kind).toBe("unconfigured");
    expect(starter.start).not.toHaveBeenCalled();
  });

  it("reports a missing project instead of starting work", async () => {
    const { service, starter } = build({ project: null });
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-4");
    expect(outcome.kind).toBe("unconfigured");
    expect(starter.start).not.toHaveBeenCalled();
  });
});
