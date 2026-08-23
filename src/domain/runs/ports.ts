export interface AgentSessionPort {
  acknowledge(sessionId: string, message: string): Promise<void>;
  progress(sessionId: string, message: string): Promise<void>;
  elicit(sessionId: string, question: string): Promise<void>;
  respond(sessionId: string, body: string): Promise<void>;
  fail(sessionId: string, message: string): Promise<void>;
}

/**
 * SDD section 28. The agent session webhook carries no label, so the cap needs a read against
 * the Linear API. The worker resolves the workspace client from the session identifier, in the
 * same way it already does for `AgentSessionPort`, and the issue identifier names the Work Item.
 */
export interface WorkItemPort {
  labels(sessionId: string, issueId: string): Promise<string[]>;
}
