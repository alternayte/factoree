import { defineSignal, log, proxyActivities, setHandler } from "@temporalio/workflow";
import type { Activities } from "~/activities/index.js";
import type { BuildAheadRequest } from "~/domain/runs/build-ahead.js";

/**
 * docs/specs/run-speed.md. A request for one more build. The starter sends it with
 * signal-with-start, so it starts the workflow or reaches the one that runs.
 */
export const buildAheadSignal = defineSignal("buildAhead");

/**
 * A build clones, bootstraps, runs the warm command and takes a snapshot. A sandbox slot can be
 * busy, and the activity gives a long wait back as an error, so the retry waits longer each time.
 */
const activities = proxyActivities<Activities>({
  startToCloseTimeout: "45 minutes",
  retry: { maximumAttempts: 5, initialInterval: "30 seconds", backoffCoefficient: 2, maximumInterval: "10 minutes" },
});

/**
 * docs/specs/run-speed.md. One workflow per repository, keyed by `buildAheadWorkflowId`. A request
 * during a build queues one more build, not one per request, because every build reads the head
 * of the default branch and makes the same snapshot.
 */
export const buildAheadWorkflow = async (request: BuildAheadRequest): Promise<void> => {
  let pending = true;
  setHandler(buildAheadSignal, () => {
    pending = true;
  });
  while (pending) {
    pending = false;
    try {
      const outcomes = await activities.buildWarmSnapshotAhead(request);
      // An activity result from before docs/specs/sandbox-provider-spillover.md is one outcome.
      const kinds = (Array.isArray(outcomes) ? outcomes : [outcomes]).map((outcome) => outcome.kind);
      log.info("build-ahead finished", { outcome: kinds.join(",") });
    } catch (error) {
      // A failed build-ahead costs the next run its warm start and nothing else.
      log.warn("the build-ahead failed after every retry", { error: String(error) });
    }
  }
};
