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
  defaultBranch: "main",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const build = (
  overrides: Partial<{ isNewDelivery: boolean; tenant: unknown; project: unknown; startFails: boolean }> = {},
) => {
  const recorded = new Set<string>();
  const starter = {
    start: vi.fn((input: { workflowId: string; args: [AgentRunWorkflowInput] }) =>
      overrides.startFails === true
        ? Promise.reject(new Error("temporal unreachable"))
        : Promise.resolve(void input),
    ),
    signalStop: vi.fn(() => Promise.resolve(true)),
    signalHumanInput: vi.fn(() => Promise.resolve(true)),
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
    webhookLog: {
      recordIfNew: (input: { deliveryId: string }) => {
        if (overrides.isNewDelivery === false) return Promise.resolve(false);
        if (recorded.has(input.deliveryId)) return Promise.resolve(false);
        recorded.add(input.deliveryId);
        return Promise.resolve(true);
      },
      remove: (deliveryId: string) => {
        recorded.delete(deliveryId);
        return Promise.resolve();
      },
    },
    starter,
    logger,
    repositoryBaseUrl: "https://github.com",
  });
  return { service, starter };
};

describe("DelegationService", () => {
  it("starts one workflow for a delegation", async () => {
    const { service, starter } = build();
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-1");
    expect(outcome).toEqual({
      kind: "started",
      agentSessionId: "session-1",
      workflowId: "linear:workspace-123:session-1",
    });
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

  it("releases the delivery marker when the workflow start fails", async () => {
    const { service, starter } = build({ startFails: true });
    await expect(service.handleAgentSessionEvent(event("agent-session-created"), "delivery-5")).rejects.toThrow(
      "temporal unreachable",
    );

    // The redelivery of the same delivery identifier must start work, not report a duplicate.
    starter.start.mockImplementation((input: { workflowId: string; args: [AgentRunWorkflowInput] }) =>
      Promise.resolve(void input),
    );
    const retry = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-5");
    expect(retry).toMatchObject({ kind: "started" });
    expect(starter.start).toHaveBeenCalledTimes(2);
  });

  it("reports a workflow that is not running instead of failing the request", async () => {
    const { service, starter } = build();
    starter.signalStop.mockImplementation(() => Promise.resolve(false));
    const outcome = await service.handleAgentSessionEvent(event("agent-session-prompted-stop"), "delivery-6");
    expect(outcome).toEqual({ kind: "not_running", workflowId: "linear:workspace-123:session-1" });
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

  it("gives the workflow the Work Item and the Project record", async () => {
    const { service, starter } = build({
      project: {
        ...project,
        primaryRepository: "acme/app",
        referenceRepositories: ["acme/lib"],
        defaultBranch: "release",
      },
    });
    const raw = event("agent-session-created");
    raw.agentSession.issue = {
      ...raw.agentSession.issue!,
      title: "Fix the header",
      description: "The header overlaps the logo.",
    };

    await service.handleAgentSessionEvent(raw, "delivery-7");

    const started = starter.start.mock.calls[0]?.[0] as unknown as { args: [Record<string, unknown>] };
    // Phase 4 refines the Work Item inside the workflow, and the workflow derives the sandbox
    // from the pinned SHAs. The Work Item text therefore travels as the author wrote it.
    expect(started.args[0]?.project).toEqual({
      primaryRepository: "acme/app",
      referenceRepositories: ["acme/lib"],
      defaultBranch: "release",
      repositoryBaseUrl: "https://github.com",
      stagingRead: false,
      spriteRetentionHours: 24,
      defaultAutonomy: "L2",
    });
    expect(started.args[0]?.workItem).toMatchObject({
      title: "Fix the header",
      description: "The header overlaps the logo.",
    });
  });

  it("carries an empty description when the issue holds none", async () => {
    const { service, starter } = build();
    const raw = event("agent-session-created");
    raw.agentSession.issue = { ...raw.agentSession.issue!, title: "Fix the header", description: null };

    await service.handleAgentSessionEvent(raw, "delivery-8");

    const started = starter.start.mock.calls[0]?.[0] as unknown as { args: [Record<string, unknown>] };
    expect(started.args[0]?.workItem).toMatchObject({ title: "Fix the header", description: "" });
  });

  it("does not start a workflow when the repository slug is unusable", async () => {
    const { service, starter } = build({
      project: { ...project, primaryRepository: "not-a-slug" },
    });
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-9");
    expect(outcome.kind).toBe("unconfigured");
    expect(starter.start).not.toHaveBeenCalled();

    // The marker was released, so a Linear redelivery of the same identifier is not a duplicate.
    const redelivery = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-9");
    expect(redelivery.kind).not.toBe("duplicate");
  });

  it("does not start a workflow when a reference repository slug is unusable", async () => {
    const { service, starter } = build({
      project: { ...project, referenceRepositories: ["not-a-slug"] },
    });
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-10");
    expect(outcome.kind).toBe("unconfigured");
    expect(starter.start).not.toHaveBeenCalled();

    // The marker was released, so a Linear redelivery of the same identifier is not a duplicate.
    const redelivery = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-10");
    expect(redelivery.kind).not.toBe("duplicate");
  });
});
