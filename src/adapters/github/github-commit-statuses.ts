import type { GitHubApiBaseUrl } from "./api-base-url.js";
import { GitHubRest } from "./github-rest.js";
import type { GitHubTokenProvider, GitHubTokenScope } from "~/domain/products/github-token-provider.js";
import type { ChangeSetStatusState, CommitStatusPort } from "~/domain/pull-requests/change-set-status.js";

/** docs/specs/change-sets.md, slice 8. A commit status needs Commit statuses write, and nothing else. */
const STATUS_SCOPE: GitHubTokenScope = { statuses: "write" };

const SHA = /^[0-9a-f]{40}$/;

export interface GitHubCommitStatusesOptions {
  apiBaseUrl: GitHubApiBaseUrl;
  tokens: GitHubTokenProvider;
  fetch?: typeof fetch;
}

/**
 * docs/specs/change-sets.md, slice 8, DI-21.155. Sets the `factoree/change-set` commit status on a
 * consumer head with `POST /repos/{owner}/{repo}/statuses/{sha}`, on the control plane only.
 */
export class GitHubCommitStatuses implements CommitStatusPort {
  private readonly http: GitHubRest;

  constructor(options: GitHubCommitStatusesOptions) {
    this.http = new GitHubRest(options);
  }

  async setStatus(
    slug: string,
    sha: string,
    status: { state: ChangeSetStatusState; context: string; description: string; targetUrl: string },
    installationId: string,
  ): Promise<void> {
    if (!SHA.test(sha)) throw new Error(`the commit "${sha}" of ${slug} is not forty hexadecimal characters`);
    await this.http.repository(
      slug,
      `/statuses/${sha}`,
      {
        method: "POST",
        body: JSON.stringify({ state: status.state, context: status.context, description: status.description, target_url: status.targetUrl }),
      },
      installationId,
      STATUS_SCOPE,
    );
  }
}
