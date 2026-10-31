/**
 * docs/specs/release-0-1-0.md. The Linear calls of setup and sign-in: the app install grant
 * (actor=app), the read of the workspace it was granted in, the team list of the first Product,
 * and the viewer of a person who signs in. A token endpoint answers with tokens, so no response
 * body ever reaches an error message (SDD section 60).
 */

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const GRAPHQL_URL = "https://api.linear.app/graphql";
const TIMEOUT_MS = 15_000;

/** `actor=app` makes the token act as the Factoree agent, not as the person who installs it. */
export const LINEAR_APP_SCOPES = ["read", "write", "app:assignable", "app:mentionable"];

export const linearInstallUrl = (input: { clientId: string; redirectUri: string; state: string }): string =>
  `${AUTHORIZE_URL}?${new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: LINEAR_APP_SCOPES.join(","),
    actor: "app",
    state: input.state,
  }).toString()}`;

export interface LinearAppGrant {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scopes: string[];
}

export const exchangeLinearCode = async (
  input: { clientId: string; clientSecret: string; redirectUri: string; code: string },
  call: typeof fetch = fetch,
): Promise<LinearAppGrant> => {
  const response = await call(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
      code: input.code,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`the Linear token endpoint answered ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.access_token !== "string") throw new Error("the Linear token endpoint answered without an access token");
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
    scopes: typeof body.scope === "string" ? body.scope.split(/[ ,]+/).filter(Boolean) : [],
  };
};

const graphql = async <T>(accessToken: string, query: string, call: typeof fetch): Promise<T> => {
  const response = await call(GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json()) as { data?: T; errors?: unknown };
  if (!response.ok || body.errors !== undefined || body.data === undefined) {
    throw new Error(`the Linear API answered ${response.status}`);
  }
  return body.data;
};

export const readLinearOrganization = async (
  accessToken: string,
  call: typeof fetch = fetch,
): Promise<{ id: string; name: string; appUserId: string | null }> => {
  const data = await graphql<{ organization: { id: string; name: string }; viewer: { id: string } | null }>(
    accessToken,
    "{ organization { id name } viewer { id } }",
    call,
  );
  return { id: data.organization.id, name: data.organization.name, appUserId: data.viewer?.id ?? null };
};

export const listLinearTeams = async (
  accessToken: string,
  call: typeof fetch = fetch,
): Promise<Array<{ id: string; key: string; name: string }>> => {
  const data = await graphql<{ teams: { nodes: Array<{ id: string; key: string; name: string }> } }>(
    accessToken,
    "{ teams(first: 250) { nodes { id key name } } }",
    call,
  );
  return data.teams.nodes;
};

export interface LinearViewerProfile {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  admin: boolean;
  organizationId: string;
}

/** The person behind a sign-in token: who, which workspace, and whether a workspace admin. */
export const readLinearViewer = async (accessToken: string, call: typeof fetch = fetch): Promise<LinearViewerProfile> => {
  const data = await graphql<{
    viewer: Omit<LinearViewerProfile, "organizationId"> & { organization: { id: string } };
  }>(
    accessToken,
    "{ viewer { id name email avatarUrl active createdAt updatedAt admin organization { id } } }",
    call,
  );
  const { organization, ...viewer } = data.viewer;
  return { ...viewer, organizationId: organization.id };
};
