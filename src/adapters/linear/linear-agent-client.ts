import { LinearClient } from "@linear/sdk";
import type { AgentSessionPort } from "~/domain/runs/ports.js";

export type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

export interface AgentActivityCreator {
  createAgentActivity(input: {
    agentSessionId: string;
    content: AgentActivityContent;
  }): Promise<unknown>;
}

export class LinearAgentClient implements AgentSessionPort {
  constructor(private readonly client: AgentActivityCreator) {}

  private async emit(sessionId: string, content: AgentActivityContent): Promise<void> {
    await this.client.createAgentActivity({ agentSessionId: sessionId, content });
  }

  acknowledge(sessionId: string, message: string): Promise<void> {
    return this.emit(sessionId, { type: "thought", body: message });
  }

  progress(sessionId: string, message: string): Promise<void> {
    return this.emit(sessionId, { type: "thought", body: message });
  }

  elicit(sessionId: string, question: string): Promise<void> {
    return this.emit(sessionId, { type: "elicitation", body: question });
  }

  respond(sessionId: string, body: string): Promise<void> {
    return this.emit(sessionId, { type: "response", body });
  }

  fail(sessionId: string, message: string): Promise<void> {
    return this.emit(sessionId, { type: "error", body: message });
  }
}

export const createLinearAgentClient = (accessToken: string): LinearAgentClient =>
  new LinearAgentClient(new LinearClient({ accessToken }));
