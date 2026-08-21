import type { FastifyInstance } from "fastify";
import { verifyLinearSignature } from "~/adapters/linear/webhook-verifier.js";
import { agentSessionEventSchema } from "~/adapters/linear/webhook-schemas.js";
import type { DelegationService } from "~/domain/runs/delegation-service.js";
import type { Logger } from "~/telemetry/logger.js";

export const registerLinearWebhookRoutes = (
  app: FastifyInstance,
  dependencies: { secret: string; delegation: DelegationService; logger: Logger },
): void => {
  app.post("/webhooks/linear", { config: { rawBody: true } }, async (request, reply) => {
    const rawBody = request.rawBody ?? Buffer.from(JSON.stringify(request.body ?? {}), "utf8");
    const parsedBody = request.body as { webhookTimestamp?: number; webhookId?: string } | undefined;

    const verified = verifyLinearSignature({
      rawBody,
      signature: request.headers["linear-signature"] as string | undefined,
      secret: dependencies.secret,
      ...(parsedBody?.webhookTimestamp === undefined ? {} : { timestampMs: parsedBody.webhookTimestamp }),
    });
    if (!verified.ok) {
      dependencies.logger.warn("rejected Linear webhook", { step: "receive", reason: verified.reason });
      return reply.code(401).send({ error: verified.reason });
    }

    const parsed = agentSessionEventSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(202).send({ status: "ignored", reason: "unsupported payload" });

    const deliveryId =
      (request.headers["linear-delivery"] as string | undefined) ??
      parsedBody?.webhookId ??
      `${parsed.data.agentSession.id}:${parsed.data.action}:${parsedBody?.webhookTimestamp ?? 0}`;

    const outcome = await dependencies.delegation.handleAgentSessionEvent(parsed.data, deliveryId);
    return reply.code(202).send(outcome);
  });
};
