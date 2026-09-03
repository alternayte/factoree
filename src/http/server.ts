import Fastify, { type FastifyInstance } from "fastify";
import type { Env } from "~/config/env.js";
import type { Logger } from "~/telemetry/logger.js";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import type { ProjectRegistry, TenantRegistry } from "~/domain/projects/project-registry.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { DelegationService } from "~/domain/runs/delegation-service.js";
import type { DiscoveryService } from "~/domain/products/discovery-service.js";
import { createAdminGuard } from "./admin/auth.js";
import { registerHealthRoutes, registerMetricsRoute } from "./health.routes.js";
import { registerProjectRoutes } from "./admin/projects.routes.js";
import { registerRunRoutes } from "./admin/runs.routes.js";
import { registerInstallationRoutes } from "./admin/installations.routes.js";
import { registerContextSourceRoutes } from "./admin/context-sources.routes.js";
import { registerLinearWebhookRoutes } from "./webhooks/linear.routes.js";
import { registerGitHubWebhookRoutes } from "./webhooks/github.routes.js";
import { PrismaContextSourceConfigurationStore } from "~/persistence/prisma/context-source-configuration.prisma.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface ServerDependencies {
  env: Env;
  logger: Logger;
  prisma: FactoreePrismaClient;
  projects: ProjectRegistry;
  tenants: TenantRegistry;
  secrets: SecretStore;
  runs: RunRepository;
  delegation: DelegationService;
  /**
   * The GitHub webhook route mounts only when both are present. Production wiring waits on a
   * per-installation GitHub App token source, a gap Task 6 already carried forward.
   */
  discovery?: DiscoveryService;
  verifyGitHubSignature?: (raw: string, signature: string) => boolean;
}

export const buildServer = (dependencies: ServerDependencies): FastifyInstance => {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const buffer = body as Buffer;
    request.rawBody = buffer;
    try {
      done(null, buffer.length === 0 ? {} : (JSON.parse(buffer.toString("utf8")) as unknown));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  registerHealthRoutes(app, dependencies.prisma);
  registerLinearWebhookRoutes(app, {
    secret: dependencies.env.LINEAR_WEBHOOK_SECRET,
    delegation: dependencies.delegation,
    logger: dependencies.logger,
  });
  if (dependencies.discovery && dependencies.verifyGitHubSignature) {
    registerGitHubWebhookRoutes(app, {
      discovery: dependencies.discovery,
      tenants: dependencies.tenants,
      verifySignature: dependencies.verifyGitHubSignature,
      logger: dependencies.logger,
    });
  }

  void app.register((admin) => {
    admin.addHook("onRequest", createAdminGuard(dependencies.env.ADMIN_API_TOKEN));
    registerProjectRoutes(admin, {
      projects: dependencies.projects,
      tenants: dependencies.tenants,
      secrets: dependencies.secrets,
    });
    registerRunRoutes(admin, { runs: dependencies.runs, tenants: dependencies.tenants });
    registerInstallationRoutes(admin, { tenants: dependencies.tenants });
    registerContextSourceRoutes(admin, {
      projects: dependencies.projects,
      tenants: dependencies.tenants,
      contextSources: new PrismaContextSourceConfigurationStore(dependencies.prisma),
    });
    registerMetricsRoute(admin);
  });

  return app;
};
