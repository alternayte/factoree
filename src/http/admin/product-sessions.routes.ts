import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { ProductAgentSessionReader } from "~/domain/runs/agent-session.js";
import { errorSchema, schemaOf, SESSION_SECURITY, useSchemasAsDocumentation } from "../openapi.js";

/** The most sessions one call returns. The product page shows the newest few. */
export const MAX_PRODUCT_SESSIONS = 50;

const querySchema = z.object({
  linearWorkspaceId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(MAX_PRODUCT_SESSIONS).default(20),
});

export const productAgentSessionSchema = z.object({
  id: z.string(),
  runId: z.string(),
  role: z.enum(["implementer", "validator", "reviewer", "refiner", "setup"]),
  attempt: z.number(),
  runner: z.string(),
  /** The model the CLI reported for the session, else the model Factoree asked for, else null. */
  model: z.string().nullable(),
  effort: z.string().nullable(),
  outcome: z.enum(["finished", "hung", "failed"]),
  durationMs: z.number(),
  createdAt: z.string(),
});

/**
 * Issue 6, DI-15.16. The newest agent sessions of one Product, with the model and the effort
 * each one ran with. Usage and cost stay on `GET /admin/runs/:id`.
 */
export const registerProductSessionRoutes = (
  app: FastifyInstance,
  dependencies: { products: ProductRegistry; tenants: TenantRegistry; sessions: ProductAgentSessionReader },
): void => {
  useSchemasAsDocumentation(app);
  app.get<{ Params: { id: string } }>(
    "/admin/products/:id/agent-sessions",
    {
      schema: {
        tags: ["products"],
        operationId: "listProductAgentSessions",
        security: SESSION_SECURITY,
        params: schemaOf(z.object({ id: z.string() })),
        querystring: schemaOf(querySchema),
        response: { 200: schemaOf(z.array(productAgentSessionSchema)), 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const query = querySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      const tenant = await dependencies.tenants.findByWorkspace(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const product = await dependencies.products.findById(tenant.id, request.params.id);
      if (!product) return reply.code(404).send({ error: "product not found" });
      const sessions = await dependencies.sessions.listRecentForProduct(tenant.id, product.id, query.data.limit);
      return sessions.map((session) => ({
        id: session.id,
        runId: session.runId,
        role: session.role,
        attempt: session.attempt,
        runner: session.runner,
        model: session.model,
        effort: session.effort,
        outcome: session.outcome,
        durationMs: session.durationMs,
        createdAt: session.createdAt.toISOString(),
      }));
    },
  );
};
