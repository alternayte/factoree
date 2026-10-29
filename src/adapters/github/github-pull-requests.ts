import { assertRepositorySlug } from "~/domain/products/repository-url.js";
import type {
  CreatePullRequestInput,
  PullRequestPort,
  PullRequestRecord,
} from "~/domain/publishing/pull-request.js";
import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";

/** One GitHub call must not hang a Run. */
const GITHUB_API_TIMEOUT_MS = 30_000;

interface GitHubPullRequestBody {
  number?: unknown;
  html_url?: unknown;
  head?: unknown;
  message?: unknown;
}

/**
 * One failed GitHub API call. SDD section 49 forbids a semantic failure to consume the
 * infrastructure retry policy, so this error reports whether the same call fails the same way on
 * every attempt. The adapter imports no Temporal type. The activity boundary owns the
 * conversion, exactly as the repository reader already arranges it.
 */
export class GitHubApiError extends Error {
  /** The HTTP status of the answer. */
  readonly status: number;

  /**
   * True when the same request fails the same way on every attempt. A 4xx names a fault of the
   * request itself, so a retry repeats it. A 408 and a 429 are the two exceptions, because the
   * server asks for a later attempt. A 5xx stays retryable.
   */
  readonly deterministic: boolean;

  /**
   * The `x-ratelimit-remaining` and `retry-after` response headers, when the caller supplies
   * them. A discovery sync reads these to tell a real permission fault from a rate limit, both
   * of which GitHub reports as a 403.
   */
  readonly headers: Record<string, string> | undefined;

  constructor(message: string, status: number, headers?: Record<string, string>) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.deterministic = status >= 400 && status < 500 && status !== 408 && status !== 429;
    this.headers = headers;
  }
}

export interface GitHubPullRequestsOptions {
  apiBaseUrl: string;
  /** Mints the GitHub write credential. SDD section 30 keeps it on the control plane only. */
  tokens: GitHubTokenProvider;
  fetch?: typeof fetch;
}

/**
 * SDD section 46 step 9. The only implementation of `PullRequestPort`. It runs on the control
 * plane, never inside a sandbox, and no agent session reaches it. It holds no token: every
 * method mints one against the installation id the caller supplies, immediately before the call.
 */
export class GitHubPullRequests implements PullRequestPort {
  private readonly base: string;
  private readonly tokens: GitHubTokenProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubPullRequestsOptions) {
    this.base = options.apiBaseUrl.replace(/\/+$/, "");
    this.tokens = options.tokens;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async findByHead(slug: string, headBranch: string, githubInstallationId: string): Promise<PullRequestRecord | null> {
    assertRepositorySlug(slug);
    const owner = slug.split("/")[0] ?? "";
    const query = new URLSearchParams({ head: `${owner}:${headBranch}`, state: "all", per_page: "1" });
    const body = await this.call(
      `${this.base}/repos/${slug}/pulls?${query.toString()}`,
      { method: "GET" },
      githubInstallationId,
      slug,
    );
    if (!Array.isArray(body) || body.length === 0) return null;
    return this.toRecord(body[0] as GitHubPullRequestBody, headBranch);
  }

  /**
   * The pull request of that number, or null when GitHub answers that it does not exist.
   *
   * The live acceptance scenario reads the Proof Pack, and SDD section 47 fixes the Pull request
   * section as the URL of the pull request. A URL names a number, and it names no branch, so a
   * confirmation by number reads what the Proof Pack actually holds. The port names this method
   * not at all, because no part of a Run needs it: the publication already holds its own record.
   */
  async findByNumber(
    slug: string,
    number: number,
    githubInstallationId: string,
  ): Promise<PullRequestRecord | null> {
    assertRepositorySlug(slug);
    let body: unknown;
    try {
      body = await this.call(
        `${this.base}/repos/${slug}/pulls/${number}`,
        { method: "GET" },
        githubInstallationId,
        slug,
      );
    } catch (error) {
      // A pull request that does not exist is an answer, not a fault.
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
    const parsed = body as GitHubPullRequestBody;
    const head = parsed.head as { ref?: unknown } | undefined;
    const headBranch = typeof head?.ref === "string" ? head.ref : "";
    return this.toRecord(parsed, headBranch);
  }

  async create(input: CreatePullRequestInput, githubInstallationId: string): Promise<PullRequestRecord> {
    assertRepositorySlug(input.slug);
    const body = await this.call(
      `${this.base}/repos/${input.slug}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.headBranch,
          base: input.baseBranch,
          draft: input.draft,
        }),
      },
      githubInstallationId,
      input.slug,
    );
    return this.toRecord(body as GitHubPullRequestBody, input.headBranch);
  }

  private toRecord(body: GitHubPullRequestBody, headBranch: string): PullRequestRecord {
    const number = body.number;
    const url = body.html_url;
    // The tip commit of the head branch. The publication record needs it. GitHub already
    // answers it here, so Factoree never runs a second git read to learn it.
    const head = body.head as { sha?: unknown } | undefined;
    const headSha = head?.sha;
    if (typeof number !== "number" || typeof url !== "string" || typeof headSha !== "string") {
      throw new Error(
        "GitHub returned a pull request without a number, without a URL, or without a head SHA",
      );
    }
    return { number, url, headBranch, headSha };
  }

  private async call(
    url: string,
    init: RequestInit,
    githubInstallationId: string,
    slug: string,
  ): Promise<unknown> {
    // The token reads and writes the pull requests of this one repository, and nothing else.
    const token = await this.tokens.tokenForInstallation(
      githubInstallationId,
      { pull_requests: "write" },
      [slug],
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
    timer.unref();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "factoree",
          // The token is minted for this request and held nowhere else. It never reaches a
          // message below.
          authorization: `Bearer ${token}`,
        },
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) {
      let message = "";
      try {
        const parsed = JSON.parse(text) as GitHubPullRequestBody;
        message = typeof parsed.message === "string" ? parsed.message : "";
      } catch {
        message = "";
      }
      throw new GitHubApiError(
        `the GitHub API answered ${response.status} for ${url}${message === "" ? "" : `: ${message}`}`,
        response.status,
      );
    }
    return text === "" ? null : (JSON.parse(text) as unknown);
  }
}
