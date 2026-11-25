import type { AutoMergeTrigger } from "~/activities/pull-request.activities.js";
import type { PullRequestEvent } from "~/domain/pull-requests/pull-request-event.js";

/**
 * docs/specs/pr-review-merge-and-deploy.md. The pure event classes of the PR workflow. The workflow
 * bundle imports this module by a relative path, and it imports nothing at run time.
 */

/** DI-21.155. The events that change the merge-order status of a change set: a new head, a reopen and a close. */
export const movesSetStatus = (event: PullRequestEvent): boolean => event.kind === "synchronized" || event.kind === "reopened" || event.kind === "closed";

/** DI-21.117. The events after which the branch may conflict with its base. */
export const mayConflict = (event: PullRequestEvent): boolean =>
  event.kind === "base_pushed" || event.kind === "synchronized" || event.kind === "reopened" || event.kind === "edited";

/**
 * DI-21.123. The events that listed themselves in the proof pack in a history from before the patch
 * `no-comment-amendments`: a submitted comment review, and a check run or commit status that passed.
 */
export const mayAmend = (event: PullRequestEvent): boolean =>
  (event.kind === "review" && event.action === "submitted" && event.state === "commented") ||
  (event.kind === "check_run" && event.status === "completed" && event.conclusion === "success") ||
  (event.kind === "commit_status" && event.state === "success");

/**
 * DI-21.104. The trigger of the L4 merge for one taken event. A close ends the workflow, and a deploy
 * changes no merge condition, so neither steers.
 */
export const autoMergeTriggerOf = (event: PullRequestEvent): AutoMergeTrigger | null => {
  switch (event.kind) {
    case "closed":
    case "deployment_status":
    // docs/specs/pr-feedback-loop.md. A conversation comment and a Linear reply change no merge
    // condition. These kinds reach no history from before them, so the switch needs no patch.
    case "comment":
    case "linear_reply":
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
