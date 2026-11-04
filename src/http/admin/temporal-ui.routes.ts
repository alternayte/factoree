import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyHttpProxy from "@fastify/http-proxy";
import { resolvePrincipal, type AdminGuardDependencies } from "../auth/admin-guard.js";

/** docs/specs/run-visibility.md. The path the Temporal UI is served under. */
export const TEMPORAL_UI_PATH = "/temporal";

/**
 * docs/specs/run-visibility.md. Proxies the Temporal UI, which the stack runs with no domain and
 * no published port. Only a signed-in Linear workspace admin reaches it. Every other caller gets
 * 404, so the path reveals nothing. The UI runs with TEMPORAL_DISABLE_WRITE_ACTIONS=true and
 * TEMPORAL_UI_PUBLIC_PATH=/temporal.
 */
export const registerTemporalUi = (
  app: FastifyInstance,
  dependencies: AdminGuardDependencies & { upstream: string | null },
): void => {
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not found" });
  if (dependencies.upstream === null) {
    app.all(TEMPORAL_UI_PATH, (_request, reply) => notFound(reply));
    app.all(`${TEMPORAL_UI_PATH}/*`, (_request, reply) => notFound(reply));
    return;
  }
  void app.register(async (scope) => {
    scope.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = await resolvePrincipal(dependencies, request).catch(() => null);
      if (principal === null || !principal.memberships.some((membership) => membership.admin)) {
        return notFound(reply);
      }
    });
    await scope.register(fastifyHttpProxy, {
      upstream: dependencies.upstream ?? "",
      prefix: TEMPORAL_UI_PATH,
      rewritePrefix: TEMPORAL_UI_PATH,
      // The Temporal UI is a read-only page. A write never passes the proxy.
      httpMethods: ["GET", "HEAD"],
      // A GET carries no body, and the API already parses JSON.
      proxyPayloads: false,
    });
  });
};
