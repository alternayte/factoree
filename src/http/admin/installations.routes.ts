import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TenantRegistry } from "~/domain/projects/project-registry.js";

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
};
