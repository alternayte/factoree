import type { FastifyInstance } from "fastify";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { registry } from "~/telemetry/metrics.js";
import { buildInfo } from "~/config/build-info.js";

export const registerHealthRoutes = (app: FastifyInstance, prisma: FactoreePrismaClient): void => {
  app.get("/healthz", () => ({ status: "ok" }));

  // docs/specs/release-0-1-0.md. An operator and a bug report name the exact build.
  app.get("/version", () => ({
    version: buildInfo.version,
    commit: buildInfo.commit,
    buildDate: buildInfo.buildDate,
  }));

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
