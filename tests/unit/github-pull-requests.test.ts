import { describe, expect, it } from "vitest";
import { GitHubPullRequests } from "~/adapters/github/github-pull-requests.js";

interface Call { url: string; init: RequestInit }

const client = (respond: (call: Call) => Response): { port: GitHubPullRequests; calls: Call[] } => {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(respond({ url: String(url), init }));
  }) as unknown as typeof fetch;
  return {
    port: new GitHubPullRequests({ apiBaseUrl: "https://api.example.test", token: "ghp_x", fetch: fetchImpl }),
    calls,
  };
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("GitHubPullRequests", () => {
  it("creates one pull request and returns its number and URL", async () => {
    const { port, calls } = client(() => json(201, { number: 7, html_url: "https://github.com/o/r/pull/7" }));
    const record = await port.create({
      slug: "o/r",
      headBranch: "factoree/run-1",
      baseBranch: "main",
      title: "Factoree: x",
      body: "body",
    });
    expect(record).toEqual({ number: 7, url: "https://github.com/o/r/pull/7", headBranch: "factoree/run-1" });
    expect(calls[0]?.url).toBe("https://api.example.test/repos/o/r/pulls");
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("finds an existing pull request for the head branch", async () => {
    const { port, calls } = client(() => json(200, [{ number: 9, html_url: "https://github.com/o/r/pull/9" }]));
    const record = await port.findByHead("o/r", "factoree/run-1");
    expect(record?.number).toBe(9);
    expect(calls[0]?.url).toContain("head=o%3Afactoree%2Frun-1");
  });

  it("returns null when no pull request exists for the head branch", async () => {
    const { port } = client(() => json(200, []));
    expect(await port.findByHead("o/r", "factoree/run-1")).toBeNull();
  });

  it("never places the token in an error message", async () => {
    const { port } = client(() => json(422, { message: "Validation failed" }));
    await expect(
      port.create({ slug: "o/r", headBranch: "h", baseBranch: "main", title: "t", body: "b" }),
    ).rejects.toThrow(/422/);
    await expect(
      port.create({ slug: "o/r", headBranch: "h", baseBranch: "main", title: "t", body: "b" }),
    ).rejects.not.toThrow(/ghp_x/);
  });

  it("refuses a slug that is not owner/repo", async () => {
    const { port } = client(() => json(200, []));
    await expect(port.findByHead("../evil", "h")).rejects.toThrow();
  });
});
