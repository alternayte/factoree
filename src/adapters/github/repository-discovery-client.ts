import { resolveGitHubApiBaseUrl, type GitHubApiBaseUrl } from "./api-base-url.js";
import { GitHubApiError } from "~/adapters/github/github-pull-requests.js";
import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";
import type { RepositoryFileEntry } from "~/domain/runs/warm-snapshot.js";

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
 * interface. It treats a null answer from `readConfig` as "this repository does not
 * participate". It treats a throw as an operational error worth a retry. An implementation must
 * never collapse the two.
 */
export interface RepositoryDiscoveryClient {
  listInstallationRepositories(installationId: string): Promise<DiscoveredRepository[]>;
  readConfig(fullName: string, ref: string, githubInstallationId: string): Promise<RepositoryConfigFile | null>;
  /**
   * docs/specs/repository-setup-and-services.md. Every file of the repository at the ref, with its
   * git blob SHA. Null when GitHub truncated the tree, so the caller cannot know the key files.
   */
  listFiles(fullName: string, ref: string, githubInstallationId: string): Promise<RepositoryFileEntry[] | null>;
}

/**
 * docs/specs/setup-speed-and-history.md. Reads one file and the head commit of a repository through
 * the GitHub API, so a setup computes its input key before any sandbox starts.
 */
export interface RepositoryFileReader {
  /** The text of one file at the ref, or null when the file does not exist. */
  readFile(fullName: string, path: string, ref: string, githubInstallationId: string): Promise<string | null>;
  /** The commit SHA the ref points to. */
  headSha(fullName: string, ref: string, githubInstallationId: string): Promise<string>;
}

export interface GitHubRepositoryDiscoveryClientOptions {
  apiBaseUrl?: GitHubApiBaseUrl;
  /** Mints the GitHub App installation token. The client holds no token of its own. */
  tokens: GitHubTokenProvider;
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
 * Reads the repositories a GitHub App installation grants. It also reads the Factoree
 * configuration file from one of them. It follows the adapter style of `GitHubPullRequests`.
 * The caller supplies the token. `fetch` is injectable for a test. Every failure carries
 * the HTTP status and the repository name.
 */
export class GitHubRepositoryDiscoveryClient implements RepositoryDiscoveryClient, RepositoryFileReader {
  private readonly apiBaseUrl: GitHubApiBaseUrl;
  private readonly tokens: GitHubTokenProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubRepositoryDiscoveryClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.tokens = options.tokens;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * GitHub scopes this endpoint by the installation access token. The client mints a token for
   * `installationId` on every request, so it never holds a token that can serve the wrong
   * installation. The identifier never reaches the URL.
   */
  async listInstallationRepositories(installationId: string): Promise<DiscoveredRepository[]> {
    const discovered: DiscoveredRepository[] = [];
    const base = await resolveGitHubApiBaseUrl(this.apiBaseUrl);
    let url: string | null = `${base}/installation/repositories?per_page=100`;
    while (url !== null) {
      const response = await this.request(url, installationId);
      const text = await response.text();
      if (!response.ok) {
        throw new GitHubApiError(
          `the GitHub API answered ${String(response.status)} while it listed the repositories of installation ${installationId}`,
          response.status,
          this.rateLimitHeaders(response.headers),
        );
      }
      const body = (text === "" ? {} : JSON.parse(text)) as GitHubInstallationRepositoriesResponse;
      const repositories = Array.isArray(body.repositories) ? body.repositories : [];
      for (const entry of repositories) {
        discovered.push(this.toDiscoveredRepository(entry as GitHubRepositorySummary));
      }
      url = this.nextPageUrl(base, response.headers.get("link"));
    }
    return discovered;
  }

  async readConfig(
    fullName: string,
    ref: string,
    githubInstallationId: string,
  ): Promise<RepositoryConfigFile | null> {
    return this.readContents(fullName, CONFIG_PATH, ref, githubInstallationId);
  }

  async readFile(fullName: string, path: string, ref: string, githubInstallationId: string): Promise<string | null> {
    return (await this.readContents(fullName, path, ref, githubInstallationId))?.content ?? null;
  }

  async headSha(fullName: string, ref: string, githubInstallationId: string): Promise<string> {
    const url = `${await resolveGitHubApiBaseUrl(this.apiBaseUrl)}/repos/${fullName}/commits/${encodeURIComponent(ref)}`;
    const response = await this.request(url, githubInstallationId);
    const text = await response.text();
    if (!response.ok) {
      throw new GitHubApiError(
        `the GitHub API answered ${String(response.status)} while it read the head of ${fullName} at ${ref}`,
        response.status,
        this.rateLimitHeaders(response.headers),
      );
    }
    const sha = (JSON.parse(text) as { sha?: unknown }).sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`the GitHub API answered no commit SHA for ${fullName} at ${ref}`);
    return sha;
  }

