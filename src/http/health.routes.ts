import type { FastifyInstance } from "fastify";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { registry } from "~/telemetry/metrics.js";

export const registerHealthRoutes = (app: FastifyInstance, prisma: FactoreePrismaClient): void => {
  app.get("/healthz", () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

};

// Every metric carries tenant_id and product_id labels, so /metrics is not public.
// The caller registers it inside the administration scope, behind the bearer guard.
export const registerMetricsRoute = (app: FastifyInstance): void => {
  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
};
