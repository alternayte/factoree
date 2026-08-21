import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export const createAdminGuard = (token: string) => {
  const expected = Buffer.from(token, "utf8");
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization ?? "";
    const provided = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "", "utf8");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
};
