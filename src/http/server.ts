import Fastify, { type FastifyInstance } from "fastify";
import type { Env } from "~/config/env.js";
import type { Logger } from "~/telemetry/logger.js";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { LinearTeamLookup } from "~/adapters/linear/team-lookup.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { DelegationService } from "~/domain/runs/delegation-service.js";
import type { DiscoveryService } from "~/domain/products/discovery-service.js";
import { createAdminGuard } from "./admin/auth.js";
import { registerHealthRoutes, registerMetricsRoute } from "./health.routes.js";
import { registerProductRoutes } from "./admin/products.routes.js";
import { registerRunRoutes } from "./admin/runs.routes.js";
import { PrismaAgentSessionStore } from "~/persistence/prisma/agent-session.prisma.js";
import { registerInstallationRoutes } from "./admin/installations.routes.js";
import { registerContextSourceRoutes } from "./admin/context-sources.routes.js";
import { registerLinearWebhookRoutes } from "./webhooks/linear.routes.js";
import { registerGitHubWebhookRoutes, type GitHubWebhookDependencies } from "./webhooks/github.routes.js";
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
  tenants: TenantRegistry;
  products: ProductRegistry;
  repositories: RepositoryRegistry;
  linearTeams: LinearTeamLookup;
  secrets: SecretStore;
  runs: RunRepository;
  delegation: DelegationService;
  /** Registers a repository and its Product from a `.factoree/config.yaml` declaration. */
  discovery: DiscoveryService;
  /** Verifies the raw request body against the `X-Hub-Signature-256` header before any parse. */
  verifyGitHubSignature: (raw: Buffer, signature: string) => boolean;
  /**
   * Starts the sync of one GitHub App installation, keyed on the installation id so a repeated
   * `installation` event joins the run already in flight rather than start a second one.
   */
  startInstallationSync: (input: { tenantId: string; githubInstallationId: string }) => Promise<void>;
  /** docs/specs/proof-pack-and-visual-evidence.md. Records a pull request preview. */
  recordPullRequestPreview: GitHubWebhookDependencies["recordPullRequestPreview"];
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
  registerGitHubWebhookRoutes(app, {
    discovery: dependencies.discovery,
    tenants: dependencies.tenants,
    verifySignature: dependencies.verifyGitHubSignature,
    startInstallationSync: dependencies.startInstallationSync,
    recordPullRequestPreview: dependencies.recordPullRequestPreview,
    logger: dependencies.logger,
  });

  void app.register((admin) => {
    admin.addHook("onRequest", createAdminGuard(dependencies.env.ADMIN_API_TOKEN));
    registerProductRoutes(admin, {
      products: dependencies.products,
      repositories: dependencies.repositories,
      tenants: dependencies.tenants,
      secrets: dependencies.secrets,
      linearTeams: dependencies.linearTeams,
      runs: dependencies.runs,
    });
    registerRunRoutes(admin, {
      runs: dependencies.runs,
      tenants: dependencies.tenants,
      sessions: new PrismaAgentSessionStore(dependencies.prisma),
    });
    registerInstallationRoutes(admin, { tenants: dependencies.tenants });
    registerContextSourceRoutes(admin, {
      products: dependencies.products,
      tenants: dependencies.tenants,
      contextSources: new PrismaContextSourceConfigurationStore(dependencies.prisma),
    });
    registerMetricsRoute(admin);
  });

  return app;
};
