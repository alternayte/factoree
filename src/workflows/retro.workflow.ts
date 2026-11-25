import { ActivityFailure, ApplicationFailure, log, proxyActivities, sleep, workflowInfo } from "@temporalio/workflow";
import type { Activities } from "~/activities/index.js";
import { SANDBOX_SLOT_UNAVAILABLE_TYPE } from "../domain/runs/sandbox-slot-error.js";

/**
 * docs/specs/retro-agent.md. An agent session is expensive and not idempotent, so a session runs
 * once. A full sandbox provider is worth a wait, as for a setup.
 */
const sessions = proxyActivities<Activities>({
  startToCloseTimeout: "45 minutes",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

const record = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5 },
});

const SLOT_POLL_MS = 60_000;
const SLOT_WAIT_MS = 2 * 60 * 60_000;

const isSlotUnavailable = (error: unknown): boolean => {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof ApplicationFailure && current.type === SANDBOX_SLOT_UNAVAILABLE_TYPE) return true;
  }
  return false;
};

const messageOf = (error: unknown): string => {
  const cause = error instanceof ActivityFailure && error.cause !== undefined ? error.cause : error;
  return cause instanceof Error ? cause.message : String(cause);
};

export interface RetroWorkflowInput {
  tenantId: string;
  trigger: "schedule" | "manual";
}

/**
 * docs/specs/retro-agent.md. One retro: one agent session per product in scope, in sequence. The
 * retro stops before the next product once its sessions spent the cost cap. It never steers a
 * live run: the run workflow stays the only orchestrator.
 */
export const retroWorkflow = async (input: RetroWorkflowInput): Promise<void> => {
  const workflowId = workflowInfo().workflowId;
  const prepared = await record.prepareRetro({ tenantId: input.tenantId, workflowId, trigger: input.trigger });
  if (prepared.kind === "skipped") {
    log.info("the retro did not start", { tenant_id: input.tenantId, reason: prepared.reason });
    return;
  }
  let spent = 0;
  try {
    for (const productId of prepared.productIds) {
      if (spent >= prepared.costCapUsd) {
        await record.skipRetroSession({
          tenantId: input.tenantId,
          retroId: prepared.retroId,
          productId,
          reason: `The retro spent ${spent.toFixed(2)} USD of its ${prepared.costCapUsd.toFixed(2)} USD cost cap before this product.`,
        });
        continue;
      }
      let waited = 0;
      for (;;) {
        try {
          const outcome = await sessions.runRetroSession({ tenantId: input.tenantId, retroId: prepared.retroId, productId });
          spent += outcome.costUsd;
          break;
        } catch (error) {
          if (isSlotUnavailable(error) && waited < SLOT_WAIT_MS) {
            await sleep(SLOT_POLL_MS);
            waited += SLOT_POLL_MS;
            continue;
          }
          // One product's fault never ends the retro of the others.
          log.warn("a retro session failed", { retro_id: prepared.retroId, product_id: productId, error: messageOf(error) });
          await record.skipRetroSession({ tenantId: input.tenantId, retroId: prepared.retroId, productId, reason: `The retro session failed: ${messageOf(error)}`, status: "failed" });
          break;
        }
      }
    }
    await record.finishRetro({ retroId: prepared.retroId, status: "succeeded", failureMessage: null });
  } catch (error) {
    log.warn("the retro failed", { retro_id: prepared.retroId, error: messageOf(error) });
    await record.finishRetro({ retroId: prepared.retroId, status: "failed", failureMessage: messageOf(error) });
  }
};
