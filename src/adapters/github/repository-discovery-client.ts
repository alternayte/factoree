/** One GitHub call must not hang the discovery service. */
const GITHUB_API_TIMEOUT_MS = 30_000;

const DEFAULT_API_BASE_URL = "https://api.github.com";

const CONFIG_PATH = ".factoree/config.yaml";

/** One repository the GitHub App installation grants, as reported by the GitHub API. */
export interface DiscoveredRepository {
  fullName: string;
  defaultBranch: string;
}

/** The content and the blob SHA of one file read from a repository. */
export interface RepositoryConfigFile {
  content: string;
  sha: string;
}

/**
 * The read side of repository discovery. The next task, the discovery service, consumes this
 * interface, and it treats a null answer from `readConfig` as "this repository does not
 * participate", and a throw as an operational error worth a retry. An implementation must never
 * collapse the two.
 */
export interface RepositoryDiscoveryClient {
  listInstallationRepositories(installationId: string): Promise<DiscoveredRepository[]>;
  readConfig(fullName: string, ref: string): Promise<RepositoryConfigFile | null>;
}

export interface GitHubRepositoryDiscoveryClientOptions {
  apiBaseUrl?: string;
  /** The GitHub App installation token. */
  token: string;
  fetch?: typeof fetch;
}

interface GitHubContentsResponse {
  sha?: unknown;
  content?: unknown;
  encoding?: unknown;
}

interface GitHubInstallationRepositoriesResponse {
  repositories?: unknown;
}

interface GitHubRepositorySummary {
  full_name?: unknown;
  default_branch?: unknown;
}

/**
 * Reads the repositories a GitHub App installation grants, and reads the Factoree configuration
 * file from one of them. It follows the adapter style of `GitHubPullRequests`: the caller
 * supplies the token, `fetch` is injectable for a test, and every failure carries the HTTP
 * status and the repository name.
 */
export class GitHubRepositoryDiscoveryClient implements RepositoryDiscoveryClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubRepositoryDiscoveryClientOptions) {
    this.base = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listInstallationRepositories(installationId: string): Promise<DiscoveredRepository[]> {
    const discovered: DiscoveredRepository[] = [];
    let url: string | null =
      `${this.base}/installation/repositories?per_page=100&installation_id=${encodeURIComponent(installationId)}`;
    while (url !== null) {
      const response = await this.request(url);
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `the GitHub API answered ${String(response.status)} while it listed the repositories of installation ${installationId}`,
        );
      }
      const body = (text === "" ? {} : JSON.parse(text)) as GitHubInstallationRepositoriesResponse;
      const repositories = Array.isArray(body.repositories) ? body.repositories : [];
      for (const entry of repositories) {
        discovered.push(this.toDiscoveredRepository(entry as GitHubRepositorySummary));
      }
      url = this.nextPageUrl(response.headers.get("link"));
    }
    return discovered;
  }

  async readConfig(fullName: string, ref: string): Promise<RepositoryConfigFile | null> {
    const query = new URLSearchParams({ ref });
    const url = `${this.base}/repos/${fullName}/contents/${CONFIG_PATH}?${query.toString()}`;
    const response = await this.request(url);
    if (response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `the GitHub API answered ${String(response.status)} while it read the configuration of ${fullName} at ${ref}`,
      );
    }
    const body = (text === "" ? {} : JSON.parse(text)) as GitHubContentsResponse;
    const sha = body.sha;
    const content = body.content;
    if (typeof sha !== "string" || typeof content !== "string") {
      throw new Error(`the GitHub API answered a configuration file of ${fullName} without a SHA or content`);
    }
    return { content: Buffer.from(content, "base64").toString("utf8"), sha };
  }

  private toDiscoveredRepository(entry: GitHubRepositorySummary): DiscoveredRepository {
    const fullName = entry.full_name;
    const defaultBranch = entry.default_branch;
    if (typeof fullName !== "string" || typeof defaultBranch !== "string") {
      throw new Error("the GitHub API answered a repository without a full name or a default branch");
    }
    return { fullName, defaultBranch };
  }

  /** The URL of the next page, read from a `link` header, or null when no next page exists. */
  private nextPageUrl(linkHeader: string | null): string | null {
    if (linkHeader === null) return null;
    for (const part of linkHeader.split(",")) {
      const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
      if (match?.[1] !== undefined) return match[1];
    }
    return null;
  }

  private async request(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
    timer.unref();
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "factoree",
          // The credential appears here and nowhere else. It never reaches a message below.
          authorization: `Bearer ${this.token}`,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
