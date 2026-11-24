import { GitHubRest, type GitHubRestOptions } from "./github-rest.js";
import { GitHubApiError } from "./github-pull-requests.js";
import { GitHubGraphqlError, graphqlUrlOf } from "./github-auto-merge.js";
import type { GitHubTokenScope } from "~/domain/products/github-token-provider.js";
import { assertRepositorySlug } from "~/domain/products/repository-url.js";
import type {
  CheckAnnotation,
  CheckOnCommit,
  PullRequestReviewOnGitHub,
  ReviewThreadComment,
  ReviewThreadOnGitHub,
} from "~/domain/pull-requests/review-apps.js";
import {
  MAX_FINDING_BODY_CHARACTERS,
  type PrReviewFinding,
  type PullRequestReviewPort,
  type ReviewOfPullRequest,
} from "~/domain/pull-requests/pr-follow-up.js";

/** The reads of the PR follow-up runs. The permission read needs Metadata read. */
const READ_SCOPE: GitHubTokenScope = { metadata: "read", pull_requests: "read" };

/** A reply and a comment write the pull request conversation. */
const WRITE_SCOPE: GitHubTokenScope = { pull_requests: "write" };

/** docs/specs/pr-feedback-loop.md. The check runs, commit statuses and annotations of a commit. */
const CHECKS_SCOPE: GitHubTokenScope = { metadata: "read", checks: "read", statuses: "read" };

/** DI-21.208. A job log needs Actions read. */
const ACTIONS_SCOPE: GitHubTokenScope = { metadata: "read", actions: "read" };

/** The most annotations Factoree reads of one check run. */
const MAX_ANNOTATIONS = 50;

/** The most characters of a job log Factoree keeps before it takes the tail. */
const MAX_LOG_CHARACTERS = 200_000;

