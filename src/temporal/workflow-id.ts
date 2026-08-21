export const buildWorkflowId = (workspaceId: string, agentSessionId: string): string => {
  if (!workspaceId || !agentSessionId) throw new Error("workspaceId and agentSessionId are required");
  return `linear:${workspaceId}:${agentSessionId}`;
};
