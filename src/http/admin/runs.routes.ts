import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { RunViewReader } from "~/domain/runs/run-view.js";
import { errorSchema, schemaOf, SESSION_SECURITY, useSchemasAsDocumentation } from "../openapi.js";

/** The most runs one page returns. */
export const MAX_RUNS_PER_PAGE = 100;

const TAGS = ["runs"];

const listQuerySchema = z.object({
  linearWorkspaceId: z.string().min(1),
  productId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_RUNS_PER_PAGE).default(50),
});

const detailQuerySchema = z.object({ linearWorkspaceId: z.string().min(1) });

export const runListItemSchema = z.object({
  id: z.string(),
  productId: z.string(),
  productSlug: z.string(),
  productName: z.string(),
  status: z.string(),
  failureReason: z.string().nullable(),
  failureMessage: z.string().nullable(),
  workItemTitle: z.string().nullable(),
  workItemUrl: z.string().nullable(),
  pullRequestUrl: z.string().nullable(),
  repairCount: z.number(),
  repairLimit: z.number().nullable(),
  costUsd: z.number().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  waitedMs: z.number(),
});

export const runDetailSchema = runListItemSchema.extend({
  temporalWorkflowId: z.string(),
  autonomyLevel: z.string(),
  followUpOfRunId: z.string().nullable(),
  baseSha: z.string().nullable(),
  commitSha: z.string().nullable(),
  patchSha256: z.string().nullable(),
  skillRegistrySet: z.string().nullable(),
  skillResolutionId: z.string().nullable(),
  proofPackPostedAt: z.string().nullable(),
  /** The proof-pack.json document an agent reads, or null before a proof pack exists. */
  proofPackDocument: z.unknown(),
  stages: z.array(
    z.object({
      stage: z.string(),
      attempt: z.number(),
      sandboxId: z.string().nullable(),
      startedAt: z.string(),
      endedAt: z.string(),
    }),
  ),
  sessions: z.array(
    z.object({
      role: z.string(),
      attempt: z.number(),
      runner: z.string(),
      model: z.string().nullable(),
      effort: z.string().nullable(),
      outcome: z.string(),
      durationMs: z.number(),
      inputTokens: z.number().nullable(),
      outputTokens: z.number().nullable(),
      reasoningTokens: z.number().nullable(),
      cacheReadTokens: z.number().nullable(),
      costUsd: z.number().nullable(),
      turns: z.number().nullable(),
      modelMs: z.number().nullable(),
      toolMs: z.number().nullable(),
      createdAt: z.string(),
    }),
  ),
  assertions: z.array(
    z.object({
      key: z.string(),
      attempt: z.number(),
      method: z.string(),
      statement: z.string(),
      result: z.string(),
      reason: z.string(),
    }),
  ),
  findings: z.array(
    z.object({
      attempt: z.number(),
      key: z.string(),
      severity: z.string(),
      category: z.string(),
      evidence: z.string(),
      description: z.string(),
      blocking: z.boolean(),
      decisionReason: z.string(),
    }),
  ),
  skills: z.array(
    z.object({
      source: z.string(),
      name: z.string(),
      version: z.number().nullable(),
      listed: z.boolean(),
      activated: z.boolean(),
    }),
  ),
  skillProposals: z.array(
    z.object({
      name: z.string(),
      source: z.string(),
      state: z.string(),
      url: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
});

/**
 * docs/specs/run-visibility.md. The read model of the Runs pages. Every member of the workspace
 * reads it, and nothing here changes a run.
 */
export const registerRunRoutes = (
  app: FastifyInstance,
  dependencies: { tenants: TenantRegistry; runViews: RunViewReader },
): void => {
  useSchemasAsDocumentation(app);

  app.get(
    "/admin/runs",
    {
      schema: {
        tags: TAGS,
        operationId: "listRuns",
        security: SESSION_SECURITY,
        querystring: schemaOf(listQuerySchema),
        response: {
          200: schemaOf(z.object({ items: z.array(runListItemSchema), nextCursor: z.string().nullable() })),
          400: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      const tenant = await dependencies.tenants.findByWorkspace(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      return dependencies.runViews.list({
        tenantId: tenant.id,
        limit: query.data.limit,
        ...(query.data.productId === undefined ? {} : { productId: query.data.productId }),
        ...(query.data.status === undefined ? {} : { status: query.data.status }),
        ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/runs/:id",
    {
      schema: {
        tags: TAGS,
        operationId: "getRun",
        security: SESSION_SECURITY,
        params: schemaOf(z.object({ id: z.string() })),
        querystring: schemaOf(detailQuerySchema),
        response: { 200: schemaOf(runDetailSchema), 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const query = detailQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      const tenant = await dependencies.tenants.findByWorkspace(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const run = await dependencies.runViews.detail(tenant.id, request.params.id);
      if (!run) return reply.code(404).send({ error: "run not found" });
      return run;
    },
  );
};
