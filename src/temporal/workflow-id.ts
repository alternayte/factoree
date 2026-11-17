export const buildWorkflowId = (workspaceId: string, agentSessionId: string): string => {
  if (!workspaceId || !agentSessionId) throw new Error("workspaceId and agentSessionId are required");
  return `linear:${workspaceId}:${agentSessionId}`;
};

/** docs/specs/run-recovery.md. The workflow of a follow-up run of one failed run. */
export const buildFollowUpWorkflowId = (workspaceId: string, agentSessionId: string, failedRunId: string): string =>
  `${buildWorkflowId(workspaceId, agentSessionId)}:follow-up:${failedRunId}`;

/**
 * docs/specs/pr-review-merge-and-deploy.md, D6. The workflow of one PR follow-up run. It shares the
 * agent session of the run that published the pull request, so the Linear calls of the worker find
 * the workspace in its id. The key names the event that started it and holds no colon.
 */
export const buildPrFollowUpWorkflowId = (workspaceId: string, agentSessionId: string, key: string): string => {
  if (!key || key.includes(":")) throw new Error("a PR follow-up workflow id needs a key without a colon");
  return `${buildWorkflowId(workspaceId, agentSessionId)}:pr-follow-up:${key}`;
};

/** True for the workflow id of a PR follow-up run. */
export const isPrFollowUpWorkflowId = (workflowId: string): boolean => workflowId.split(":")[3] === "pr-follow-up";

/**
 * docs/specs/draft-of-failed-run.md. The one workflow that publishes the draft of one failed run.
 * Temporal refuses a second start while it runs, so a second request finds it.
 */
export const buildDraftWorkflowId = (runId: string): string => {
  if (!runId) throw new Error("runId is required");
  return `draft-${runId}`;
};

export interface ParsedWorkflowId {
  workspaceId: string;
  agentSessionId: string;
}

export const parseWorkflowId = (workflowId: string): ParsedWorkflowId => {
  const parts = workflowId.split(":");
  const [prefix, workspaceId, agentSessionId] = parts;
  // docs/specs/run-recovery.md. A follow-up run adds `:follow-up:<failed run id>`. D6: a PR
  // follow-up run adds `:pr-follow-up:<key>`.
  const followUp = parts.length === 5 && (parts[3] === "follow-up" || parts[3] === "pr-follow-up") && Boolean(parts[4]);
  if ((parts.length !== 3 && !followUp) || prefix !== "linear" || !workspaceId || !agentSessionId) {
    throw new Error(`malformed workflow id ${workflowId}`);
  }
  return { workspaceId, agentSessionId };
};
