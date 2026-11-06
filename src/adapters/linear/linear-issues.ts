import type { AppChangeIssuePort } from "~/domain/setup/app-change-issues.js";

const GRAPHQL_URL = "https://api.linear.app/graphql";
const TIMEOUT_MS = 15_000;

const graphql = async <T>(accessToken: string, query: string, variables: Record<string, unknown>, call: typeof fetch): Promise<T> => {
  const response = await call(GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json()) as { data?: T; errors?: Array<{ message?: unknown }> };
  if (!response.ok || body.errors !== undefined || body.data === undefined) {
    const said = body.errors?.map((error) => (typeof error.message === "string" ? error.message : "")).filter(Boolean).join("; ") ?? "";
    throw new Error(`the Linear API answered ${response.status}${said === "" ? "" : `: ${said}`}`);
  }
  return body.data;
};

/**
 * docs/specs/setup-app-change-issues.md. The token acts as the Factoree app (`actor=app`), so the
 * viewer is the app user, and an issue delegated to it starts a run like a human delegation.
 */
export const createLinearIssues = (accessToken: string, call: typeof fetch = fetch): AppChangeIssuePort => ({
  async createDelegatedIssue(input) {
    const viewer = await graphql<{ viewer: { id: string } }>(accessToken, "{ viewer { id } }", {}, call);
    const created = await graphql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string } | null } }>(
      accessToken,
      "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }",
      { input: { teamId: input.teamId, title: input.title, description: input.description, delegateId: viewer.viewer.id } },
      call,
    );
    if (!created.issueCreate.success || created.issueCreate.issue === null) throw new Error("Linear did not create the app-change issue");
    return created.issueCreate.issue;
  },
});
