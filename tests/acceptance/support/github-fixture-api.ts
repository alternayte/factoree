import Fastify from "fastify";
import type { CreatePullRequestInput } from "~/domain/publishing/pull-request.js";

/**
 * A real Fastify HTTP server that answers the two GitHub pull request endpoints the adapter
 * calls. AT-29 runs the real `GitHubPullRequests` adapter against this server, so nothing here
 * is a double of the adapter itself.
 *
 * `GET /repos/:owner/:repo/pulls` answers the list it holds, filtered by the `head` query the
 * adapter sends. `POST /repos/:owner/:repo/pulls` appends one record and answers 201.
 */
export interface GitHubFixtureApi {
  baseUrl: string;
  /** Every create input the adapter sent, in order. A test asserts on it. */
  created: CreatePullRequestInput[];
  /** Every list query the adapter sent, in order. */
  lookups: string[];
  stop: () => Promise<void>;
}

interface StoredPullRequest {
  number: number;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  title: string;
  body: string;
}

export interface GitHubFixtureApiOptions {
  /**
   * Answers the tip commit SHA of one head branch. The real GitHub answers it from the pushed
   * branch, so a test passes the reader of its own bare remote here.
   */
  resolveHeadSha?: (branch: string) => string | null;
}

const UNKNOWN_SHA = "0".repeat(40);

export const startGitHubFixtureApi = async (
  options: GitHubFixtureApiOptions = {},
): Promise<GitHubFixtureApi> => {
  const app = Fastify({ logger: false });
  const created: CreatePullRequestInput[] = [];
  const lookups: string[] = [];
  const store: StoredPullRequest[] = [];

  app.get("/repos/:owner/:repo/pulls", (request, reply) => {
    const query = request.query as { head?: string };
    const head = query.head ?? "";
    lookups.push(head);
    // GitHub names a head branch `owner:branch`. The fixture compares the branch half only.
    const branch = head.includes(":") ? head.slice(head.indexOf(":") + 1) : head;
    const matches = branch === "" ? store : store.filter((entry) => entry.head.ref === branch);
    return reply.code(200).send(matches);
  });

  app.post("/repos/:owner/:repo/pulls", (request, reply) => {
    const parameters = request.params as { owner: string; repo: string };
    const body = request.body as { title?: string; body?: string; head?: string; base?: string };
    const headBranch = body.head ?? "";
    created.push({
      slug: `${parameters.owner}/${parameters.repo}`,
      headBranch,
      baseBranch: body.base ?? "",
      title: body.title ?? "",
      body: body.body ?? "",
    });
    const number = store.length + 1;
    const record: StoredPullRequest = {
      number,
      html_url: `https://github.test/${parameters.owner}/${parameters.repo}/pull/${String(number)}`,
      head: { ref: headBranch, sha: options.resolveHeadSha?.(headBranch) ?? UNKNOWN_SHA },
      base: { ref: body.base ?? "" },
      title: body.title ?? "",
      body: body.body ?? "",
    };
    store.push(record);
    return reply.code(201).send(record);
  });

  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  return {
    baseUrl,
    created,
    lookups,
    stop: () => app.close(),
  };
};
