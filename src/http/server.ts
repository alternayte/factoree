import {
  registerRepositorySetupRoutes,
  type BuildAheadFailureView,
  type RepositorySetupRouteDependencies,
} from "./admin/repository-setup.routes.js";
import { repositoryNamesOf } from "~/activities/repository-credential.js";
import { PrismaRepositorySetupStore } from "~/persistence/prisma/repository-setup.prisma.js";
import { PrismaAppChangeIssueStore } from "~/persistence/prisma/app-change-issue.prisma.js";
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
import { registerProductRoutes, type ProductRouteDependencies } from "./admin/products.routes.js";
import { registerRunRoutes } from "./admin/runs.routes.js";
import { registerTemporalUi } from "./admin/temporal-ui.routes.js";
import { PrismaRunViewReader } from "~/persistence/prisma/run-view.prisma.js";
import { registerProductSessionRoutes } from "./admin/product-sessions.routes.js";
import { PrismaAgentSessionStore } from "~/persistence/prisma/agent-session.prisma.js";
import { registerInstallationRoutes } from "./admin/installations.routes.js";
import { registerContextSourceRoutes } from "./admin/context-sources.routes.js";
import { registerSettingsRoutes } from "./admin/settings.routes.js";
import { registerSandboxProviderRoutes } from "./admin/sandbox-providers.routes.js";
import { PrismaSandboxProviderStore } from "~/persistence/prisma/sandbox-provider.prisma.js";
import type { SandboxProviderStore } from "~/domain/settings/sandbox-providers.js";
import { registerModelCatalogRoutes } from "./admin/model-catalog.routes.js";
import type { ModelCatalogService } from "~/domain/products/model-catalog-service.js";
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
  /** docs/specs/sandbox-provider-spillover.md. Absent means the store on `prisma`. */
  sandboxProviders?: SandboxProviderStore;
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
  /** docs/specs/setup-app-change-issues.md. Checks the setups of a repository after a push. */
  setupAfterPush?: (input: { tenantId: string; repositoryFullName: string }) => Promise<void>;
  /**
   * docs/specs/repository-setup-and-services.md. Lists the repositories one installation grants,
   * and starts one setup workflow. Absent in a server that starts no workflow, such as the
   * OpenAPI build, which still documents the routes.
   */
  repositorySetup?: Pick<RepositorySetupRouteDependencies, "listInstallationRepositories" | "startSetup">;
  /** docs/specs/run-visibility.md. The Temporal UI inside the stack, or absent for none. */
  temporalUiUrl?: string | undefined;
  /** The Temporal namespace of the install. Absent means `default`. */
  temporalNamespace?: string;
  /** docs/specs/model-picker.md. The models.dev catalog. Absent in the OpenAPI build. */
  modelCatalog?: ModelCatalogService;
  /** docs/specs/skill-registry.md. The save-time check of a Product skill registry. */
  checkSkillRegistry?: ProductRouteDependencies["checkSkillRegistry"];
  /** docs/specs/proof-pack-and-visual-evidence.md. Records a pull request preview. */
  recordPullRequestPreview: GitHubWebhookDependencies["recordPullRequestPreview"];
  /** docs/specs/egress-honesty-and-issue-status.md. A pull request of a run merged or closed. */
  pullRequestClosed?: GitHubWebhookDependencies["pullRequestClosed"];
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
  const sandboxProviders = dependencies.sandboxProviders ?? new PrismaSandboxProviderStore(dependencies.prisma, masterKey);

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
      ...(dependencies.setupAfterPush === undefined ? {} : { setupAfterPush: dependencies.setupAfterPush }),
      ...(dependencies.pullRequestClosed === undefined ? {} : { pullRequestClosed: dependencies.pullRequestClosed }),
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
      sandboxProviders,
      buildAhead: dependencies.buildAhead,
      logger: dependencies.logger,
      startInstallationSync: dependencies.startInstallationSync,
      ...dependencies.setup,
    });

    registerTemporalUi(root, {
      auth: dependencies.auth,
      prisma: dependencies.prisma,
      settings: dependencies.settings,
      logger: dependencies.logger,
      upstream: dependencies.temporalUiUrl ?? null,
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
        ...(dependencies.checkSkillRegistry === undefined ? {} : { checkSkillRegistry: dependencies.checkSkillRegistry }),
        ...(dependencies.modelCatalog === undefined ? {} : { modelCatalog: dependencies.modelCatalog }),
        sandboxProviders,
      });
      registerModelCatalogRoutes(admin, { modelCatalog: dependencies.modelCatalog });
      const sessions = new PrismaAgentSessionStore(dependencies.prisma);
      registerRunRoutes(admin, {
        tenants: dependencies.tenants,
        runViews: new PrismaRunViewReader(dependencies.prisma),
        // Issue #45. A Factoree UI stop takes the stop path of a Linear stop.
        stopRun: (input) => dependencies.delegation.stopRun(input),
        // docs/specs/draft-of-failed-run.md. A Factoree UI draft takes the path of a Linear reply.
        requestDraft: (input) => dependencies.delegation.requestDraft(input),
        userName: async (userId) => {
          const user = await dependencies.prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
          return user === null ? null : user.name.trim() || user.email;
        },
      });
      registerProductSessionRoutes(admin, {
        products: dependencies.products,
        tenants: dependencies.tenants,
        sessions,
      });
      registerInstallationRoutes(admin, { tenants: dependencies.tenants });
      const prisma = dependencies.prisma;
      registerRepositorySetupRoutes(admin, {
        products: dependencies.products,
        tenants: dependencies.tenants,
        setups: new PrismaRepositorySetupStore(prisma),
        appChangeIssues: new PrismaAppChangeIssueStore(prisma),
        registeredRepositories: async (tenantId) =>
          (await prisma.repository.findMany({ where: { tenantId } })).map((row) => ({
            ...row,
            linearProjects: row.linearProjects,
            requestedSecretNames: row.requestedSecretNames,
          })),
        installations: async (tenantId) =>
          (await prisma.gitHubInstallation.findMany({ where: { tenantId } })).map((row) => row.githubInstallationId),
        listInstallationRepositories:
          dependencies.repositorySetup?.listInstallationRepositories ?? (() => Promise.reject(new Error("this server lists no repository"))),
        startSetup: dependencies.repositorySetup?.startSetup ?? (() => Promise.reject(new Error("this server starts no workflow"))),
        buildAheadFailures: async (tenantId) => {
          const names = new Map((await sandboxProviders.list()).map((provider) => [provider.id, provider.name]));
          const byRepository = new Map<string, BuildAheadFailureView[]>();
          for (const row of await prisma.buildAheadFailure.findMany({ where: { tenantId }, orderBy: { failedAt: "desc" } })) {
            const fullName = repositoryNamesOf([row.repositoryUrl])?.[0];
            if (fullName === undefined) continue;
            const entries = byRepository.get(fullName) ?? [];
            entries.push({ provider: names.get(row.providerId) ?? row.providerId, reason: row.reason, failedAt: row.failedAt.toISOString() });
            byRepository.set(fullName, entries);
          }
          return byRepository;
        },
      });
      registerContextSourceRoutes(admin, {
        products: dependencies.products,
        tenants: dependencies.tenants,
        contextSources: new PrismaContextSourceConfigurationStore(dependencies.prisma),
        repositories: dependencies.repositories,
        secrets: dependencies.secrets,
      });
      registerSandboxProviderRoutes(admin, {
        providers: sandboxProviders,
        settings: dependencies.settings,
        localSandboxAllowed,
        ...(dependencies.buildAhead === undefined ? {} : { buildAhead: dependencies.buildAhead }),
      });
      registerSettingsRoutes(admin, {
        prisma: dependencies.prisma,
        settings: dependencies.settings,
        tenants: dependencies.tenants,
        auth: dependencies.auth,
        publicUrl,
        masterKey,
        localSandboxAllowed,
        temporalNamespace: dependencies.temporalNamespace ?? "default",
        listLinearTeams: dependencies.setup.linear.listTeams,
        ...(dependencies.buildAhead === undefined ? {} : { buildAhead: dependencies.buildAhead }),
      });
      registerMetricsRoute(admin);
    });
  });

  return app;
};
