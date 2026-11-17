import { GitHubRest, type GitHubRestOptions } from "./github-rest.js";
import { GitHubApiError } from "./github-pull-requests.js";
import type { GitHubTokenScope } from "~/domain/products/github-token-provider.js";
import { MAX_PREVIOUS_DEPLOYMENTS, type DeployPort } from "~/domain/pull-requests/deploys.js";

/** The reads of the deploy report: compares of commits and the deployments of an environment. */
const READ_SCOPE: GitHubTokenScope = { metadata: "read", contents: "read", deployments: "read" };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 5. The GitHub reads of the deploy report, on the
 * control plane only. Factoree reads deployments and never creates, approves or dispatches one.
 */
export class GitHubDeployments implements DeployPort {
  private readonly http: GitHubRest;

  constructor(options: GitHubRestOptions) {
    this.http = new GitHubRest(options);
  }

  /** DI-21.120. `GET /compare/<ancestor>...<descendant>` answers `ahead` or `identical` when the history holds it. */
  async contains(slug: string, ancestor: string, descendant: string, installationId: string): Promise<boolean> {
    try {
      const body = await this.http.repository(
        slug,
        `/compare/${encodeURIComponent(ancestor)}...${encodeURIComponent(descendant)}?per_page=1`,
        { method: "GET" },
        installationId,
        READ_SCOPE,
      );
      if (!isRecord(body) || typeof body.status !== "string") throw new Error(`GitHub answered no compare of ${slug} ${ancestor}...${descendant}`);
      return body.status === "ahead" || body.status === "identical";
    } catch (error) {
      // A commit or a branch GitHub does not know holds nothing.
      if (error instanceof GitHubApiError && (error.status === 404 || error.status === 422)) return false;
      throw error;
    }
  }

  /**
   * DI-21.122. GitHub lists the deployments of an environment newest first. The newest one created
   * before the failed one that reached `success` is the previous successful deploy.
   */
  async previousSuccess(slug: string, environment: string, beforeDeploymentId: number, installationId: string): Promise<string | null> {
    const query = new URLSearchParams({ environment, per_page: String(MAX_PREVIOUS_DEPLOYMENTS) });
    const deployments = await this.http.repository(slug, `/deployments?${query.toString()}`, { method: "GET" }, installationId, READ_SCOPE);
    if (!Array.isArray(deployments)) return null;
    for (const deployment of deployments) {
      if (!isRecord(deployment) || typeof deployment.id !== "number" || typeof deployment.sha !== "string") continue;
      if (deployment.id >= beforeDeploymentId) continue;
      const statuses = await this.http.repository(slug, `/deployments/${String(deployment.id)}/statuses?per_page=100`, { method: "GET" }, installationId, READ_SCOPE);
      // A later success marks an older successful deployment `inactive`, so a deployment counts as a
      // success when any of its statuses is `success`.
      if (Array.isArray(statuses) && statuses.some((status) => isRecord(status) && status.state === "success")) return deployment.sha;
    }
    return null;
  }
}
