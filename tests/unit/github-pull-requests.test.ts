import { describe, expect, it } from "vitest";
import { GitHubPullRequests } from "~/adapters/github/github-pull-requests.js";

interface Call { url: string; init: RequestInit }

const client = (
  respond: (call: Call) => Response,
): { port: GitHubPullRequests; calls: Call[]; asked: string[] } => {
  const calls: Call[] = [];
  const asked: string[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(respond({ url: String(url), init }));
  }) as unknown as typeof fetch;
  return {
    port: new GitHubPullRequests({
      apiBaseUrl: "https://api.example.test",
      tokens: {
        tokenForInstallation: (id: string) => {
          asked.push(id);
          return Promise.resolve("ghp_x");
        },
      },
      fetch: fetchImpl,
    }),
    calls,
    asked,
  };
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("GitHubPullRequests", () => {
  it("creates one pull request and returns its number and URL", async () => {
    const { port, calls } = client(() => json(201, { number: 7, html_url: "https://github.com/o/r/pull/7", head: { sha: "dddddddddddddddddddddddddddddddddddddddd" } }));
    const record = await port.create(
      {
        slug: "o/r",
        headBranch: "factoree/run-1",
        draft: false,
        baseBranch: "main",
        title: "Factoree: x",
        body: "body",
      },
      "42",
    );
    expect(record).toEqual({
      number: 7,
      url: "https://github.com/o/r/pull/7",
      headBranch: "factoree/run-1",
      headSha: "dddddddddddddddddddddddddddddddddddddddd",
    });
    expect(calls[0]?.url).toBe("https://api.example.test/repos/o/r/pulls");
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("mints a token for the installation it is asked to reach", async () => {
    const { port, asked } = client(() => json(200, []));
    await port.findByHead("o/r", "factoree/run-1", "42");
    await port.findByHead("o/r", "factoree/run-1", "43");
    expect(asked).toEqual(["42", "43"]);
  });

  it("finds an existing pull request for the head branch", async () => {
    const { port, calls } = client(() => json(200, [{ number: 9, html_url: "https://github.com/o/r/pull/9", head: { sha: "dddddddddddddddddddddddddddddddddddddddd" } }]));
    const record = await port.findByHead("o/r", "factoree/run-1", "42");
    expect(record?.number).toBe(9);
    // The tip commit of the head branch arrives with the answer. Factoree needs no second read.
    expect(record?.headSha).toBe("dddddddddddddddddddddddddddddddddddddddd");
    expect(calls[0]?.url).toContain("head=o%3Afactoree%2Frun-1");
  });

  it("refuses an answer that carries no head SHA", async () => {
    const { port } = client(() => json(201, { number: 7, html_url: "https://github.com/o/r/pull/7" }));
    await expect(
      port.create({ slug: "o/r", headBranch: "h", baseBranch: "main", title: "t", body: "b", draft: false }, "42"),
    ).rejects.toThrow(/head SHA/);
  });

  it("returns null when no pull request exists for the head branch", async () => {
    const { port } = client(() => json(200, []));
    expect(await port.findByHead("o/r", "factoree/run-1", "42")).toBeNull();
  });

  it("never places the token in an error message", async () => {
    const { port } = client(() => json(422, { message: "Validation failed" }));
    await expect(
      port.create({ slug: "o/r", headBranch: "h", baseBranch: "main", title: "t", body: "b", draft: false }, "42"),
    ).rejects.toThrow(/422/);
    await expect(
      port.create({ slug: "o/r", headBranch: "h", baseBranch: "main", title: "t", body: "b", draft: false }, "42"),
    ).rejects.not.toThrow(/ghp_x/);
  });

  it("refuses a slug that is not owner/repo", async () => {
    const { port } = client(() => json(200, []));
    await expect(port.findByHead("../evil", "h", "42")).rejects.toThrow();
  });
});

describe("GitHubPullRequests.findByNumber", () => {
  // The Proof Pack names the pull request by its URL, and SDD section 47 fixes that section as
  // the URL alone. The live acceptance scenario therefore confirms by number. It looked for a
  // head branch in that section before, and the Proof Pack writes none, so it confirmed nothing
  // even when the pull request existed.
  it("reads the pull request of that number, and its head branch", async () => {
    const { port, calls } = client(() =>
      json(200, {
        number: 2,
        html_url: "https://github.com/o/r/pull/2",
        head: { ref: "factoree/run-1", sha: "d".repeat(40) },
      }),
    );

    const record = await port.findByNumber("o/r", 2, "42");

    expect(record).toEqual({
      number: 2,
      url: "https://github.com/o/r/pull/2",
      headBranch: "factoree/run-1",
      headSha: "d".repeat(40),
    });
    expect(calls[0]?.url).toBe("https://api.example.test/repos/o/r/pulls/2");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("returns null when GitHub answers that the pull request does not exist", async () => {
    const { port } = client(() => json(404, { message: "Not Found" }));

    await expect(port.findByNumber("o/r", 404, "42")).resolves.toBeNull();
  });

  it("reports any other failure, so a broken token never reads as a missing pull request", async () => {
    const { port } = client(() => json(401, { message: "Bad credentials" }));

    await expect(port.findByNumber("o/r", 2, "42")).rejects.toThrow(/401/);
  });

  it("refuses a slug that is not owner and repository", async () => {
    const { port } = client(() => json(200, {}));

    await expect(port.findByNumber("not-a-slug", 2, "42")).rejects.toThrow(/owner\/repo/);
  });
});
