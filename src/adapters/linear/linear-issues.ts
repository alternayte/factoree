import type { AppChangeIssuePort } from "~/domain/setup/app-change-issues.js";

/** docs/specs/retro-agent.md. An issue Factoree creates from a retro finding, delegated to Factoree or not. */
export interface LinearIssueCreator extends AppChangeIssuePort {
  createIssue(input: { teamId: string; title: string; description: string; delegate: boolean }): Promise<{ id: string; identifier: string; url: string }>;
}

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
export const createLinearIssues = (accessToken: string, call: typeof fetch = fetch): LinearIssueCreator => {
  const createIssue = async (input: { teamId: string; title: string; description: string; delegate: boolean }) => {
    const delegateId = input.delegate ? (await graphql<{ viewer: { id: string } }>(accessToken, "{ viewer { id } }", {}, call)).viewer.id : undefined;
    const created = await graphql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null } }>(
      accessToken,
      "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
      { input: { teamId: input.teamId, title: input.title, description: input.description, ...(delegateId === undefined ? {} : { delegateId }) } },
      call,
    );
    if (!created.issueCreate.success || created.issueCreate.issue === null) throw new Error("Linear did not create the issue");
    return created.issueCreate.issue;
  };
  return {
    createIssue,
    createDelegatedIssue: (input) => createIssue({ ...input, delegate: true }),
  };
};
