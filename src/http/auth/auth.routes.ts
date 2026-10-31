import type { FastifyInstance } from "fastify";
import { AUTH_BASE_PATH, type AuthHandle } from "./auth.js";

/**
 * Mounts better-auth at /api/auth. Fastify parses a JSON body before the handler runs, so the
 * request better-auth reads is rebuilt from the exact bytes the client sent.
 */
export const registerAuthRoutes = (app: FastifyInstance, dependencies: { auth: AuthHandle; publicUrl: string }): void => {
  app.route({
    method: ["GET", "POST"],
    url: `${AUTH_BASE_PATH}/*`,
    handler: async (request, reply) => {
      const auth = await dependencies.auth.current();
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const response = await auth.handler(
        new Request(new URL(request.url, dependencies.publicUrl), {
          method: request.method,
          headers,
          ...(request.method === "POST" && request.rawBody !== undefined ? { body: new Uint8Array(request.rawBody) } : {}),
        }),
      );
      reply.status(response.status);
      response.headers.forEach((value, name) => {
        if (name.toLowerCase() !== "set-cookie") reply.header(name, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header("set-cookie", cookies);
      return reply.send(response.body === null ? null : Buffer.from(await response.arrayBuffer()));
    },
  });
};
