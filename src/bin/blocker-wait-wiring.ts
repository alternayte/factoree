import type { Client } from "@temporalio/client";
import { createLinearAgentClient } from "~/adapters/linear/linear-agent-client.js";
import { createLinearBlockerReader } from "~/adapters/linear/linear-blockers.js";
import { BlockerWait } from "~/domain/runs/blocker-wait.js";
import { DrainMode } from "~/domain/runs/drain-mode.js";
import { PrismaDrainSettings } from "~/persistence/prisma/drain-settings.prisma.js";
import { FACTOREE_RELEASE } from "~/workflows/release.js";
import { PrismaWaitingRunStore } from "~/persistence/prisma/waiting-run.prisma.js";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { createReleasedRunStarter } from "~/temporal/connection.js";
import type { Logger } from "~/telemetry/logger.js";

/**
 * docs/specs/blocked-by-wait.md, DI-21.89, and docs/specs/drain-mode.md. The API and the worker build
 * the same blocker wait and drain mode: the API holds a delegation, stops or answers a waiting run and
 * sweeps a tenant after a merge, and the worker sweeps every minute. Both start a released run
 * through the same idempotent start.
 */
export const createRunWaits = (input: {
  prisma: FactoreePrismaClient;
  /** The Linear access token of a workspace. */
  linearToken: (workspaceId: string) => Promise<string>;
  client: Client;
  taskQueue: string;
  logger: Logger;
}): { blockerWait: BlockerWait; drainMode: DrainMode } => {
  const tokenOfTenant = async (tenantId: string): Promise<string> => {
    const tenant = await input.prisma.tenant.findUnique({ where: { id: tenantId }, select: { linearWorkspaceId: true } });
    if (tenant === null) throw new Error(`no tenant ${tenantId} for the blockers`);
    return await input.linearToken(tenant.linearWorkspaceId);
  };
  const store = new PrismaWaitingRunStore(input.prisma);
  const start = createReleasedRunStarter(input.client, input.taskQueue);
  const post = async (tenantId: string, sessionId: string, kind: "elicitation" | "response", body: string): Promise<void> => {
    const linear = createLinearAgentClient(await tokenOfTenant(tenantId));
    if (kind === "elicitation") await linear.elicit(sessionId, body);
    else await linear.respond(sessionId, body);
  };
  const drainMode = new DrainMode({
    settings: new PrismaDrainSettings(input.prisma),
    store,
    start,
    post,
    release: FACTOREE_RELEASE,
    logger: input.logger,
  });
  const blockerWait = new BlockerWait({
    store,
    reader: async (tenantId) => createLinearBlockerReader(await tokenOfTenant(tenantId)),
    start,
    post,
    logger: input.logger,
    drain: drainMode,
  });
  return { blockerWait, drainMode };
};
