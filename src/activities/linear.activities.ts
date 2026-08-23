import type { AgentSessionPort, WorkItemPort } from "~/domain/runs/ports.js";

export interface LinearActivityDependencies {
  agentSession: AgentSessionPort;
  workItems: WorkItemPort;
}

export const createLinearActivities = (dependencies: LinearActivityDependencies) => ({
  acknowledgeSession: (input: { sessionId: string; message: string }): Promise<void> =>
    dependencies.agentSession.acknowledge(input.sessionId, input.message),
  postProgress: (input: { sessionId: string; message: string }): Promise<void> =>
    dependencies.agentSession.progress(input.sessionId, input.message),
  postElicitation: (input: { sessionId: string; question: string }): Promise<void> =>
    dependencies.agentSession.elicit(input.sessionId, input.question),
  postFinalResponse: (input: { sessionId: string; body: string }): Promise<void> =>
    dependencies.agentSession.respond(input.sessionId, input.body),
  postError: (input: { sessionId: string; message: string }): Promise<void> =>
    dependencies.agentSession.fail(input.sessionId, input.message),
  /**
   * SDD section 28. The agent session webhook carries no label, so the cap needs a read against
   * the Linear API. An issue that no longer exists, and a transport fault the retry policy has
   * already exhausted, both yield no label, and the Run then runs at its Project default. The
   * cap must never invent a label it did not see.
   */
  async fetchWorkItemLabels(input: { sessionId: string; issueId: string }): Promise<string[]> {
    return await dependencies.workItems.labels(input.sessionId, input.issueId);
  },
});
