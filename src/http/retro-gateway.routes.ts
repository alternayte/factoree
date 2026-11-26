import type { FastifyInstance } from "fastify";
import { GatewayUnauthorizedError, type GatewayRequest, type RetroGateway } from "~/domain/retro/retro-gateway.js";
import { GATEWAY_PATH } from "~/domain/retro/web-research.js";

/**
 * docs/specs/retro-web-research.md. The retro gateway over the MCP Streamable HTTP transport: a
 * POST carries one JSON-RPC message, or a batch, and gets JSON back. The server opens no stream,
 * so a GET answers 405, as the transport allows. The bearer token is the only credential, and it
 * reaches no log line. The route is outside the admin guard and outside the OpenAPI document.
 */
export const registerRetroGatewayRoutes = (app: FastifyInstance, gateway: Pick<RetroGateway, "authorize" | "handle">): void => {
  app.post(GATEWAY_PATH, { schema: { hide: true } }, async (request, reply) => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (token === "") return reply.code(401).send({ error: "the retro gateway needs a bearer token" });
    let session;
    try {
      session = await gateway.authorize(token);
    } catch (error) {
      if (error instanceof GatewayUnauthorizedError) return reply.code(401).send({ error: error.message });
      throw error;
    }
    const body = request.body;
    const messages = Array.isArray(body) ? (body as GatewayRequest[]) : [body as GatewayRequest];
    if (messages.length === 0 || messages.length > 20) return reply.code(400).send({ error: "send one JSON-RPC message, or a batch of at most 20" });
    const answers = [];
    for (const message of messages) {
      const answer = await gateway.handle(session, message !== null && typeof message === "object" ? message : {});
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) return reply.code(202).send();
    return reply.header("content-type", "application/json").send(Array.isArray(body) ? answers : answers[0]);
  });

  app.get(GATEWAY_PATH, { schema: { hide: true } }, (_request, reply) => reply.code(405).header("allow", "POST").send());
  app.delete(GATEWAY_PATH, { schema: { hide: true } }, (_request, reply) => reply.code(405).header("allow", "POST").send());
};
