import type { IssueStatusPort, IssueWorkflowState } from "~/domain/runs/issue-status.js";

const GRAPHQL_URL = "https://api.linear.app/graphql";
const TIMEOUT_MS = 15_000;

const graphql = async <T>(accessToken: string, query: string, variables: Record<string, unknown>, call: typeof fetch): Promise<T> => {
  const response = await call(GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as { data?: T | null; errors?: Array<{ message?: unknown }> };
  if (!response.ok || body.errors !== undefined || body.data === undefined || body.data === null) {
    const said = body.errors?.map((error) => (typeof error.message === "string" ? error.message : "")).filter(Boolean).join("; ") ?? "";
    throw new Error(`the Linear API answered ${response.status}${said === "" ? "" : `: ${said}`}`);
  }
  return body.data;
};

const STATE_FIELDS = "id name type position";

const ISSUE_STATE_QUERY = `query($id: String!) {
  issue(id: $id) {
    state { ${STATE_FIELDS} }
    team { states(first: 250) { nodes { ${STATE_FIELDS} } } }
  }
}`;

interface StateNode {
  id: string;
  name: string;
  type: string;
  position: number;
}

const toState = (node: StateNode): IssueWorkflowState => ({ id: node.id, name: node.name, type: node.type, position: node.position });

/** Linear answers an unknown issue id with an "Entity not found" error, not with a null issue. */
const isNotFound = (error: unknown): boolean => /entity not found|could not find/i.test(error instanceof Error ? error.message : String(error));

/**
 * docs/specs/egress-honesty-and-issue-status.md. The status moves and the pull request attachment
 * of one workspace. The token acts as the Factoree app, which holds read and write scope.
 */
export const createLinearIssueStatus = (accessToken: string, call: typeof fetch = fetch): IssueStatusPort => ({
  async read(issueId) {
    let data: { issue: { state: StateNode | null; team: { states: { nodes: StateNode[] } } | null } | null };
    try {
      data = await graphql(accessToken, ISSUE_STATE_QUERY, { id: issueId }, call);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    if (data.issue === null || data.issue.state === null) return null;
    return { state: toState(data.issue.state), teamStates: (data.issue.team?.states.nodes ?? []).map(toState) };
  },

  async move(issueId, stateId) {
    const data = await graphql<{ issueUpdate: { success: boolean } }>(
      accessToken,
      "mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }",
      { id: issueId, stateId },
      call,
    );
    if (!data.issueUpdate.success) throw new Error("Linear did not move the issue");
  },

  async attachPullRequest(issueId, pullRequest) {
    // Linear keeps one attachment per URL and issue, so a retry updates the one it made.
    const data = await graphql<{ attachmentCreate: { success: boolean } }>(
      accessToken,
      "mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }",
      { input: { issueId, url: pullRequest.url, title: pullRequest.title, subtitle: pullRequest.subtitle } },
      call,
    );
    if (!data.attachmentCreate.success) throw new Error("Linear did not attach the pull request");
  },
});
