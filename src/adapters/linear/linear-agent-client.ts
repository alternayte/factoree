import { LinearClient } from "@linear/sdk";
import type { AgentSessionPort } from "~/domain/runs/ports.js";

export type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

/** One label the Linear SDK reports on an issue. */
interface LinearIssueLabel {
  name: string;
}

/** The Linear SDK issue shape this adapter reads, narrowed to the fields it uses. */
interface LinearIssueWithLabels {
  labels(): Promise<{ nodes: LinearIssueLabel[] } | null>;
}

export interface LinearApi {
  createAgentActivity(input: {
    agentSessionId: string;
    content: AgentActivityContent;
  }): Promise<unknown>;
  issue(issueId: string): Promise<LinearIssueWithLabels | null>;
}

/** @deprecated Use `LinearApi`, which also carries the `issue` lookup of SDD section 28. */
export type AgentActivityCreator = LinearApi;

export class LinearAgentClient implements AgentSessionPort {
  constructor(private readonly client: LinearApi) {}

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

  /**
   * SDD section 28. A null issue and a null label list both yield an empty list, so the cap
   * never invents a label it did not see.
   */
  async labels(issueId: string): Promise<string[]> {
    const issue = await this.client.issue(issueId);
    if (issue === null) return [];
    const labels = await issue.labels();
    if (labels === null) return [];
    return labels.nodes.map((label) => label.name);
  }
}

export const createLinearAgentClient = (accessToken: string): LinearAgentClient =>
  new LinearAgentClient(new LinearClient({ accessToken }));
