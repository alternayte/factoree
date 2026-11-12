import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { agentSessionEventSchema } from "~/adapters/linear/webhook-schemas.js";
import { DelegationService } from "~/domain/runs/delegation-service.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import type { AgentRunWorkflowInput } from "~/workflows/agent-run.workflow.js";
import type { ProductRecord } from "~/domain/products/product-registry.js";
import type { RepositoryRecord } from "~/domain/products/repository-registry.js";
import { DRAFT_STARTED_LINE, type DraftFacts, type DraftRequest } from "~/domain/runs/run-draft.js";

const event = (name: string) =>
  agentSessionEventSchema.parse(JSON.parse(readFileSync(`tests/fixtures/linear/${name}.json`, "utf8")));

const logger = createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined });

const productFor = (slug: string, organizationSkillsRepository: string | null = null): ProductRecord => ({
  id: `product-${slug}`,
  tenantId: "tenant-1",
  slug,
  name: slug,
  status: "active",
  linearTeamKey: "TEAM",
  linearTeamId: "team-1",
  defaultAutonomy: "L2",
  riskCaps: null,
  allowedDomains: [],
  maxRunMinutes: 90,
  organizationSkillsRepository,
  skillRegistry: null,
  defaultRunner: "opencode",
  model: null,
  runners: { implementer: null, refiner: null, validator: null, reviewer: null, setup: null },
  models: { implementer: null, refiner: null, validator: null, reviewer: null, setup: null },
  effort: { implementer: null, refiner: null, validator: null, reviewer: null, setup: null },
  silenceMinutes: 10,
  refinerCriteriaLimit: 20,
  repairMaxAttempts: 2,
  sandboxRetentionHours: 24,
  sandboxProviderIds: [],
  maxConcurrentRuns: 2, appChangeIssues: "one_per_change",
  createdAt: new Date(),
  updatedAt: new Date(),
});

const defaultProduct = productFor("acme");

const repositoryFor = (
  productId: string,
  fullName: string,
  defaultBranch = "main",
  githubInstallationId = "install-1",
): RepositoryRecord => ({
  id: `repository-${fullName}`,
  tenantId: "tenant-1",
  productId,
  fullName,
  defaultBranch,
  configSha: "a".repeat(40),
  requestedSecretNames: [],
  linearProjects: [],
  discoveredAt: new Date(),
  lastSeenAt: new Date(),
  absentSince: null,
  githubInstallationId,
});

const defaultRepositories = [
  repositoryFor(defaultProduct.id, "acme/api"),
  repositoryFor(defaultProduct.id, "acme/web"),
];

