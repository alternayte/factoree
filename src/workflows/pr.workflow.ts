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
import type { AgentRunWorkflowResult, agentRunWorkflow } from "./agent-run.workflow.js";
import type { BringCurrentReason } from "~/domain/pull-requests/auto-merge.js";
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
  /**
   * docs/specs/pr-review-merge-and-deploy.md, slices 3 and 4. The workflow id of the PR follow-up
   * run or the bring-current run that runs, or null.
   */
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

/** docs/specs/pr-review-merge-and-deploy.md, slice 4. A history from before the bring-current update reads no conflict. */
const BRING_CURRENT_PATCH = "bring-current";

/** DI-21.115. GitHub computes the merge state after a push. The workflow reads it this often at most. */
const MERGEABILITY_READS = 4;
const MERGEABILITY_WAIT = "30 seconds";

/** DI-21.117. The events after which the branch may conflict with its base. */
const mayConflict = (event: PullRequestEvent): boolean =>
  event.kind === "base_pushed" || event.kind === "synchronized" || event.kind === "reopened" || event.kind === "edited";

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
    case "base_pushed":
      return "base_moved";
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

  /** Steers auto-merge, and answers the bring-current update the steer asks for, or null. */
  const steer = async (trigger: AutoMergeTrigger, eventHeadSha: string | null): Promise<BringCurrentReason | null> => {
    try {
      const steered = await autoMergeActivities.steerAutoMerge({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, trigger, eventHeadSha });
      return steered.bringCurrent ?? null;
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the auto-merge steer failed", { trigger, error: String(error) });
      return null;
    }
  };

  /**
   * docs/specs/pr-review-merge-and-deploy.md, slices 3 and 4, D6, DI-21.111. Runs one PR follow-up
   * run or one bring-current run. The run is a child that ABANDON keeps alive, and it takes a run
   * slot and its sandbox slots like any run. The workflow waits for it, so one such run runs at a
   * time per pull request, and every event that arrives meanwhile waits in the queue. A merge or a
   * close in the queue stops the run, because its push would land on a pull request that ended. It
   * answers the result of the run, or null when the run did not start or failed.
   */
  const runChild = async (plan: PullRequestFollowUpPlan): Promise<AgentRunWorkflowResult | null> => {
    if (plan.kind === "none") return null;
    let finished = false;
    let outcome: AgentRunWorkflowResult | null = null;
    let result: Promise<AgentRunWorkflowResult>;
    try {
      const child = await startChild<typeof agentRunWorkflow>("agentRunWorkflow", {
        workflowId: plan.workflowId,
        args: [plan.input],
        parentClosePolicy: ParentClosePolicy.ABANDON,
      });
      result = child.result();
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the run did not start", { workflow_id: plan.workflowId, error: String(error) });
      return null;
    }
    view.followUp = plan.workflowId;
    const settled = result.then(
      (value) => {
        finished = true;
        outcome = value;
      },
      (error: unknown) => {
        finished = true;
        log.warn("the run failed", { workflow_id: plan.workflowId, error: String(error) });
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
    return outcome;
  };

  /** Slice 3. One event may start one PR follow-up run. */
  const followUp = async (event: PullRequestEvent): Promise<void> => {
    let plan: PullRequestFollowUpPlan;
    try {
      plan = await followUpActivities.planPullRequestFollowUp({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, event });
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the PR follow-up plan failed", { delivery_id: event.deliveryId, error: String(error) });
      return;
    }
    await runChild(plan);
  };

  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.115. True when GitHub reports that the
   * branch conflicts with its base. GitHub computes the state after a push, so an unknown state is
   * read again a few times. A failed read counts as no conflict: the next event reads again.
   */
  const conflicts = async (event: PullRequestEvent): Promise<boolean> => {
    if (event.kind === "edited" && (event.mergeable === false || event.mergeableState === "dirty")) return true;
    for (let read = 0; read < MERGEABILITY_READS; read += 1) {
      let mergeability: string;
      try {
        ({ mergeability } = await followUpActivities.readPullRequestMergeability({ tenantId: input.tenantId, pullRequestId: input.pullRequestId }));
      } catch (error) {
        if (isCancellation(error)) throw error;
        log.warn("the merge state read failed", { delivery_id: event.deliveryId, error: String(error) });
        return false;
      }
      if (mergeability !== "unknown") return mergeability === "conflict";
      if (await condition(() => queue.some((queued) => queued.kind === "closed"), MERGEABILITY_WAIT)) return false;
    }
    return false;
  };

  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.117 to DI-21.119. One bring-current run.
   * A conflict, or a failed check of the clean merge, starts a PR follow-up run with it as a finding,
   * outside the limit of PR reviewer follow-up runs. An update that pushed nothing marks the head, so
   * no later event starts the same update again until the head or the base moves (DI-21.118).
   */
  const bringCurrent = async (reason: BringCurrentReason, triggerKey: string): Promise<void> => {
    let plan: PullRequestFollowUpPlan;
    try {
      plan = await followUpActivities.planBringCurrent({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, reason, triggerKey });
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the bring-current plan failed", { trigger: triggerKey, error: String(error) });
      return;
    }
    if (plan.kind === "none") return;
    const headSha = plan.input.bringCurrent?.headSha ?? null;
    const result = await runChild(plan);
    const outcome = result?.bringCurrent ?? { kind: "ended" as const };
    if (outcome.kind === "pushed" || outcome.kind === "moved" || headSha === null) return;
    try {
      await activities.markBringCurrentTried({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, headSha });
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the bring-current head was not marked", { error: String(error) });
    }
    if (outcome.kind === "ended" || outcome.kind === "current") return;
    let followUpPlan: PullRequestFollowUpPlan;
    try {
      followUpPlan = await followUpActivities.planBaseUpdateFollowUp({
        tenantId: input.tenantId,
        pullRequestId: input.pullRequestId,
        headSha,
        baseSha: outcome.baseSha,
        conflicts: outcome.kind === "conflict" ? outcome.conflicts : [],
        failure: outcome.kind === "failed" ? outcome.failure : null,
        bringCurrentWorkflowId: plan.workflowId,
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the PR follow-up plan of the base update failed", { error: String(error) });
      return;
    }
    await runChild(followUpPlan);
  };

  // A continue-as-new carries its events. Only a new workflow steers at its start.
  if (input.pending === undefined) {
    const wanted = await steer("start", null);
    if (wanted !== null && patched(BRING_CURRENT_PATCH)) await bringCurrent(wanted, "start");
  }

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
      const wanted = trigger === null ? null : await steer(trigger, event.kind === "auto_merge_disabled" ? event.headSha : null);
      if (mayStartFollowUp(event) && patched(PR_FOLLOW_UP_PATCH)) await followUp(event);
      // Slice 4. A conflict at any level, or a branch an L4 merge needs up to date, is brought current.
      if ((wanted !== null || mayConflict(event)) && patched(BRING_CURRENT_PATCH)) {
        const reason = wanted ?? ((await conflicts(event)) ? "conflict" : null);
        if (reason !== null) await bringCurrent(reason, event.deliveryId);
      }
    }
    // A pull request with many check runs takes many events. The history starts again before it
    // grows too large, and the events not yet taken move to the new run.
    if (workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof pullRequestWorkflow>({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, pending: [...queue] });
    }
  }
};
