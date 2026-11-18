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
import type { AutoMergeTrigger, PullRequestFollowUpPlan, TakeDeploymentOutput } from "~/activities/pull-request.activities.js";
import type { AgentRunWorkflowResult, agentRunWorkflow } from "./agent-run.workflow.js";
import type { BringCurrentReason } from "~/domain/pull-requests/auto-merge.js";
import type { StopRequest } from "~/domain/runs/run-stop.js";
// The workflow bundler resolves a relative path only. The module imports nothing at run time.
import { mayStartFollowUp } from "../domain/pull-requests/pr-follow-up.js";
import { DEPLOY_WINDOW_MS } from "../domain/pull-requests/deploys.js";
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
  /**
   * Slice 5, DI-21.121. The time of the merge, in milliseconds since the epoch, when a merged pull
   * request continued as new. The workflow then takes deploys until the deploy window ends.
   */
  mergedAt?: number;
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

/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 5. A history from before the deploy report ends at
 * the merge, and amends no proof pack.
 */
const DEPLOYS_PATCH = "deploys";

/**
 * docs/specs/change-sets.md, slice 8. A history from before the change-set status sets none. The
 * activity runs only for a pull request of a change set, so one pull request alone adds no command.
 */
const CHANGE_SET_STATUS_PATCH = "change-set-status";

/** DI-21.155. The events that change the merge-order status of a change set: a new head, a reopen and a close. */
const movesSetStatus = (event: PullRequestEvent): boolean => event.kind === "synchronized" || event.kind === "reopened" || event.kind === "closed";

/** DI-21.115. GitHub computes the merge state after a push. The workflow reads it this often at most. */
const MERGEABILITY_READS = 4;
const MERGEABILITY_WAIT = "30 seconds";

/** DI-21.117. The events after which the branch may conflict with its base. */
const mayConflict = (event: PullRequestEvent): boolean =>
  event.kind === "base_pushed" || event.kind === "synchronized" || event.kind === "reopened" || event.kind === "edited";

/**
 * DI-21.123. The events that may list themselves in the proof pack: a submitted comment review, and a
 * check run or commit status that passed. The planner decides whether it is the PR reviewer's.
 */
