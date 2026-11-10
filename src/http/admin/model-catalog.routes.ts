import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AGENT_RUNNERS } from "~/domain/products/agent-settings.js";
import type { ModelCatalogService } from "~/domain/products/model-catalog-service.js";
import { errorSchema, schemaOf, SESSION_SECURITY, useSchemasAsDocumentation } from "../openapi.js";

const querySchema = z.object({ runner: z.enum(AGENT_RUNNERS) });

const catalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  reasoning: z.boolean(),
  /** The effort values the runner accepts for the model. Empty means the model takes none. */
  efforts: z.array(z.string()),
  contextTokens: z.number().nullable(),
  /** US dollars per million tokens. */
  costInput: z.number().nullable(),
  costOutput: z.number().nullable(),
  releaseDate: z.string().nullable(),
});

export const modelCatalogSchema = z.object({
  /** False when no catalog was ever fetched and models.dev cannot be reached. */
  available: z.boolean(),
  fetchedAt: z.string().nullable(),
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      /** The environment variables the provider reads its key from. The first one is the one to set. */
      env: z.array(z.string()),
      models: z.array(catalogModelSchema),
    }),
  ),
});

/**
 * docs/specs/model-picker.md. The models of one runner, with their effort values and the key name
 * of each provider. The API trims the models.dev catalog, so the browser never loads the raw file.
 */
export const registerModelCatalogRoutes = (app: FastifyInstance, dependencies: { modelCatalog?: ModelCatalogService | undefined }): void => {
  useSchemasAsDocumentation(app);
  app.get(
    "/admin/model-catalog",
    {
      schema: {
        tags: ["products"],
        operationId: "getModelCatalog",
        security: SESSION_SECURITY,
        querystring: schemaOf(querySchema),
        response: { 200: schemaOf(modelCatalogSchema), 400: errorSchema },
      },
    },
    async (request, reply) => {
      const query = querySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "invalid request" });
      const catalog = (await dependencies.modelCatalog?.providers(query.data.runner)) ?? null;
      return catalog === null
        ? { available: false, fetchedAt: null, providers: [] }
        : { available: true, fetchedAt: catalog.fetchedAt.toISOString(), providers: catalog.providers };
    },
  );
};
