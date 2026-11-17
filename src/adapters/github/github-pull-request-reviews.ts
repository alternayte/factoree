import { GitHubRest, type GitHubRestOptions } from "./github-rest.js";
import type { GitHubTokenScope } from "~/domain/products/github-token-provider.js";
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
