import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { RunViewReader } from "~/domain/runs/run-view.js";
import type { StopRequest } from "~/domain/runs/run-stop.js";
import { principalOf } from "../auth/admin-guard.js";
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
const stopBodySchema = z.object({ linearWorkspaceId: z.string().min(1) });

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
  /** docs/specs/sandbox-provider-spillover.md. The sandbox provider of the run, or null. */
  sandboxProvider: z.string().nullable(),
});

export const runDetailSchema = runListItemSchema.extend({
  temporalWorkflowId: z.string(),
  /** Issue #45. True when the status is terminal, so the run takes no stop. */
  terminal: z.boolean(),
  /** Issue #45, DI-21.65. The first stop that reached the workflow, or null. */
  stopRequestedAt: z.string().nullable(),
  /** "linear" or "factoree_ui", or null when nobody stopped the run. */
  stopSource: z.string().nullable(),
  /** The admin who stopped the run from the Factoree UI, or null. */
  stopRequestedBy: z.string().nullable(),
  /** The sandbox retention of the product, in hours. */
  sandboxRetentionHours: z.number(),
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
 * reads it. Issue #45: only the stop route changes a run, and the admin guard limits it to a
 * Linear admin of the workspace, as for every other change.
 */
export const registerRunRoutes = (
  app: FastifyInstance,
  dependencies: {
    tenants: TenantRegistry;
    runViews: RunViewReader;
    /** The stop path of a Linear stop: DelegationService.stopRun. */
    stopRun: (input: { tenantId: string; runId: string; workflowId: string; request: StopRequest }) => Promise<boolean>;
    /** The name, or else the email, of a user, for the stop message and the stop record. */
    userName: (userId: string) => Promise<string | null>;
  },
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

  app.post<{ Params: { id: string } }>(
    "/admin/runs/:id/stop",
    {
      schema: {
        tags: TAGS,
        operationId: "stopRun",
        security: SESSION_SECURITY,
        params: schemaOf(z.object({ id: z.string() })),
        body: schemaOf(stopBodySchema),
        response: {
          202: schemaOf(z.object({ stopRequestedBy: z.string().nullable() })),
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const body = stopBodySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const tenant = await dependencies.tenants.findByWorkspace(body.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const run = await dependencies.runViews.detail(tenant.id, request.params.id);
      if (!run) return reply.code(404).send({ error: "run not found" });
      if (run.terminal) return reply.code(409).send({ error: `the run already ended as ${run.status}` });
      const by = await dependencies.userName(principalOf(request).userId);
      const signalled = await dependencies.stopRun({
        tenantId: tenant.id,
        runId: run.id,
        workflowId: run.temporalWorkflowId,
        request: { source: "factoree_ui", by },
      });
      // DI-21.65. A run row that is not terminal while its workflow is gone takes no signal, so
      // nothing can stop it from here.
      if (!signalled) return reply.code(409).send({ error: "the workflow of the run is not running" });
      return reply.code(202).send({ stopRequestedBy: by });
    },
  );
};
