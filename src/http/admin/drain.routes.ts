import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DrainMode } from "~/domain/runs/drain-mode.js";
import { errorSchema, schemaOf, SESSION_SECURITY, useSchemasAsDocumentation } from "../openapi.js";
import { principalOf } from "../auth/admin-guard.js";

/** One open agent run, which a breaking release must wait for. */
export interface OpenRunView {
  workflowId: string;
  /** Null for a workflow with no run row. */
  runId: string | null;
  workItemTitle: string | null;
  workItemUrl: string | null;
  status: string | null;
  /** The release that started it, from its Temporal memo, or null for an older run. */
  release: string | null;
  createdAt: string | null;
}

export interface DrainRouteDependencies {
  drainMode: Pick<DrainMode, "state" | "turnOn" | "turnOff">;
  /** Every open agentRun workflow, with its run. */
  openRuns: () => Promise<OpenRunView[]>;
  /** The runs that wait as WAITING_FOR_UPDATE. */
  heldCount: () => Promise<number>;
}

const openRunSchema = z.object({
  workflowId: z.string(),
  runId: z.string().nullable(),
  workItemTitle: z.string().nullable(),
  workItemUrl: z.string().nullable(),
  status: z.string().nullable(),
  release: z.string().nullable(),
  createdAt: z.string().nullable(),
});

export const drainViewSchema = z.object({
  on: z.boolean(),
  startedAt: z.string().nullable(),
  startedBy: z.string().nullable(),
  /** The release that turned drain mode on. A worker of a newer release ends it at boot. */
  release: z.string().nullable(),
  heldCount: z.number().int(),
  /** Absent in the summary that every page reads for its banner. */
  openRuns: z.array(openRunSchema).optional(),
});

const drainUpdateSchema = z.object({ on: z.boolean() });

/**
 * docs/specs/drain-mode.md. Any admin reads whether drain mode is on, because every page shows a
 * banner while it is. Only an operator admin turns it on or off, and reads the open runs.
 */
export const registerDrainRoutes = (app: FastifyInstance, dependencies: DrainRouteDependencies): void => {
  useSchemasAsDocumentation(app);

  const view = async (withOpenRuns: boolean): Promise<z.infer<typeof drainViewSchema>> => {
    const state = await dependencies.drainMode.state();
    return {
      on: state !== null,
      startedAt: state?.startedAt.toISOString() ?? null,
      startedBy: state?.startedBy ?? null,
      release: state?.release ?? null,
      heldCount: await dependencies.heldCount(),
      ...(withOpenRuns ? { openRuns: await dependencies.openRuns() } : {}),
    };
  };

  app.get(
    "/admin/install/drain",
    {
      schema: {
        tags: ["install"],
        operationId: "getDrainMode",
        security: SESSION_SECURITY,
        response: { 200: schemaOf(drainViewSchema) },
      },
    },
    async (request) => view(principalOf(request).operatorAdmin),
  );

  app.put(
    "/admin/install/drain",
    {
      schema: {
        tags: ["install"],
        operationId: "setDrainMode",
        security: SESSION_SECURITY,
        body: schemaOf(drainUpdateSchema),
        response: { 200: schemaOf(drainViewSchema), 403: errorSchema, 422: errorSchema },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      if (!principal.operatorAdmin) {
        return reply.code(403).send({ error: "only a Linear admin of the setup workspace turns drain mode on or off" });
      }
      const body = drainUpdateSchema.safeParse(request.body);
      if (!body.success) return reply.code(422).send({ error: body.error.flatten() });
      if (body.data.on) await dependencies.drainMode.turnOn(principal.apiKeyId === null ? principal.userId : `api-key:${principal.apiKeyId}`);
      else await dependencies.drainMode.turnOff();
      return await view(true);
    },
  );
};
