import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProjectRegistry } from "~/domain/projects/project-registry.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { ContextSourceConfigurationStore } from "~/domain/context/context-source-configuration.js";
import { CONTEXT_SOURCE_KINDS, ContextSourceConfigurationError } from "~/domain/context/context-source-configuration.js";

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

const tenantQuerySchema = z.object({ linearWorkspaceId: z.string().min(1) });

/** SDD section 59 fixes these three paths. */
export const registerContextSourceRoutes = (
  app: FastifyInstance,
  dependencies: {
    projects: ProjectRegistry;
    tenants: TenantRegistry;
    contextSources: ContextSourceConfigurationStore;
  },
): void => {
  const resolveTenant = async (linearWorkspaceId: string) =>
    dependencies.tenants.findByWorkspace(linearWorkspaceId);

  app.post<{ Params: { id: string } }>(
    "/admin/projects/:id/context-sources",
    async (request, reply) => {
      const query = tenantQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      const tenant = await resolveTenant(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const project = await dependencies.projects.findById(tenant.id, request.params.id);
      if (!project) return reply.code(404).send({ error: "project not found" });

      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      try {
        const record = await dependencies.contextSources.put({
          tenantId: tenant.id,
          projectId: project.id,
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

  app.get<{ Params: { id: string } }>(
    "/admin/projects/:id/context-sources",
    async (request, reply) => {
      const query = tenantQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      const tenant = await resolveTenant(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const project = await dependencies.projects.findById(tenant.id, request.params.id);
      if (!project) return reply.code(404).send({ error: "project not found" });
      return reply.code(200).send(await dependencies.contextSources.list(tenant.id, project.id));
    },
  );

  app.delete<{ Params: { id: string; sourceId: string } }>(
    "/admin/projects/:id/context-sources/:sourceId",
    async (request, reply) => {
      const query = tenantQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      const tenant = await resolveTenant(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const project = await dependencies.projects.findById(tenant.id, request.params.id);
      if (!project) return reply.code(404).send({ error: "project not found" });
      const removed = await dependencies.contextSources.remove(
        tenant.id,
        project.id,
        request.params.sourceId,
      );
      return removed ? reply.code(204).send() : reply.code(404).send({ error: "no such context source" });
    },
  );
};
