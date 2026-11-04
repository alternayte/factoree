export const buildWorkflowId = (workspaceId: string, agentSessionId: string): string => {
  if (!workspaceId || !agentSessionId) throw new Error("workspaceId and agentSessionId are required");
  return `linear:${workspaceId}:${agentSessionId}`;
};

/** docs/specs/run-recovery.md. The workflow of a follow-up run of one failed run. */
export const buildFollowUpWorkflowId = (workspaceId: string, agentSessionId: string, failedRunId: string): string =>
  `${buildWorkflowId(workspaceId, agentSessionId)}:follow-up:${failedRunId}`;

export interface ParsedWorkflowId {
  workspaceId: string;
  agentSessionId: string;
}

export const parseWorkflowId = (workflowId: string): ParsedWorkflowId => {
  const parts = workflowId.split(":");
  const [prefix, workspaceId, agentSessionId] = parts;
  // docs/specs/run-recovery.md. A follow-up run adds `:follow-up:<failed run id>`.
  const followUp = parts.length === 5 && parts[3] === "follow-up" && Boolean(parts[4]);
  if ((parts.length !== 3 && !followUp) || prefix !== "linear" || !workspaceId || !agentSessionId) {
    throw new Error(`malformed workflow id ${workflowId}`);
  }
  return { workspaceId, agentSessionId };
};
