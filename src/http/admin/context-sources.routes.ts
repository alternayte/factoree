import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { ContextSourceConfigurationStore } from "~/domain/context/context-source-configuration.js";
import {
  assertContextSourceEndpoint,
  assertContextSourceId,
  backstageSettingsSchema,
  CONTEXT_SOURCE_KINDS,
  ContextSourceConfigurationError,
  llmsTxtSettingsSchema,
  mcpSettingsSchema,
  parseContextSourceSettings,
} from "~/domain/context/context-source-configuration.js";
import { errorSchema, schemaOf, SESSION_SECURITY, useSchemasAsDocumentation } from "../openapi.js";
import { probeContextSource } from "./context-source-probe.js";

const TAGS = ["context sources"];

const createSchema = z
  .object({
    sourceId: z.string().min(1),
    kind: z.enum(CONTEXT_SOURCE_KINDS),
    endpoint: z.string().min(1),
    enabled: z.boolean().optional(),
    secretName: z.string().min(1).nullable().optional(),
    settings: z.unknown().optional(),
  })
  .strict();

// Documentation only: the route validates `settings` with `parseContextSourceSettings`, which
// names the bad key. The document gives the UI client the three shapes. DI-14.52.
const settingsDocumentation = z.union([backstageSettingsSchema, mcpSettingsSchema, llmsTxtSettingsSchema]);
const createDocumentation = createSchema.extend({ settings: settingsDocumentation.optional() });

/**
 * Issue 8. The test takes the unsaved configuration. `credential` is a value the operator has not
 * stored yet. Without it the test reads the stored secret `secretName` names.
 */
const testSchema = createSchema
  .omit({ enabled: true })
  .extend({ credential: z.string().min(1).optional() })
  .strict();
const testDocumentation = testSchema.extend({ settings: settingsDocumentation.optional() });

const sourceSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  productId: z.string(),
  sourceId: z.string(),
  kind: z.enum(CONTEXT_SOURCE_KINDS),
  enabled: z.boolean(),
  endpoint: z.string(),
  secretName: z.string().nullable(),
  settings: settingsDocumentation,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const listedSourceSchema = sourceSchema.extend({
  /** DI-15.18. The newest Context Contract that holds an item from this source, or null. */
  lastReadAt: z.string().nullable(),
});

const probeResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  itemCount: z.number(),
  items: z.array(z.object({ ref: z.string(), title: z.string().nullable() })),
});

const idParams = schemaOf(z.object({ id: z.string() }));
const tenantQuerySchema = z.object({ linearWorkspaceId: z.string().min(1) });
const workspaceQuery = schemaOf(tenantQuerySchema);

/** SDD section 59 fixes these three paths. SDD section 5 and section 7 put context sources on the Product. */
export const registerContextSourceRoutes = (
  app: FastifyInstance,
  dependencies: {
    products: ProductRegistry;
    tenants: TenantRegistry;
    contextSources: ContextSourceConfigurationStore;
    repositories: RepositoryRegistry;
    secrets: SecretStore;
  },
): void => {
  useSchemasAsDocumentation(app);
  const resolveTenant = async (linearWorkspaceId: string) =>
    dependencies.tenants.findByWorkspace(linearWorkspaceId);

  app.post<{ Params: { id: string } }>(
    "/admin/products/:id/context-sources",
    {
      schema: {
        tags: TAGS,
        operationId: "putContextSource",
        security: SESSION_SECURITY,
        params: idParams,
        querystring: workspaceQuery,
        body: schemaOf(createDocumentation),
        response: { 201: schemaOf(sourceSchema), 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const query = tenantQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      const tenant = await resolveTenant(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const product = await dependencies.products.findById(tenant.id, request.params.id);
      if (!product) return reply.code(404).send({ error: "product not found" });

      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      try {
        const record = await dependencies.contextSources.put({
          tenantId: tenant.id,
          productId: product.id,
          sourceId: parsed.data.sourceId,
          kind: parsed.data.kind,
          endpoint: parsed.data.endpoint,
          ...(parsed.data.enabled === undefined ? {} : { enabled: parsed.data.enabled }),
          ...(parsed.data.secretName === undefined ? {} : { secretName: parsed.data.secretName }),
          settings: parsed.data.settings,
        });
        return reply.code(201).send(record);
      } catch (error) {
        if (error instanceof ContextSourceConfigurationError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/products/:id/context-sources/test",
    {
      schema: {
        tags: TAGS,
        operationId: "testContextSource",
        security: SESSION_SECURITY,
        params: idParams,
        querystring: workspaceQuery,
        body: schemaOf(testDocumentation),
        response: { 200: schemaOf(probeResultSchema), 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const query = tenantQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      const tenant = await resolveTenant(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const product = await dependencies.products.findById(tenant.id, request.params.id);
      if (!product) return reply.code(404).send({ error: "product not found" });

      const parsed = testSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const body = parsed.data;

      let settings;
      try {
        // The same checks a save runs, so a passing test never hides a configuration a save refuses.
        assertContextSourceId(body.sourceId);
        settings = parseContextSourceSettings(body.kind, body.settings);
        assertContextSourceEndpoint(body.sourceId, body.endpoint);
      } catch (error) {
        if (error instanceof ContextSourceConfigurationError) return reply.code(400).send({ error: error.message });
        throw error;
      }

      let credential = body.credential ?? null;
      if (credential === null && body.secretName !== undefined && body.secretName !== null) {
        credential = await dependencies.secrets.get(tenant.id, product.id, body.secretName);
        if (credential === null) {
          return reply.code(400).send({ error: `The product holds no secret named "${body.secretName}".` });
        }
      }

      const repositories = await dependencies.repositories.listByProduct(product.id);
      const repository = repositories.find((candidate) => candidate.absentSince === null) ?? null;
      return probeContextSource({
        sourceId: body.sourceId,
        kind: body.kind,
        endpoint: body.endpoint,
        settings,
        credential,
        repositorySlug: repository?.fullName ?? null,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/products/:id/context-sources",
    {
      schema: {
        tags: TAGS,
        operationId: "listContextSources",
        security: SESSION_SECURITY,
        params: idParams,
        querystring: workspaceQuery,
        response: { 200: schemaOf(z.array(listedSourceSchema)), 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const query = tenantQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      const tenant = await resolveTenant(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const product = await dependencies.products.findById(tenant.id, request.params.id);
      if (!product) return reply.code(404).send({ error: "product not found" });
      const [records, reads] = await Promise.all([
        dependencies.contextSources.list(tenant.id, product.id),
        dependencies.contextSources.lastReads(tenant.id, product.id),
      ]);
      return reply
        .code(200)
        .send(records.map((record) => ({ ...record, lastReadAt: reads.get(record.sourceId)?.toISOString() ?? null })));
    },
  );

  app.delete<{ Params: { id: string; sourceId: string } }>(
    "/admin/products/:id/context-sources/:sourceId",
    {
      schema: {
        tags: TAGS,
        operationId: "deleteContextSource",
        security: SESSION_SECURITY,
        params: schemaOf(z.object({ id: z.string(), sourceId: z.string() })),
        querystring: workspaceQuery,
        response: { 204: { type: "null" }, 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const query = tenantQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      const tenant = await resolveTenant(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const product = await dependencies.products.findById(tenant.id, request.params.id);
      if (!product) return reply.code(404).send({ error: "product not found" });
      const removed = await dependencies.contextSources.remove(
        tenant.id,
        product.id,
        request.params.sourceId,
      );
      return removed ? reply.code(204).send() : reply.code(404).send({ error: "no such context source" });
    },
  );
};
