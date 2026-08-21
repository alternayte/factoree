import type { AgentSessionPort } from "~/domain/runs/ports.js";

export interface LinearActivityDependencies {
  agentSession: AgentSessionPort;
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
});
