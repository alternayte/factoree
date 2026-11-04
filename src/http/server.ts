import Fastify, { type FastifyInstance } from "fastify";
import type { BuildAheadTrigger } from "~/domain/runs/build-ahead.js";
import type { Env } from "~/config/env.js";
import type { Logger } from "~/telemetry/logger.js";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { InstallSettingsStore } from "~/domain/settings/install-settings.js";
import type { LinearTeamLookup } from "~/adapters/linear/team-lookup.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { DelegationService } from "~/domain/runs/delegation-service.js";
import type { DiscoveryService } from "~/domain/products/discovery-service.js";
import { verifyGitHubSignature } from "~/adapters/github/webhook-verifier.js";
import { registerHealthRoutes, registerMetricsRoute } from "./health.routes.js";
import { registerProductRoutes } from "./admin/products.routes.js";
import { registerRunRoutes } from "./admin/runs.routes.js";
import { registerProductSessionRoutes } from "./admin/product-sessions.routes.js";
import { PrismaAgentSessionStore } from "~/persistence/prisma/agent-session.prisma.js";
import { registerInstallationRoutes } from "./admin/installations.routes.js";
import { registerContextSourceRoutes } from "./admin/context-sources.routes.js";
import { registerSettingsRoutes } from "./admin/settings.routes.js";
import { registerLinearWebhookRoutes } from "./webhooks/linear.routes.js";
import { registerGitHubWebhookRoutes, type GitHubWebhookDependencies } from "./webhooks/github.routes.js";
import { PrismaContextSourceConfigurationStore } from "~/persistence/prisma/context-source-configuration.prisma.js";
import { registerAdminGuard } from "./auth/admin-guard.js";
import { registerAuthRoutes } from "./auth/auth.routes.js";
import type { AuthHandle } from "./auth/auth.js";
import { registerSetupRoutes, type SetupRouteDependencies } from "./setup/setup.routes.js";
import { registerOpenApi } from "./openapi.js";
import { registerUi } from "./ui.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface ServerDependencies {
  env: Pick<Env, "FACTOREE_PUBLIC_URL" | "FACTOREE_MASTER_KEY" | "FACTOREE_UNSAFE_LOCAL_SANDBOX">;
  /** The release version, for the OpenAPI document. */
  version: string;
  logger: Logger;
  prisma: FactoreePrismaClient;
  settings: InstallSettingsStore;
  auth: AuthHandle;
  tenants: TenantRegistry;
  products: ProductRegistry;
  repositories: RepositoryRegistry;
  linearTeams: LinearTeamLookup;
  secrets: SecretStore;
  runs: RunRepository;
  delegation: DelegationService;
  /** Registers a repository and its Product from a `.factoree/config.yaml` declaration. */
  discovery: DiscoveryService;
  /**
   * Starts the sync of one GitHub App installation, keyed on the installation id so a repeated
   * `installation` event joins the run already in flight rather than start a second one.
   */
  startInstallationSync: (input: { tenantId: string; githubInstallationId: string }) => Promise<void>;
  /** docs/specs/run-speed.md. Requests a build-ahead when a bootstrap key changes. */
  buildAhead?: BuildAheadTrigger;
  /** docs/specs/proof-pack-and-visual-evidence.md. Records a pull request preview. */
  recordPullRequestPreview: GitHubWebhookDependencies["recordPullRequestPreview"];
  /** The GitHub and Linear calls of setup. */
  setup: Pick<SetupRouteDependencies, "github" | "linear">;
  /** The built UI. Absent, or a directory without index.html, serves no UI. */
  uiRoot?: string;
}

