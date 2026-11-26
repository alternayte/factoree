import type { FastifyInstance } from "fastify";
import type { BuildAheadTrigger } from "~/domain/runs/build-ahead.js";
import { z } from "zod";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { applyPatch, type InstallSettingsStore, type SandboxSettings } from "~/domain/settings/install-settings.js";
import { completeBucket, effectiveBucket, lockedBucketFields, objectStoreFingerprint, objectStoreTested } from "~/domain/retro/transcript.js";
import { S3ObjectStore } from "~/adapters/s3/s3-object-store.js";
import { randomUUID } from "node:crypto";
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
  type ObjectStoreEnv,
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
  /** The Temporal namespace of the install. The UI links into the Temporal UI under it. */
  temporalNamespace: string;
  /** The teams of a set-up workspace, read with the Linear app token of that workspace. */
  listLinearTeams: (linearWorkspaceId: string) => Promise<Array<{ id: string; key: string; name: string }>>;
  /** docs/specs/run-speed.md. A new provider, image or size makes every warm snapshot stale. */
  buildAhead?: Pick<BuildAheadTrigger, "afterTemplateChange">;
  /** docs/specs/retro-agent.md. The transcript bucket env vars, which lock their fields. */
  objectStoreEnv?: ObjectStoreEnv;
  /** The object store client of a test. A unit test passes a fake. */
  objectStoreFor?: (location: { endpoint: string; bucket: string; region: string; accessKey: string; secretKey: string }) => Pick<S3ObjectStore, "put" | "get" | "delete">;
}

/**
 * docs/specs/run-speed.md. The install sandbox settings that decide the template a warm snapshot
 * belongs to. docs/specs/sandbox-provider-spillover.md: the provider and the size belong to each
 * provider, and its own routes request the build-ahead.
 */
const templateOf = (sandbox: SandboxSettings): string => JSON.stringify([sandbox.image]);

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
        temporalNamespace: dependencies.temporalNamespace,
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
      viewInstallSettings(await dependencies.settings.read(), dependencies.publicUrl, dependencies.localSandboxAllowed, dependencies.objectStoreEnv),
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
      const problem = sandboxSettingsProblem(sandbox);
      if (problem !== null) return reply.code(422).send({ error: problem });
      // docs/specs/retro-agent.md. An env var wins and locks its field: the owner's env-over-UI rule.
      const locked = lockedBucketFields(dependencies.objectStoreEnv ?? {});
      const lockedChange = locked.find((field) => body.data.objectStore?.[field] !== undefined);
      if (lockedChange !== undefined) return reply.code(422).send({ error: `an env var sets the object store ${lockedChange}, so it is locked` });
      // docs/specs/s3-object-store.md. The env var locks the choice, and S3 needs a tested object store.
      if (body.data.evidenceStorage !== undefined) {
        if (dependencies.objectStoreEnv?.FACTOREE_EVIDENCE_STORAGE !== undefined) {
          return reply.code(422).send({ error: "FACTOREE_EVIDENCE_STORAGE sets the evidence store, so it is locked" });
        }
        const objectStore = applyPatch(current.objectStore, body.data.objectStore);
        if (body.data.evidenceStorage === "s3" && !objectStoreTested(objectStore, current.objectStoreTestedSha256, dependencies.objectStoreEnv ?? {})) {
          return reply.code(422).send({ error: "S3 needs a complete object store that passed Test object store" });
        }
      }
      if (dependencies.objectStoreEnv?.FACTOREE_WEB_SEARCH_EXA_API_KEY !== undefined && body.data.webSearch?.exaApiKey !== undefined) {
        return reply.code(422).send({ error: "FACTOREE_WEB_SEARCH_EXA_API_KEY sets the Exa key, so it is locked" });
      }
      const updated = await dependencies.settings.update(body.data);
      if (templateOf(current.sandbox) !== templateOf(updated.sandbox)) await dependencies.buildAhead?.afterTemplateChange();
      return viewInstallSettings(updated, dependencies.publicUrl, dependencies.localSandboxAllowed, dependencies.objectStoreEnv);
    },
  );

  // docs/specs/s3-object-store.md. Puts, reads and deletes one probe object with the effective
  // object store, and stores the fingerprint of the settings that passed.
  app.post(
    "/admin/install-settings/object-store/test",
    {
      schema: {
        tags: ["install"],
        operationId: "testObjectStore",
        security: SESSION_SECURITY,
        response: { 200: schemaOf(z.object({ ok: z.boolean(), error: z.string().nullable() })), 403: errorSchema },
      },
    },
    async (request, reply) => {
      if (!principalOf(request).operatorAdmin) {
        return reply.code(403).send({ error: "only a Linear admin of the setup workspace changes the install settings" });
      }
      const current = await dependencies.settings.read();
      const effective = effectiveBucket(current.objectStore, dependencies.objectStoreEnv ?? {});
      const bucket = completeBucket(effective);
      if (bucket === null) return { ok: false, error: "the object store needs an endpoint, a bucket, an access key and a secret key" };
      const store = (dependencies.objectStoreFor ?? ((location) => new S3ObjectStore(location)))(bucket);
      const key = `factoree-probe/${randomUUID()}.txt`;
      const body = Buffer.from(`factoree object store test ${new Date().toISOString()}`, "utf8");
      try {
        await store.put(key, body, "text/plain");
        const read = await store.get(key);
        if (read === null || !read.equals(body)) throw new Error("the probe object read back different bytes");
        await store.delete(key);
      } catch (error) {
        await dependencies.settings.update({ objectStoreTestedSha256: null });
        const message = (error instanceof Error ? error.message : String(error)).split(bucket.secretKey).join("[redacted]");
        return { ok: false, error: message.slice(0, 500) };
      }
      await dependencies.settings.update({ objectStoreTestedSha256: objectStoreFingerprint(effective) });
      return { ok: true, error: null };
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
