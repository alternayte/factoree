import { signGitHubAppJwt, type GitHubAppCredentials } from "./app-token-provider.js";

/**
 * docs/specs/release-0-1-0.md. The GitHub App manifest flow of setup. The permissions and the
 * events are the ones docs/quickstart.md granted by hand before 0.1.0, plus Workflows
 * (DI-21.33), Issues read (DI-21.41) and Pull request (DI-21.51).
 * docs/specs/pr-review-merge-and-deploy.md (D4) adds Checks read, Commit statuses read and the
 * events pull_request_review, check_run and status. docs/specs/change-sets.md changes Commit
 * statuses to write: Factoree sets `factoree/change-set` on each consumer head. GitHub delivers `installation` and
 * `installation_repositories` to every App, so the manifest does not name them.
 */
export const GITHUB_APP_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  // DI-21.33. GitHub refuses a push that creates or changes a file in .github/workflows without it.
  workflows: "write",
  // DI-21.41. A work item link to a GitHub issue of the product is read with an issues:read token.
  issues: "read",
  deployments: "read",
  metadata: "read",
  // docs/specs/pr-review-merge-and-deploy.md. The PR reviewer verdict is a check run or a commit
  // status on the pull request head.
  checks: "read",
  // docs/specs/change-sets.md, DI-21.155. Factoree sets the factoree/change-set status on each
  // consumer head of a change set.
  statuses: "write",
} as const;

// docs/specs/egress-honesty-and-issue-status.md. A close without a merge makes no push, so the
// pull_request event says when a pull request of a run merged or closed.
// docs/specs/pr-review-merge-and-deploy.md. The PR workflow takes reviews, check runs and commit
// statuses.
export const GITHUB_APP_EVENTS = ["push", "deployment_status", "pull_request", "pull_request_review", "check_run", "status"] as const;

/** The access GitHub ranks above each level. */
const LEVEL_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** One permission the installation lacks, with the level it holds, or null for none. */
export interface MissingGitHubPermission {
  name: keyof typeof GITHUB_APP_PERMISSIONS;
  required: (typeof GITHUB_APP_PERMISSIONS)[keyof typeof GITHUB_APP_PERMISSIONS];
  granted: string | null;
}

/**
 * docs/specs/pr-review-merge-and-deploy.md. An existing installation keeps its old permissions until
 * an owner accepts the new ones. This compares what it holds with what the manifest asks for.
 */
export const missingGitHubAccess = (granted: {
  permissions: Record<string, string>;
  events: readonly string[];
}): { permissions: MissingGitHubPermission[]; events: string[] } => {
  const permissions: MissingGitHubPermission[] = [];
  for (const [name, required] of Object.entries(GITHUB_APP_PERMISSIONS) as [MissingGitHubPermission["name"], MissingGitHubPermission["required"]][]) {
    const held = granted.permissions[name] ?? null;
    if ((held === null ? 0 : (LEVEL_RANK[held] ?? 0)) < (LEVEL_RANK[required] ?? 0)) permissions.push({ name, required, granted: held });
  }
  const events = GITHUB_APP_EVENTS.filter((event) => !granted.events.includes(event));
  return { permissions, events };
};

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

/** One installation of the App, with the permissions and the events it accepted. */
export interface GitHubAppInstallation {
  id: string;
  accountLogin: string;
  permissions: Record<string, string>;
  events: string[];
  /** The installation settings page, where an owner accepts new permissions. */
  settingsUrl: string | null;
}

/** Reads one installation of the App. A 404 means the installation belongs to another App. */
export const readGitHubAppInstallation = async (
  input: { credentials: GitHubAppCredentials; installationId: string },
  call: typeof fetch = fetch,
): Promise<GitHubAppInstallation | null> => {
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
  const body = (await response.json()) as {
    id?: unknown;
    account?: { login?: unknown };
    permissions?: unknown;
    events?: unknown;
    html_url?: unknown;
  };
  if (typeof body.id !== "number" || typeof body.account?.login !== "string") {
    throw new Error("GitHub returned an installation without an id or an account");
  }
  const permissions: Record<string, string> = {};
  if (body.permissions !== null && typeof body.permissions === "object") {
    for (const [name, level] of Object.entries(body.permissions as Record<string, unknown>)) {
      if (typeof level === "string") permissions[name] = level;
    }
  }
  return {
    id: String(body.id),
    accountLogin: body.account.login,
    permissions,
    events: Array.isArray(body.events) ? body.events.filter((event): event is string => typeof event === "string") : [],
    settingsUrl: typeof body.html_url === "string" ? body.html_url : null,
  };
};