const build = (
  overrides: Partial<{
    isNewDelivery: boolean;
    tenant: unknown;
    products: ProductRecord[];
    repositories: RepositoryRecord[];
    startFails: boolean;
    latest: { id: string; status: "FAILED" | "READY_FOR_HUMAN" | "IMPLEMENTING" | "DRAFT_PUBLISHED"; temporalWorkflowId: string; pullRequestUrl: string | null } | null;
    draftFacts: Partial<DraftFacts>;
    draftRunning: boolean;
  }> = {},
) => {
  const postedResponses: string[] = [];
  const recorded = new Set<string>();
  const postedFailures: Array<{ workspaceId: string; sessionId: string; message: string }> = [];
  const starter = {
    start: vi.fn((input: { workflowId: string; args: [AgentRunWorkflowInput] }) =>
      overrides.startFails === true
        ? Promise.reject(new Error("temporal unreachable"))
        : Promise.resolve(void input),
    ),
    signalStop: vi.fn(() => Promise.resolve(true)),
    signalHumanInput: vi.fn(() => Promise.resolve(true)),
    startDraft: vi.fn(() => Promise.resolve(overrides.draftRunning !== true)),
  };
  const draftRequests: DraftRequest[] = [];
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
    products: {
      list: () => Promise.resolve(overrides.products ?? [defaultProduct]),
    } as never,
    repositories: {
      listByProduct: (productId: string) =>
        Promise.resolve(overrides.repositories ?? defaultRepositories.filter((r) => r.productId === productId)),
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
    refusalNotifier: {
      postFailure: (workspaceId: string, sessionId: string, message: string) => {
        postedFailures.push({ workspaceId, sessionId, message });
        return Promise.resolve();
      },
      postResponse: (_workspaceId: string, _sessionId: string, message: string) => {
        postedResponses.push(message);
        return Promise.resolve();
      },
    },
    logger,
    repositoryBaseUrl: () => Promise.resolve("https://github.com"),
    productPageUrl: (productId: string) => `https://factoree.example/products/${productId}`,
    sessionRuns: {
      findByAgentSession: () => Promise.resolve(overrides.latest ?? null),
      lastPatch: () => Promise.resolve(Buffer.from("diff --git a/x b/x\n").toString("base64")),
    },
    runViews: {
      list: () => Promise.reject(new Error("unused")),
      detail: () =>
        Promise.resolve({
          assertions: [{ key: "VAL-UI-001", attempt: 1, method: "browser", statement: "Shows Loading configs...", result: "FAIL", reason: "not visible" }],
          findings: [],
        } as never),
    },
    drafts: {
      facts: (_tenantId: string, runId: string) =>
        Promise.resolve({
          runId,
          status: overrides.latest?.status ?? "FAILED",
          failureReason: "VALIDATION_FAILED",
          failureMessage: "VAL-UI-001 failed.",
          pullRequestUrl: overrides.latest?.pullRequestUrl ?? null,
          hasPatch: true,
          patchAttempt: 1,
          targetCount: 1,
          assertions: [],
          findings: [],
          reviewed: true,
          ...overrides.draftFacts,
        }),
      subject: () => Promise.resolve(null),
      recordRequest: (_tenantId: string, _runId: string, request: DraftRequest) => {
        draftRequests.push(request);
        return Promise.resolve();
      },
      markPublished: () => Promise.resolve(true),
    },
  });
  return { service, starter, postedFailures, postedResponses, draftRequests };
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
      productId: "product-acme",
      workspaceId: "workspace-123",
      agentSessionId: "session-1",
      linearIssueId: "issue-1",
      autonomyLevel: "L2",
      maxRunMinutes: 90,
    });
  });

  it("runs a pending Product at L0, whatever level its row holds (autonomy-levels.md)", async () => {
    const pending: ProductRecord = { ...defaultProduct, status: "pending", defaultAutonomy: "L3" };
    const { service, starter } = build({ products: [pending] });
    await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-1");
    const call = starter.start.mock.calls[0]?.[0] as unknown as { args: [AgentRunWorkflowInput] };
    expect(call.args[0].autonomyLevel).toBe("L0");
    expect(call.args[0].product.defaultAutonomy).toBe("L0");
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
    expect(starter.signalStop).toHaveBeenCalledWith("linear:workspace-123:session-1", { source: "linear" });
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
    const { service, starter, postedFailures } = build({ tenant: null });
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-3");
    expect(outcome.kind).toBe("unconfigured");
    expect(starter.start).not.toHaveBeenCalled();
    // F4. A refusal must reach the human waiting in Linear, not only the delivery log.
    expect(postedFailures).toHaveLength(1);
    expect(postedFailures[0]?.sessionId).toBe("session-1");
    if (outcome.kind === "unconfigured") expect(postedFailures[0]?.message).toBe(outcome.reason);
  });

  it("blocks routing when no Product claims the team", async () => {
    const { service, starter, postedFailures } = build({ products: [] });
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-4");
    expect(outcome).toMatchObject({ kind: "blocked_routing" });
    expect(starter.start).not.toHaveBeenCalled();
    // F4. The routing refusal reaches the human, as a comment on the agent session.
    expect(postedFailures).toHaveLength(1);
    if (outcome.kind === "blocked_routing") expect(postedFailures[0]?.message).toBe(outcome.reason);
  });

  it("links the product page instead of asking an empty target question (repository-setup-and-services.md)", async () => {
    const { service, starter, postedFailures } = build({ repositories: [] });
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-9");
    expect(outcome).toMatchObject({ kind: "blocked_routing" });
    expect(starter.start).not.toHaveBeenCalled();
    expect(postedFailures[0]?.message).toContain(`https://factoree.example/products/${defaultProduct.id}`);
  });

  it("blocks routing when two Products claim the team", async () => {
    const { service, starter, postedFailures } = build({ products: [productFor("a"), productFor("b")] });
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-13");
    expect(outcome).toMatchObject({ kind: "blocked_routing" });
    expect(starter.start).not.toHaveBeenCalled();
    expect(postedFailures).toHaveLength(1);
  });

  it("passes every member repository to the workflow", async () => {
    const { service, starter } = build({});
    await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-14");
    const started = starter.start.mock.calls[0]?.[0] as unknown as { args: [Record<string, unknown>] };
    const product = started.args[0]?.product as { repositories: Array<{ fullName: string }> };
    expect(product.repositories.map((entry) => entry.fullName)).toEqual(["acme/api", "acme/web"]);
  });

  it("passes the installation that granted each repository, not a placeholder", async () => {
    const { service, starter } = build({
      repositories: [repositoryFor(defaultProduct.id, "acme/api", "main", "install-77")],
    });
    await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-14b");
    const started = starter.start.mock.calls[0]?.[0] as unknown as { args: [Record<string, unknown>] };
    const product = started.args[0]?.product as {
      repositories: Array<{ fullName: string; githubInstallationId: string }>;
    };
    expect(product.repositories).toEqual([
      expect.objectContaining({ fullName: "acme/api", githubInstallationId: "install-77" }),
    ]);
  });

  it("gives the workflow the Work Item and the Product record", async () => {
    const { service, starter } = build({
      products: [productFor("app")],
      repositories: [repositoryFor("product-app", "acme/app", "release")],
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
    expect(started.args[0]?.product).toEqual({
      productId: "product-app",
      productSlug: "app",
      repositories: [
        {
          id: "repository-acme/app",
          fullName: "acme/app",
          defaultBranch: "release",
          absentSince: null,
          githubInstallationId: "install-1",
          linearProjects: [],
        },
      ],
      repositoryBaseUrl: "https://github.com",
      stagingRead: false,
      spriteRetentionHours: 24,
      defaultAutonomy: "L2",
      riskCaps: null,
      allowedDomains: [],
      organizationSkillsRepository: null,
      skillRegistry: null,
      productPageUrl: "https://factoree.example/products/product-app",
      refinerCriteriaLimit: 20,
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

  it("does not start a workflow when a member repository slug is unusable", async () => {
    const { service, starter, postedFailures } = build({
      repositories: [repositoryFor(defaultProduct.id, "not-a-slug")],
    });
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-9");
    expect(outcome.kind).toBe("unconfigured");
    expect(starter.start).not.toHaveBeenCalled();
    // F4. An unusable slug refusal reaches the human too.
    expect(postedFailures).toHaveLength(1);

    // The marker was released, so a Linear redelivery of the same identifier is not a duplicate.
    const redelivery = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-9");
    expect(redelivery.kind).not.toBe("duplicate");
  });

  it("does not start a workflow when a second member repository slug is unusable", async () => {
    const { service, starter } = build({
      repositories: [repositoryFor(defaultProduct.id, "acme/api"), repositoryFor(defaultProduct.id, "not-a-slug")],
    });
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-10");
    expect(outcome.kind).toBe("unconfigured");
    expect(starter.start).not.toHaveBeenCalled();

    // The marker was released, so a Linear redelivery of the same identifier is not a duplicate.
    const redelivery = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-10");
    expect(redelivery.kind).not.toBe("duplicate");
  });
});

describe("the delegation service and the organization skills repository", () => {
  it("carries no organization skills repository when the Product defines none", async () => {
    const { service, starter } = build();
    await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-11");
    const started = starter.start.mock.calls[0]?.[0] as unknown as { args: [Record<string, unknown>] };
    const workflowProduct = started.args[0]?.product as Record<string, unknown>;
    expect(workflowProduct["organizationSkillsRepository"]).toBeNull();
  });

  it("carries the organization skills repository slug into the workflow input", async () => {
    const { service, starter } = build({
      products: [productFor("acme", "acme/skills")],
    });
    await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-12");
    const started = starter.start.mock.calls[0]?.[0] as unknown as { args: [Record<string, unknown>] };
    const workflowProduct = started.args[0]?.product as Record<string, unknown>;
    expect(workflowProduct["organizationSkillsRepository"]).toBe("acme/skills");
  });

  it("does not start a workflow when the organization skills slug is unusable", async () => {
    const { service, starter } = build({
      products: [productFor("acme", "not-a-slug")],
    });
    const outcome = await service.handleAgentSessionEvent(event("agent-session-created"), "delivery-13");
    expect(outcome.kind).toBe("unconfigured");
    expect(starter.start).not.toHaveBeenCalled();
  });

  // docs/specs/run-recovery.md. A reply in the session of a failed run starts a follow-up run.
  describe("a reply after a run", () => {
    const reply = (body: string) => {
      const created = JSON.parse(readFileSync("tests/fixtures/linear/agent-session-created.json", "utf8")) as Record<string, unknown>;
      return agentSessionEventSchema.parse({ ...created, action: "prompted", agentActivity: { content: { type: "prompt", body } } });
    };

    it("starts a follow-up run after a failed run, with the reply and the facts in the work item", async () => {
      const { service, starter } = build({
        latest: { id: "run-73", status: "FAILED", temporalWorkflowId: "linear:workspace-123:session-1", pullRequestUrl: null },
      });
      const outcome = await service.handleAgentSessionEvent(reply("Drop VAL-UI-001."), "delivery-follow-up");

      expect(outcome.kind).toBe("started");
      const started = starter.start.mock.calls[0]?.[0];
      expect(started?.workflowId).toMatch(/:follow-up:run-73$/);
      expect(started?.args[0].followUpOfRunId).toBe("run-73");
      expect(started?.args[0].workItem.description).toContain("Drop VAL-UI-001.");
      expect(started?.args[0].workItem.description).toContain("- VAL-UI-001: Shows Loading configs...");
      expect(started?.args[0].workItem.description).toContain("diff --git a/x b/x");
      expect(started?.args[0].followUpBrowserAssertions).toEqual(["VAL-UI-001"]);
    });

    it("answers a reply after a run that succeeded with one line, and starts nothing", async () => {
      const { service, starter, postedResponses } = build({
        latest: { id: "run-72", status: "READY_FOR_HUMAN", temporalWorkflowId: "w", pullRequestUrl: "https://github.com/acme/web/pull/24" },
      });
      const outcome = await service.handleAgentSessionEvent(reply("Also change the footer."), "delivery-done");

      expect(outcome).toEqual({ kind: "follow_up_refused", status: "READY_FOR_HUMAN" });
      expect(starter.start).not.toHaveBeenCalled();
      expect(postedResponses).toEqual([expect.stringContaining("pull/24")]);
    });

    // docs/specs/draft-of-failed-run.md. The typed reply and the chosen option take one matcher.
    it("publishes a failed run as a draft for the reply `publish as draft`, and starts no follow-up run", async () => {
      const { service, starter, postedResponses, draftRequests } = build({
        latest: { id: "run-73", status: "FAILED", temporalWorkflowId: "linear:workspace-123:session-1", pullRequestUrl: null },
      });
      const prompted = JSON.parse(readFileSync("tests/fixtures/linear/agent-session-created.json", "utf8")) as Record<string, unknown>;
      const outcome = await service.handleAgentSessionEvent(
        agentSessionEventSchema.parse({
          ...prompted,
          action: "prompted",
          agentActivity: { content: { type: "prompt", body: "  Publish as draft. " }, user: { id: "u-1", name: "Ada" } },
        }),
        "delivery-draft",
      );

      expect(outcome).toEqual({ kind: "draft", outcome: "started" });
      expect(starter.startDraft).toHaveBeenCalledWith({ workflowId: "draft-run-73", tenantId: "tenant-1", runId: "run-73" });
      expect(starter.start).not.toHaveBeenCalled();
      expect(postedResponses).toEqual([DRAFT_STARTED_LINE]);
      expect(draftRequests).toEqual([{ source: "linear", by: "Ada" }]);
    });

    it("still starts a follow-up run for any other reply on a failed run", async () => {
      const { service, starter } = build({
        latest: { id: "run-73", status: "FAILED", temporalWorkflowId: "linear:workspace-123:session-1", pullRequestUrl: null },
      });
      const outcome = await service.handleAgentSessionEvent(reply("fix the button colour"), "delivery-colour");

      expect(outcome.kind).toBe("started");
      expect(starter.startDraft).not.toHaveBeenCalled();
      expect(starter.start.mock.calls[0]?.[0].workflowId).toMatch(/:follow-up:run-73$/);
    });

    it("answers a second request with the open draft pull request, and starts nothing", async () => {
      const url = "https://github.com/acme/web/pull/31";
      const { service, starter, postedResponses } = build({
        latest: { id: "run-73", status: "DRAFT_PUBLISHED", temporalWorkflowId: "w", pullRequestUrl: url },
      });
      const outcome = await service.handleAgentSessionEvent(reply("publish as draft"), "delivery-draft-again");

      expect(outcome).toEqual({ kind: "draft", outcome: "published" });
      expect(starter.startDraft).not.toHaveBeenCalled();
      expect(postedResponses).toEqual([`The draft pull request of this run is open: ${url}.`]);
    });

    it("answers a request while the draft workflow runs with that workflow, and records nothing", async () => {
      const { service, draftRequests } = build({
        latest: { id: "run-73", status: "FAILED", temporalWorkflowId: "w", pullRequestUrl: null },
        draftRunning: true,
      });
      const outcome = await service.requestDraft({ tenantId: "tenant-1", runId: "run-73", request: { source: "factoree_ui", by: "Ada" } });

      expect(outcome).toEqual({ kind: "in_progress", workflowId: "draft-run-73" });
      expect(draftRequests).toEqual([]);
    });

    it("refuses the draft of a patch whose review found a blocker, names the finding, and opens nothing", async () => {
      const { service, starter, postedResponses } = build({
        latest: { id: "run-73", status: "FAILED", temporalWorkflowId: "w", pullRequestUrl: null },
        draftFacts: {
          findings: [{ key: "RV-1", severity: "blocker", category: "security", evidence: "src/auth.ts:12", description: "The token reaches the log.", blocking: true }],
        },
      });
      const outcome = await service.handleAgentSessionEvent(reply("Publish as draft"), "delivery-draft-blocker");

      expect(outcome).toEqual({ kind: "draft", outcome: "refused" });
      expect(starter.startDraft).not.toHaveBeenCalled();
      expect(postedResponses[0]).toContain("RV-1 at src/auth.ts:12: The token reaches the log.");
    });

    it("forwards a reply to the newest run while it is active", async () => {
      const { service, starter } = build({
        latest: { id: "run-74", status: "IMPLEMENTING", temporalWorkflowId: "linear:w:s:follow-up:run-73", pullRequestUrl: null },
      });
      const outcome = await service.handleAgentSessionEvent(reply("Use the old label."), "delivery-active");

      expect(outcome).toEqual({ kind: "prompt_forwarded", workflowId: "linear:w:s:follow-up:run-73" });
      expect(starter.signalHumanInput).toHaveBeenCalledWith("linear:w:s:follow-up:run-73", "Use the old label.");
    });
  });
});
