import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

/** docs/specs/release-0-1-0.md. The UI loads nothing from another origin and injects no inline code. */
export const CONTENT_SECURITY_POLICY = "default-src 'self'";

/** Paths the API owns. A miss under one of them is a 404, never the UI shell. */
const API_PREFIXES = ["/api/", "/admin/", "/webhooks/", "/documentation", "/temporal"];

/** docs/specs/run-visibility.md. The proxied Temporal UI sends its own headers and inline scripts. */
const isTemporalUi = (url: string): boolean => url === "/temporal" || url.startsWith("/temporal/") || url.startsWith("/temporal?");

/**
 * Serves the Vite build of `ui/` from the API origin, so one image and one port carry both. A
 * browser path the API does not own gets `index.html`, and the client router takes it from there.
 */
export const registerUi = (app: FastifyInstance, root: string): boolean => {
  app.addHook("onSend", async (request, reply, payload) => {
    if (isTemporalUi(request.url)) return payload;
    reply.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    return payload;
  });
  if (!existsSync(join(root, "index.html"))) return false;
  void app.register(fastifyStatic, { root, wildcard: false, index: ["index.html"] });
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split("?")[0] ?? "/";
    if ((request.method !== "GET" && request.method !== "HEAD") || API_PREFIXES.some((prefix) => path.startsWith(prefix)) || path.includes(".")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.type("text/html").sendFile("index.html");
  });
  return true;
};
