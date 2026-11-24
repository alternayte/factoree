import type { GitHubApiBaseUrl } from "./api-base-url.js";
import { GitHubRest } from "./github-rest.js";
import { GitHubApiError } from "./github-pull-requests.js";
import { assertRepositorySlug } from "~/domain/products/repository-url.js";
import type { GitHubTokenProvider, GitHubTokenScope } from "~/domain/products/github-token-provider.js";
import type { PrReviewer } from "~/domain/pull-requests/auto-merge.js";
import {
  BRANCH_PROTECTION,
  MERGE_GATING_RULES,
  type AutoMergeGate,
  type AutoMergePort,
  type EnableAutoMergeOutcome,
  type MergeMethod,
  type MergeOutcome,
  type PullRequestOnGitHub,
  type ReviewerVerdict,
  type ReviewOnGitHub,
} from "~/domain/pull-requests/auto-merge.js";

/** The reads of the L4 merge. D5: the gate reads with Metadata read, the verdicts with Checks and Commit statuses read. */
const READ_SCOPE: GitHubTokenScope = { metadata: "read", contents: "read", pull_requests: "read", checks: "read", statuses: "read" };

/** GitHub turns auto-merge on and off, and merges, only for a token that can write the branch. */
const WRITE_SCOPE: GitHubTokenScope = { contents: "write", pull_requests: "write" };

/** The most review pages Factoree reads, at 100 reviews a page. */
const MAX_REVIEW_PAGES = 10;

const GRAPHQL_METHOD: Record<MergeMethod, string> = { squash: "SQUASH", merge: "MERGE", rebase: "REBASE" };

export interface GitHubAutoMergeOptions {
  apiBaseUrl: GitHubApiBaseUrl;
  tokens: GitHubTokenProvider;
  fetch?: typeof fetch;
}

/**
 * The GraphQL endpoint of a REST base: `https://api.github.com/graphql` for github.com, and
 * `https://<host>/api/graphql` for GitHub Enterprise Server, whose REST base ends in `/api/v3`.
 */
export const graphqlUrlOf = (restBase: string): string =>
  /\/api\/v3$/.test(restBase) ? restBase.replace(/\/api\/v3$/, "/api/graphql") : `${restBase}/graphql`;

/** GitHub answered a GraphQL call with errors. The same call fails the same way again. */
export class GitHubGraphqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubGraphqlError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * docs/specs/pr-review-merge-and-deploy.md. The GitHub calls of the L4 merge, on the control plane
 * only. Every call mints a token for the one repository, with the narrowest scope of that call.
 */
export class GitHubAutoMerge implements AutoMergePort {
  private readonly http: GitHubRest;

  constructor(options: GitHubAutoMergeOptions) {
    this.http = new GitHubRest(options);
  }

  async pullRequest(slug: string, number: number, installationId: string): Promise<PullRequestOnGitHub> {
    const body = await this.rest(slug, `/pulls/${String(number)}`, { method: "GET" }, installationId, READ_SCOPE);
    if (!isRecord(body)) throw new Error(`GitHub answered no pull request ${slug}#${String(number)}`);
    const head = isRecord(body.head) ? body.head : {};
    const base = isRecord(body.base) ? body.base : {};
    if (typeof body.node_id !== "string" || typeof head.sha !== "string" || typeof base.ref !== "string") {
      throw new Error(`GitHub answered the pull request ${slug}#${String(number)} without a node id, a head or a base`);
    }
    return {
      nodeId: body.node_id,
      headSha: head.sha,
      open: body.state === "open" && body.merged !== true,
      draft: body.draft === true,
      mergeableState: typeof body.mergeable_state === "string" ? body.mergeable_state : null,
      mergeable: typeof body.mergeable === "boolean" ? body.mergeable : null,
      autoMergeEnabled: isRecord(body.auto_merge),
      baseBranch: base.ref,
    };
  }

