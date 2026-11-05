import { ActivityFailure, ApplicationFailure, log, proxyActivities, sleep } from "@temporalio/workflow";
import type { Activities } from "~/activities/index.js";
import { SANDBOX_SLOT_UNAVAILABLE_TYPE } from "../domain/runs/sandbox-slot-error.js";

/**
 * docs/specs/repository-setup-and-services.md. An agent session is expensive and not idempotent,
 * so an activity runs once. Only a full sandbox provider is worth a wait, and the workflow waits.
 */
const activities = proxyActivities<Activities>({
  startToCloseTimeout: "2 hours",
  retry: { maximumAttempts: 1 },
});

const record = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5 },
});

/** The wait between two tries of a full provider, and the longest a setup waits for a slot. */
const SLOT_POLL_MS = 60_000;
const SLOT_WAIT_MS = 6 * 60 * 60_000;

const isSlotUnavailable = (error: unknown): boolean => {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof ApplicationFailure && current.type === SANDBOX_SLOT_UNAVAILABLE_TYPE) return true;
  }
  return false;
};

const withSlot = async <T>(work: () => Promise<T>): Promise<T> => {
  let waited = 0;
  for (;;) {
    try {
      return await work();
    } catch (error) {
      if (!isSlotUnavailable(error) || waited >= SLOT_WAIT_MS) throw error;
    }
    await sleep(SLOT_POLL_MS);
    waited += SLOT_POLL_MS;
  }
};

const messageOf = (error: unknown): string => {
  const cause = error instanceof ActivityFailure && error.cause !== undefined ? error.cause : error;
  return cause instanceof Error ? cause.message : String(cause);
};

/**
 * One setup run, keyed by `setupWorkflowId`, so one repository runs one setup at a time. The agent
 * writes `.factoree/`, Factoree proves each part in a fresh sandbox, and opens the pull request.
 */
export const repositorySetupWorkflow = async (input: { setupId: string }): Promise<void> => {
  try {
    const session = await withSlot(() => activities.runSetupSession({ setupId: input.setupId }));
    if (session.kind === "failed") {
      await record.finishSetup({ setupId: input.setupId, status: "failed", pullRequestUrl: null, failureMessage: session.reason });
      return;
    }
    const proof = await withSlot(() => activities.proveAndPublishSetup({ setupId: input.setupId, session }));
    await record.finishSetup({ setupId: input.setupId, status: proof.status, pullRequestUrl: proof.pullRequestUrl, failureMessage: proof.failureMessage });
  } catch (error) {
    log.warn("the setup failed", { setup_id: input.setupId, error: messageOf(error) });
    await record.finishSetup({ setupId: input.setupId, status: "failed", pullRequestUrl: null, failureMessage: messageOf(error) });
  }
};