  private async readContents(fullName: string, path: string, ref: string, githubInstallationId: string): Promise<RepositoryConfigFile | null> {
    const query = new URLSearchParams({ ref });
    const url = `${await resolveGitHubApiBaseUrl(this.apiBaseUrl)}/repos/${fullName}/contents/${path}?${query.toString()}`;
    const response = await this.request(url, githubInstallationId);
    if (response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) {
      throw new GitHubApiError(
        `the GitHub API answered ${String(response.status)} while it read ${path} of ${fullName} at ${ref}`,
        response.status,
        this.rateLimitHeaders(response.headers),
      );
    }
    const body = (text === "" ? {} : JSON.parse(text)) as GitHubContentsResponse;
    const sha = body.sha;
    const content = body.content;
    // A directory answers an array, with no content of its own.
    if (Array.isArray(body)) return null;
    if (typeof sha !== "string" || typeof content !== "string") {
      throw new Error(`the GitHub API answered ${path} of ${fullName} without a SHA or content`);
    }
    return { content: Buffer.from(content, "base64").toString("utf8"), sha };
  }

  async listFiles(fullName: string, ref: string, githubInstallationId: string): Promise<RepositoryFileEntry[] | null> {
    const url = `${await resolveGitHubApiBaseUrl(this.apiBaseUrl)}/repos/${fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    const response = await this.request(url, githubInstallationId);
    const text = await response.text();
    if (!response.ok) {
      throw new GitHubApiError(
        `the GitHub API answered ${String(response.status)} while it listed the files of ${fullName} at ${ref}`,
        response.status,
        this.rateLimitHeaders(response.headers),
      );
    }
    const body = (text === "" ? {} : JSON.parse(text)) as { truncated?: unknown; tree?: unknown };
    if (body.truncated === true || !Array.isArray(body.tree)) return null;
    const files: RepositoryFileEntry[] = [];
    for (const entry of body.tree as Array<{ type?: unknown; path?: unknown; sha?: unknown }>) {
      if (entry.type === "blob" && typeof entry.path === "string" && typeof entry.sha === "string") {
        files.push({ path: entry.path, sha: entry.sha });
      }
    }
    return files;
  }

  /**
   * The two headers a discovery sync needs to tell a real permission fault from a rate limit,
   * both of which GitHub answers as a 403. Absent headers become absent entries, never empty
   * strings, so the caller can tell "not present" from "present and empty".
   */
  private rateLimitHeaders(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    const remaining = headers.get("x-ratelimit-remaining");
    if (remaining !== null) result["x-ratelimit-remaining"] = remaining;
    const retryAfter = headers.get("retry-after");
    if (retryAfter !== null) result["retry-after"] = retryAfter;
    return result;
  }

  private toDiscoveredRepository(entry: GitHubRepositorySummary): DiscoveredRepository {
    const fullName = entry.full_name;
    const defaultBranch = entry.default_branch;
    if (typeof fullName !== "string" || typeof defaultBranch !== "string") {
      throw new Error("the GitHub API answered a repository without a full name or a default branch");
    }
    return { fullName, defaultBranch };
  }

  /**
   * The URL of the next page, read from a `link` header, or null when no next page exists.
   * F8. `request` attaches the bearer token to whatever URL this method returns, so a `link`
   * header naming a host other than the configured GitHub API host must not be followed. The
   * check compares scheme and host, never a string prefix, so `https://api.github.com.evil.example`
   * cannot pass it.
   */
  private nextPageUrl(base: string, linkHeader: string | null): string | null {
    if (linkHeader === null) return null;
    let allowedOrigin: string;
    try {
      allowedOrigin = new URL(base).origin;
    } catch {
      return null;
    }
    for (const part of linkHeader.split(",")) {
      const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
      const candidate = match?.[1];
      if (candidate === undefined) continue;
      try {
        if (new URL(candidate).origin === allowedOrigin) return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async request(url: string, githubInstallationId: string): Promise<Response> {
    const token = await this.tokens.tokenForInstallation(githubInstallationId, { contents: "read" });
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
          // The token is minted for this request and held nowhere else. It never reaches a
          // message below, because a later call can mint against a different installation.
          authorization: `Bearer ${token}`,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
