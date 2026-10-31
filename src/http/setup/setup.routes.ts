import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { applyPatch, type InstallSettings, type InstallSettingsStore } from "~/domain/settings/install-settings.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { LinearTeamLookup } from "~/adapters/linear/team-lookup.js";
import { assertRunnerCredential, RunnerCredentialError } from "~/domain/products/runner-credentials.js";
import {
  buildGitHubAppManifest,
  gitHubAppCreationUrl,
  type ConvertedGitHubApp,
} from "~/adapters/github/app-manifest.js";
import type { GitHubAppCredentials } from "~/adapters/github/app-token-provider.js";
import { linearInstallUrl, type LinearAppGrant } from "~/adapters/linear/linear-app-flows.js";
import type { Logger } from "~/telemetry/logger.js";
import { buildInfo } from "~/config/build-info.js";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { errorSchema, schemaOf, SETUP_SECURITY, useSchemasAsDocumentation } from "../openapi.js";
import {
  autonomyLevel,
  installSettingsUpdateSchema,
  linearInstallCallbackUrl,
  linearSignInCallbackUrl,
  linearTeamSchema,
  productSchema,
  sandboxSettingsProblem,
} from "../admin/schemas.js";
import { checkSetupToken, readFlowState, signFlowState } from "./setup-token.js";

export interface SetupRouteDependencies {
  prisma: FactoreePrismaClient;
  settings: InstallSettingsStore;
  tenants: TenantRegistry;
  products: ProductRegistry;
  secrets: SecretStore;
  linearTeams: LinearTeamLookup;
  publicUrl: string;
  masterKey: string;
  localSandboxAllowed: boolean;
  logger: Logger;
  github: {
    convertManifest: (input: { apiBaseUrl: string; code: string }) => Promise<ConvertedGitHubApp>;
    readInstallation: (input: {
      credentials: GitHubAppCredentials;
      installationId: string;
    }) => Promise<{ id: string; accountLogin: string } | null>;
  };
  linear: {
    exchangeCode: (input: { clientId: string; clientSecret: string; redirectUri: string; code: string }) => Promise<LinearAppGrant>;
    readOrganization: (accessToken: string) => Promise<{ id: string; name: string; appUserId: string | null }>;
    listTeams: (linearWorkspaceId: string) => Promise<Array<{ id: string; key: string; name: string }>>;
  };
  startInstallationSync: (input: { tenantId: string; githubInstallationId: string }) => Promise<void>;
}

const TAGS = ["setup"];

const stepSchema = z.object({ done: z.boolean() });

const setupStatusSchema = z.object({
  completed: z.boolean(),
  publicUrl: z.string(),
  githubApp: stepSchema.extend({
    appSlug: z.string().nullable(),
    installUrl: z.string().nullable(),
    baseUrl: z.string(),
    apiBaseUrl: z.string(),
  }),
  linearApp: stepSchema.extend({
    clientId: z.string().nullable(),
    webhookUrl: z.string(),
    installCallbackUrl: z.string(),
    signInCallbackUrl: z.string(),
  }),
  linearInstall: stepSchema.extend({
    workspaceName: z.string().nullable(),
    linearWorkspaceId: z.string().nullable(),
    existing: z.array(z.object({ tenantId: z.string(), workspaceName: z.string() })),
  }),
  githubInstall: stepSchema.extend({ accounts: z.array(z.string()) }),
  sandbox: stepSchema.extend({
    provider: z.string().nullable(),
    localAllowed: z.boolean(),
    /** The sandbox image this release pins. Null in a build from a checkout, where Kiln needs an image. */
    pinnedImage: z.string().nullable(),
  }),
  product: stepSchema.extend({ slugs: z.array(z.string()) }),
});

type SetupStatus = z.infer<typeof setupStatusSchema>;

const manifestSchema = z
  .object({
    name: z.string().min(1).max(34),
    /** The organization that owns the App. Null means the account of the person who creates it. */
    organization: z.string().min(1).nullable(),
    githubBaseUrl: z.string().url().optional(),
    githubApiBaseUrl: z.string().url().optional(),
  })
  .strict();

