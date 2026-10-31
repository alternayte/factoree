export interface AgentSessionPort {
  acknowledge(sessionId: string, message: string): Promise<void>;
  progress(sessionId: string, message: string): Promise<void>;
  elicit(sessionId: string, question: string): Promise<void>;
  respond(sessionId: string, body: string): Promise<void>;
  fail(sessionId: string, message: string): Promise<void>;
  /**
   * docs/specs/proof-pack-and-visual-evidence.md. Adds one link to the session, for example the
   * pull request or the pull request preview. Linear shows it as an Open button.
   */
  addLink(sessionId: string, label: string, url: string): Promise<void>;
}

/**
 * SDD section 28. The agent session webhook carries no label, so the cap needs a read against
 * the Linear API. The worker resolves the workspace client from the session identifier, in the
 * same way it already does for `AgentSessionPort`, and the issue identifier names the Work Item.
 */
export interface WorkItemPort {
  /**
   * The labels of the Work Item, and the name of its Linear project or null.
   * docs/specs/own-proposals-and-parallel-runs.md uses the project to choose the target.
   */
  facts(sessionId: string, issueId: string): Promise<WorkItemFacts>;
}

export interface WorkItemFacts {
  labels: string[];
  project: string | null;
}
