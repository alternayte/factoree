import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProjectRegistry, TenantRegistry } from "~/domain/projects/project-registry.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";

const createSchema = z.object({
  linearWorkspaceId: z.string().min(1),
  workspaceName: z.string().min(1).default("workspace"),
  key: z.string().min(1),
  name: z.string().min(1),
  primaryRepository: z.string().regex(/^[^/]+\/[^/]+$/),
  referenceRepositories: z.array(z.string()).default([]),
  // SDD section 16. One organization-wide skills repository, as an owner and repository slug.
  organizationSkillsRepository: z.string().regex(/^[^/]+\/[^/]+$/).nullable().optional(),
  linearTeamId: z.string().min(1).optional(),
  defaultAutonomy: z.enum(["L0", "L1", "L2", "L3", "L4"]).default("L2"),
  maxRunMinutes: z.number().int().positive().max(600).default(90),
  defaultBranch: z.string().min(1).max(255).default("main"),
});

const updateSchema = createSchema.partial().omit({ linearWorkspaceId: true, workspaceName: true, key: true });

const tenantQuerySchema = z.object({ linearWorkspaceId: z.string().min(1) });

export const registerProjectRoutes = (
  app: FastifyInstance,
  dependencies: { projects: ProjectRegistry; tenants: TenantRegistry; secrets: SecretStore },
): void => {
  const resolveTenant = async (linearWorkspaceId: string) =>
    dependencies.tenants.findByWorkspace(linearWorkspaceId);

  app.post("/admin/projects", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await dependencies.tenants.ensureTenant(parsed.data.linearWorkspaceId, parsed.data.workspaceName);
    const project = await dependencies.projects.create({
      tenantId: tenant.id,
      key: parsed.data.key,
      name: parsed.data.name,
      primaryRepository: parsed.data.primaryRepository,
      referenceRepositories: parsed.data.referenceRepositories,
      ...(parsed.data.organizationSkillsRepository === undefined
        ? {}
        : { organizationSkillsRepository: parsed.data.organizationSkillsRepository }),
      ...(parsed.data.linearTeamId === undefined ? {} : { linearTeamId: parsed.data.linearTeamId }),
      defaultAutonomy: parsed.data.defaultAutonomy,
      maxRunMinutes: parsed.data.maxRunMinutes,
      defaultBranch: parsed.data.defaultBranch,
    });
    return reply.code(201).send(project);
  });

  app.get("/admin/projects", async (request, reply) => {
    const parsed = tenantQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await resolveTenant(parsed.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    return dependencies.projects.list(tenant.id);
  });

  app.get<{ Params: { id: string } }>("/admin/projects/:id", async (request, reply) => {
    const parsed = tenantQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await resolveTenant(parsed.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const project = await dependencies.projects.findById(tenant.id, request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return project;
  });

  app.put<{ Params: { id: string } }>("/admin/projects/:id", async (request, reply) => {
    const query = tenantQuerySchema.safeParse(request.query);
    const body = updateSchema.safeParse(request.body);
    if (!query.success || !body.success) return reply.code(400).send({ error: "invalid request" });
    const tenant = await resolveTenant(query.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const update = {
      ...(body.data.name === undefined ? {} : { name: body.data.name }),
      ...(body.data.primaryRepository === undefined ? {} : { primaryRepository: body.data.primaryRepository }),
      ...(body.data.referenceRepositories === undefined
        ? {}
        : { referenceRepositories: body.data.referenceRepositories }),
      ...(body.data.organizationSkillsRepository === undefined
        ? {}
        : { organizationSkillsRepository: body.data.organizationSkillsRepository }),
      ...(body.data.linearTeamId === undefined ? {} : { linearTeamId: body.data.linearTeamId }),
      ...(body.data.defaultAutonomy === undefined ? {} : { defaultAutonomy: body.data.defaultAutonomy }),
      ...(body.data.maxRunMinutes === undefined ? {} : { maxRunMinutes: body.data.maxRunMinutes }),
      ...(body.data.defaultBranch === undefined ? {} : { defaultBranch: body.data.defaultBranch }),
    };
    const project = await dependencies.projects.update(tenant.id, request.params.id, update);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return project;
  });

  app.delete<{ Params: { id: string } }>("/admin/projects/:id", async (request, reply) => {
    const query = tenantQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    const tenant = await resolveTenant(query.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const removed = await dependencies.projects.remove(tenant.id, request.params.id);
    if (!removed) return reply.code(404).send({ error: "project not found" });
    return reply.code(204).send();
  });

  app.put<{ Params: { id: string; name: string } }>("/admin/projects/:id/secrets/:name", async (request, reply) => {
    const query = tenantQuerySchema.safeParse(request.query);
    // SDD section 30. The Implementer receives a Project secret only when the operator marks it
    // here. The mark defaults to false, so an unmarked secret stays out of the sandbox.
    const body = z
      .object({ value: z.string().min(1), injectIntoImplementer: z.boolean().default(false) })
      .safeParse(request.body);
    if (!query.success || !body.success) return reply.code(400).send({ error: "invalid request" });
    const tenant = await resolveTenant(query.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const project = await dependencies.projects.findById(tenant.id, request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    await dependencies.secrets.put(tenant.id, project.id, request.params.name, body.data.value, {
      injectIntoImplementer: body.data.injectIntoImplementer,
    });
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string; name: string } }>("/admin/projects/:id/secrets/:name", async (request, reply) => {
    const query = tenantQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    const tenant = await resolveTenant(query.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const removed = await dependencies.secrets.remove(tenant.id, request.params.id, request.params.name);
    if (!removed) return reply.code(404).send({ error: "secret not found" });
    return reply.code(204).send();
  });
};