const conversionSchema = z.object({ code: z.string().min(1), state: z.string().min(1) }).strict();

const linearAppSchema = z
  .object({ clientId: z.string().min(1), clientSecret: z.string().min(1), webhookSecret: z.string().min(1) })
  .strict();

const adoptSchema = z.object({ tenantId: z.string().uuid() }).strict();

const installationSchema = z.object({ installationId: z.string().regex(/^\d+$/) }).strict();

const sandboxSchema = installSettingsUpdateSchema.shape.sandbox.unwrap().extend({
  provider: installSettingsUpdateSchema.shape.sandbox.unwrap().shape.provider.unwrap(),
});

const productBodySchema = z
  .object({
    linearTeamKey: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be lower case letters, digits and dashes"),
    name: z.string().min(1),
    defaultAutonomy: autonomyLevel,
    model: z.string().regex(/^[^\s/]+\/\S+$/, "must name a model as provider/model").nullable(),
    /** The environment variable the coding agent reads, for example DEEPSEEK_API_KEY. */
    modelKeyName: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    modelKeyValue: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => (value.modelKeyName === undefined) === (value.modelKeyValue === undefined), {
    message: "the model key name and its value go together",
    path: ["modelKeyValue"],
  });

const githubAppDone = (settings: InstallSettings): boolean =>
  settings.github.appId !== null && settings.github.privateKey !== null && settings.github.webhookSecret !== null;

const linearAppDone = (settings: InstallSettings): boolean =>
  settings.linear.clientId !== null && settings.linear.clientSecret !== null && settings.linear.webhookSecret !== null;

const bearerOf = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
};

/**
 * docs/specs/release-0-1-0.md. The setup of a new install, guarded by the one-time setup token
 * from the API log until setup ends. Steps: the GitHub App through the manifest flow, the Linear
 * OAuth app and its install, the GitHub App install, the sandbox provider, the first Product.
 */
