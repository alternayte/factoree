import { signGitHubAppJwt, type GitHubAppCredentials } from "./app-token-provider.js";

/**
 * docs/specs/release-0-1-0.md. The GitHub App manifest flow of setup. The permissions and the
 * events are the ones docs/quickstart.md granted by hand before 0.1.0: four repository
 * permissions and two events. GitHub delivers `installation` and `installation_repositories` to
 * every App, so the manifest does not name them.
 */
export const GITHUB_APP_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  deployments: "read",
  metadata: "read",
} as const;

export const GITHUB_APP_EVENTS = ["push", "deployment_status"] as const;

export interface GitHubAppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  setup_url: string;
  setup_on_update: boolean;
  public: boolean;
  default_permissions: typeof GITHUB_APP_PERMISSIONS;
  default_events: (typeof GITHUB_APP_EVENTS)[number][];
}

export const buildGitHubAppManifest = (input: { publicUrl: string; name: string }): GitHubAppManifest => ({
  name: input.name,
  url: input.publicUrl,
  hook_attributes: { url: `${input.publicUrl}/webhooks/github`, active: true },
  redirect_url: `${input.publicUrl}/setup/github/created`,
  setup_url: `${input.publicUrl}/setup/github/installed`,
  setup_on_update: true,
  public: false,
  default_permissions: GITHUB_APP_PERMISSIONS,
  default_events: [...GITHUB_APP_EVENTS],
});

/** The page the browser posts the manifest to: a user account, or an organization. */
export const gitHubAppCreationUrl = (input: { githubBaseUrl: string; organization: string | null; state: string }): string => {
  const base = input.githubBaseUrl.replace(/\/+$/, "");
  const path =
    input.organization === null
      ? "/settings/apps/new"
      : `/organizations/${encodeURIComponent(input.organization)}/settings/apps/new`;
  return `${base}${path}?${new URLSearchParams({ state: input.state }).toString()}`;
};

export interface ConvertedGitHubApp {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKey: string;
  htmlUrl: string;
}

/** Exchanges the one-hour code GitHub returned for the App identity. The call needs no credential. */
export const convertGitHubAppManifest = async (
  input: { apiBaseUrl: string; code: string },
  call: typeof fetch = fetch,
): Promise<ConvertedGitHubApp> => {
  const response = await call(
    `${input.apiBaseUrl.replace(/\/+$/, "")}/app-manifests/${encodeURIComponent(input.code)}/conversions`,
    {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(15_000),
    },
  );
  // The body of a success holds the private key, so no body reaches an error message.
  if (response.status !== 201) throw new Error(`GitHub answered ${response.status} to the manifest conversion`);
  const body = (await response.json()) as Record<string, unknown>;
  const text = (key: string): string => {
    const value = body[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
    throw new Error(`the manifest conversion returned no ${key}`);
  };
  return {
    appId: text("id"),
    slug: text("slug"),
    clientId: text("client_id"),
    clientSecret: text("client_secret"),
    webhookSecret: text("webhook_secret"),
    privateKey: text("pem"),
    htmlUrl: text("html_url"),
  };
};

/** Reads one installation of the App. A 404 means the installation belongs to another App. */
export const readGitHubAppInstallation = async (
  input: { credentials: GitHubAppCredentials; installationId: string },
  call: typeof fetch = fetch,
): Promise<{ id: string; accountLogin: string } | null> => {
  const { credentials } = input;
  const response = await call(
    `${credentials.apiBaseUrl.replace(/\/+$/, "")}/app/installations/${encodeURIComponent(input.installationId)}`,
    {
      headers: {
        authorization: `Bearer ${signGitHubAppJwt(credentials.appId, credentials.privateKey, Date.now())}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status} to the installation read`);
  const body = (await response.json()) as { id?: unknown; account?: { login?: unknown } };
  if (typeof body.id !== "number" || typeof body.account?.login !== "string") {
    throw new Error("GitHub returned an installation without an id or an account");
  }
  return { id: String(body.id), accountLogin: body.account.login };
};
