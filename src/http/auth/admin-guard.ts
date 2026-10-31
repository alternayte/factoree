import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import type { InstallSettingsStore } from "~/domain/settings/install-settings.js";
import type { Logger } from "~/telemetry/logger.js";
import type { AuthHandle } from "./auth.js";
import { principalFor, type Membership, type Principal } from "./membership.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AdminGuardDependencies {
  auth: AuthHandle;
  prisma: FactoreePrismaClient;
  settings: InstallSettingsStore;
  logger: Logger;
}

const bearerOf = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") && header.length > 7 ? header.slice(7) : null;
};

/**
 * docs/specs/release-0-1-0.md. The person behind an administration call: a better-auth API key
 * sent as `Authorization: Bearer`, or the session cookie of a Linear sign-in. A revoked or
 * expired key, and a session that ended, give null.
 */
export const resolvePrincipal = async (
  dependencies: AdminGuardDependencies,
  request: FastifyRequest,
): Promise<Principal | null> => {
  const auth = await dependencies.auth.current();
  const { operatorTenantId } = await dependencies.settings.read();
  const bearer = bearerOf(request);
  if (bearer !== null) {
    const verified = await auth.api.verifyApiKey({ body: { key: bearer } });
    if (!verified.valid || verified.key === null) return null;
    return principalFor(dependencies.prisma, verified.key.referenceId, verified.key.id, operatorTenantId);
  }
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (session === null) return null;
  return principalFor(dependencies.prisma, session.user.id, null, operatorTenantId);
};

/** The Linear workspace an administration call names, in its query or its body. */
const workspaceOf = (request: FastifyRequest): string | undefined => {
  const fromQuery = (request.query as { linearWorkspaceId?: unknown } | undefined)?.linearWorkspaceId;
  if (typeof fromQuery === "string") return fromQuery;
  const fromBody = (request.body as { linearWorkspaceId?: unknown } | undefined)?.linearWorkspaceId;
  return typeof fromBody === "string" ? fromBody : undefined;
};

const isRead = (request: FastifyRequest): boolean => request.method === "GET" || request.method === "HEAD";

/**
 * A member of a workspace reads its records. Only a Linear admin of the workspace changes them.
 * A call that names no workspace changes nothing unless the caller is an admin somewhere, and a
 * route with a narrower rule checks it itself.
 */
export const authorize = (principal: Principal, request: FastifyRequest): { status: 403; error: string } | null => {
  const workspace = workspaceOf(request);
  if (workspace !== undefined) {
    const membership: Membership | undefined = principal.memberships.find(
      (candidate) => candidate.linearWorkspaceId === workspace,
    );
    if (membership === undefined) return { status: 403, error: "not a member of this Linear workspace" };
    if (!isRead(request) && !membership.admin) return { status: 403, error: "a Linear workspace admin must make this change" };
    return null;
  }
  if (!isRead(request) && !principal.memberships.some((membership) => membership.admin)) {
    return { status: 403, error: "a Linear workspace admin must make this change" };
  }
  return null;
};

/**
 * Guards every route of the scope it is registered in, and records every call with the user or
 * the API key that made it.
 */
export const registerAdminGuard = (app: FastifyInstance, dependencies: AdminGuardDependencies): void => {
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await resolvePrincipal(dependencies, request);
    if (principal === null) return reply.code(401).send({ error: "unauthorized" });
    request.principal = principal;
    const refusal = authorize(principal, request);
    if (refusal !== null) return reply.code(refusal.status).send({ error: refusal.error });
  });

  // onSend runs before the response leaves, so the entry exists when the caller reads the answer.
  app.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    try {
      await dependencies.prisma.adminAuditEntry.create({
        data: {
          userId: request.principal?.userId ?? null,
          apiKeyId: request.principal?.apiKeyId ?? null,
          method: request.method,
          path: request.routeOptions.url ?? request.url.split("?")[0] ?? request.url,
          statusCode: reply.statusCode,
        },
      });
    } catch (error) {
      dependencies.logger.error("the admin audit entry was not written", { error: String(error) });
    }
    return payload;
  });
};

/** The principal of a guarded route. The guard has set it, so its absence is a wiring fault. */
export const principalOf = (request: FastifyRequest): Principal => {
  if (request.principal === undefined) throw new Error("the admin guard did not run for this route");
  return request.principal;
};