/** DI-21.207. The review threads of a pull request, 100 a page, with the first 100 comments of each. */
const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          path
          line
          originalLine
          comments(first: 100) { nodes { databaseId body url author { __typename login } } }
        }
      }
    }
  }
}`;

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** GraphQL names a bot by its app slug, and REST as `<slug>[bot]`. Factoree compares the REST form. */
const restLogin = (author: unknown): string => {
  if (!isRecord(author) || typeof author.login !== "string") return "ghost";
  return author.__typename === "Bot" && !author.login.endsWith("[bot]") ? `${author.login}[bot]` : author.login;
};

/** The most pages Factoree reads of one list, at 100 entries a page. */
const MAX_PAGES = 10;

const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const clip = (text: string): string =>
  text.length <= MAX_FINDING_BODY_CHARACTERS ? text : `${text.slice(0, MAX_FINDING_BODY_CHARACTERS)}…`;

/**
 * docs/specs/pr-review-merge-and-deploy.md. The review reads and the replies of the PR follow-up
 * runs, through the GitHub REST API.
 */
export class GitHubPullRequestReviews implements PullRequestReviewPort {
  private readonly http: GitHubRest;

  constructor(options: GitHubRestOptions) {
    this.http = new GitHubRest(options);
  }

  async reviewerFindings(slug: string, number: number, headSha: string, appSlug: string, installationId: string): Promise<PrReviewFinding[]> {
    const bot = `${appSlug.toLowerCase()}[bot]`;
    const reviews = (await this.list(slug, `/pulls/${String(number)}/reviews`, installationId)).filter(
      (review) => isRecord(review.user) && typeof review.user.login === "string" && review.user.login.toLowerCase() === bot && review.commit_id === headSha,
    );
    const findings: PrReviewFinding[] = [];
    for (const review of reviews) {
      if (typeof review.id !== "number") continue;
      findings.push(...(await this.findingsOf(slug, number, review, installationId)));
    }
    return findings;
  }

  async review(slug: string, number: number, reviewId: number, installationId: string): Promise<ReviewOfPullRequest> {
    const review = await this.http.repository(slug, `/pulls/${String(number)}/reviews/${String(reviewId)}`, { method: "GET" }, installationId, READ_SCOPE);
    if (!isRecord(review) || !isRecord(review.user) || typeof review.user.login !== "string") {
      throw new Error(`GitHub answered no review ${String(reviewId)} of ${slug}#${String(number)}`);
    }
    return { reviewerLogin: review.user.login, findings: await this.findingsOf(slug, number, review, installationId) };
  }

  async canWrite(slug: string, login: string, installationId: string): Promise<boolean> {
    const body = await this.http.repository(
      slug,
      `/collaborators/${encodeURIComponent(login)}/permission`,
      { method: "GET" },
      installationId,
      READ_SCOPE,
    );
    return isRecord(body) && typeof body.permission === "string" && WRITE_PERMISSIONS.has(body.permission);
  }

  async reply(slug: string, number: number, finding: PrReviewFinding, body: string, installationId: string): Promise<void> {
    if (finding.commentId === null) {
      await this.comment(slug, number, body, installationId);
      return;
    }
    await this.http.repository(
      slug,
      `/pulls/${String(number)}/comments/${String(finding.commentId)}/replies`,
      { method: "POST", body: JSON.stringify({ body }) },
      installationId,
      WRITE_SCOPE,
    );
  }

  async comment(slug: string, number: number, body: string, installationId: string): Promise<void> {
    await this.http.repository(slug, `/issues/${String(number)}/comments`, { method: "POST", body: JSON.stringify({ body }) }, installationId, WRITE_SCOPE);
  }

  async reviews(slug: string, number: number, installationId: string): Promise<PullRequestReviewOnGitHub[]> {
    return (await this.list(slug, `/pulls/${String(number)}/reviews`, installationId)).flatMap((review) =>
      typeof review.id === "number" && isRecord(review.user) && typeof review.user.login === "string"
        ? [
            {
              reviewId: review.id,
              authorLogin: review.user.login,
              authorType: typeof review.user.type === "string" ? review.user.type : "User",
              state: typeof review.state === "string" ? review.state.toUpperCase() : "COMMENTED",
              commitSha: text(review.commit_id),
              body: text(review.body) ?? "",
            },
          ]
        : [],
    );
  }

  async checksOnCommit(slug: string, sha: string, installationId: string): Promise<CheckOnCommit[]> {
    const checks: CheckOnCommit[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await this.http.repository(
        slug,
        `/commits/${sha}/check-runs?filter=latest&per_page=100&page=${String(page)}`,
        { method: "GET" },
        installationId,
        CHECKS_SCOPE,
      );
      const runs = isRecord(body) && Array.isArray(body.check_runs) ? body.check_runs : [];
      for (const run of runs) {
        if (!isRecord(run) || typeof run.id !== "number" || typeof run.name !== "string") continue;
        const output = isRecord(run.output) ? run.output : {};
        checks.push({
          kind: "check_run",
          id: run.id,
          name: run.name,
          appSlug: isRecord(run.app) && typeof run.app.slug === "string" ? run.app.slug.toLowerCase() : null,
          creatorLogin: null,
          completed: run.status === "completed",
          conclusion: text(run.conclusion),
          title: text(output.title),
          summary: text(output.summary),
          text: text(output.text),
          detailsUrl: text(run.details_url) ?? text(run.html_url),
        });
      }
      if (runs.length < 100) break;
    }
    // GitHub lists the statuses of a commit newest first, so the first of each context is its state.
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await this.http.repository(slug, `/commits/${sha}/statuses?per_page=100&page=${String(page)}`, { method: "GET" }, installationId, CHECKS_SCOPE);
      const statuses = Array.isArray(body) ? body : [];
      for (const status of statuses) {
        if (!isRecord(status) || typeof status.context !== "string" || typeof status.state !== "string" || seen.has(status.context)) continue;
        seen.add(status.context);
        checks.push({
          kind: "status",
          id: null,
          name: status.context,
          appSlug: null,
          creatorLogin: isRecord(status.creator) && typeof status.creator.login === "string" ? status.creator.login.toLowerCase() : null,
          completed: status.state !== "pending",
          conclusion: status.state === "pending" ? null : status.state,
          title: null,
          summary: text(status.description),
          text: null,
          detailsUrl: text(status.target_url),
        });
      }
      if (statuses.length < 100) break;
    }
    return checks;
  }

  async annotations(slug: string, checkRunId: number, installationId: string): Promise<CheckAnnotation[]> {
    const body = await this.http.repository(
      slug,
      `/check-runs/${String(checkRunId)}/annotations?per_page=${String(MAX_ANNOTATIONS)}`,
      { method: "GET" },
      installationId,
      CHECKS_SCOPE,
    );
    return (Array.isArray(body) ? body : []).flatMap((entry) =>
      isRecord(entry) && typeof entry.message === "string"
        ? [
            {
              path: text(entry.path),
              startLine: typeof entry.start_line === "number" ? entry.start_line : null,
              level: text(entry.annotation_level),
              title: text(entry.title),
              message: clip(entry.message),
            },
          ]
        : [],
    );
  }

  async reviewThreads(slug: string, number: number, installationId: string): Promise<ReviewThreadOnGitHub[]> {
    assertRepositorySlug(slug);
    const [owner, name] = slug.split("/") as [string, string];
    const threads: ReviewThreadOnGitHub[] = [];
    let after: string | null = null;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const data = await this.graphql(slug, REVIEW_THREADS_QUERY, { owner, name, number, after }, installationId);
      const connection =
        isRecord(data) && isRecord(data.repository) && isRecord(data.repository.pullRequest) && isRecord(data.repository.pullRequest.reviewThreads)
          ? data.repository.pullRequest.reviewThreads
          : null;
      if (connection === null) break;
      for (const node of Array.isArray(connection.nodes) ? connection.nodes : []) {
        if (!isRecord(node)) continue;
        const comments: ReviewThreadComment[] = [];
        const commentNodes = isRecord(node.comments) && Array.isArray(node.comments.nodes) ? node.comments.nodes : [];
        for (const comment of commentNodes) {
          if (!isRecord(comment) || typeof comment.databaseId !== "number") continue;
          comments.push({ commentId: comment.databaseId, authorLogin: restLogin(comment.author), body: clip(text(comment.body) ?? ""), url: text(comment.url) });
        }
        threads.push({
          isResolved: node.isResolved === true,
          path: text(node.path),
          line: typeof node.line === "number" ? node.line : typeof node.originalLine === "number" ? node.originalLine : null,
          comments,
        });
      }
      const info = isRecord(connection.pageInfo) ? connection.pageInfo : {};
      if (info.hasNextPage !== true || typeof info.endCursor !== "string") break;
      after = info.endCursor;
    }
    return threads;
  }

  async jobLog(slug: string, jobId: number, installationId: string): Promise<string | null> {
    assertRepositorySlug(slug);
    const url = `${await this.http.baseUrl()}/repos/${slug}/actions/jobs/${String(jobId)}/logs`;
    // GitHub answers with a redirect to a short-lived download URL. Fetch drops the token on the
    // redirect to another origin.
    const response = await this.http.send(url, { method: "GET" }, installationId, ACTIONS_SCOPE, slug);
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new GitHubApiError(`the GitHub API answered ${String(response.status)} for ${url}`, response.status);
    const log = await response.text();
    return log.length <= MAX_LOG_CHARACTERS ? log : log.slice(-MAX_LOG_CHARACTERS);
  }

  async react(slug: string, target: { kind: "comment" | "review_comment"; commentId: number }, installationId: string): Promise<void> {
    const path = target.kind === "comment" ? `/issues/comments/${String(target.commentId)}/reactions` : `/pulls/comments/${String(target.commentId)}/reactions`;
    await this.http.repository(slug, path, { method: "POST", body: JSON.stringify({ content: "eyes" }) }, installationId, WRITE_SCOPE);
  }

  private async graphql(slug: string, query: string, variables: Record<string, unknown>, installationId: string): Promise<unknown> {
    const url = graphqlUrlOf(await this.http.baseUrl());
    const response = await this.http.send(url, { method: "POST", body: JSON.stringify({ query, variables }) }, installationId, READ_SCOPE, slug);
    const body = await response.text();
    if (!response.ok) throw new GitHubApiError(`the GitHub GraphQL API answered ${String(response.status)}`, response.status);
    const parsed = JSON.parse(body) as { data?: unknown; errors?: unknown };
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      throw new GitHubGraphqlError(parsed.errors.map((entry) => (isRecord(entry) && typeof entry.message === "string" ? entry.message : "unknown error")).join("; "));
    }
    return parsed.data ?? null;
  }

  /** The body of one review, when it holds text, and then each of its comments. */
  private async findingsOf(slug: string, number: number, review: Record<string, unknown>, installationId: string): Promise<PrReviewFinding[]> {
    const reviewId = review.id as number;
    const author = isRecord(review.user) && typeof review.user.login === "string" ? review.user.login : "unknown";
    const findings: PrReviewFinding[] = [];
    if (typeof review.body === "string" && review.body.trim() !== "") {
      findings.push({ key: `review-${String(reviewId)}`, reviewId, commentId: null, author, path: null, line: null, body: clip(review.body.trim()) });
    }
    for (const comment of await this.list(slug, `/pulls/${String(number)}/reviews/${String(reviewId)}/comments`, installationId)) {
      if (typeof comment.id !== "number" || typeof comment.body !== "string" || comment.body.trim() === "") continue;
      findings.push({
        key: `comment-${String(comment.id)}`,
        reviewId,
        commentId: comment.id,
        author,
        path: typeof comment.path === "string" ? comment.path : null,
        line: typeof comment.line === "number" ? comment.line : typeof comment.original_line === "number" ? comment.original_line : null,
        body: clip(comment.body.trim()),
      });
    }
    return findings;
  }

  private async list(slug: string, path: string, installationId: string): Promise<Array<Record<string, unknown>>> {
    const entries: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await this.http.repository(slug, `${path}?per_page=100&page=${String(page)}`, { method: "GET" }, installationId, READ_SCOPE);
      const items = Array.isArray(body) ? body : [];
      for (const item of items) if (isRecord(item)) entries.push(item);
      if (items.length < 100) break;
    }
    return entries;
  }
}
