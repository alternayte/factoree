import { condition, continueAsNew, defineQuery, defineSignal, log, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import type { Activities } from "~/activities/index.js";
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

/**
 * docs/specs/pr-review-merge-and-deploy.md, DI-21.101. One workflow per published pull request, keyed
 * `pr:<tenant>:<repository>#<number>`. The run that published the pull request ends READY_FOR_HUMAN and
 * frees its slot (DI-15.13). This workflow takes the events after that, one at a time, in the order
 * they arrive.
 *
 * Every event is recorded once on the pull request. A merge or a close moves the issue through the
 * origin run and ends the workflow. The other kinds change only the record: the head commit on a
 * synchronize, the base branch on an edit. The L4 merge, the PR follow-up runs, the bring-current
 * update and the deploy report each add their handling of their event kinds to this loop.
 */
export const pullRequestWorkflow = async (input: PullRequestWorkflowInput): Promise<PullRequestState> => {
  const queue: PullRequestEvent[] = [...(input.pending ?? [])];
  const view: PullRequestWorkflowState = { state: "open", headSha: null, pending: queue.length, taken: 0 };
  setHandler(pullRequestEventSignal, (event) => {
    queue.push(event);
    view.pending = queue.length;
  });
  setHandler(pullRequestStateQuery, () => view);

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
    }
    // A pull request with many check runs takes many events. The history starts again before it
    // grows too large, and the events not yet taken move to the new run.
    if (workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof pullRequestWorkflow>({ tenantId: input.tenantId, pullRequestId: input.pullRequestId, pending: [...queue] });
    }
  }
};
