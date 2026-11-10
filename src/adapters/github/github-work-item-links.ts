import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";
import { WORK_ITEM_MAX_LINK_BYTES, type LinkTarget } from "~/domain/context/work-item-content.js";

const TIMEOUT_MS = 15_000;

type GitHubTarget = Extract<LinkTarget, { kind: "github_issue" | "github_pull" | "github_file" }>;

/**
 * docs/specs/work-item-images-and-links.md. Reads one GitHub issue, pull request or file that a
 * work item links, in a repository of the product, with a read-only App token scoped to that one
 * repository. The request goes to the API base URL of the install, never to the link itself, and
 * a redirect is an error, so no link can point the worker at another host.
 */
export class GitHubWorkItemLinks {
  constructor(
    private readonly options: {
      apiBaseUrl: () => Promise<string>;
      tokens: GitHubTokenProvider;
      fetch?: typeof fetch;
    },
  ) {}

  async read(target: GitHubTarget): Promise<{ title: string; content: string }> {
    const base = (await this.options.apiBaseUrl()).replace(/\/+$/, "");
    const [owner, name] = target.repository.split("/");
    const repository = `${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
    if (target.kind === "github_file") {
      const path = target.path.split("/").map(encodeURIComponent).join("/");
      const content = await this.call(
        `${base}/repos/${repository}/contents/${path}?ref=${encodeURIComponent(target.ref)}`,
        "application/vnd.github.raw",
        { contents: "read" },
        target,
      );
      return { title: `${target.repository} ${target.path} at ${target.ref}`, content };
    }
    const kind = target.kind === "github_pull" ? "pulls" : "issues";
    const text = await this.call(
      `${base}/repos/${repository}/${kind}/${target.number}`,
      "application/vnd.github+json",
      target.kind === "github_pull" ? { pull_requests: "read" } : { issues: "read" },
      target,
    );
    const body = JSON.parse(text) as { title?: unknown; body?: unknown; state?: unknown };
    const title = `${target.repository}#${target.number} ${typeof body.title === "string" ? body.title : ""}`.trim();
    const noun = target.kind === "github_pull" ? "Pull request" : "Issue";
    return {
      title,
      content:
        `# ${noun} ${title}\n\n` +
        (typeof body.state === "string" ? `State: ${body.state}\n\n` : "") +
        `${typeof body.body === "string" ? body.body : ""}`.trimEnd() +
        "\n",
    };
  }

  private async call(
    url: string,
    accept: string,
    scope: Parameters<GitHubTokenProvider["tokenForInstallation"]>[1],
    target: GitHubTarget,
  ): Promise<string> {
    let token: string;
    try {
      token = await this.options.tokens.tokenForInstallation(target.githubInstallationId, scope, [target.repository]);
    } catch (error) {
      const permission = Object.keys(scope ?? {}).join(", ");
      throw new Error(
        `the GitHub App token with ${permission} read access could not be minted. ` +
          `The installation may lack that permission: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const response = await (this.options.fetch ?? fetch)(url, {
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept,
        "x-github-api-version": "2022-11-28",
        "user-agent": "factoree",
        authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`the GitHub API answered ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > WORK_ITEM_MAX_LINK_BYTES) {
      await response.body?.cancel();
      throw new Error(`the content is ${declared} bytes, more than ${WORK_ITEM_MAX_LINK_BYTES}`);
    }
    return await response.text();
  }
}
