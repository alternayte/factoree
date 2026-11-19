import Fastify from "fastify";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { productAgentSessionSchema, registerProductSessionRoutes } from "~/http/admin/product-sessions.routes.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import {
  AGENT_SESSION_OUTCOMES,
  type AgentSessionOutcome,
  type AgentSessionRecord,
  type ProductAgentSessionReader,
} from "~/domain/runs/agent-session.js";

const session = (outcome: AgentSessionOutcome): AgentSessionRecord => ({
  id: `session-${outcome}`,
  tenantId: "tenant-1",
  runId: "run-1",
  role: "implementer",
  attempt: 1,
  runner: "claude-code",
  cliSessionId: null,
  model: null,
  effort: null,
  usage: null,
  durationMs: 1_000,
  outcome,
  idempotencyKey: `run:run-1:implementer:1:${outcome}`,
  createdAt: new Date("2026-11-19T08:00:00.000Z"),
});

const build = (rows: AgentSessionRecord[]) => {
  const app = Fastify({ logger: false });
  const tenants = {
    findByWorkspace: (workspace: string) =>
      Promise.resolve(workspace === "ws-1" ? { id: "tenant-1", linearWorkspaceId: "ws-1", name: "Acme" } : null),
  } as unknown as TenantRegistry;
  const products = { findById: (_tenant: string, id: string) => Promise.resolve({ id }) } as unknown as ProductRegistry;
  const sessions: ProductAgentSessionReader = { listRecentForProduct: () => Promise.resolve(rows) };
  registerProductSessionRoutes(app, { products, tenants, sessions });
  return app;
};

describe("GET /admin/products/:id/agent-sessions", () => {
  it("serializes a session that ended unreachable and the body passes the response schema", async () => {
    const app = build(AGENT_SESSION_OUTCOMES.map(session));
    const response = await app.inject({ method: "GET", url: "/admin/products/p1/agent-sessions?linearWorkspaceId=ws-1" });
    expect(response.statusCode).toBe(200);
    const body = productAgentSessionSchema.array().parse(response.json());
    expect(body.map((entry) => entry.outcome)).toContain("unreachable");
    expect(body.map((entry) => entry.outcome)).toEqual([...AGENT_SESSION_OUTCOMES]);
    await app.close();
  });

  it("lists the same outcomes as the domain union", () => {
    expect([...productAgentSessionSchema.shape.outcome.options].sort()).toEqual([...AGENT_SESSION_OUTCOMES].sort());
    expectTypeOf<z.output<typeof productAgentSessionSchema>["outcome"]>().toEqualTypeOf<AgentSessionOutcome>();
  });
});
