import { resolveGitHubApiBaseUrl, type GitHubApiBaseUrl } from "./api-base-url.js";
import { GitHubApiError } from "./github-pull-requests.js";
import { assertRepositorySlug } from "~/domain/products/repository-url.js";
import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";
import type { SkillProposalFile } from "~/domain/runs/skill-registry.js";

const GITHUB_API_TIMEOUT_MS = 30_000;

export interface SkillProposalPullRequestInput {
  /** The organization skills repository, as `owner/repository`. */
  slug: string;
  githubInstallationId: string;
  /** The branch the pull request comes from. A retry reuses it. */
  headBranch: string;
  title: string;
  body: string;
  /** The files, with paths relative to the repository root. */
  files: SkillProposalFile[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringAt = (value: unknown, ...path: string[]): string => {
  let current: unknown = value;
  for (const key of path) current = isRecord(current) ? current[key] : undefined;
  if (typeof current !== "string") throw new Error(`GitHub returned no ${path.join(".")}`);
  return current;
};

/**
 * docs/specs/skill-registry.md. Sends a skill proposal to the organization skills repository as a
 * pull request. It runs on the worker, never in a sandbox, and a person reviews the pull request.
 */
export class GitHubSkillProposals {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: { apiBaseUrl: GitHubApiBaseUrl; tokens: GitHubTokenProvider; fetch?: typeof fetch },
  ) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Opens the pull request, or returns the one an earlier attempt opened. */
  async open(input: SkillProposalPullRequestInput): Promise<{ number: number; url: string }> {
    assertRepositorySlug(input.slug);
    const api = `${await resolveGitHubApiBaseUrl(this.options.apiBaseUrl)}/repos/${input.slug}`;
    const call = (path: string, init: RequestInit) => this.call(`${api}${path}`, init, input);

    const owner = input.slug.split("/")[0] ?? "";
    const existing = await call(
      `/pulls?${new URLSearchParams({ head: `${owner}:${input.headBranch}`, state: "all", per_page: "1" }).toString()}`,
      { method: "GET" },
    );
    if (Array.isArray(existing) && existing.length > 0) return this.toPullRequest(existing[0]);

    const repository = await call("", { method: "GET" });
    const baseBranch = stringAt(repository, "default_branch");
    const head = await call(`/git/ref/heads/${encodeURIComponent(baseBranch)}`, { method: "GET" });
    const baseSha = stringAt(head, "object", "sha");
    const baseCommit = await call(`/git/commits/${baseSha}`, { method: "GET" });
    const tree = await call("/git/trees", {
      method: "POST",
      body: JSON.stringify({
        base_tree: stringAt(baseCommit, "tree", "sha"),
        tree: input.files.map((file) => ({ path: file.path, mode: "100644", type: "blob", content: file.content })),
      }),
    });
    const commit = await call("/git/commits", {
      method: "POST",
      body: JSON.stringify({ message: input.title, tree: stringAt(tree, "sha"), parents: [baseSha] }),
    });
    const commitSha = stringAt(commit, "sha");
    try {
      await call("/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${input.headBranch}`, sha: commitSha }) });
    } catch (error) {
      // An earlier attempt created the branch and failed before the pull request.
      if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
      await call(`/git/refs/heads/${input.headBranch}`, { method: "PATCH", body: JSON.stringify({ sha: commitSha, force: true }) });
    }
    const pull = await call("/pulls", {
      method: "POST",
      body: JSON.stringify({ title: input.title, body: input.body, head: input.headBranch, base: baseBranch }),
    });
    return this.toPullRequest(pull);
  }

  private toPullRequest(body: unknown): { number: number; url: string } {
    const number = isRecord(body) ? body["number"] : undefined;
    if (typeof number !== "number") throw new Error("GitHub returned a pull request without a number");
    return { number, url: stringAt(body, "html_url") };
  }

  private async call(url: string, init: RequestInit, input: SkillProposalPullRequestInput): Promise<unknown> {
    // The token writes the contents and the pull requests of the one skills repository.
    const token = await this.options.tokens.tokenForInstallation(
      input.githubInstallationId,
      { contents: "write", pull_requests: "write" },
      [input.slug],
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
        const parsed: unknown = JSON.parse(text);
        message = isRecord(parsed) && typeof parsed["message"] === "string" ? parsed["message"] : "";
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
