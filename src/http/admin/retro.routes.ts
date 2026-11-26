import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { McpToolPort } from "~/adapters/mcp/mcp-json-rpc-client.js";
import type { LinearIssueCreator } from "~/adapters/linear/linear-issues.js";
import { AGENT_RUNNERS } from "~/domain/products/agent-settings.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import { findingIssueText, RETRO_FINDING_KINDS, RETRO_FINDING_STATUSES } from "~/domain/retro/retro-finding.js";
import { FIRST_RETRO_WINDOW_MS } from "~/domain/retro/retro-export.js";
import { RETRO_SCHEDULES, retroSettingsInputSchema, retroSettingsProblems, type RetroSettings } from "~/domain/retro/retro-settings.js";
import { fetchSignals } from "~/domain/retro/signal-fetch.js";
import { SIGNAL_SOURCE_KINDS, signalSourceInputSchema, type SignalSourceRecord } from "~/domain/retro/signal-source.js";
import type { PrismaRetroSettingsStore, PrismaRetroStore, PrismaSignalSourceStore, RetroRecord } from "~/persistence/prisma/retro.prisma.js";
import type { RetroScheduler } from "~/temporal/retro-schedule.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { Logger } from "~/telemetry/logger.js";
import { principalOf } from "../auth/admin-guard.js";
import { errorSchema, schemaOf, SESSION_SECURITY, useSchemasAsDocumentation } from "../openapi.js";

const TAGS = ["retro"];

const workspaceQuerySchema = z.object({ linearWorkspaceId: z.string().min(1) });
const workspaceQuery = schemaOf(workspaceQuerySchema);
const idParams = schemaOf(z.object({ id: z.string() }));

const retroSettingsSchema = z.object({
  schedule: z.enum(RETRO_SCHEDULES),
  weekday: z.number(),
  hour: z.number(),
  timeZone: z.string(),
  productIds: z.array(z.string()),
  runner: z.enum(AGENT_RUNNERS).nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  costCapUsd: z.number(),
});

const retroSummarySchema = z.object({
  id: z.string(),
  trigger: z.string(),
  status: z.enum(["running", "succeeded", "failed"]),
  windowStart: z.string().nullable(),
  windowEnd: z.string(),
  promptVersion: z.string(),
  costUsd: z.number().nullable(),
  findingCount: z.number(),
  failureMessage: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});

const settingsViewSchema = z.object({
  settings: retroSettingsSchema,
  /** True when the workspace saved its retro settings at least once. False shows the defaults. */
  saved: z.boolean(),
  /** The next retro time the Temporal Schedule holds, or null when it is off or unknown. */
  nextRunAt: z.string().nullable(),
  /** Why the schedule could not be read or saved, or null. */
  scheduleError: z.string().nullable(),
  running: retroSummarySchema.nullable(),
  last: retroSummarySchema.nullable(),
});

const metricsSchema = z.object({
  runs: z.number(),
  firstPassRate: z.number().nullable(),
  repairsPerRun: z.number().nullable(),
  hungSessions: z.number(),
  costPerRun: z.number().nullable(),
});

const findingSchema = z.object({
  id: z.string(),
  retroId: z.string(),
  productId: z.string(),
  productName: z.string(),
  kind: z.enum(RETRO_FINDING_KINDS),
  title: z.string(),
  description: z.string(),
  runIds: z.array(z.string()),
  signalResultIds: z.array(z.string()),
  repositories: z.array(z.string()),
  status: z.enum(RETRO_FINDING_STATUSES),
  duplicateOfId: z.string().nullable(),
  /** The retro of the finding that this one repeats, or null. */
  duplicateOfRetroId: z.string().nullable(),
  linearIssueIdentifier: z.string().nullable(),
  linearIssueUrl: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});

