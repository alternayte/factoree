import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  getExternalWorkflowHandle,
  isCancellation,
  log,
  ParentClosePolicy,
  patched,
  proxyActivities,
  setHandler,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";
import type { Activities } from "~/activities/index.js";
import type { AutoMergeTrigger, PullRequestFollowUpPlan } from "~/activities/pull-request.activities.js";
import type { agentRunWorkflow } from "./agent-run.workflow.js";
import type { StopRequest } from "~/domain/runs/run-stop.js";
// The workflow bundler resolves a relative path only. The module imports nothing at run time.
import { mayStartFollowUp } from "../domain/pull-requests/pr-follow-up.js";
import type { PullRequestEvent } from "~/domain/pull-requests/pull-request-event.js";
import type { PullRequestState } from "~/domain/runs/issue-status.js";

/**
 * docs/specs/pr-review-merge-and-deploy.md. Each GitHub event of the pull request: a close, a reopen,
 * a new head, an edit, a review, a check run, a commit status or a deployment status. The webhook
 * route sends it with signal-with-start, so it reaches the workflow that runs or starts it.
 */
export const pullRequestEventSignal = defineSignal<[PullRequestEvent]>("pullRequestEvent");

export interface PullRequestWorkflowState {
  state: PullRequestState;
  headSha: string | null;
  /** The events the workflow holds and has not taken yet. */
  pending: number;
  /** The events the workflow took since it started or continued as new. */
  taken: number;
  /** docs/specs/pr-review-merge-and-deploy.md, slice 3. The workflow id of the PR follow-up run that runs, or null. */
  followUp: string | null;
}

export const pullRequestStateQuery = defineQuery<PullRequestWorkflowState>("pullRequestState");

export interface PullRequestWorkflowInput {
  tenantId: string;
  pullRequestId: string;
  /** The events a continue-as-new carried over. */
  pending?: PullRequestEvent[];
}

/** Each activity reads or writes the database and Linear once. A retry repeats it safely. */
const activities = proxyActivities<Activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 10, initialInterval: "2 seconds", backoffCoefficient: 2, maximumInterval: "5 minutes" },
});

/** Each GitHub read of the L4 merge goes again on a fault. A refusal is an answer, not a fault. */
const autoMergeActivities = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 5, initialInterval: "5 seconds", backoffCoefficient: 2, maximumInterval: "2 minutes" },
});

/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 3. The planner reads GitHub and the database once
 * per event. A fault goes again, and a failure after the retries costs only that event.
 */
const followUpActivities = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 5, initialInterval: "5 seconds", backoffCoefficient: 2, maximumInterval: "2 minutes" },
});

/** docs/specs/pr-review-merge-and-deploy.md, slice 3. A history from before the PR follow-up runs starts none. */
const PR_FOLLOW_UP_PATCH = "pr-follow-up";

/**
 * DI-21.104. The trigger of the L4 merge for one taken event. A close ends the workflow, and a deploy
 * changes no merge condition, so neither steers.
 */
const autoMergeTriggerOf = (event: PullRequestEvent): AutoMergeTrigger | null => {
  switch (event.kind) {
    case "closed":
    case "deployment_status":
      return null;
    case "synchronized":
      return "new_head";
    case "auto_merge_disabled":
      return "auto_merge_disabled";
    default:
      return "event";
  }
};

/**
 * docs/specs/pr-review-merge-and-deploy.md, DI-21.101. One workflow per published pull request, keyed
 * `pr:<tenant>:<repository>#<number>`. The run that published the pull request ends READY_FOR_HUMAN and
 * frees its slot (DI-15.13). This workflow takes the events after that, one at a time, in the order
 * they arrive.
 *
 * Every event is recorded once on the pull request. A merge or a close moves the issue through the
 * origin run and ends the workflow. The other kinds change only the record: the head commit on a
 * synchronize, the base branch on an edit. The L4 merge, the PR follow-up runs, the bring-current
 * update and the deploy report each add their handling of their event kinds to this loop. A PR
 * reviewer check and a review may start a PR follow-up run, which the loop waits for.
 *
 * The L4 merge (DI-21.104) steers GitHub auto-merge once at the start and after each other event. A
 * steer that fails after its retries costs only that steer: the next event steers again.
 */
