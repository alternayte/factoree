import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { AgentSessionStore } from "~/domain/runs/agent-session.js";

const querySchema = z.object({ linearWorkspaceId: z.string().min(1) });

export const registerRunRoutes = (
  app: FastifyInstance,
  dependencies: { runs: RunRepository; tenants: TenantRegistry; sessions: AgentSessionStore },
): void => {
  app.get<{ Params: { id: string } }>("/admin/runs/:id", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await dependencies.tenants.findByWorkspace(parsed.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const run = await dependencies.runs.findById(tenant.id, request.params.id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    // docs/specs/agent-session-usage-and-hangs.md. Every agent session of the Run, with its usage.
    const agentSessions = await dependencies.sessions.listForRun(tenant.id, run.id);
    return { ...run, agentSessions };
  });
};
