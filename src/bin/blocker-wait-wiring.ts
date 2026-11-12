import type { Client } from "@temporalio/client";
import { createLinearAgentClient } from "~/adapters/linear/linear-agent-client.js";
import { createLinearBlockerReader } from "~/adapters/linear/linear-blockers.js";
import { BlockerWait } from "~/domain/runs/blocker-wait.js";
import { PrismaWaitingRunStore } from "~/persistence/prisma/waiting-run.prisma.js";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { createReleasedRunStarter } from "~/temporal/connection.js";
import type { Logger } from "~/telemetry/logger.js";

/**
 * docs/specs/blocked-by-wait.md, DI-21.89. The API and the worker build the same blocker wait: the
 * API holds a delegation, stops or answers a waiting run and sweeps a tenant after a merge, and the
 * worker sweeps every minute. Both start a released run through the same idempotent start.
 */
export const createBlockerWait = (input: {
  prisma: FactoreePrismaClient;
  /** The Linear access token of a workspace. */
  linearToken: (workspaceId: string) => Promise<string>;
  client: Client;
  taskQueue: string;
  logger: Logger;
}): BlockerWait => {
  const tokenOfTenant = async (tenantId: string): Promise<string> => {
    const tenant = await input.prisma.tenant.findUnique({ where: { id: tenantId }, select: { linearWorkspaceId: true } });
    if (tenant === null) throw new Error(`no tenant ${tenantId} for the blockers`);
    return await input.linearToken(tenant.linearWorkspaceId);
  };
  return new BlockerWait({
    store: new PrismaWaitingRunStore(input.prisma),
    reader: async (tenantId) => createLinearBlockerReader(await tokenOfTenant(tenantId)),
    start: createReleasedRunStarter(input.client, input.taskQueue),
    post: async (tenantId, sessionId, kind, body) => {
      const linear = createLinearAgentClient(await tokenOfTenant(tenantId));
      if (kind === "elicitation") await linear.elicit(sessionId, body);
      else await linear.respond(sessionId, body);
    },
    logger: input.logger,
  });
};