export const pullRequestWorkflow = async (input: PullRequestWorkflowInput): Promise<PullRequestState> => {
  const queue: PullRequestEvent[] = [...(input.pending ?? [])];
  const view: PullRequestWorkflowState = { state: "open", headSha: null, pending: queue.length, taken: 0, followUp: null };
  setHandler(pullRequestEventSignal, (event) => {
    queue.push(event);
    view.pending = queue.length;
  });
  setHandler(pullRequestStateQuery, () => view);

  const steer = async (trigger: AutoMergeTrigger, eventHeadSha: string | null) => {
    try {
      await autoMergeActivities.steerAutoMerge({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, trigger, eventHeadSha });
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the auto-merge steer failed", { trigger, error: String(error) });
    }
  };
  // A continue-as-new carries its events. Only a new workflow steers at its start.
  if (input.pending === undefined) await steer("start", null);

  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 3, D6, DI-21.111. One event may start one PR
   * follow-up run. The run is a child that ABANDON keeps alive, and it takes a run slot and its
   * sandbox slots like any run. The workflow waits for it, so one PR follow-up run runs at a time,
   * and every event that arrives meanwhile waits in the queue. A merge or a close in the queue stops
   * the run, because its push would land on a pull request that ended.
   */
  const followUp = async (event: PullRequestEvent): Promise<void> => {
    let plan: PullRequestFollowUpPlan;
    try {
      plan = await followUpActivities.planPullRequestFollowUp({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, event });
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the PR follow-up plan failed", { delivery_id: event.deliveryId, error: String(error) });
      return;
    }
    if (plan.kind === "none") return;
    let finished = false;
    let result: Promise<unknown>;
    try {
      const child = await startChild<typeof agentRunWorkflow>("agentRunWorkflow", {
        workflowId: plan.workflowId,
        args: [plan.input],
        parentClosePolicy: ParentClosePolicy.ABANDON,
      });
      result = child.result();
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the PR follow-up run did not start", { workflow_id: plan.workflowId, error: String(error) });
      return;
    }
    view.followUp = plan.workflowId;
    const settled = result.then(
      () => {
        finished = true;
      },
      (error: unknown) => {
        finished = true;
        log.warn("the PR follow-up run failed", { workflow_id: plan.workflowId, error: String(error) });
      },
    );
    await condition(() => finished || queue.some((queued) => queued.kind === "closed"));
    if (!finished) {
      const stop: StopRequest = { source: "pull_request" };
      try {
        await getExternalWorkflowHandle(plan.workflowId).signal("stop", stop);
      } catch (error) {
        if (isCancellation(error)) throw error;
        // The run ended between the check and the signal.
      }
    }
    await settled;
    view.followUp = null;
  };

  for (;;) {
    await condition(() => queue.length > 0);
    const event = queue.shift() as PullRequestEvent;
    view.pending = queue.length;
    const taken = await activities.takePullRequestEvent({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, event });
    view.taken += 1;
    view.state = taken.state;
    view.headSha = taken.headSha;
    if (!taken.isNew) {
      log.info("the pull request already took this delivery", { delivery_id: event.deliveryId, kind: event.kind });
    } else if (event.kind === "closed") {
      view.state = await activities.closePullRequestOfRecord({
        tenantId: input.tenantId,
        pullRequestId: input.pullRequestId,
        merged: event.merged,
        mergeCommitSha: event.mergeCommitSha,
      });
      // The events that arrived with the close are recorded too, so none is lost.
      while (queue.length > 0) {
        const rest = queue.shift() as PullRequestEvent;
        await activities.takePullRequestEvent({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, event: rest });
      }
      view.pending = 0;
      return view.state;
    } else {
      const trigger = autoMergeTriggerOf(event);
      if (trigger !== null) await steer(trigger, event.kind === "auto_merge_disabled" ? event.headSha : null);
      if (mayStartFollowUp(event) && patched(PR_FOLLOW_UP_PATCH)) await followUp(event);
    }
    // A pull request with many check runs takes many events. The history starts again before it
    // grows too large, and the events not yet taken move to the new run.
    if (workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof pullRequestWorkflow>({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, pending: [...queue] });
    }
  }
};
