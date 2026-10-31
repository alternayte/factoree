import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { applyPatch, type InstallSettingsStore } from "~/domain/settings/install-settings.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import { linearInstallUrl } from "~/adapters/linear/linear-app-flows.js";
import { errorSchema, schemaOf, SESSION_SECURITY, useSchemasAsDocumentation } from "../openapi.js";
import type { AuthHandle } from "../auth/auth.js";
import { principalOf } from "../auth/admin-guard.js";
import { signFlowState } from "../setup/setup-token.js";
import {
  apiKeySchema,
  installSettingsUpdateSchema,
  installSettingsViewSchema,
  linearInstallCallbackUrl,
  linearTeamSchema,
  meSchema,
  sandboxSettingsProblem,
  viewInstallSettings,
  workspaceQuerySchema,
  workspaceSchema,
} from "./schemas.js";

export interface SettingsRouteDependencies {
  prisma: FactoreePrismaClient;
  settings: InstallSettingsStore;
  tenants: TenantRegistry;
  auth: AuthHandle;
  publicUrl: string;
  masterKey: string;
  localSandboxAllowed: boolean;
  /** The teams of a set-up workspace, read with the Linear app token of that workspace. */
  listLinearTeams: (linearWorkspaceId: string) => Promise<Array<{ id: string; key: string; name: string }>>;
}

