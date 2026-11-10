import type { FastifyInstance } from "fastify";
import type { BuildAheadTrigger } from "~/domain/runs/build-ahead.js";
import { Prisma } from "@prisma/client";
import { normalizeNetworkPolicy } from "~/domain/runs/sandbox.js";
import { z } from "zod";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { LinearTeamLookup } from "~/adapters/linear/team-lookup.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import { assertSecretKindAndMark, PROJECT_SECRET_KINDS, ProjectSecretKindError } from "~/domain/products/secret-store.js";
import { assertRunnerCredential, RunnerCredentialError } from "~/domain/products/runner-credentials.js";
import {
  SKILL_REGISTRY_KEY_SECRET,
  SKILL_REGISTRY_KINDS,
  type SkillRegistrySettings,
} from "~/domain/runs/skill-registry.js";
import { MAX_SKILLS } from "~/domain/runs/skill-discovery.js";
import { agentSettingsProblems, PRODUCT_ROLES, resolveRole, type RoleValues } from "~/domain/products/agent-settings.js";
import { catalogEffortProblem } from "~/domain/products/model-catalog.js";
import type { ModelCatalogService } from "~/domain/products/model-catalog-service.js";
import { errorSchema, schemaOf, SESSION_SECURITY, useSchemasAsDocumentation } from "../openapi.js";
import {
  autonomyLevel,
  productSchema,
  productSettingsFields,
  secretDescriptorSchema,
  workspaceQuerySchema,
} from "./schemas.js";

const TAGS = ["products"];
const productResponse = { 200: schemaOf(productSchema), 400: errorSchema, 403: errorSchema, 404: errorSchema };
const idParams = schemaOf(z.object({ id: z.string() }));
const secretParams = schemaOf(z.object({ id: z.string(), name: z.string() }));
const workspaceQuery = schemaOf(workspaceQuerySchema);

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

// docs/specs/autonomy-levels.md. SDD section 27 reserves L4, and Version 1 never merges, so no
// operator can set it. `autonomyLevel` in ./schemas.ts holds L0 to L3.

const updateSchema = z
  .object({
    name: z.string().min(1),
    maxRunMinutes: z.number().int().positive().max(600),
    organizationSkillsRepository: z.string().regex(/^[^/]+\/[^/]+$/).nullable(),
    // docs/specs/skill-registry.md. An empty set name means every released skill.
    skillRegistry: z
      .object({
        kind: z.enum(SKILL_REGISTRY_KINDS),
        url: z.string().trim().regex(/^https?:\/\/\S+$/, "must be an http or https URL"),
        set: z
          .string()
          .trim()
          .nullable()
          .transform((value) => (value === null || value === "" ? null : value)),
      })
      .strict()
      .nullable(),
    defaultAutonomy: autonomyLevel,
    // The highest level each Linear label allows. A label that is absent has no cap.
    riskCaps: z.record(z.string().min(1).transform((label) => label.trim().toLowerCase()), autonomyLevel),
    // R-4. The egress ceiling of every sandbox of this Product. A repository can only narrow it.
    allowedDomains: z.array(z.string().min(1)).transform((domains, context) => {
      try {
        return normalizeNetworkPolicy({ allowedDomains: domains }).allowedDomains;
      } catch (error) {
        context.addIssue({ code: "custom", message: (error as Error).message });
        return z.NEVER;
      }
    }),
    // docs/specs/release-0-1-0.md. The model, the effort, the silence limit, retention and concurrency.
    ...productSettingsFields,
  })
  .partial()
  .strict();

const activateSchema = z
  .object({
    defaultAutonomy: autonomyLevel,
  })
  .strict();

const tenantQuerySchema = z.object({ linearWorkspaceId: z.string().min(1) });

