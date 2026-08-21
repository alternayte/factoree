export const buildWorkflowId = (workspaceId: string, agentSessionId: string): string => {
  if (!workspaceId || !agentSessionId) throw new Error("workspaceId and agentSessionId are required");
  return `linear:${workspaceId}:${agentSessionId}`;
};

export interface ParsedWorkflowId {
  workspaceId: string;
  agentSessionId: string;
}

export const parseWorkflowId = (workflowId: string): ParsedWorkflowId => {
  const parts = workflowId.split(":");
  const [prefix, workspaceId, agentSessionId] = parts;
  if (parts.length !== 3 || prefix !== "linear" || !workspaceId || !agentSessionId) {
    throw new Error(`malformed workflow id ${workflowId}`);
  }
  return { workspaceId, agentSessionId };
};
