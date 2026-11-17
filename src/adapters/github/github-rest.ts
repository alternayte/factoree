import { resolveGitHubApiBaseUrl, type GitHubApiBaseUrl } from "./api-base-url.js";
import { GitHubApiError } from "./github-pull-requests.js";
import { assertRepositorySlug } from "~/domain/products/repository-url.js";
import type { GitHubTokenProvider, GitHubTokenScope } from "~/domain/products/github-token-provider.js";

/** One GitHub call must not hang a workflow. */
const GITHUB_API_TIMEOUT_MS = 30_000;

export interface GitHubRestOptions {
  apiBaseUrl: GitHubApiBaseUrl;
  tokens: GitHubTokenProvider;
  fetch?: typeof fetch;
}

/**
 * docs/specs/pr-review-merge-and-deploy.md. The GitHub calls of the PR workflow, on the control
 * plane only. Every call mints a token for the one repository, with the scope the caller names.
 */
export class GitHubRest {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GitHubRestOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** The REST base, without a trailing slash. */
  async baseUrl(): Promise<string> {
    return await resolveGitHubApiBaseUrl(this.options.apiBaseUrl);
  }

  /** One call under `/repos/<slug>`. A non-2xx answer throws `GitHubApiError` with GitHub's message. */
  async repository(slug: string, path: string, init: RequestInit, installationId: string, scope: GitHubTokenScope): Promise<unknown> {
    assertRepositorySlug(slug);
    const url = `${await this.baseUrl()}/repos/${slug}${path}`;
    const response = await this.send(url, init, installationId, scope, slug);
    const text = await response.text();
    if (!response.ok) {
      let message = "";
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        message = typeof parsed.message === "string" ? parsed.message : "";
      } catch {
        message = "";
      }
      throw new GitHubApiError(`the GitHub API answered ${String(response.status)} for ${url}${message === "" ? "" : `: ${message}`}`, response.status);
    }
    return text === "" ? null : (JSON.parse(text) as unknown);
  }

  async send(url: string, init: RequestInit, installationId: string, scope: GitHubTokenScope, slug: string): Promise<Response> {
    const token = await this.options.tokens.tokenForInstallation(installationId, scope, [slug]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
    timer.unref();
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "factoree",
          authorization: `Bearer ${token}`,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