/** The stored value of each role, with the request's value where it names one. */
const mergeRoles = <T>(stored: RoleValues<T>, update: { [role: string]: T | null | undefined } | undefined): RoleValues<T> =>
  Object.fromEntries(
    PRODUCT_ROLES.map((role) => [role, update?.[role] === undefined ? stored[role] : update[role]]),
  ) as RoleValues<T>;

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
  /** docs/specs/run-speed.md. The allow list is part of the bootstrap key of each repository. */
  buildAhead?: Pick<BuildAheadTrigger, "afterAllowListChange">;
  /**
   * docs/specs/skill-registry.md. Resolves a registry once and counts its skills. A registry that
   * does not resolve throws, and the save is refused.
   */
  checkSkillRegistry?: (settings: SkillRegistrySettings, key: string) => Promise<{ skills: number }>;
  /** docs/specs/model-picker.md. A listed model's effort must be one of its catalog values. */
  modelCatalog?: Pick<ModelCatalogService, "current">;
}

export const registerProductRoutes = (app: FastifyInstance, dependencies: ProductRouteDependencies): void => {
  useSchemasAsDocumentation(app);
  const resolveTenant = async (linearWorkspaceId: string) => dependencies.tenants.findByWorkspace(linearWorkspaceId);

  app.post(
    "/admin/products",
    {
      schema: {
        tags: TAGS,
        operationId: "createProduct",
        security: SESSION_SECURITY,
        body: schemaOf(createSchema),
        response: { 201: schemaOf(productSchema), 400: errorSchema, 404: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
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
  },
  );

  app.get(
    "/admin/products",
    {
      schema: {
        tags: TAGS,
        operationId: "listProducts",
        security: SESSION_SECURITY,
        querystring: workspaceQuery,
        response: { 200: schemaOf(z.array(productSchema)), 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
    const parsed = tenantQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await resolveTenant(parsed.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    return dependencies.products.list(tenant.id);
  },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/products/:id",
    {
      schema: {
        tags: TAGS,
        operationId: "getProduct",
        security: SESSION_SECURITY,
        params: idParams,
        querystring: workspaceQuery,
        response: productResponse,
      },
    },
    async (request, reply) => {
    const parsed = tenantQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await resolveTenant(parsed.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const product = await dependencies.products.findById(tenant.id, request.params.id);
    if (!product) return reply.code(404).send({ error: "product not found" });
    return product;
  },
  );

  app.put<{ Params: { id: string } }>(
    "/admin/products/:id",
    {
      schema: {
        tags: TAGS,
        operationId: "updateProduct",
        security: SESSION_SECURITY,
        params: idParams,
        querystring: workspaceQuery,
        body: schemaOf(updateSchema),
        response: { ...productResponse, 422: errorSchema },
      },
    },
    async (request, reply) => {
    const query = tenantQuerySchema.safeParse(request.query);
    const body = updateSchema.safeParse(request.body);
    if (!query.success) return reply.code(400).send({ error: "invalid request" });
    if (!body.success) return reply.code(422).send({ error: body.error.flatten() });
    const tenant = await resolveTenant(query.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    // docs/specs/claude-code-runner.md. A model or an effort that does not fit the runner its
    // role resolves to fails here, before any write, and not in a run.
    if (
      body.data.defaultRunner !== undefined ||
      body.data.model !== undefined ||
      body.data.runners !== undefined ||
      body.data.models !== undefined ||
      body.data.effort !== undefined
    ) {
      const current = await dependencies.products.findById(tenant.id, request.params.id);
      if (!current) return reply.code(404).send({ error: "product not found" });
      const merged = {
        defaultRunner: body.data.defaultRunner ?? current.defaultRunner,
        model: body.data.model === undefined ? current.model : body.data.model,
        runners: mergeRoles(current.runners, body.data.runners),
        models: mergeRoles(current.models, body.data.models),
        effort: mergeRoles(current.effort, body.data.effort),
      };
      const problems = agentSettingsProblems(merged);
      // docs/specs/model-picker.md. A model the catalog lists takes only its own effort values.
      const catalog = (await dependencies.modelCatalog?.current()) ?? null;
      if (catalog !== null) {
        for (const role of PRODUCT_ROLES) {
          const resolved = resolveRole(merged, role);
          if (resolved.model === null || resolved.effort === null || problems[`effort.${role}`] !== undefined) continue;
          const problem = catalogEffortProblem(catalog.raw, resolved.runner, resolved.model, resolved.effort);
          if (problem !== null) problems[`effort.${role}`] = problem;
        }
      }
      if (Object.keys(problems).length > 0) {
        return reply.code(422).send({
          error: {
            formErrors: [],
            fieldErrors: Object.fromEntries(Object.entries(problems).map(([field, message]) => [field, [message]])),
          },
        });
      }
    }
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
    if (
      body.data.defaultAutonomy !== undefined ||
      body.data.riskCaps !== undefined ||
      body.data.allowedDomains !== undefined
    ) {
      const before = await dependencies.products.findById(tenant.id, request.params.id);
      product = await dependencies.products.updatePolicy(tenant.id, request.params.id, {
        ...(body.data.defaultAutonomy === undefined ? {} : { defaultAutonomy: body.data.defaultAutonomy }),
        ...(body.data.riskCaps === undefined ? {} : { riskCaps: body.data.riskCaps }),
        ...(body.data.allowedDomains === undefined ? {} : { allowedDomains: body.data.allowedDomains }),
      });
      if (!product) return reply.code(404).send({ error: "product not found" });
      if (before !== null && before.allowedDomains.join(",") !== product.allowedDomains.join(",")) {
        await dependencies.buildAhead?.afterAllowListChange(tenant.id, product.id);
      }
    }
    if (
      body.data.defaultRunner !== undefined ||
      body.data.model !== undefined ||
      body.data.runners !== undefined ||
      body.data.models !== undefined ||
      body.data.effort !== undefined ||
      body.data.silenceMinutes !== undefined ||
      body.data.sandboxRetentionHours !== undefined ||
      body.data.maxConcurrentRuns !== undefined ||
      body.data.appChangeIssues !== undefined
    ) {
      product = await dependencies.products.updateSettings(tenant.id, request.params.id, {
        ...(body.data.defaultRunner === undefined ? {} : { defaultRunner: body.data.defaultRunner }),
        ...(body.data.model === undefined ? {} : { model: body.data.model }),
        ...(body.data.runners === undefined ? {} : { runners: body.data.runners }),
        ...(body.data.models === undefined ? {} : { models: body.data.models }),
        ...(body.data.effort === undefined ? {} : { effort: body.data.effort }),
        ...(body.data.silenceMinutes === undefined ? {} : { silenceMinutes: body.data.silenceMinutes }),
        ...(body.data.sandboxRetentionHours === undefined
          ? {}
          : { sandboxRetentionHours: body.data.sandboxRetentionHours }),
        ...(body.data.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: body.data.maxConcurrentRuns }),
        ...(body.data.appChangeIssues === undefined ? {} : { appChangeIssues: body.data.appChangeIssues }),
      });
      if (!product) return reply.code(404).send({ error: "product not found" });
    }
    let skillRegistryWarning: string | null = null;
    if (body.data.skillRegistry !== undefined) {
      const settings = body.data.skillRegistry;
      const stored = (await dependencies.products.findById(tenant.id, request.params.id))?.skillRegistry ?? null;
      const changed = JSON.stringify(stored) !== JSON.stringify(settings);
      if (settings !== null && changed) {
        // docs/specs/skill-registry.md. A wrong setting fails here, where the operator reads the
        // message, not in a run.
        const key = await dependencies.secrets.get(tenant.id, request.params.id, SKILL_REGISTRY_KEY_SECRET);
        if (key === null) {
          return reply
            .code(422)
            .send({ error: `Store the service key of the registry as the secret ${SKILL_REGISTRY_KEY_SECRET} first.` });
        }
        if (dependencies.checkSkillRegistry !== undefined) {
          let count: number;
          try {
            count = (await dependencies.checkSkillRegistry(settings, key)).skills;
          } catch (error) {
            return reply.code(422).send({ error: `The skill registry did not resolve: ${(error as Error).message}` });
          }
          if (settings.set === null && count > MAX_SKILLS) {
            skillRegistryWarning =
              `The registry holds ${count} released skills. A run lists the first ${MAX_SKILLS} in the prompt, ` +
              "and the agent must find the rest on disk. Name a set to choose the skills of a run.";
          }
        }
      }
      product = await dependencies.products.updateSkillRegistry(tenant.id, request.params.id, settings);
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
    return { ...product, skillRegistryWarning };
  },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/products/:id",
    {
      schema: {
        tags: TAGS,
        operationId: "deleteProduct",
        security: SESSION_SECURITY,
        params: idParams,
        querystring: workspaceQuery,
        response: { 204: { type: "null" }, 404: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
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
  },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/products/:id/activate",
    {
      schema: {
        tags: TAGS,
        operationId: "activateProduct",
        security: SESSION_SECURITY,
        params: idParams,
        querystring: workspaceQuery,
        body: schemaOf(activateSchema),
        response: productResponse,
      },
    },
    async (request, reply) => {
    const query = tenantQuerySchema.safeParse(request.query);
    const body = activateSchema.safeParse(request.body);
    if (!query.success || !body.success) return reply.code(400).send({ error: "invalid request" });
    const tenant = await resolveTenant(query.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    // The level change leaves a policy history row, the same as a later raise does.
    const updated = await dependencies.products.updatePolicy(tenant.id, request.params.id, {
      defaultAutonomy: body.data.defaultAutonomy,
    });
    if (!updated) return reply.code(404).send({ error: "product not found" });
    const product = await dependencies.products.activate(tenant.id, request.params.id, body.data.defaultAutonomy);
    if (!product) return reply.code(404).send({ error: "product not found" });
    return product;
  },
  );

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

  app.get<{ Params: { id: string } }>(
    "/admin/products/:id/secrets",
    {
      schema: {
        tags: TAGS,
        operationId: "listProductSecrets",
        security: SESSION_SECURITY,
        params: idParams,
        querystring: workspaceQuery,
        response: { 200: schemaOf(z.array(secretDescriptorSchema)), 404: errorSchema },
      },
    },
    async (request, reply) => {
      const parsed = tenantQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const tenant = await resolveTenant(parsed.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const product = await dependencies.products.findById(tenant.id, request.params.id);
      if (!product) return reply.code(404).send({ error: "product not found" });
      // Names, kinds and marks only. A secret value never leaves the store through the API.
      return dependencies.secrets.list(tenant.id, product.id);
    },
  );

  app.put<{ Params: { id: string; name: string } }>(
    "/admin/products/:id/secrets/:name",
    {
      schema: {
        tags: TAGS,
        operationId: "putProductSecret",
        security: SESSION_SECURITY,
        params: secretParams,
        querystring: workspaceQuery,
        body: schemaOf(secretBodySchema),
        response: { 204: { type: "null" }, 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
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
      // docs/specs/skill-registry.md. The registry key stays on the worker. A mark or the runner
      // credential kind would carry it into the sandbox.
      if (request.params.name === SKILL_REGISTRY_KEY_SECRET && (body.data.injectIntoImplementer || body.data.kind !== "test")) {
        return reply.code(400).send({
          error: `${SKILL_REGISTRY_KEY_SECRET} must be stored as a "test" secret without the injection mark, so it never reaches a sandbox.`,
        });
      }
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
  },
  );

  app.delete<{ Params: { id: string; name: string } }>(
    "/admin/products/:id/secrets/:name",
    {
      schema: {
        tags: TAGS,
        operationId: "deleteProductSecret",
        security: SESSION_SECURITY,
        params: secretParams,
        querystring: workspaceQuery,
        response: { 204: { type: "null" }, 404: errorSchema },
      },
    },
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