export const buildServer = (dependencies: ServerDependencies): FastifyInstance => {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  const publicUrl = dependencies.env.FACTOREE_PUBLIC_URL;
  const masterKey = dependencies.env.FACTOREE_MASTER_KEY;
  const localSandboxAllowed = dependencies.env.FACTOREE_UNSAFE_LOCAL_SANDBOX === "1";

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const buffer = body as Buffer;
    request.rawBody = buffer;
    try {
      done(null, buffer.length === 0 ? {} : (JSON.parse(buffer.toString("utf8")) as unknown));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  // Swagger loads first, so it sees every route the plugin below declares.
  registerOpenApi(app, dependencies.version);
  if (dependencies.uiRoot !== undefined) registerUi(app, dependencies.uiRoot);

  void app.register((root) => {
    root.get("/api/openapi.json", () => app.swagger());
    registerHealthRoutes(root, dependencies.prisma);

    // docs/specs/release-0-1-0.md. Both webhook secrets come from the install settings, read for
    // each delivery, so a secret changed in the UI applies to the next delivery.
    registerLinearWebhookRoutes(root, {
      secret: async () => (await dependencies.settings.read()).linear.webhookSecret,
      delegation: dependencies.delegation,
      logger: dependencies.logger,
    });
    registerGitHubWebhookRoutes(root, {
      discovery: dependencies.discovery,
      tenants: dependencies.tenants,
      verifySignature: async (raw, signature) => {
        const secret = (await dependencies.settings.read()).github.webhookSecret;
        return secret !== null && verifyGitHubSignature({ rawBody: raw, signature, secret }).ok;
      },
      startInstallationSync: dependencies.startInstallationSync,
      recordPullRequestPreview: dependencies.recordPullRequestPreview,
      logger: dependencies.logger,
      ...(dependencies.buildAhead === undefined ? {} : { buildAhead: dependencies.buildAhead }),
    });

    registerAuthRoutes(root, { auth: dependencies.auth, publicUrl });
    registerSetupRoutes(root, {
      prisma: dependencies.prisma,
      settings: dependencies.settings,
      tenants: dependencies.tenants,
      products: dependencies.products,
      secrets: dependencies.secrets,
      linearTeams: dependencies.linearTeams,
      publicUrl,
      masterKey,
      localSandboxAllowed,
      logger: dependencies.logger,
      startInstallationSync: dependencies.startInstallationSync,
      ...dependencies.setup,
    });

    void root.register((admin) => {
      registerAdminGuard(admin, {
        auth: dependencies.auth,
        prisma: dependencies.prisma,
        settings: dependencies.settings,
        logger: dependencies.logger,
      });
      registerProductRoutes(admin, {
        products: dependencies.products,
        repositories: dependencies.repositories,
        tenants: dependencies.tenants,
        secrets: dependencies.secrets,
        linearTeams: dependencies.linearTeams,
        runs: dependencies.runs,
        ...(dependencies.buildAhead === undefined ? {} : { buildAhead: dependencies.buildAhead }),
      });
      const sessions = new PrismaAgentSessionStore(dependencies.prisma);
      registerRunRoutes(admin, {
        runs: dependencies.runs,
        tenants: dependencies.tenants,
        sessions,
      });
      registerProductSessionRoutes(admin, {
        products: dependencies.products,
        tenants: dependencies.tenants,
        sessions,
      });
      registerInstallationRoutes(admin, { tenants: dependencies.tenants });
      registerContextSourceRoutes(admin, {
        products: dependencies.products,
        tenants: dependencies.tenants,
        contextSources: new PrismaContextSourceConfigurationStore(dependencies.prisma),
        repositories: dependencies.repositories,
        secrets: dependencies.secrets,
      });
      registerSettingsRoutes(admin, {
        prisma: dependencies.prisma,
        settings: dependencies.settings,
        tenants: dependencies.tenants,
        auth: dependencies.auth,
        publicUrl,
        masterKey,
        localSandboxAllowed,
        listLinearTeams: dependencies.setup.linear.listTeams,
        ...(dependencies.buildAhead === undefined ? {} : { buildAhead: dependencies.buildAhead }),
      });
      registerMetricsRoute(admin);
    });
  });

  return app;
};
