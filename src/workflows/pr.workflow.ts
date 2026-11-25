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
import {
  isDecisionEvent,
  mayStartFollowUp,
  needsAttention,
  SETTLE_MAX_MS,
  SETTLE_QUIET_MS,
  type DecisionEvent,
} from "../domain/pull-requests/pr-follow-up.js";
import { DEPLOY_WINDOW_MS } from "../domain/pull-requests/deploys.js";
import { releaseMemo } from "./release.js";
import { autoMergeTriggerOf, mayAmend, mayConflict, movesSetStatus } from "./pr-workflow-events.js";
import { HELD_LINE } from "../domain/runs/drain-mode.js";
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

/**
 * docs/specs/change-sets.md, slice 9, DI-21.158. The PR workflow that held the set for a set run gave
 * it back. Each other PR workflow of the set that waits reads the set again.
 */
export const changeSetReleasedSignal = defineSignal("changeSetReleased");

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
  /** docs/specs/pr-feedback-loop.md, DI-21.209. The human decisions a continue-as-new carried over, oldest first. */
  decisions?: DecisionEvent[];
  /** DI-21.209. The settle of the head that a continue-as-new carried over, or null. */
  attention?: ReviewSettle | null;
}

/**
 * docs/specs/pr-feedback-loop.md, DI-21.209. The reviews of the head settle: the time of the first
 * event that asked for attention, the time of the newest one, and the delivery of the newest one,
 * which keys the run that the settle plans. Times are milliseconds since the epoch.
 */
export interface ReviewSettle {
  since: number;
  lastAt: number;
  key: string;
  /** True when the pull request belongs to a change set, so the plan takes the set. */
  inSet: boolean;
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
 * docs/specs/pr-feedback-loop.md, DI-21.209. A history from before the review apps starts a PR
 * follow-up run on each failed PR reviewer check, one event at a time. After it, the workflow waits
 * for the reviews of the head to settle and plans once from every review app, CI check and human.
 */
const REVIEW_APPS_SETTLE_PATCH = "review-apps-settle";

/** docs/specs/drain-mode.md. While drain mode is on, a PR workflow waits before it starts a run. */
const DRAIN_MODE_PATCH = "drain-mode";
const DRAIN_MODE_POLL = "60 seconds";

/**
 * docs/specs/change-sets.md, slice 8. A history from before the change-set status sets none. The
 * activity runs only for a pull request of a change set, so one pull request alone adds no command.
 */
const CHANGE_SET_STATUS_PATCH = "change-set-status";

/**
 * docs/specs/change-sets.md, slice 9. A history from before the set rules starts the run of one pull
 * request and waits for no other PR workflow. The activities run only for a pull request of a set.
 */
const SET_RUN_PATCH = "change-set-runs";

/**
 * docs/specs/pr-feedback-loop.md, DI-21.213. The proof pack lists no PR comment and no suggestion of a
 * passed check. A history from before this patch plans the amendment of such an event, which now
 * amends nothing.
 */
const NO_COMMENT_AMENDMENTS_PATCH = "no-comment-amendments";

/** docs/specs/pr-body-for-humans.md, DI-21.220. A history from before it writes no body after a deployment of the head. */
const PREVIEW_LINK_PATCH = "pr-preview-link";

/** DI-21.158. A waiting PR workflow reads the set again this often, in case a release signal was lost. */
const SET_WAIT = "5 minutes";


/** DI-21.115. GitHub computes the merge state after a push. The workflow reads it this often at most. */
const MERGEABILITY_READS = 4;
const MERGEABILITY_WAIT = "30 seconds";




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
  // DI-21.158. Set when another PR workflow of the change set gave the set back.
  let setReleased = false;
  setHandler(changeSetReleasedSignal, () => {
    setReleased = true;
  });
  const closeQueued = (): boolean => queue.some((queued) => queued.kind === "closed");
  // DI-21.209. The settle of the current head, and the human decisions held until its plan.
  let attention: ReviewSettle | null = input.attention ?? null;
  const decisions: DecisionEvent[] = [...(input.decisions ?? [])];

