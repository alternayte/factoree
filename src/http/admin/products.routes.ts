import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { LinearTeamLookup } from "~/adapters/linear/team-lookup.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import { assertSecretKindAndMark, PROJECT_SECRET_KINDS, ProjectSecretKindError } from "~/domain/products/secret-store.js";
import { assertRunnerCredential, RunnerCredentialError } from "~/domain/products/runner-credentials.js";

const createSchema = z
  .object({
    linearWorkspaceId: z.string().min(1),
    workspaceName: z.string().min(1).default("workspace"),
    slug: z.string().min(1),
    name: z.string().min(1),
    // A human names a team by its key. Factoree resolves the key once through Linear. Factoree
    // keeps the id afterward, because a team key rename never changes the id.
    linearTeamKey: z.string().min(1),
    organizationSkillsRepository: z.string().regex(/^[^/]+\/[^/]+$/).nullable().optional(),
    maxRunMinutes: z.number().int().positive().max(600).optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().min(1),
    maxRunMinutes: z.number().int().positive().max(600),
    organizationSkillsRepository: z.string().regex(/^[^/]+\/[^/]+$/).nullable(),
  })
  .partial()
  .strict();

const activateSchema = z
  .object({
    defaultAutonomy: z.enum(["L0", "L1", "L2", "L3", "L4"]),
  })
  .strict();

const tenantQuerySchema = z.object({ linearWorkspaceId: z.string().min(1) });

const isUniqueConstraintViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

const secretBodySchema = z
  .object({
    value: z.string().min(1),
    injectIntoImplementer: z.boolean().default(false),
    kind: z.enum(PROJECT_SECRET_KINDS).default("test"),
  })
  .strict();

export interface ProductRouteDependencies {
  products: ProductRegistry;
  repositories: RepositoryRegistry;
  tenants: TenantRegistry;
  secrets: SecretStore;
  linearTeams: LinearTeamLookup;
  runs: RunRepository;
}