export const registerSetupRoutes = (app: FastifyInstance, dependencies: SetupRouteDependencies): void => {
  useSchemasAsDocumentation(app);
  /** The tenant of the Linear workspace that setup installed the app in. */
  const operatorTenant = async (settings: InstallSettings) =>
    settings.operatorTenantId === null
      ? null
      : await dependencies.prisma.tenant.findUnique({ where: { id: settings.operatorTenantId } });

  const status = async (): Promise<SetupStatus> => {
    const settings = await dependencies.settings.read();
    const tenant = await operatorTenant(settings);
    const githubAccounts =
      tenant === null
        ? []
        : await dependencies.prisma.gitHubInstallation.findMany({ where: { tenantId: tenant.id } });
    const products = tenant === null ? [] : await dependencies.products.list(tenant.id);
    // A workspace that holds the app from before setup cannot install it again without an
    // uninstall, so setup offers its stored installation instead.
    const existing =
      tenant === null
        ? await dependencies.prisma.tenant.findMany({
            where: { installations: { some: {} } },
            select: { id: true, name: true },
            orderBy: { createdAt: "asc" },
          })
        : [];
    const { publicUrl } = dependencies;
    return {
      completed: settings.setupCompletedAt !== null,
      publicUrl,
      githubApp: {
        done: githubAppDone(settings),
        appSlug: settings.github.appSlug,
        installUrl:
          settings.github.appSlug === null
            ? null
            : `${settings.github.baseUrl.replace(/\/+$/, "")}/apps/${settings.github.appSlug}/installations/new`,
        baseUrl: settings.github.baseUrl,
        apiBaseUrl: settings.github.apiBaseUrl,
      },
      linearApp: {
        done: linearAppDone(settings),
        clientId: settings.linear.clientId,
        webhookUrl: `${publicUrl}/webhooks/linear`,
        installCallbackUrl: linearInstallCallbackUrl(publicUrl),
        signInCallbackUrl: linearSignInCallbackUrl(publicUrl),
      },
      linearInstall: {
        done: tenant !== null,
        workspaceName: tenant?.name ?? null,
        linearWorkspaceId: tenant?.linearWorkspaceId ?? null,
        existing: existing.map((candidate) => ({ tenantId: candidate.id, workspaceName: candidate.name })),
      },
      githubInstall: { done: githubAccounts.length > 0, accounts: githubAccounts.map((github) => github.accountLogin) },
      sandbox: {
        done:
          settings.sandbox.provider !== null &&
          sandboxSettingsProblem(settings.sandbox, dependencies.localSandboxAllowed) === null,
        provider: settings.sandbox.provider,
        localAllowed: dependencies.localSandboxAllowed,
        pinnedImage: buildInfo.sandboxImageDefault,
      },
      product: { done: products.length > 0, slugs: products.map((product) => product.slug) },
    };
  };

  app.get(
    "/api/setup/state",
    {
      schema: {
        tags: TAGS,
        operationId: "getSetupState",
        response: { 200: schemaOf(z.object({ completed: z.boolean() })) },
      },
    },
    async () => ({ completed: (await dependencies.settings.read()).setupCompletedAt !== null }),
  );

  // The Linear install grant returns here. A setup token holder or an admin started it, and the
  // signed state proves which. The browser follows a redirect, so this route answers with one.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/linear/callback",
    async (request, reply) => {
      const purpose = readFlowState(dependencies.masterKey, request.query.state ?? "");
      const back = purpose === "workspace" ? "/workspaces" : "/setup";
      if (purpose === null) return reply.code(400).send({ error: "the state of this Linear callback is not valid" });
      if (request.query.error !== undefined || request.query.code === undefined) {
        return reply.redirect(`${back}?linearError=${encodeURIComponent(request.query.error ?? "no_code")}`);
      }
      const settings = await dependencies.settings.read();
      if (purpose === "setup" && settings.setupCompletedAt !== null) {
        return reply.code(410).send({ error: "setup is complete" });
      }
      if (settings.linear.clientId === null || settings.linear.clientSecret === null) {
        return reply.code(409).send({ error: "the install settings hold no Linear client credentials" });
      }
      try {
        const grant = await dependencies.linear.exchangeCode({
          clientId: settings.linear.clientId,
          clientSecret: settings.linear.clientSecret,
          redirectUri: linearInstallCallbackUrl(dependencies.publicUrl),
          code: request.query.code,
        });
        const organization = await dependencies.linear.readOrganization(grant.accessToken);
        const tenant = await dependencies.tenants.putInstallation({
          linearWorkspaceId: organization.id,
          workspaceName: organization.name,
          accessToken: grant.accessToken,
          scopes: grant.scopes,
          ...(grant.refreshToken === null ? {} : { refreshToken: grant.refreshToken }),
          ...(grant.expiresIn === null ? {} : { expiresAt: new Date(Date.now() + grant.expiresIn * 1_000) }),
          ...(organization.appUserId === null ? {} : { appUserId: organization.appUserId }),
        });
        if (purpose === "setup") await dependencies.settings.update({ operatorTenantId: tenant.id });
        dependencies.logger.info("Linear app installed", { linear_workspace_id: organization.id, step: "setup" });
        return reply.redirect(back);
      } catch (error) {
        dependencies.logger.error("the Linear app install failed", { error: String(error), step: "setup" });
        return reply.redirect(`${back}?linearError=install_failed`);
      }
    },
  );

  void app.register((scope) => {
    scope.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
      const check = await checkSetupToken(dependencies.settings, bearerOf(request));
      if (check === "setup_complete") return reply.code(410).send({ error: "setup is complete" });
      if (check === "invalid") return reply.code(401).send({ error: "the setup token is not valid" });
    });

    scope.get(
      "/api/setup/status",
      {
        schema: {
          tags: TAGS,
          operationId: "getSetupStatus",
          security: SETUP_SECURITY,
          response: { 200: schemaOf(setupStatusSchema), 401: errorSchema, 410: errorSchema },
        },
      },
      status,
    );

    scope.post(
      "/api/setup/github/manifest",
      {
        schema: {
          tags: TAGS,
          operationId: "createGitHubAppManifest",
          security: SETUP_SECURITY,
          body: schemaOf(manifestSchema),
          response: {
            200: schemaOf(z.object({ postUrl: z.string(), manifest: z.string() })),
            401: errorSchema,
            422: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const body = manifestSchema.safeParse(request.body);
        if (!body.success) return reply.code(422).send({ error: body.error.flatten() });
        const settings = await dependencies.settings.update({
          github: {
            ...(body.data.githubBaseUrl === undefined ? {} : { baseUrl: body.data.githubBaseUrl }),
            ...(body.data.githubApiBaseUrl === undefined ? {} : { apiBaseUrl: body.data.githubApiBaseUrl }),
          },
        });
        const manifest = buildGitHubAppManifest({ publicUrl: dependencies.publicUrl, name: body.data.name });
        return {
          postUrl: gitHubAppCreationUrl({
            githubBaseUrl: settings.github.baseUrl,
            organization: body.data.organization,
            state: signFlowState(dependencies.masterKey, "setup"),
          }),
          manifest: JSON.stringify(manifest),
        };
      },
    );

    scope.post(
      "/api/setup/github/conversion",
      {
        schema: {
          tags: TAGS,
          operationId: "convertGitHubAppManifest",
          security: SETUP_SECURITY,
          body: schemaOf(conversionSchema),
          response: { 200: schemaOf(setupStatusSchema), 400: errorSchema, 401: errorSchema, 502: errorSchema },
        },
      },
      async (request, reply) => {
        const body = conversionSchema.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        if (readFlowState(dependencies.masterKey, body.data.state) !== "setup") {
          return reply.code(400).send({ error: "the state GitHub returned is not one this setup issued" });
        }
        const settings = await dependencies.settings.read();
        let app: ConvertedGitHubApp;
        try {
          app = await dependencies.github.convertManifest({ apiBaseUrl: settings.github.apiBaseUrl, code: body.data.code });
        } catch (error) {
          return reply.code(502).send({ error: (error as Error).message });
        }
        await dependencies.settings.update({
          github: {
            appId: app.appId,
            appSlug: app.slug,
            clientId: app.clientId,
            clientSecret: app.clientSecret,
            privateKey: app.privateKey,
            webhookSecret: app.webhookSecret,
          },
        });
        dependencies.logger.info("GitHub App created", { github_app_id: app.appId, step: "setup" });
        return status();
      },
    );

    scope.put(
      "/api/setup/linear",
      {
        schema: {
          tags: TAGS,
          operationId: "putLinearApp",
          security: SETUP_SECURITY,
          body: schemaOf(linearAppSchema),
          response: { 200: schemaOf(setupStatusSchema), 401: errorSchema, 422: errorSchema },
        },
      },
      async (request, reply) => {
        const body = linearAppSchema.safeParse(request.body);
        if (!body.success) return reply.code(422).send({ error: body.error.flatten() });
        await dependencies.settings.update({ linear: body.data });
        return status();
      },
    );

    scope.post(
      "/api/setup/linear/install",
      {
        schema: {
          tags: TAGS,
          operationId: "startSetupLinearInstall",
          security: SETUP_SECURITY,
          response: { 200: schemaOf(z.object({ url: z.string() })), 401: errorSchema, 409: errorSchema },
        },
      },
      async (_request, reply) => {
        const settings = await dependencies.settings.read();
        if (!linearAppDone(settings) || settings.linear.clientId === null) {
          return reply.code(409).send({ error: "store the Linear app credentials first" });
        }
        return {
          url: linearInstallUrl({
            clientId: settings.linear.clientId,
            redirectUri: linearInstallCallbackUrl(dependencies.publicUrl),
            state: signFlowState(dependencies.masterKey, "setup"),
          }),
        };
      },
    );

    scope.post(
      "/api/setup/linear/adopt",
      {
        schema: {
          tags: TAGS,
          operationId: "adoptSetupLinearInstall",
          security: SETUP_SECURITY,
          body: schemaOf(adoptSchema),
          response: { 200: schemaOf(setupStatusSchema), 401: errorSchema, 404: errorSchema, 422: errorSchema },
        },
      },
      async (request, reply) => {
        const body = adoptSchema.safeParse(request.body);
        if (!body.success) return reply.code(422).send({ error: body.error.flatten() });
        const tenant = await dependencies.prisma.tenant.findFirst({
          where: { id: body.data.tenantId, installations: { some: {} } },
        });
        if (tenant === null) return reply.code(404).send({ error: "no stored Linear installation for this workspace" });
        // A team read with the stored token proves the installation still works.
        try {
          await dependencies.linear.listTeams(tenant.linearWorkspaceId);
        } catch (error) {
          dependencies.logger.warn("the stored Linear installation does not work", { error: String(error), step: "setup" });
          return reply.code(422).send({ error: "the stored Linear token no longer works. Install the app again" });
        }
        // The stored workspace can hold installations of an App from before setup. A token request
        // for one fails with this App's key, so only installations of this App stay bound.
        const settings = await dependencies.settings.read();
        if (settings.github.appId !== null && settings.github.privateKey !== null) {
          const credentials = {
            appId: settings.github.appId,
            privateKey: settings.github.privateKey,
            apiBaseUrl: settings.github.apiBaseUrl,
          };
          const bound = await dependencies.prisma.gitHubInstallation.findMany({ where: { tenantId: tenant.id } });
          for (const installation of bound) {
            const current = await dependencies.github.readInstallation({
              credentials,
              installationId: installation.githubInstallationId,
            });
            if (current !== null) continue;
            await dependencies.prisma.gitHubInstallation.delete({ where: { id: installation.id } });
            dependencies.logger.info("a GitHub installation of another App is unbound", {
              github_installation_id: installation.githubInstallationId,
              step: "setup",
            });
          }
        }
        await dependencies.settings.update({ operatorTenantId: tenant.id });
        dependencies.logger.info("Linear installation adopted", { linear_workspace_id: tenant.linearWorkspaceId, step: "setup" });
        return status();
      },
    );

    scope.post(
      "/api/setup/github/installation",
      {
        schema: {
          tags: TAGS,
          operationId: "bindGitHubInstallation",
          security: SETUP_SECURITY,
          body: schemaOf(installationSchema),
          response: {
            200: schemaOf(setupStatusSchema),
            401: errorSchema,
            404: errorSchema,
            409: errorSchema,
            422: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const body = installationSchema.safeParse(request.body);
        if (!body.success) return reply.code(422).send({ error: body.error.flatten() });
        const settings = await dependencies.settings.read();
        if (settings.operatorTenantId === null) return reply.code(409).send({ error: "install the Linear app first" });
        if (!githubAppDone(settings) || settings.github.appId === null || settings.github.privateKey === null) {
          return reply.code(409).send({ error: "create the GitHub App first" });
        }
        // The id arrives from the browser, so GitHub must confirm it is an installation of this App.
        const installation = await dependencies.github.readInstallation({
          credentials: {
            appId: settings.github.appId,
            privateKey: settings.github.privateKey,
            apiBaseUrl: settings.github.apiBaseUrl,
          },
          installationId: body.data.installationId,
        });
        if (installation === null) return reply.code(404).send({ error: "GitHub reports no such installation of this App" });
        const outcome = await dependencies.tenants.putGitHubInstallation(
          settings.operatorTenantId,
          installation.id,
          installation.accountLogin,
        );
        if (outcome === "held_by_another_tenant") {
          return reply.code(409).send({ error: "the installation is bound to another tenant" });
        }
        await dependencies.startInstallationSync({
          tenantId: settings.operatorTenantId,
          githubInstallationId: installation.id,
        });
        return status();
      },
    );

    scope.put(
      "/api/setup/sandbox",
      {
        schema: {
          tags: TAGS,
          operationId: "putSandbox",
          security: SETUP_SECURITY,
          body: schemaOf(sandboxSchema),
          response: { 200: schemaOf(setupStatusSchema), 401: errorSchema, 422: errorSchema },
        },
      },
      async (request, reply) => {
        const body = sandboxSchema.safeParse(request.body);
        if (!body.success) return reply.code(422).send({ error: body.error.flatten() });
        const current = await dependencies.settings.read();
        const problem = sandboxSettingsProblem(applyPatch(current.sandbox, body.data), dependencies.localSandboxAllowed);
        if (problem !== null) return reply.code(422).send({ error: problem });
        await dependencies.settings.update({ sandbox: body.data });
        return status();
      },
    );

    scope.get(
      "/api/setup/linear-teams",
      {
        schema: {
          tags: TAGS,
          operationId: "listSetupLinearTeams",
          security: SETUP_SECURITY,
          response: { 200: schemaOf(z.array(linearTeamSchema)), 401: errorSchema, 409: errorSchema },
        },
      },
      async (_request, reply) => {
        const tenant = await operatorTenant(await dependencies.settings.read());
        if (tenant === null) return reply.code(409).send({ error: "install the Linear app first" });
        return dependencies.linear.listTeams(tenant.linearWorkspaceId);
      },
    );

    scope.post(
      "/api/setup/product",
      {
        schema: {
          tags: TAGS,
          operationId: "createSetupProduct",
          security: SETUP_SECURITY,
          body: schemaOf(productBodySchema),
          response: {
            201: schemaOf(productSchema),
            401: errorSchema,
            404: errorSchema,
            409: errorSchema,
            422: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const body = productBodySchema.safeParse(request.body);
        if (!body.success) return reply.code(422).send({ error: body.error.flatten() });
        const tenant = await operatorTenant(await dependencies.settings.read());
        if (tenant === null) return reply.code(409).send({ error: "install the Linear app first" });
        if (body.data.modelKeyName !== undefined && body.data.modelKeyValue !== undefined) {
          try {
            assertRunnerCredential(body.data.modelKeyName, body.data.modelKeyValue);
          } catch (error) {
            if (error instanceof RunnerCredentialError) return reply.code(422).send({ error: error.message });
            throw error;
          }
        }
        const team = await dependencies.linearTeams.resolveTeamKey(tenant.id, body.data.linearTeamKey);
        if (team === null) {
          return reply.code(404).send({ error: `Linear reports no team for the key "${body.data.linearTeamKey}".` });
        }
        let product;
        try {
          product = await dependencies.products.create({
            tenantId: tenant.id,
            slug: body.data.slug,
            name: body.data.name,
            linearTeamKey: team.key,
            linearTeamId: team.id,
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            return reply.code(409).send({ error: "a Product already holds this slug or this Linear team" });
          }
          throw error;
        }
        if (body.data.modelKeyName !== undefined && body.data.modelKeyValue !== undefined) {
          await dependencies.secrets.put(tenant.id, product.id, body.data.modelKeyName, body.data.modelKeyValue, {
            kind: "runner_credential",
          });
        }
        await dependencies.products.updateSettings(tenant.id, product.id, { model: body.data.model });
        await dependencies.products.updatePolicy(tenant.id, product.id, { defaultAutonomy: body.data.defaultAutonomy });
        const activated = await dependencies.products.activate(tenant.id, product.id, body.data.defaultAutonomy);
        return reply.code(201).send(activated ?? product);
      },
    );

    scope.post(
      "/api/setup/complete",
      {
        schema: {
          tags: TAGS,
          operationId: "completeSetup",
          security: SETUP_SECURITY,
          response: { 200: schemaOf(setupStatusSchema), 401: errorSchema, 409: errorSchema },
        },
      },
      async (_request, reply) => {
        const current = await status();
        const open = (["githubApp", "linearApp", "linearInstall", "githubInstall", "sandbox", "product"] as const).filter(
          (step) => !current[step].done,
        );
        if (open.length > 0) return reply.code(409).send({ error: `these setup steps are not done: ${open.join(", ")}` });
        await dependencies.settings.completeSetup(new Date());
        dependencies.logger.info("setup completed", { step: "setup" });
        return { ...current, completed: true };
      },
    );
  });
};