  /**
   * docs/specs/change-sets.md, slice 9, DI-21.158. Waits while another PR workflow of the set runs a
   * set run. The events wait in the queue, and none is lost. A close of this pull request stops that
   * run once, because its push would land on a set that changed.
   */
  const waitWhileSetHeld = async (closing: boolean, heldBy: string | null = null): Promise<void> => {
    let runWorkflowId = heldBy;
    let stopSent = false;
    for (;;) {
      if (runWorkflowId === null) {
        let holder: { held: boolean; runWorkflowId: string | null };
        try {
          holder = await activities.changeSetRunHolder({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, holderWorkflowId: workflowInfo().workflowId });
        } catch (error) {
          if (isCancellation(error)) throw error;
          log.warn("the change set holder was not read, so the workflow goes on", { error: String(error) });
          return;
        }
        if (!holder.held) return;
        runWorkflowId = holder.runWorkflowId;
      }
      if (!stopSent && runWorkflowId !== null && (closing || closeQueued())) {
        stopSent = true;
        const stop: StopRequest = { source: "pull_request" };
        try {
          await getExternalWorkflowHandle(runWorkflowId).signal("stop", stop);
        } catch (error) {
          if (isCancellation(error)) throw error;
          // The set run ended between the read and the signal.
        }
      }
      setReleased = false;
      await condition(() => setReleased || (!stopSent && closeQueued()), SET_WAIT);
      runWorkflowId = null;
    }
  };

  /** DI-21.158. True while this PR workflow holds the set for its set run. */
  let holdingSet = false;

  /**
   * DI-21.158. Takes the set for a set run before it starts. While another PR workflow holds it, this
   * one waits and plans again, because the other run may have moved the heads. A plan of one pull
   * request needs no set.
   */
  const takeSet = async (plan: PullRequestFollowUpPlan, replan: () => Promise<PullRequestFollowUpPlan>): Promise<PullRequestFollowUpPlan> => {
    let current = plan;
    for (;;) {
      if (current.kind === "none" || current.changeSet !== true || !patched(SET_RUN_PATCH)) return current;
      if (closeQueued()) return { kind: "none", reason: "the pull request closed" };
      let taken: { acquired: boolean; heldBy: string | null };
      try {
        taken = await activities.acquireChangeSetRun({
          tenantId: input.tenantId,
          pullRequestId: input.pullRequestId,
          holderWorkflowId: workflowInfo().workflowId,
          runWorkflowId: current.workflowId,
        });
      } catch (error) {
        if (isCancellation(error)) throw error;
        log.warn("the change set was not taken, so the set run does not start", { workflow_id: current.workflowId, error: String(error) });
        return { kind: "none", reason: "the change set was not taken" };
      }
      if (taken.acquired) {
        holdingSet = true;
        return current;
      }
      await waitWhileSetHeld(false, taken.heldBy);
      try {
        current = await replan();
      } catch (error) {
        if (isCancellation(error)) throw error;
        log.warn("the set run plan failed", { error: String(error) });
        return { kind: "none", reason: "the plan failed" };
      }
    }
  };

  /**
   * DI-21.158. Takes the set before a plan that marks what it handled, so the plan runs once and
   * reads the heads after any other set run. The set run is named once the plan starts one; a plan
   * that starts nothing gives the set back.
   */
  const planInSet = async (inSet: boolean, planOnce: () => Promise<PullRequestFollowUpPlan>): Promise<PullRequestFollowUpPlan> => {
    if (!inSet || !patched(SET_RUN_PATCH)) return await planOnce();
    for (;;) {
      if (closeQueued()) return { kind: "none", reason: "the pull request closed" };
      let taken: { acquired: boolean; heldBy: string | null };
      try {
        taken = await activities.acquireChangeSetRun({
          tenantId: input.tenantId,
          pullRequestId: input.pullRequestId,
          holderWorkflowId: workflowInfo().workflowId,
          runWorkflowId: null,
        });
      } catch (error) {
        if (isCancellation(error)) throw error;
        log.warn("the change set was not taken, so no set run starts", { error: String(error) });
        return { kind: "none", reason: "the change set was not taken" };
      }
      if (taken.acquired) break;
      await waitWhileSetHeld(false, taken.heldBy);
    }
    holdingSet = true;
    let plan: PullRequestFollowUpPlan;
    try {
      plan = await planOnce();
    } catch (error) {
      await releaseSet();
      throw error;
    }
    if (plan.kind === "none") {
      await releaseSet();
      return plan;
    }
    return await takeSet(plan, planOnce);
  };

