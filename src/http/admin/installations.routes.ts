import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";

const gitHubInstallationSchema = z
  .object({
    linearWorkspaceId: z.string().min(1),
    githubInstallationId: z.string().min(1),
    // Stored for display only. A route must never resolve a tenant by this value. An account
    // rename never breaks the binding, because the numeric installation id is the key.
    accountLogin: z.string().min(1),
  })
  .strict();

const schema = z.object({
  linearWorkspaceId: z.string().min(1),
  workspaceName: z.string().min(1),
  appUserId: z.string().min(1).optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  scopes: z.array(z.string()).default([]),
  /**
   * The lifetime Linear returned with the token, in seconds. A Linear access token lives for
   * twenty-four hours, and the worker refreshes it shortly before this moment. Without the value
   * the token is treated as unexpiring, and only a rejected call triggers a refresh.
   */
  expiresIn: z.number().int().positive().optional(),
});

export const registerInstallationRoutes = (
  app: FastifyInstance,
  dependencies: { tenants: TenantRegistry },
): void => {
  app.put("/admin/linear-installations", async (request, reply) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await dependencies.tenants.putInstallation({
      linearWorkspaceId: parsed.data.linearWorkspaceId,
      workspaceName: parsed.data.workspaceName,
      accessToken: parsed.data.accessToken,
      scopes: parsed.data.scopes,
      ...(parsed.data.expiresIn === undefined
        ? {}
        : { expiresAt: new Date(Date.now() + parsed.data.expiresIn * 1_000) }),
      ...(parsed.data.appUserId === undefined ? {} : { appUserId: parsed.data.appUserId }),
      ...(parsed.data.refreshToken === undefined ? {} : { refreshToken: parsed.data.refreshToken }),
    });
    return reply.code(200).send({ tenantId: tenant.id, linearWorkspaceId: tenant.linearWorkspaceId });
  });

  // This route binds a GitHub App installation to a tenant, by the numeric installation id GitHub
  // sends. It never resolves anything from the account login, and it never moves an installation
  // that another tenant holds.
  app.put("/admin/github-installations", async (request, reply) => {
    const parsed = gitHubInstallationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const tenant = await dependencies.tenants.findByWorkspace(parsed.data.linearWorkspaceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    const outcome = await dependencies.tenants.putGitHubInstallation(
      tenant.id,
      parsed.data.githubInstallationId,
      parsed.data.accountLogin,
    );
    if (outcome === "held_by_another_tenant") {
      return reply.code(409).send({ error: "the installation is bound to another tenant" });
    }
    return reply.code(200).send({ tenantId: tenant.id, githubInstallationId: parsed.data.githubInstallationId });
  });
};