const retroDetailSchema = retroSummarySchema.extend({
  events: z.array(z.object({ kind: z.string(), productId: z.string().nullable(), message: z.string(), at: z.string().nullable() })),
  sessions: z.array(
    z.object({
      productId: z.string(),
      productName: z.string(),
      status: z.string(),
      runCount: z.number(),
      runner: z.string().nullable(),
      model: z.string().nullable(),
      effort: z.string().nullable(),
      outcome: z.string().nullable(),
      costUsd: z.number().nullable(),
      durationMs: z.number().nullable(),
      metrics: metricsSchema.nullable(),
      failureMessage: z.string().nullable(),
    }),
  ),
  findings: z.array(findingSchema),
  signalResults: z.array(
    z.object({ id: z.string(), productId: z.string(), sourceName: z.string(), sourceKind: z.enum(SIGNAL_SOURCE_KINDS), queryName: z.string(), bytes: z.number() }),
  ),
});

const signalResultSchema = z.object({
  id: z.string(),
  retroId: z.string(),
  productId: z.string(),
  sourceName: z.string(),
  sourceKind: z.enum(SIGNAL_SOURCE_KINDS),
  queryName: z.string(),
  content: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  createdAt: z.string(),
});

const signalSourceSchema = z.object({
  id: z.string(),
  productId: z.string(),
  name: z.string(),
  kind: z.enum(SIGNAL_SOURCE_KINDS),
  endpoint: z.string(),
  secretName: z.string().nullable(),
  enabled: z.boolean(),
  queries: z.array(z.object({ name: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()), maxBytes: z.number() })),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const signalTestSchema = z.object({
  results: z.array(z.object({ queryName: z.string(), ok: z.boolean(), bytes: z.number().nullable(), preview: z.string().nullable(), reason: z.string().nullable() })),
});

const RETRO_PAGE_SIZE = 25;
const listRetrosQuerySchema = z.object({ linearWorkspaceId: z.string().min(1), cursor: z.string().min(1).optional() });

const workspaceBodySchema = z.object({ linearWorkspaceId: z.string().min(1) }).strict();
const settingsBodySchema = retroSettingsInputSchema.extend({ linearWorkspaceId: z.string().min(1) }).strict();
const signalBodySchema = signalSourceInputSchema.extend({ linearWorkspaceId: z.string().min(1) }).strict();

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const toSummary = (retro: RetroRecord) => ({
  id: retro.id,
  trigger: retro.trigger,
  status: retro.status,
  windowStart: iso(retro.windowStart),
  windowEnd: retro.windowEnd.toISOString(),
  promptVersion: retro.promptVersion,
  costUsd: retro.costUsd,
  findingCount: retro.findingCount,
  failureMessage: retro.failureMessage,
  startedAt: retro.startedAt.toISOString(),
  endedAt: iso(retro.endedAt),
});

const toSignalSource = (source: SignalSourceRecord) => ({
  id: source.id,
  productId: source.productId,
  name: source.name,
  kind: source.kind,
  endpoint: source.endpoint,
  secretName: source.secretName,
  enabled: source.enabled,
  queries: source.queries,
  createdAt: source.createdAt.toISOString(),
  updatedAt: source.updatedAt.toISOString(),
});

const TEMPORAL_UNREACHABLE = "Schedule not saved: Temporal is unreachable";

export interface RetroRouteDependencies {
  tenants: TenantRegistry;
  products: Pick<ProductRegistry, "findById" | "list">;
  secrets: Pick<SecretStore, "get">;
  retroSettings: Pick<PrismaRetroSettingsStore, "read" | "write" | "saved">;
  retros: PrismaRetroStore;
  signalSources: PrismaSignalSourceStore;
  /** Null on a server with no Temporal client: the schedule and Run now answer 503. */
  scheduler: RetroScheduler | null;
  linearIssues: (tenantId: string) => Promise<Pick<LinearIssueCreator, "createIssue">>;
  mcpTools: (endpoint: string, token: string | null) => McpToolPort;
  redactor: Pick<Redactor, "redactText">;
  publicUrl: string;
  userName: (userId: string) => Promise<string | null>;
  logger: Logger;
}

/** docs/specs/retro-agent.md. The retro settings, the Retro page, the findings and the signal sources. */
export const registerRetroRoutes = (app: FastifyInstance, dependencies: RetroRouteDependencies): void => {
  useSchemasAsDocumentation(app);
  const base = dependencies.publicUrl.replace(/\/+$/, "");

  const tenantOf = async (linearWorkspaceId: unknown) =>
    typeof linearWorkspaceId === "string" && linearWorkspaceId !== "" ? dependencies.tenants.findByWorkspace(linearWorkspaceId) : null;

  const settingsView = async (tenantId: string, settings: RetroSettings, scheduleError: string | null) => {
    let nextRunAt: string | null = null;
    let error = scheduleError;
    if (dependencies.scheduler !== null && settings.schedule !== "off") {
      try {
        nextRunAt = iso(await dependencies.scheduler.nextRun(tenantId));
      } catch {
        error ??= "The schedule could not be read: Temporal is unreachable";
      }
    }
    const [running, last, saved] = await Promise.all([
      dependencies.retros.running(tenantId),
      dependencies.retros.latest(tenantId),
      dependencies.retroSettings.saved(tenantId),
    ]);
    return {
      settings: {
        schedule: settings.schedule,
        weekday: settings.weekday,
        hour: settings.hour,
        timeZone: settings.timeZone,
        productIds: settings.productIds,
        runner: settings.runner,
        model: settings.model,
        effort: settings.effort,
        costCapUsd: settings.costCapUsd,
      },
      saved,
      nextRunAt,
      scheduleError: error,
      running: running === null ? null : toSummary(running),
      last: last === null ? null : toSummary(last),
    };
  };

  const reconcile = async (settings: RetroSettings): Promise<string | null> => {
    if (dependencies.scheduler === null) return settings.schedule === "off" ? null : TEMPORAL_UNREACHABLE;
    try {
      await dependencies.scheduler.reconcile(settings);
      return null;
    } catch (error) {
      dependencies.logger.warn("the retro schedule was not saved", { tenant_id: settings.tenantId, error: String(error) });
      return TEMPORAL_UNREACHABLE;
    }
  };

  app.get<{ Querystring: { linearWorkspaceId: string } }>(
    "/admin/retro/settings",
    { schema: { tags: TAGS, operationId: "getRetroSettings", security: SESSION_SECURITY, querystring: workspaceQuery, response: { 200: schemaOf(settingsViewSchema), 404: errorSchema } } },
    async (request, reply) => {
      const tenant = await tenantOf(request.query.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      return reply.send(await settingsView(tenant.id, await dependencies.retroSettings.read(tenant.id), null));
    },
  );

  app.put(
    "/admin/retro/settings",
    {
      schema: {
        tags: TAGS,
        operationId: "putRetroSettings",
        security: SESSION_SECURITY,
        body: schemaOf(settingsBodySchema),
        response: { 200: schemaOf(settingsViewSchema), 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const body = settingsBodySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const { linearWorkspaceId, ...input } = body.data;
      const tenant = await tenantOf(linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const problems = retroSettingsProblems(input);
      if (Object.keys(problems).length > 0) return reply.code(400).send({ error: { fieldErrors: problems } });
      const products = new Set((await dependencies.products.list(tenant.id)).map((product) => product.id));
      const unknown = input.productIds.find((id) => !products.has(id));
      if (unknown !== undefined) return reply.code(400).send({ error: `the product ${unknown} is not a product of this workspace` });
      // The stored settings are the truth: they save even when Temporal cannot take the schedule.
      const settings = await dependencies.retroSettings.write(tenant.id, input);
      return reply.send(await settingsView(tenant.id, settings, await reconcile(settings)));
    },
  );

  app.post(
    "/admin/retro/settings/schedule",
    {
      schema: {
        tags: TAGS,
        operationId: "retryRetroSchedule",
        summary: "Saves the Temporal Schedule from the stored retro settings again",
        security: SESSION_SECURITY,
        body: schemaOf(workspaceBodySchema),
        response: { 200: schemaOf(settingsViewSchema), 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const body = workspaceBodySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const tenant = await tenantOf(body.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const settings = await dependencies.retroSettings.read(tenant.id);
      return reply.send(await settingsView(tenant.id, settings, await reconcile(settings)));
    },
  );

  app.post(
    "/admin/retro/run",
    {
      schema: {
        tags: TAGS,
        operationId: "runRetroNow",
        security: SESSION_SECURITY,
        body: schemaOf(workspaceBodySchema),
        response: { 202: schemaOf(z.object({ workflowId: z.string() })), 400: errorSchema, 404: errorSchema, 409: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      const body = workspaceBodySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const tenant = await tenantOf(body.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      if ((await dependencies.retros.running(tenant.id)) !== null) return reply.code(409).send({ error: "A retro is running" });
      if (dependencies.scheduler === null) return reply.code(503).send({ error: "Temporal is unreachable" });
      try {
        const started = await dependencies.scheduler.startNow(tenant.id, new Date());
        if (!started.started) return reply.code(409).send({ error: "A retro is running" });
        return reply.code(202).send({ workflowId: started.workflowId });
      } catch (error) {
        dependencies.logger.warn("the retro did not start", { tenant_id: tenant.id, error: String(error) });
        return reply.code(503).send({ error: "Temporal is unreachable" });
      }
    },
  );

  app.get<{ Querystring: { linearWorkspaceId: string; cursor?: string } }>(
    "/admin/retros",
    {
      schema: {
        tags: TAGS,
        operationId: "listRetros",
        security: SESSION_SECURITY,
        querystring: schemaOf(listRetrosQuerySchema),
        response: {
          200: schemaOf(z.object({ retros: z.array(retroSummarySchema), nextCursor: z.string().nullable() })),
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await tenantOf(request.query.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const page = await dependencies.retros.list(tenant.id, RETRO_PAGE_SIZE, request.query.cursor);
      return reply.send({ retros: page.items.map(toSummary), nextCursor: page.nextCursor });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { linearWorkspaceId: string } }>(
    "/admin/retros/:id",
    {
      schema: { tags: TAGS, operationId: "getRetro", security: SESSION_SECURITY, params: idParams, querystring: workspaceQuery, response: { 200: schemaOf(retroDetailSchema), 404: errorSchema } },
    },
    async (request, reply) => {
      const tenant = await tenantOf(request.query.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const retro = await dependencies.retros.detail(tenant.id, request.params.id);
      if (!retro) return reply.code(404).send({ error: "retro not found" });
      return reply.send({
        ...toSummary(retro),
        events: retro.events,
        sessions: retro.sessions,
        findings: retro.findings.map((finding) => ({ ...finding, decidedAt: iso(finding.decidedAt), createdAt: finding.createdAt.toISOString() })),
        signalResults: retro.signalResults,
      });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { linearWorkspaceId: string } }>(
    "/admin/retro/signal-results/:id",
    {
      schema: { tags: TAGS, operationId: "getSignalResult", security: SESSION_SECURITY, params: idParams, querystring: workspaceQuery, response: { 200: schemaOf(signalResultSchema), 404: errorSchema } },
    },
    async (request, reply) => {
      const tenant = await tenantOf(request.query.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const result = await dependencies.retros.signalResult(tenant.id, request.params.id);
      if (!result) return reply.code(404).send({ error: "signal result not found" });
      return reply.send({
        id: result.id,
        retroId: result.retroId,
        productId: result.productId,
        sourceName: result.sourceName,
        sourceKind: result.sourceKind === "analytics" ? "analytics" : "errors",
        queryName: result.queryName,
        content: result.content,
        sha256: result.sha256,
        bytes: result.bytes,
        createdAt: result.createdAt.toISOString(),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/retro/findings/:id/issue",
    {
      schema: {
        tags: TAGS,
        operationId: "createRetroFindingIssue",
        summary: "Creates the Linear issue of a finding. A factory or error finding is delegated to Factoree, an idea finding is not.",
        security: SESSION_SECURITY,
        params: idParams,
        body: schemaOf(workspaceBodySchema),
        response: { 201: schemaOf(findingSchema), 400: errorSchema, 404: errorSchema, 409: errorSchema, 502: errorSchema },
      },
    },
    async (request, reply) => {
      const body = workspaceBodySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const tenant = await tenantOf(body.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const finding = await dependencies.retros.finding(tenant.id, request.params.id);
      if (!finding) return reply.code(404).send({ error: "finding not found" });
      if (finding.status !== "proposed") return reply.code(409).send({ error: `the finding is ${finding.status.replace("_", " ")}` });
      const product = await dependencies.products.findById(tenant.id, finding.productId);
      if (!product) return reply.code(404).send({ error: "product not found" });
      const text = findingIssueText(finding, {
        runUrl: (runId) => `${base}/runs/${runId}`,
        signalResultUrl: (id) => `${base}/retro/signal-results/${id}`,
        retroUrl: `${base}/retro/${finding.retroId}`,
      });
      let issue;
      try {
        // An idea is a product decision: a human edits and delegates the issue.
        issue = await (await dependencies.linearIssues(tenant.id)).createIssue({ teamId: product.linearTeamId, ...text, delegate: finding.kind !== "idea" });
      } catch (error) {
        dependencies.logger.warn("the retro finding issue was not created", { finding_id: finding.id, error: String(error) });
        return reply.code(502).send({ error: dependencies.redactor.redactText(error instanceof Error ? error.message : String(error)) });
      }
      const by = (await dependencies.userName(principalOf(request).userId)) ?? "an admin";
      if (!(await dependencies.retros.markCreated(tenant.id, finding.id, issue, by))) return reply.code(409).send({ error: "another request decided the finding first" });
      const updated = (await dependencies.retros.finding(tenant.id, finding.id))!;
      return reply.code(201).send({ ...updated, decidedAt: iso(updated.decidedAt), createdAt: updated.createdAt.toISOString() });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/retro/findings/:id/dismiss",
    {
      schema: {
        tags: TAGS,
        operationId: "dismissRetroFinding",
        security: SESSION_SECURITY,
        params: idParams,
        body: schemaOf(workspaceBodySchema),
        response: { 200: schemaOf(findingSchema), 400: errorSchema, 404: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      const body = workspaceBodySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const tenant = await tenantOf(body.data.linearWorkspaceId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      const by = (await dependencies.userName(principalOf(request).userId)) ?? "an admin";
      if (!(await dependencies.retros.dismiss(tenant.id, request.params.id, by))) return reply.code(409).send({ error: "the finding is not proposed" });
      const finding = (await dependencies.retros.finding(tenant.id, request.params.id))!;
      return reply.send({ ...finding, decidedAt: iso(finding.decidedAt), createdAt: finding.createdAt.toISOString() });
    },
  );

  // Signal sources of a product.
  const productOf = async (linearWorkspaceId: unknown, productId: string) => {
    const tenant = await tenantOf(linearWorkspaceId);
    if (!tenant) return null;
    const product = await dependencies.products.findById(tenant.id, productId);
    return product === null ? null : { tenant, product };
  };

  app.get<{ Params: { id: string }; Querystring: { linearWorkspaceId: string } }>(
    "/admin/products/:id/signal-sources",
    {
      schema: {
        tags: TAGS,
        operationId: "listSignalSources",
        security: SESSION_SECURITY,
        params: idParams,
        querystring: workspaceQuery,
        response: { 200: schemaOf(z.object({ sources: z.array(signalSourceSchema) })), 404: errorSchema },
      },
    },
    async (request, reply) => {
      const found = await productOf(request.query.linearWorkspaceId, request.params.id);
      if (!found) return reply.code(404).send({ error: "product not found" });
      return reply.send({ sources: (await dependencies.signalSources.list(found.tenant.id, found.product.id)).map(toSignalSource) });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/products/:id/signal-sources",
    {
      schema: {
        tags: TAGS,
        operationId: "createSignalSource",
        security: SESSION_SECURITY,
        params: idParams,
        body: schemaOf(signalBodySchema),
        response: { 201: schemaOf(signalSourceSchema), 400: errorSchema, 404: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      const body = signalBodySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const { linearWorkspaceId, ...input } = body.data;
      const found = await productOf(linearWorkspaceId, request.params.id);
      if (!found) return reply.code(404).send({ error: "product not found" });
      const existing = await dependencies.signalSources.list(found.tenant.id, found.product.id);
      if (existing.some((source) => source.name === input.name)) return reply.code(409).send({ error: `the product already has a signal source named ${input.name}` });
      return reply.code(201).send(toSignalSource(await dependencies.signalSources.create(found.tenant.id, found.product.id, input)));
    },
  );

  app.put<{ Params: { id: string; sourceId: string } }>(
    "/admin/products/:id/signal-sources/:sourceId",
    {
      schema: {
        tags: TAGS,
        operationId: "updateSignalSource",
        security: SESSION_SECURITY,
        params: schemaOf(z.object({ id: z.string(), sourceId: z.string() })),
        body: schemaOf(signalBodySchema),
        response: { 200: schemaOf(signalSourceSchema), 400: errorSchema, 404: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      const body = signalBodySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const { linearWorkspaceId, ...input } = body.data;
      const found = await productOf(linearWorkspaceId, request.params.id);
      if (!found) return reply.code(404).send({ error: "product not found" });
      const existing = await dependencies.signalSources.list(found.tenant.id, found.product.id);
      if (existing.some((source) => source.name === input.name && source.id !== request.params.sourceId)) {
        return reply.code(409).send({ error: `the product already has a signal source named ${input.name}` });
      }
      const updated = await dependencies.signalSources.update(found.tenant.id, found.product.id, request.params.sourceId, input);
      if (!updated) return reply.code(404).send({ error: "signal source not found" });
      return reply.send(toSignalSource(updated));
    },
  );

  app.delete<{ Params: { id: string; sourceId: string }; Querystring: { linearWorkspaceId: string } }>(
    "/admin/products/:id/signal-sources/:sourceId",
    {
      schema: {
        tags: TAGS,
        operationId: "deleteSignalSource",
        security: SESSION_SECURITY,
        params: schemaOf(z.object({ id: z.string(), sourceId: z.string() })),
        querystring: workspaceQuery,
        response: { 204: schemaOf(z.null()), 404: errorSchema },
      },
    },
    async (request, reply) => {
      const found = await productOf(request.query.linearWorkspaceId, request.params.id);
      if (!found) return reply.code(404).send({ error: "product not found" });
      if (!(await dependencies.signalSources.remove(found.tenant.id, found.product.id, request.params.sourceId))) return reply.code(404).send({ error: "signal source not found" });
      return reply.code(204).send(null);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/products/:id/signal-sources/test",
    {
      schema: {
        tags: TAGS,
        operationId: "testSignalSource",
        summary: "Runs each query of an unsaved signal source and shows its size and its first 500 characters",
        security: SESSION_SECURITY,
        params: idParams,
        body: schemaOf(signalBodySchema),
        response: { 200: schemaOf(signalTestSchema), 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const body = signalBodySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const { linearWorkspaceId, ...input } = body.data;
      const found = await productOf(linearWorkspaceId, request.params.id);
      if (!found) return reply.code(404).send({ error: "product not found" });
      const now = new Date();
      const source: SignalSourceRecord = { ...input, enabled: true, id: "test", tenantId: found.tenant.id, productId: found.product.id, createdAt: now, updatedAt: now };
      const since = (await dependencies.retros.lastSuccessful(found.tenant.id))?.windowEnd ?? new Date(now.getTime() - FIRST_RETRO_WINDOW_MS);
      // The token never reaches the answer, even when the server echoes it.
      const local = new Redactor([]);
      const fetched = await fetchSignals([source], since, {
        tools: dependencies.mcpTools,
        token: async (name) => {
          const value = await dependencies.secrets.get(found.tenant.id, found.product.id, name);
          if (value !== null) local.addSecret(value);
          return value;
        },
        redactor: { redactText: (text) => dependencies.redactor.redactText(local.redactText(text)) },
      });
      return reply.send({
        results: input.queries.map((query) => {
          const result = fetched.results.find((entry) => entry.queryName === query.name);
          if (result !== undefined) return { queryName: query.name, ok: true, bytes: result.bytes, preview: result.content.slice(0, 500), reason: null };
          const skipped = fetched.skipped.find((entry) => entry.queryName === query.name);
          return { queryName: query.name, ok: false, bytes: null, preview: null, reason: skipped?.reason ?? "no result" };
        }),
      });
    },
  );
};
