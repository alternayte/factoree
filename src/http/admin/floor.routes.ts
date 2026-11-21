import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import { MAX_REPLAY_MS, type FloorData, type FloorReader } from "~/domain/runs/floor.js";
import { TOOL_KINDS } from "~/domain/runs/session-pulse.js";
import { errorSchema, schemaOf, SESSION_SECURITY, useSchemasAsDocumentation } from "../openapi.js";

const TAGS = ["floor"];

const liveQuerySchema = z.object({ linearWorkspaceId: z.string().min(1) });
const replayQuerySchema = z.object({
  linearWorkspaceId: z.string().min(1),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});

const statusChangeSchema = z.object({ status: z.string(), at: z.string() });

export const floorSchema = z.object({
  generatedAt: z.string(),
  from: z.string(),
  to: z.string(),
  /** One line per product of the workspace. */
  lines: z.array(
    z.object({ productId: z.string(), name: z.string(), slug: z.string(), teamKey: z.string(), repositories: z.array(z.string()) }),
  ),
  runs: z.array(
    z.object({
      id: z.string(),
      productId: z.string(),
      title: z.string().nullable(),
      url: z.string().nullable(),
      createdAt: z.string(),
      repairLimit: z.number(),
      costUsd: z.number().nullable(),
      /** True for a PR follow-up run: it works on the pull request of an earlier run. */
      followsPullRequest: z.boolean(),
      /** True for a run from before the status history: its times come from the stage rows. */
      approximate: z.boolean(),
      statuses: z.array(statusChangeSchema),
      pullRequests: z.array(
        z.object({
          url: z.string(),
          repository: z.string(),
          state: z.enum(["open", "merged", "closed"]),
          openedAt: z.string(),
          closedAt: z.string().nullable(),
        }),
      ),
      deploys: z.array(z.object({ environment: z.string(), state: z.enum(["success", "failure"]), at: z.string() })),
    }),
  ),
  setups: z.array(
    z.object({ id: z.string(), productId: z.string(), repository: z.string(), approximate: z.boolean(), statuses: z.array(statusChangeSchema) }),
  ),
  pulses: z.array(
    z.object({
      runId: z.string().nullable(),
      setupId: z.string().nullable(),
      role: z.string(),
      toolKind: z.enum(TOOL_KINDS),
      lastOutputAt: z.string(),
      at: z.string(),
    }),
  ),
  throughput: z.array(z.object({ day: z.string(), arrived: z.number(), merged: z.number() })),
});

type FloorJson = z.infer<typeof floorSchema>;

const iso = (date: Date): string => date.toISOString();

const toJson = (floor: FloorData): FloorJson => ({
  generatedAt: iso(floor.generatedAt),
  from: iso(floor.from),
  to: iso(floor.to),
  lines: floor.lines,
  runs: floor.runs.map((run) => ({
    ...run,
    createdAt: iso(run.createdAt),
    statuses: run.statuses.map((change) => ({ status: change.status, at: iso(change.at) })),
    pullRequests: run.pullRequests.map((pr) => ({ ...pr, openedAt: iso(pr.openedAt), closedAt: pr.closedAt === null ? null : iso(pr.closedAt) })),
    deploys: run.deploys.map((deploy) => ({ ...deploy, at: iso(deploy.at) })),
  })),
  setups: floor.setups.map((setup) => ({ ...setup, statuses: setup.statuses.map((change) => ({ status: change.status, at: iso(change.at) })) })),
  pulses: floor.pulses.map((pulse) => ({ ...pulse, lastOutputAt: iso(pulse.lastOutputAt), at: iso(pulse.at) })),
  throughput: floor.throughput,
});

/**
 * docs/specs/factory-floor.md. The factory floor of a workspace, live or over a past window. Every
 * member of the workspace reads it, and the floor changes nothing.
 */
export const registerFloorRoutes = (app: FastifyInstance, dependencies: { tenants: TenantRegistry; floor: FloorReader }): void => {
  useSchemasAsDocumentation(app);

  app.get(
    "/admin/floor",
    {
      schema: {
        tags: TAGS,
        operationId: "getFloor",
        summary: "The live factory floor of a workspace",
        security: SESSION_SECURITY,
        querystring: schemaOf(liveQuerySchema),
        response: { 200: schemaOf(floorSchema), 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const query = liveQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      const tenant = await dependencies.tenants.findByWorkspace(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      return toJson(await dependencies.floor.live(tenant.id, new Date()));
    },
  );

  app.get(
    "/admin/floor/replay",
    {
      schema: {
        tags: TAGS,
        operationId: "getFloorReplay",
        summary: "The factory floor of a workspace over a past window of at most 7 days",
        security: SESSION_SECURITY,
        querystring: schemaOf(replayQuerySchema),
        response: { 200: schemaOf(floorSchema), 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const query = replayQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      const from = new Date(query.data.from);
      const to = new Date(query.data.to);
      if (to.getTime() <= from.getTime()) return reply.code(400).send({ error: "to must be after from" });
      if (to.getTime() - from.getTime() > MAX_REPLAY_MS) return reply.code(400).send({ error: "a replay window is at most 7 days" });
      const tenant = await dependencies.tenants.findByWorkspace(query.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      return toJson(await dependencies.floor.replay(tenant.id, from, to));
    },
  );
};
