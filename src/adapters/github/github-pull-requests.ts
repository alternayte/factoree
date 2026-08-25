import { assertRepositorySlug } from "~/domain/projects/repository-url.js";
import type {
  CreatePullRequestInput,
  PullRequestPort,
  PullRequestRecord,
} from "~/domain/publishing/pull-request.js";

/** One GitHub call must not hang a Run. */
const GITHUB_API_TIMEOUT_MS = 30_000;

interface GitHubPullRequestBody {
  number?: unknown;
  html_url?: unknown;
  head?: unknown;
  message?: unknown;
}

export interface GitHubPullRequestsOptions {
  apiBaseUrl: string;
  /** The GitHub write credential. SDD section 30 keeps it on the control plane only. */
  token: string;
  fetch?: typeof fetch;
}

/**
 * SDD section 46 step 9. The only implementation of `PullRequestPort`. It runs on the control
 * plane, never inside a sandbox, and no agent session reaches it.
 */
export class GitHubPullRequests implements PullRequestPort {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubPullRequestsOptions) {
    this.base = options.apiBaseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async findByHead(slug: string, headBranch: string): Promise<PullRequestRecord | null> {
    assertRepositorySlug(slug);
    const owner = slug.split("/")[0] ?? "";
    const query = new URLSearchParams({ head: `${owner}:${headBranch}`, state: "all", per_page: "1" });
    const body = await this.call(`${this.base}/repos/${slug}/pulls?${query.toString()}`, { method: "GET" });
    if (!Array.isArray(body) || body.length === 0) return null;
    return this.toRecord(body[0] as GitHubPullRequestBody, headBranch);
  }

  async create(input: CreatePullRequestInput): Promise<PullRequestRecord> {
    assertRepositorySlug(input.slug);
    const body = await this.call(`${this.base}/repos/${input.slug}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
      }),
    });
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

  private async call(url: string, init: RequestInit): Promise<unknown> {
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
          // The credential appears here and nowhere else. It never reaches a message below.
          authorization: `Bearer ${this.token}`,
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
      throw new Error(
        `the GitHub API answered ${response.status} for ${url}${message === "" ? "" : `: ${message}`}`,
      );
    }
    return text === "" ? null : (JSON.parse(text) as unknown);
  }
}