  /**
   * D5, DI-21.106. The repository settings come from GraphQL, which answers them to a Metadata
   * reader. The base branch requirements are the active ruleset rules of the branch, and a classic
   * protection rule.
   */
  async gate(slug: string, baseBranch: string, installationId: string): Promise<AutoMergeGate> {
    const [owner, name] = slug.split("/") as [string, string];
    const data = await this.graphql(
      slug,
      "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){autoMergeAllowed squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed}}",
      { owner, name },
      installationId,
      READ_SCOPE,
    );
    const repository = isRecord(data) && isRecord(data.repository) ? data.repository : {};
    const branch = encodeURIComponent(baseBranch);
    const rules = await this.rest(slug, `/rules/branches/${branch}?per_page=100`, { method: "GET" }, installationId, READ_SCOPE);
    const requirements = new Set<string>();
    let requiresUpToDate = false;
    if (Array.isArray(rules)) {
      for (const rule of rules) {
        if (isRecord(rule) && typeof rule.type === "string" && MERGE_GATING_RULES.includes(rule.type)) requirements.add(rule.type);
        // DI-21.115. "Require branches to be up to date before merging" of a ruleset.
        if (
          isRecord(rule) &&
          rule.type === "required_status_checks" &&
          isRecord(rule.parameters) &&
          rule.parameters.strict_required_status_checks_policy === true
        ) {
          requiresUpToDate = true;
        }
      }
    }
    let protectedBranch = false;
    try {
      const branchBody = await this.rest(slug, `/branches/${branch}`, { method: "GET" }, installationId, READ_SCOPE);
      protectedBranch = isRecord(branchBody) && branchBody.protected === true;
    } catch (error) {
      // A base branch that does not exist has no rule.
      if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
    }
    if (protectedBranch) requirements.add(BRANCH_PROTECTION);
    return {
      settings: {
        allowAutoMerge: typeof repository.autoMergeAllowed === "boolean" ? repository.autoMergeAllowed : null,
        allowSquash: repository.squashMergeAllowed === true,
        allowMergeCommit: repository.mergeCommitAllowed === true,
        allowRebase: repository.rebaseMergeAllowed === true,
      },
      baseRequirements: [...requirements].sort(),
      requiresUpToDate,
    };
  }

  /** DI-21.115. The compare of the base branch with the head names how far the head is behind. */
  async behindBy(slug: string, baseBranch: string, headSha: string, installationId: string): Promise<number> {
    const body = await this.rest(
      slug,
      `/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headSha)}?per_page=1`,
      { method: "GET" },
      installationId,
      READ_SCOPE,
    );
    if (!isRecord(body) || typeof body.behind_by !== "number") throw new Error(`GitHub answered no compare of ${slug} ${baseBranch}...${headSha}`);
    return body.behind_by;
  }