const createKeySchema = z
  .object({
    name: z.string().min(1).max(32),
    /** Days until the key expires. Absent means no expiry. */
    expiresInDays: z.number().int().positive().max(365).optional(),
  })
  .strict();

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** docs/specs/release-0-1-0.md. Install settings, workspaces and API keys. */
export const registerSettingsRoutes = (app: FastifyInstance, dependencies: SettingsRouteDependencies): void => {
  useSchemasAsDocumentation(app);
  app.get(
    "/admin/me",
    { schema: { tags: ["session"], operationId: "getMe", security: SESSION_SECURITY, response: { 200: schemaOf(meSchema) } } },
    async (request) => {
      // The guard admitted the caller, so the principal and its user exist.
      const principal = principalOf(request);
      const user = await dependencies.prisma.user.findUniqueOrThrow({ where: { id: principal.userId } });
      return {
        userId: principal.userId,
        name: user.name,
        email: user.email,
        image: user.image,
        apiKeyId: principal.apiKeyId,
        memberships: principal.memberships,
        operatorAdmin: principal.operatorAdmin,
      };
    },
  );

  app.get(
    "/admin/install-settings",
    {
      schema: {
        tags: ["install"],
        operationId: "getInstallSettings",
        security: SESSION_SECURITY,
        response: { 200: schemaOf(installSettingsViewSchema) },
      },
    },
    async () =>
      viewInstallSettings(await dependencies.settings.read(), dependencies.publicUrl, dependencies.localSandboxAllowed),
  );

  app.put(
    "/admin/install-settings",
    {
      schema: {
        tags: ["install"],
        operationId: "updateInstallSettings",
        security: SESSION_SECURITY,
        body: schemaOf(installSettingsUpdateSchema),
        response: { 200: schemaOf(installSettingsViewSchema), 403: errorSchema, 422: errorSchema },
      },
    },
    async (request, reply) => {
      // DI-14.53. The install settings belong to the operator of the install, so only a Linear
      // admin of the workspace that ran setup changes them.
      if (!principalOf(request).operatorAdmin) {
        return reply.code(403).send({ error: "only a Linear admin of the setup workspace changes the install settings" });
      }
      const body = installSettingsUpdateSchema.safeParse(request.body);
      if (!body.success) return reply.code(422).send({ error: body.error.flatten() });
      const current = await dependencies.settings.read();
      const sandbox = applyPatch(current.sandbox, body.data.sandbox);
      const problem = sandboxSettingsProblem(sandbox, dependencies.localSandboxAllowed);
      if (problem !== null) return reply.code(422).send({ error: problem });
      const updated = await dependencies.settings.update(body.data);
      return viewInstallSettings(updated, dependencies.publicUrl, dependencies.localSandboxAllowed);
    },
  );

  app.get(
    "/admin/workspaces",
    {
      schema: {
        tags: ["workspaces"],
        operationId: "listWorkspaces",
        security: SESSION_SECURITY,
        response: { 200: schemaOf(z.array(workspaceSchema)) },
      },
    },
    async (request) => {
      const principal = principalOf(request);
      const tenantIds = principal.memberships.map((membership) => membership.tenantId);
      const rows = await dependencies.prisma.tenant.findMany({
        where: { id: { in: tenantIds } },
        include: { installations: true, githubInstallations: true, _count: { select: { products: true } } },
        orderBy: { name: "asc" },
      });
      return rows.map((row) => {
        const installation = row.installations[0] ?? null;
        return {
          tenantId: row.id,
          linearWorkspaceId: row.linearWorkspaceId,
          name: row.name,
          admin: principal.memberships.some((membership) => membership.tenantId === row.id && membership.admin),
          linearInstallation:
            installation === null
              ? null
              : {
                  expiresAt: iso(installation.expiresAt),
                  refreshable: installation.refreshTokenCipher !== null,
                  scopes: installation.scopes,
                },
          githubInstallations: row.githubInstallations.map((github) => ({
            githubInstallationId: github.githubInstallationId,
            accountLogin: github.accountLogin,
          })),
          productCount: row._count.products,
        };
      });
    },
  );

  app.post(
    "/admin/workspaces/linear-install",
    {
      schema: {
        tags: ["workspaces"],
        operationId: "startLinearInstall",
        security: SESSION_SECURITY,
        response: { 200: schemaOf(z.object({ url: z.string() })), 403: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      if (!principalOf(request).operatorAdmin) {
        return reply.code(403).send({ error: "only a Linear admin of the setup workspace installs Factoree in a workspace" });
      }
      const { linear } = await dependencies.settings.read();
      if (linear.clientId === null) return reply.code(409).send({ error: "the install settings hold no Linear client id" });
      return {
        url: linearInstallUrl({
          clientId: linear.clientId,
          redirectUri: linearInstallCallbackUrl(dependencies.publicUrl),
          state: signFlowState(dependencies.masterKey, "workspace"),
        }),
      };
    },
  );

  app.get(
    "/admin/linear-teams",
    {
      schema: {
        tags: ["workspaces"],
        operationId: "listLinearTeams",
        security: SESSION_SECURITY,
        querystring: schemaOf(workspaceQuerySchema),
        response: { 200: schemaOf(z.array(linearTeamSchema)), 400: errorSchema },
      },
    },
    async (request, reply) => {
      const query = workspaceQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      return dependencies.listLinearTeams(query.data.linearWorkspaceId);
    },
  );

  app.get(
    "/admin/api-keys",
    {
      schema: {
        tags: ["api-keys"],
        operationId: "listApiKeys",
        security: SESSION_SECURITY,
        response: { 200: schemaOf(z.array(apiKeySchema)) },
      },
    },
    async (request) => {
      const rows = await dependencies.prisma.apikey.findMany({
        where: { referenceId: principalOf(request).userId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        start: row.start,
        createdAt: row.createdAt.toISOString(),
        expiresAt: iso(row.expiresAt),
        lastRequest: iso(row.lastRequest),
      }));
    },
  );

  app.post(
    "/admin/api-keys",
    {
      schema: {
        tags: ["api-keys"],
        operationId: "createApiKey",
        security: SESSION_SECURITY,
        body: schemaOf(createKeySchema),
        response: {
          201: schemaOf(z.object({ id: z.string(), key: z.string(), name: z.string().nullable() })),
          403: errorSchema,
          422: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      // A key acts as the person who made it. A key never makes another key, so a leaked key
      // cannot outlive its own revocation.
      if (principal.apiKeyId !== null) return reply.code(403).send({ error: "an API key cannot create an API key" });
      const body = createKeySchema.safeParse(request.body);
      if (!body.success) return reply.code(422).send({ error: body.error.flatten() });
      const auth = await dependencies.auth.current();
      const created = await auth.api.createApiKey({
        body: {
          name: body.data.name,
          userId: principal.userId,
          ...(body.data.expiresInDays === undefined ? {} : { expiresIn: body.data.expiresInDays * 86_400 }),
        },
      });
      return reply.code(201).send({ id: created.id, key: created.key, name: created.name ?? null });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/api-keys/:id",
    {
      schema: {
        tags: ["api-keys"],
        operationId: "revokeApiKey",
        security: SESSION_SECURITY,
        params: schemaOf(z.object({ id: z.string() })),
        response: { 204: { type: "null" }, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const removed = await dependencies.prisma.apikey.deleteMany({
        where: { id: request.params.id, referenceId: principalOf(request).userId },
      });
      if (removed.count === 0) return reply.code(404).send({ error: "API key not found" });
      return reply.code(204).send();
    },
  );
};
