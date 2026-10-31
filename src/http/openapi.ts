import type { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import { z } from "zod";

/**
 * A JSON Schema for the OpenAPI document. The route still validates with zod, so a schema here
 * is documentation only: DI-14.52.
 */
export const schemaOf = (schema: z.ZodType): Record<string, unknown> => {
  const document: Record<string, unknown> = { ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) };
  delete document.$schema;
  return document;
};

export const errorSchema = schemaOf(z.object({ error: z.unknown() }));

export const SESSION_SECURITY = [{ bearer: [] }, { session: [] }];
export const SETUP_SECURITY = [{ setupToken: [] }];

/**
 * docs/specs/release-0-1-0.md. `@fastify/swagger` writes the document of the administration,
 * settings and setup API from the route schemas. A route without a tag stays out of it, so the
 * webhooks and the probes are not part of the generated client.
 *
 * Fastify would validate a request against the schema with Ajv and serialise a response with
 * it. The zod validation of each route decides the status code, and a response schema must not
 * drop a field, so both compilers pass the data through unchanged. Each route module that
 * declares a schema sets them too, so it behaves the same in a test that mounts it alone.
 */
export const useSchemasAsDocumentation = (app: FastifyInstance): void => {
  app.setValidatorCompiler(() => (data: unknown) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
};

export const registerOpenApi = (app: FastifyInstance, version: string): void => {
  useSchemasAsDocumentation(app);
  void app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "Factoree", version },
      components: {
        securitySchemes: {
          bearer: { type: "http", scheme: "bearer", description: "A Factoree API key." },
          session: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
          setupToken: { type: "http", scheme: "bearer", description: "The one-time setup token from the API log." },
        },
      },
    },
    hideUntagged: true,
  });
};