export const registerProductRoutes = (app: FastifyInstance, dependencies: ProductRouteDependencies): void => {
  const resolveTenant = async (linearWorkspaceId: string) => dependencies.tenants.findByWorkspace(linearWorkspaceId);

  app.post("/admin/products", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await dependencies.tenants.ensureTenant(parsed.data.linearWorkspaceId, parsed.data.workspaceName);
    const team = await dependencies.linearTeams.resolveTeamKey(tenant.id, parsed.data.linearTeamKey);
    if (!team) {
      return reply
        .code(404)
        .send({ error: `Linear reports no team for the key "${parsed.data.linearTeamKey}".` });
    }
    try {
      const product = await dependencies.products.create({
        tenantId: tenant.id,
        slug: parsed.data.slug,
        name: parsed.data.name,
        linearTeamKey: team.key,
        linearTeamId: team.id,
        ...(parsed.data.maxRunMinutes === undefined ? {} : { maxRunMinutes: parsed.data.maxRunMinutes }),
        ...(parsed.data.organizationSkillsRepository === undefined
          ? {}
          : { organizationSkillsRepository: parsed.data.organizationSkillsRepository }),
      });
      return reply.code(201).send(product);
    } catch (error) {
      // F8. A create for a Linear team, or a slug, another Product already claims must not
      // surface as a bare 500. The unique constraint of `Product` names the collision, so the
      // response names the Product that already claims it.
      if (isUniqueConstraintViolation(error)) {
        const claimant = await dependencies.products.findByLinearTeamId(tenant.id, team.id);
        return reply.code(409).send({
          error:
            claimant === null
              ? `Product "${parsed.data.slug}" already exists for tenant "${tenant.id}".`
              : `Linear team "${team.key}" is already claimed by Product "${claimant.slug}".`,
        });
      }
      throw error;
    }
  });

  app.get("/admin/products", async (request, reply) => {
    const parsed = tenantQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await resolveTenant(parsed.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    return dependencies.products.list(tenant.id);
  });

  app.get<{ Params: { id: string } }>("/admin/products/:id", async (request, reply) => {
    const parsed = tenantQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await resolveTenant(parsed.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const product = await dependencies.products.findById(tenant.id, request.params.id);
    if (!product) return reply.code(404).send({ error: "product not found" });
    return product;
  });

  app.put<{ Params: { id: string } }>("/admin/products/:id", async (request, reply) => {
    const query = tenantQuerySchema.safeParse(request.query);
    const body = updateSchema.safeParse(request.body);
    if (!query.success || !body.success) return reply.code(400).send({ error: "invalid request" });
    const tenant = await resolveTenant(query.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    // F8. The replaced `PUT /admin/projects/:id` route let an operator change the name and the
    // maximum Run minutes too. `updateSchema` now covers those, so both writes must apply.
    let product = null;
    if (body.data.name !== undefined || body.data.maxRunMinutes !== undefined) {
      product = await dependencies.products.update(tenant.id, request.params.id, {
        ...(body.data.name === undefined ? {} : { name: body.data.name }),
        ...(body.data.maxRunMinutes === undefined ? {} : { maxRunMinutes: body.data.maxRunMinutes }),
      });
      if (!product) return reply.code(404).send({ error: "product not found" });
    }
    if (body.data.organizationSkillsRepository !== undefined) {
      product = await dependencies.products.updateOrganizationSkillsRepository(
        tenant.id,
        request.params.id,
        body.data.organizationSkillsRepository,
      );
      if (!product) return reply.code(404).send({ error: "product not found" });
    }
    if (product === null) product = await dependencies.products.findById(tenant.id, request.params.id);
    if (!product) return reply.code(404).send({ error: "product not found" });
    return product;
  });

  app.delete<{ Params: { id: string } }>("/admin/products/:id", async (request, reply) => {
    const query = tenantQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    const tenant = await resolveTenant(query.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const product = await dependencies.products.findById(tenant.id, request.params.id);
    if (!product) return reply.code(404).send({ error: "product not found" });
    // F6. `Run.productId` carries `onDelete: Cascade`, so deleting a Product that owns Runs
    // would destroy their evidence and every Proof Pack it ever produced. Deleting audit
    // evidence to tidy the registry is the wrong trade, so this route refuses instead of
    // deleting when the Product still owns at least one Run. A pending Product a typo created
    // owns none, so that case still deletes.
    const runCount = await dependencies.runs.countByProduct(tenant.id, product.id);
    if (runCount > 0) {
      return reply.code(409).send({
        error:
          `Product "${product.slug}" owns ${String(runCount)} Run${runCount === 1 ? "" : "s"}, so ` +
          "Factoree refuses to delete it. Deleting it would destroy their evidence and every " +
          "Proof Pack it produced.",
      });
    }
    const removed = await dependencies.products.remove(tenant.id, request.params.id);
    if (!removed) return reply.code(404).send({ error: "product not found" });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/admin/products/:id/activate", async (request, reply) => {
    const query = tenantQuerySchema.safeParse(request.query);
    const body = activateSchema.safeParse(request.body);
    if (!query.success || !body.success) return reply.code(400).send({ error: "invalid request" });
    const tenant = await resolveTenant(query.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const product = await dependencies.products.activate(tenant.id, request.params.id, body.data.defaultAutonomy);
    if (!product) return reply.code(404).send({ error: "product not found" });
    return product;
  });

  // Discovery owns the Repository row: a repository declares itself in its own
  // `.factoree/config.yaml`. No route here creates, updates, or deletes one.
  app.get<{ Params: { id: string } }>("/admin/products/:id/repositories", async (request, reply) => {
    const parsed = tenantQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await resolveTenant(parsed.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const product = await dependencies.products.findById(tenant.id, request.params.id);
    if (!product) return reply.code(404).send({ error: "product not found" });
    return dependencies.repositories.listByProduct(product.id);
  });

  app.put<{ Params: { id: string; name: string } }>("/admin/products/:id/secrets/:name", async (request, reply) => {
    const query = tenantQuerySchema.safeParse(request.query);
    // Specification section 30. The Implementer receives a Product secret only when the operator
    // marks it here. The mark defaults to false, so an unmarked secret stays out of the sandbox.
    const body = secretBodySchema.safeParse(request.body);
    if (!query.success || !body.success) return reply.code(400).send({ error: "invalid request" });
    const tenant = await resolveTenant(query.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const product = await dependencies.products.findById(tenant.id, request.params.id);
    if (!product) return reply.code(404).send({ error: "product not found" });
    // A credential must fail here, where an operator reads the message, rather than in the
    // middle of a Run. Both rules come from specification section 30.
    try {
      assertSecretKindAndMark(body.data.kind, body.data.injectIntoImplementer);
      if (body.data.kind === "runner_credential") {
        assertRunnerCredential(request.params.name, body.data.value);
      }
    } catch (error) {
      if (error instanceof ProjectSecretKindError || error instanceof RunnerCredentialError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
    await dependencies.secrets.put(tenant.id, product.id, request.params.name, body.data.value, {
      injectIntoImplementer: body.data.injectIntoImplementer,
      kind: body.data.kind,
    });
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string; name: string } }>(
    "/admin/products/:id/secrets/:name",
    async (request, reply) => {
      const query = tenantQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      const tenant = await resolveTenant(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const removed = await dependencies.secrets.remove(tenant.id, request.params.id, request.params.name);
      if (!removed) return reply.code(404).send({ error: "secret not found" });
      return reply.code(204).send();
    },
  );
};
