import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BuildAheadTrigger } from "~/domain/runs/build-ahead.js";
import type { InstallSettingsStore } from "~/domain/settings/install-settings.js";
import {
  SandboxProviderInUseError,
  type SandboxProviderSettings,
  type SandboxProviderStore,
} from "~/domain/settings/sandbox-providers.js";
import { errorSchema, schemaOf, SESSION_SECURITY, useSchemasAsDocumentation } from "../openapi.js";
import { principalOf } from "../auth/admin-guard.js";
import {
  sandboxProviderCreateSchema,
  sandboxProviderProblem,
  sandboxProviderUpdateSchema,
  sandboxProviderViewSchema,
  viewSandboxProvider,
} from "./schemas.js";

export interface SandboxProviderRouteDependencies {
  providers: SandboxProviderStore;
  settings: InstallSettingsStore;
  localSandboxAllowed: boolean;
  /** A new or changed provider needs the warm snapshots of every repository. */
  buildAhead?: Pick<BuildAheadTrigger, "afterTemplateChange">;
}

const idParams = z.object({ id: z.string().min(1) });

/** The provider settings that decide its template, or whether it serves runs at all. */
const templateOf = (provider: SandboxProviderSettings): string =>
  JSON.stringify([provider.type, provider.url, provider.vcpus, provider.memoryMb, provider.enabled]);

/**
 * docs/specs/sandbox-provider-spillover.md. The sandbox providers of the install. Any admin reads
 * the list, because the product page offers it. Only an operator admin changes it (DI-14.53).
 */
export const registerSandboxProviderRoutes = (app: FastifyInstance, dependencies: SandboxProviderRouteDependencies): void => {
  useSchemasAsDocumentation(app);

  const view = async (provider: SandboxProviderSettings, live?: Record<string, number>) => {
    const counts = live ?? (await dependencies.providers.liveCounts());
    const image = (await dependencies.settings.read()).sandbox.image;
    return viewSandboxProvider(
      provider,
      counts[provider.id] ?? 0,
      sandboxProviderProblem(provider, image, dependencies.localSandboxAllowed),
      new Date(),
    );
  };

  app.get(
    "/admin/sandbox-providers",
    {
      schema: {
        tags: ["install"],
        operationId: "listSandboxProviders",
        security: SESSION_SECURITY,
        response: { 200: schemaOf(z.array(sandboxProviderViewSchema)) },
      },
    },
    async () => {
      const live = await dependencies.providers.liveCounts();
      return Promise.all((await dependencies.providers.list()).map((provider) => view(provider, live)));
    },
  );

  app.post(
    "/admin/sandbox-providers",
    {
      schema: {
        tags: ["install"],
        operationId: "createSandboxProvider",
        security: SESSION_SECURITY,
        body: schemaOf(sandboxProviderCreateSchema),
        response: { 201: schemaOf(sandboxProviderViewSchema), 403: errorSchema, 422: errorSchema },
      },
    },
    async (request, reply) => {
      if (!principalOf(request).operatorAdmin) {
        return reply.code(403).send({ error: "only a Linear admin of the setup workspace changes the sandbox providers" });
      }
      const body = sandboxProviderCreateSchema.safeParse(request.body);
      if (!body.success) return reply.code(422).send({ error: body.error.flatten() });
      const input = {
        name: body.data.name,
        type: body.data.type,
        url: body.data.type === "local" ? null : (body.data.url ?? null),
        apiKey: body.data.type === "local" ? null : (body.data.apiKey ?? null),
        maxLive: body.data.maxLive ?? null,
        vcpus: body.data.vcpus ?? null,
        memoryMb: body.data.memoryMb ?? null,
        priority: body.data.priority ?? 1,
        enabled: body.data.enabled ?? true,
      };
      const image = (await dependencies.settings.read()).sandbox.image;
      const problem = sandboxProviderProblem(input, image, dependencies.localSandboxAllowed);
      if (problem !== null) return reply.code(422).send({ error: problem });
      const created = await dependencies.providers.create(input);
      if (created.enabled) await dependencies.buildAhead?.afterTemplateChange();
      return reply.code(201).send(await view(created));
    },
  );

  app.put<{ Params: { id: string } }>(
    "/admin/sandbox-providers/:id",
    {
      schema: {
        tags: ["install"],
        operationId: "updateSandboxProvider",
        security: SESSION_SECURITY,
        params: schemaOf(idParams),
        body: schemaOf(sandboxProviderUpdateSchema),
        response: { 200: schemaOf(sandboxProviderViewSchema), 403: errorSchema, 404: errorSchema, 422: errorSchema },
      },
    },
    async (request, reply) => {
      if (!principalOf(request).operatorAdmin) {
        return reply.code(403).send({ error: "only a Linear admin of the setup workspace changes the sandbox providers" });
      }
      const body = sandboxProviderUpdateSchema.safeParse(request.body);
      if (!body.success) return reply.code(422).send({ error: body.error.flatten() });
      const current = await dependencies.providers.find(request.params.id);
      if (current === null) return reply.code(404).send({ error: "sandbox provider not found" });
      // A live sandbox of the provider was made by its adapter type, so the type stays while it runs.
      if (body.data.type !== undefined && body.data.type !== current.type) {
        const live = (await dependencies.providers.liveCounts())[current.id] ?? 0;
        if (live > 0) {
          return reply.code(422).send({ error: `the provider runs ${live} sandboxes, so its type cannot change; disable it and wait until its runs end` });
        }
      }
      const next = { ...current, ...Object.fromEntries(Object.entries(body.data).filter(([, value]) => value !== undefined)) };
      const image = (await dependencies.settings.read()).sandbox.image;
      const problem = sandboxProviderProblem(next, image, dependencies.localSandboxAllowed);
      if (problem !== null) return reply.code(422).send({ error: problem });
      const updated = await dependencies.providers.update(current.id, body.data);
      if (updated === null) return reply.code(404).send({ error: "sandbox provider not found" });
      if (templateOf(current) !== templateOf(updated) && updated.enabled) await dependencies.buildAhead?.afterTemplateChange();
      return view(updated);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/sandbox-providers/:id",
    {
      schema: {
        tags: ["install"],
        operationId: "deleteSandboxProvider",
        security: SESSION_SECURITY,
        params: schemaOf(idParams),
        response: { 204: { type: "null" }, 403: errorSchema, 404: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      if (!principalOf(request).operatorAdmin) {
        return reply.code(403).send({ error: "only a Linear admin of the setup workspace changes the sandbox providers" });
      }
      try {
        const deleted = await dependencies.providers.delete(request.params.id);
        if (!deleted) return reply.code(404).send({ error: "sandbox provider not found" });
      } catch (error) {
        if (error instanceof SandboxProviderInUseError) return reply.code(409).send({ error: error.message });
        throw error;
      }
      return reply.code(204).send();
    },
  );
};
