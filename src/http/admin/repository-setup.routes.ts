import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DiscoveredRepository } from "~/adapters/github/repository-discovery-client.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRecord } from "~/domain/products/repository-registry.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import { setupWorkflowId, type RepositorySetupRecord, type RepositorySetupStore } from "~/domain/setup/repository-setup.js";
import { renderSetupReport } from "~/domain/setup/setup-report.js";
import { errorSchema, schemaOf, SESSION_SECURITY, useSchemasAsDocumentation } from "../openapi.js";

export interface RepositorySetupRouteDependencies {
  products: ProductRegistry;
  tenants: TenantRegistry;
  setups: RepositorySetupStore;
  /** Every repository of the tenant, registered to any product. */
  registeredRepositories: (tenantId: string) => Promise<RepositoryRecord[]>;
  /** The GitHub App installations of the tenant. */
  installations: (tenantId: string) => Promise<string[]>;
  listInstallationRepositories: (installationId: string) => Promise<DiscoveredRepository[]>;
  /** Starts the setup workflow. False when one already runs for the repository. */
  startSetup: (input: { setupId: string; workflowId: string }) => Promise<boolean>;
}

const workspaceQuery = z.object({ linearWorkspaceId: z.string().min(1) });

const setupSchema = z.object({
  id: z.string(),
  status: z.enum(["queued", "running", "proposed", "partial", "failed", "merged"]),
  pullRequestUrl: z.string().nullable(),
  failureMessage: z.string().nullable(),
  /** The setup report in Markdown, as the pull request body holds it. */
  report: z.string().nullable(),
  /** The hosts outside the ecosystem host list that the setup sandbox was denied. */
  deniedHosts: z.array(z.string()),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});

const repositorySetupSchema = z.object({
  fullName: z.string(),
  githubInstallationId: z.string(),
  /** True when this product already owns the repository through its config. */
  registered: z.boolean(),
  /** Why a build-ahead marked the repository for setup, or null. */
  needsSetupReason: z.string().nullable(),
  setup: setupSchema.nullable(),
});

const startSchema = z.object({
  linearWorkspaceId: z.string().min(1),
  repositories: z.array(z.string().min(1).regex(/^[^/\s]+\/[^/\s]+$/)).min(1).max(50),
});

const ACTIVE: ReadonlyArray<RepositorySetupRecord["status"]> = ["queued", "running"];

const toSetup = (setup: RepositorySetupRecord): z.infer<typeof setupSchema> => ({
  id: setup.id,
  status: setup.status,
  pullRequestUrl: setup.pullRequestUrl,
  failureMessage: setup.failureMessage,
  report: setup.report === null ? null : renderSetupReport(setup.report),
  deniedHosts: setup.report?.deniedHosts ?? [],
  createdAt: setup.createdAt.toISOString(),
  endedAt: setup.endedAt?.toISOString() ?? null,
});

/**
 * docs/specs/repository-setup-and-services.md. The product page lists the repositories the GitHub
 * App can read, with their setup state, and starts setup runs. Nothing starts a setup by itself.
 */
export const registerRepositorySetupRoutes = (app: FastifyInstance, dependencies: RepositorySetupRouteDependencies): void => {
  useSchemasAsDocumentation(app);

  /** The App-visible repositories this product can set up: its own, and those no product owns. */
  const candidatesOf = async (tenantId: string, productId: string) => {
    const registered = new Map((await dependencies.registeredRepositories(tenantId)).filter((repository) => repository.absentSince === null).map((repository) => [repository.fullName, repository]));
    const seen = new Map<string, string>();
    for (const installationId of await dependencies.installations(tenantId)) {
      for (const repository of await dependencies.listInstallationRepositories(installationId)) {
        if (!seen.has(repository.fullName)) seen.set(repository.fullName, installationId);
      }
    }
    return [...seen.entries()]
      .filter(([fullName]) => {
        const owner = registered.get(fullName);
        return owner === undefined || owner.productId === productId;
      })
      .map(([fullName, githubInstallationId]) => ({ fullName, githubInstallationId, registered: registered.get(fullName) ?? null }))
      .sort((left, right) => (left.fullName < right.fullName ? -1 : 1));
  };

  app.get<{ Params: { id: string } }>(
    "/admin/products/:id/repository-setups",
    {
      schema: {
        tags: ["products"],
        operationId: "listRepositorySetups",
        security: SESSION_SECURITY,
        params: schemaOf(z.object({ id: z.string() })),
        querystring: schemaOf(workspaceQuery),
        response: { 200: schemaOf(z.array(repositorySetupSchema)), 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const query = workspaceQuery.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      const tenant = await dependencies.tenants.findByWorkspace(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const product = await dependencies.products.findById(tenant.id, request.params.id);
      if (!product) return reply.code(404).send({ error: "product not found" });
      const latest = new Map((await dependencies.setups.latestByProduct(product.id)).map((setup) => [setup.repositoryFullName, setup]));
      return (await candidatesOf(tenant.id, product.id)).map((candidate) => {
        const setup = latest.get(candidate.fullName);
        return {
          fullName: candidate.fullName,
          githubInstallationId: candidate.githubInstallationId,
          registered: candidate.registered !== null,
          needsSetupReason: candidate.registered?.needsSetupReason ?? null,
          setup: setup === undefined ? null : toSetup(setup),
        };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/products/:id/repository-setups",
    {
      schema: {
        tags: ["products"],
        operationId: "startRepositorySetups",
        security: SESSION_SECURITY,
        params: schemaOf(z.object({ id: z.string() })),
        body: schemaOf(startSchema),
        response: { 202: schemaOf(z.array(z.object({ fullName: z.string(), setupId: z.string() }))), 400: errorSchema, 404: errorSchema, 422: errorSchema },
      },
    },
    async (request, reply) => {
      const body = startSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const tenant = await dependencies.tenants.findByWorkspace(body.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const product = await dependencies.products.findById(tenant.id, request.params.id);
      if (!product) return reply.code(404).send({ error: "product not found" });
      const candidates = new Map((await candidatesOf(tenant.id, product.id)).map((candidate) => [candidate.fullName, candidate]));
      const unknown = body.data.repositories.filter((fullName) => !candidates.has(fullName));
      if (unknown.length > 0) {
        return reply.code(422).send({ error: `The product cannot set up these repositories: ${unknown.join(", ")}.` });
      }
      const latest = new Map((await dependencies.setups.latestByProduct(product.id)).map((setup) => [setup.repositoryFullName, setup]));
      const started: Array<{ fullName: string; setupId: string }> = [];
      for (const fullName of [...new Set(body.data.repositories)]) {
        const running = latest.get(fullName);
        // One setup per repository at a time: a second start shows the running one.
        if (running !== undefined && ACTIVE.includes(running.status)) {
          started.push({ fullName, setupId: running.id });
          continue;
        }
        const workflowId = setupWorkflowId(tenant.id, fullName);
        const setup = await dependencies.setups.create({
          tenantId: tenant.id,
          productId: product.id,
          repositoryFullName: fullName,
          githubInstallationId: candidates.get(fullName)!.githubInstallationId,
          workflowId,
        });
        if (!(await dependencies.startSetup({ setupId: setup.id, workflowId }))) {
          await dependencies.setups.update(setup.id, {
            status: "failed",
            failureMessage: "Another setup of this repository runs, from another product.",
            endedAt: new Date(),
          });
        }
        started.push({ fullName, setupId: setup.id });
      }
      return reply.code(202).send(started);
    },
  );
};