  /** DI-21.158. Gives the set back, and wakes each other PR workflow of the set. */
  const releaseSet = async (): Promise<void> => {
    if (!holdingSet) return;
    holdingSet = false;
    let siblings: string[] = [];
    try {
      ({ siblings } = await activities.releaseChangeSetRun({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, holderWorkflowId: workflowInfo().workflowId }));
    } catch (error) {
      if (isCancellation(error)) throw error;
      // A held set passes on after a day, or when this pull request ends.
      log.warn("the change set was not given back", { error: String(error) });
    }
    for (const sibling of siblings) {
      try {
        await getExternalWorkflowHandle(sibling).signal(changeSetReleasedSignal);
      } catch (error) {
        if (isCancellation(error)) throw error;
        // The PR workflow of an ended pull request takes no signal.
      }
    }
  };

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
    try {
      return plan.kind === "none" ? null : await runChildHeld(plan);
    } finally {
      await releaseSet();
    }
  };

  /**
   * docs/specs/drain-mode.md. Waits while drain mode is on, so no new run opens before a release that
   * open runs cannot replay. The session gets the held line once. It answers false when the pull
   * request closed during the wait, and then no run starts.
   */
  const waitWhileDrained = async (plan: Extract<PullRequestFollowUpPlan, { kind: "start" }>): Promise<boolean> => {
    let told = false;
    for (;;) {
      let on: boolean;
      try {
        on = await activities.isDrainModeOn();
      } catch (error) {
        if (isCancellation(error)) throw error;
        // A failed read starts the run, as with drain mode off: the worker refuses a release that cannot replay it.
        on = false;
      }
      if (!on) return true;
      if (!told) {
        told = true;
        try {
          await activities.postElicitation({ sessionId: plan.input.agentSessionId, question: HELD_LINE });
        } catch (error) {
          if (isCancellation(error)) throw error;
          log.warn("the held line was not posted", { workflow_id: plan.workflowId, error: String(error) });
        }
      }
      if (await condition(() => queue.some((queued) => queued.kind === "closed"), DRAIN_MODE_POLL)) return false;
    }
  };

  const runChildHeld = async (plan: Extract<PullRequestFollowUpPlan, { kind: "start" }>): Promise<AgentRunWorkflowResult | null> => {
    if (patched(DRAIN_MODE_PATCH) && !(await waitWhileDrained(plan))) return null;
    let finished = false;
    let outcome: AgentRunWorkflowResult | null = null;
    let result: Promise<AgentRunWorkflowResult>;
    try {
      const child = await startChild<typeof agentRunWorkflow>("agentRunWorkflow", {
        workflowId: plan.workflowId,
        args: [plan.input],
        parentClosePolicy: ParentClosePolicy.ABANDON,
        // docs/specs/run-workflow-structure.md. A run that this workflow starts carries the release
        // memo too, so `factoree upgrade-check` sees it.
        memo: releaseMemo(),
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
  const followUp = async (event: PullRequestEvent, inSet: boolean): Promise<void> => {
    let plan: PullRequestFollowUpPlan;
    const planOnce = () => followUpActivities.planPullRequestFollowUp({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, event });
    try {
      plan = await planInSet(inSet, planOnce);
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
    const planOnce = () => followUpActivities.planBringCurrent({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, reason, triggerKey });
    try {
      plan = await takeSet(await planOnce(), planOnce);
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the bring-current plan failed", { trigger: triggerKey, error: String(error) });
      return;
    }
    if (plan.kind === "none") {
      await releaseSet();
      return;
    }
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
    const bringCurrentWorkflowId = plan.workflowId;
    const planFollowUp = () =>
      followUpActivities.planBaseUpdateFollowUp({
        tenantId: input.tenantId,
        pullRequestId: input.pullRequestId,
        headSha,
        baseSha: outcome.baseSha,
        conflicts: outcome.kind === "conflict" ? outcome.conflicts : [],
        failure: outcome.kind === "failed" ? outcome.failure : null,
        bringCurrentWorkflowId,
      });
    try {
      followUpPlan = await takeSet(await planFollowUp(), planFollowUp);
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the PR follow-up plan of the base update failed", { error: String(error) });
      return;
    }
    await runChild(followUpPlan);
  };

  /**
   * docs/specs/pr-feedback-loop.md, DI-21.209 to DI-21.211. One event that asks for attention. A
   * human decision is taken first: a GitHub one counts only from a human with write access, and gets
   * 👀. The event then starts or extends the settle of the head. A decision that does not count asks
   * for no attention, unless it is a review, which a review app may have written.
   */
  const attend = async (event: PullRequestEvent, inSet: boolean): Promise<void> => {
    if (isDecisionEvent(event)) {
      let accepted = false;
      try {
        ({ accepted } = await activities.acknowledgeHumanDecision({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, event: event as DecisionEvent }));
      } catch (error) {
        if (isCancellation(error)) throw error;
        log.warn("the human decision was not taken", { delivery_id: event.deliveryId, error: String(error) });
      }
      if (accepted && !decisions.some((held) => held.deliveryId === event.deliveryId)) decisions.push(event as DecisionEvent);
      if (!accepted && event.kind !== "review") return;
    }
    const now = Date.now();
    attention = attention === null ? { since: now, lastAt: now, key: event.deliveryId, inSet } : { ...attention, lastAt: now, key: event.deliveryId, inSet };
  };

  /**
   * DI-21.209. The quiet window ended. While a review app check on the head still runs, the workflow
   * waits another window, up to the upper wait from the first event. Then it plans once, with the
   * decisions it held, and runs the plan.
   */
  const settle = async (): Promise<void> => {
    const current = attention;
    if (current === null) return;
    let pending = false;
    try {
      ({ pending } = await followUpActivities.readReviewSettle({ tenantId: input.tenantId, pullRequestId: input.pullRequestId }));
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the review state of the head was not read, so the workflow plans now", { error: String(error) });
    }
    if (pending && Date.now() < current.since + SETTLE_MAX_MS) {
      attention = { ...current, lastAt: Date.now() };
      return;
    }
    attention = null;
    const held = decisions.splice(0, decisions.length);
    const planOnce = () =>
      followUpActivities.planSettledFollowUp({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, decisions: held, settleKey: current.key });
    let plan: PullRequestFollowUpPlan;
    try {
      plan = await planInSet(current.inSet, planOnce);
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the settled PR follow-up plan failed", { settle: current.key, error: String(error) });
      return;
    }
    await runChild(plan);
  };

  /**
   * docs/specs/pr-review-merge-and-deploy.md, DI-21.123. The amendment of a history from before the
   * patch `no-comment-amendments`. A failure costs only the amendment.
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

  /** DI-21.220. Writes the body again with the preview link of the head. */
  const preview = async (event: PullRequestEvent): Promise<void> => {
    try {
      await activities.writePullRequestPreviewBody({ tenantId: input.tenantId, pullRequestId: input.pullRequestId });
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn("the preview link was not written", { delivery_id: event.deliveryId, error: String(error) });
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
      if (attention === null) {
        await condition(() => queue.length > 0);
      } else {
        // DI-21.209. A settle exists only after the patch, so its timer is a command of new histories only.
        const quiet = attention.lastAt + SETTLE_QUIET_MS - Date.now();
        if (quiet <= 0 || !(await condition(() => queue.length > 0, quiet))) {
          await settle();
          continue;
        }
      }
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
    // docs/specs/change-sets.md, slice 9, DI-21.158. While another PR workflow of the set runs a set
    // run, this one acts on no event. The record took the event, and the handling waits.
    if (taken.isNew && taken.changeSet === true && patched(SET_RUN_PATCH)) await waitWhileSetHeld(event.kind === "closed");
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
      // DI-21.220. A successful deployment of the head is its preview: the record took it, and the
      // body links it. A failure costs only the link.
      if (event.kind === "deployment_status" && event.state === "success" && patched(PREVIEW_LINK_PATCH)) await preview(event);
      // DI-21.155. A new head of a provider or a consumer moves the status of the set.
      if (taken.changeSet === true && movesSetStatus(event) && patched(CHANGE_SET_STATUS_PATCH)) await setStatuses(event);
      const trigger = autoMergeTriggerOf(event);
      const wanted = trigger === null ? null : await steer(trigger, event.kind === "auto_merge_disabled" ? event.headSha : null);
      // DI-21.209. A new head starts a new settle. The decisions held for the old head stay, and
      // their settle starts again on the new head.
      if (event.kind === "synchronized" && attention !== null) {
        const now = Date.now();
        attention = decisions.length === 0 ? null : { since: now, lastAt: now, key: event.deliveryId, inSet: taken.changeSet === true };
      }
      if (needsAttention(event) && patched(REVIEW_APPS_SETTLE_PATCH)) {
        await attend(event, taken.changeSet === true);
      } else if (mayStartFollowUp(event) && patched(PR_FOLLOW_UP_PATCH)) {
        await followUp(event, taken.changeSet === true);
      }
      // Slice 4. A conflict at any level, or a branch an L4 merge needs up to date, is brought current.
      if ((wanted !== null || mayConflict(event)) && patched(BRING_CURRENT_PATCH)) {
        const reason = wanted ?? ((await conflicts(event)) ? "conflict" : null);
        if (reason !== null) await bringCurrent(reason, event.deliveryId);
      }
      // DI-21.123, DI-21.213. A history from before the patch planned an amendment for a plain comment
      // or a passed PR reviewer check. Since the patch, no such event amends the proof pack.
      if (mayAmend(event) && patched(DEPLOYS_PATCH) && !patched(NO_COMMENT_AMENDMENTS_PATCH)) {
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
        ...(decisions.length === 0 ? {} : { decisions: [...decisions] }),
        ...(attention === null ? {} : { attention }),
      });
    }
  }
};