  /**
   * DI-21.107. The newest check run of that name from the reviewer app on the commit. Without one,
   * the newest commit status of that context that the app's bot created.
   */
  async reviewerVerdict(slug: string, sha: string, reviewer: PrReviewer, installationId: string): Promise<ReviewerVerdict> {
    const query = new URLSearchParams({ check_name: reviewer.checkName, filter: "latest", per_page: "100" });
    const checks = await this.rest(slug, `/commits/${sha}/check-runs?${query.toString()}`, { method: "GET" }, installationId, READ_SCOPE);
    const runs = isRecord(checks) && Array.isArray(checks.check_runs) ? checks.check_runs : [];
    const run = runs.find(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) && isRecord(candidate.app) && typeof candidate.app.slug === "string" && candidate.app.slug.toLowerCase() === reviewer.appSlug,
    );
    if (run !== undefined) {
      if (run.status !== "completed") return "pending";
      return run.conclusion === "success" ? "passed" : "failed";
    }
    const statuses = await this.rest(slug, `/commits/${sha}/statuses?per_page=100`, { method: "GET" }, installationId, READ_SCOPE);
    const bot = `${reviewer.appSlug}[bot]`;
    // GitHub lists the statuses of a commit newest first.
    const status = (Array.isArray(statuses) ? statuses : []).find(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) &&
        candidate.context === reviewer.checkName &&
        isRecord(candidate.creator) &&
        typeof candidate.creator.login === "string" &&
        candidate.creator.login.toLowerCase() === bot,
    );
    if (status === undefined) return "absent";
    if (status.state === "success") return "passed";
    return status.state === "pending" ? "pending" : "failed";
  }

  async reviews(slug: string, number: number, installationId: string): Promise<ReviewOnGitHub[]> {
    const reviews: ReviewOnGitHub[] = [];
    for (let page = 1; page <= MAX_REVIEW_PAGES; page += 1) {
      const body = await this.rest(slug, `/pulls/${String(number)}/reviews?per_page=100&page=${String(page)}`, { method: "GET" }, installationId, READ_SCOPE);
      const entries = Array.isArray(body) ? body : [];
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.state !== "string" || !isRecord(entry.user) || typeof entry.user.login !== "string") continue;
        reviews.push({ reviewerLogin: entry.user.login, state: entry.state });
      }
      if (entries.length < 100) break;
    }
    return reviews;
  }

  /** The head pin keeps auto-merge from merging a head that moved since Factoree read it. */
  async enable(slug: string, pullRequest: PullRequestOnGitHub, method: MergeMethod, installationId: string): Promise<EnableAutoMergeOutcome> {
    try {
      await this.graphql(
        slug,
        "mutation($id:ID!,$method:PullRequestMergeMethod!,$head:GitObjectID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$method,expectedHeadOid:$head}){clientMutationId}}",
        { id: pullRequest.nodeId, method: GRAPHQL_METHOD[method], head: pullRequest.headSha },
        installationId,
        WRITE_SCOPE,
      );
      return { kind: "enabled" };
    } catch (error) {
      if (!(error instanceof GitHubGraphqlError)) throw error;
      // GitHub refuses auto-merge on a pull request it can merge at once.
      if (/(clean|unstable) status/i.test(error.message)) return { kind: "clean" };
      return { kind: "refused", message: error.message };
    }
  }

  async disable(slug: string, pullRequest: PullRequestOnGitHub, installationId: string): Promise<void> {
    try {
      await this.graphql(
        slug,
        "mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){clientMutationId}}",
        { id: pullRequest.nodeId },
        installationId,
        WRITE_SCOPE,
      );
    } catch (error) {
      // Auto-merge that is already off is the state Factoree wants.
      if (error instanceof GitHubGraphqlError && /not enabled|already disabled/i.test(error.message)) return;
      throw error;
    }
  }

  async merge(slug: string, number: number, sha: string, method: MergeMethod, installationId: string): Promise<MergeOutcome> {
    try {
      await this.rest(
        slug,
        `/pulls/${String(number)}/merge`,
        { method: "PUT", body: JSON.stringify({ sha, merge_method: method }) },
        installationId,
        WRITE_SCOPE,
      );
      return { kind: "merged" };
    } catch (error) {
      // 405: the rules hold the merge back. 409: the head moved. 422: the method is not allowed.
      if (error instanceof GitHubApiError && [405, 409, 422].includes(error.status)) return { kind: "refused", message: error.message };
      throw error;
    }
  }

  private async rest(slug: string, path: string, init: RequestInit, installationId: string, scope: GitHubTokenScope): Promise<unknown> {
    return await this.http.repository(slug, path, init, installationId, scope);
  }

  private async graphql(
    slug: string,
    query: string,
    variables: Record<string, unknown>,
    installationId: string,
    scope: GitHubTokenScope,
  ): Promise<unknown> {
    assertRepositorySlug(slug);
    const url = graphqlUrlOf(await this.http.baseUrl());
    const response = await this.http.send(url, { method: "POST", body: JSON.stringify({ query, variables }) }, installationId, scope, slug);
    const text = await response.text();
    if (!response.ok) throw new GitHubApiError(`the GitHub GraphQL API answered ${String(response.status)}`, response.status);
    const parsed = JSON.parse(text) as { data?: unknown; errors?: unknown };
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const messages = parsed.errors.map((entry) => (isRecord(entry) && typeof entry.message === "string" ? entry.message : "unknown error"));
      throw new GitHubGraphqlError(messages.join("; "));
    }
    return parsed.data ?? null;
  }
}