const mayAmend = (event: PullRequestEvent): boolean =>
  (event.kind === "review" && event.action === "submitted" && event.state === "commented") ||
  (event.kind === "check_run" && event.status === "completed" && event.conclusion === "success") ||
  (event.kind === "commit_status" && event.state === "success");

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
 * origin run. A close ends the workflow. After a merge the workflow takes the deploys of the merge
 * commit for the deploy window (DI-21.121), and then ends. The other kinds change only the record: the head commit on a
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

  /**
   * docs/specs/pr-review-merge-and-deploy.md, DI-21.123. A plain comment, or a passed PR reviewer
   * check with comments, amends the proof pack of the verified head. A failure costs only the
   * amendment.
   */
  const amend = async (event: PullRequestEvent): Promise<void> => {
    try {
      const planned = await followUpActivities.planProofPackAmendment({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, event });
      if (planned.amend !== null) await activities.amendProofPack(planned.amend);
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the proof pack amendment failed", { delivery_id: event.deliveryId, error: String(error) });
    }
  };

  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 5, DI-21.120 to DI-21.122. One deployment status
   * of the merged pull request. A deploy result of the run amends the proof pack and posts its
   * notice in the agent session, the notice last, so a failed deploy ends on the line that asks for
   * a reply. Each step that fails after its retries costs only itself.
   */
  const deploy = async (event: PullRequestEvent): Promise<void> => {
    let taken: TakeDeploymentOutput;
    try {
      taken = await followUpActivities.takeDeployment({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, event });
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the deployment was not taken", { delivery_id: event.deliveryId, error: String(error) });
      return;
    }
    if (taken.kind === "none") return;
    try {
      await activities.amendProofPack(taken.amend);
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the proof pack amendment of the deploy failed", { delivery_id: event.deliveryId, error: String(error) });
    }
    try {
      await activities.postPullRequestNotice({ sessionId: taken.sessionId, body: taken.notice });
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the deploy notice did not reach Linear", { delivery_id: event.deliveryId, error: String(error) });
    }
  };

  /**
   * docs/specs/change-sets.md, slice 8, DI-21.155. Sets the `factoree/change-set` status of each
   * consumer of the set again, from the records after the event. A failure costs only the status:
   * the next event of the set sets it again.
   */
  const setStatuses = async (event: PullRequestEvent): Promise<void> => {
    try {
      await activities.setChangeSetStatuses({ tenantId: input.tenantId, pullRequestId: input.pullRequestId });
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the change-set status was not set", { delivery_id: event.deliveryId, error: String(error) });
    }
  };

  // DI-21.121. A merged pull request takes deploys until this time, in milliseconds since the epoch.
  let mergedAt: number | null = input.mergedAt ?? null;

  // A continue-as-new carries its events. Only a new workflow steers at its start.
  if (input.pending === undefined && mergedAt === null) {
    const wanted = await steer("start", null);
    if (wanted !== null && patched(BRING_CURRENT_PATCH)) await bringCurrent(wanted, "start");
  }

  for (;;) {
    if (mergedAt === null) {
      await condition(() => queue.length > 0);
    } else {
      // DI-21.121. After the merge the workflow waits for deploys until the deploy window ends.
      const remaining = mergedAt + DEPLOY_WINDOW_MS - Date.now();
      if (remaining <= 0 || !(await condition(() => queue.length > 0, remaining))) {
        view.state = "merged";
        return "merged";
      }
    }
    const event = queue.shift() as PullRequestEvent;
    view.pending = queue.length;
    const taken = await activities.takePullRequestEvent({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, event });
    view.taken += 1;
    view.state = taken.state;
    view.headSha = taken.headSha;
    if (!taken.isNew) {
      log.info("the pull request already took this delivery", { delivery_id: event.deliveryId, kind: event.kind });
    } else if (taken.state === "merged" && event.kind !== "closed" && patched(DEPLOYS_PATCH)) {
      // Slice 5. A merged pull request takes only deploys. A workflow that a deploy started again
      // after its end takes the merge time from the record.
      mergedAt ??= taken.mergedAt === undefined || taken.mergedAt === null ? Date.now() : Date.parse(taken.mergedAt);
      if (event.kind === "deployment_status") await deploy(event);
    } else if (event.kind === "closed") {
      view.state = await activities.closePullRequestOfRecord({
        tenantId: input.tenantId,
        pullRequestId: input.pullRequestId,
        merged: event.merged,
        mergeCommitSha: event.mergeCommitSha,
      });
      // DI-21.155. A provider that merged or closed moves the status of each consumer of its set.
      if (taken.changeSet === true && patched(CHANGE_SET_STATUS_PATCH)) await setStatuses(event);
      // Slice 5, DI-21.121. A merge keeps the workflow open for the deploys of the merge commit. The
      // events that arrived with it stay in the queue and are taken as events of a merged pull request.
      if (view.state === "merged" && patched(DEPLOYS_PATCH)) {
        mergedAt = Date.now();
      } else {
        // The events that arrived with the close are recorded too, so none is lost.
        while (queue.length > 0) {
          const rest = queue.shift() as PullRequestEvent;
          await activities.takePullRequestEvent({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, event: rest });
        }
        view.pending = 0;
        return view.state;
      }
    } else {
      // DI-21.155. A new head of a provider or a consumer moves the status of the set.
      if (taken.changeSet === true && movesSetStatus(event) && patched(CHANGE_SET_STATUS_PATCH)) await setStatuses(event);
      const trigger = autoMergeTriggerOf(event);
      const wanted = trigger === null ? null : await steer(trigger, event.kind === "auto_merge_disabled" ? event.headSha : null);
      if (mayStartFollowUp(event) && patched(PR_FOLLOW_UP_PATCH)) await followUp(event);
      // Slice 4. A conflict at any level, or a branch an L4 merge needs up to date, is brought current.
      if ((wanted !== null || mayConflict(event)) && patched(BRING_CURRENT_PATCH)) {
        const reason = wanted ?? ((await conflicts(event)) ? "conflict" : null);
        if (reason !== null) await bringCurrent(reason, event.deliveryId);
      }
      // DI-21.123. A plain comment or a passed PR reviewer check lists itself in the proof pack.
      if (mayAmend(event) && patched(DEPLOYS_PATCH)) {
        await amend(event);
      }
    }
    // A pull request with many check runs takes many events. The history starts again before it
    // grows too large, and the events not yet taken move to the new run.
    if (workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof pullRequestWorkflow>({
        tenantId: input.tenantId,
        pullRequestId: input.pullRequestId,
        pending: [...queue],
        ...(mergedAt === null ? {} : { mergedAt }),
      });
    }
  }
};
