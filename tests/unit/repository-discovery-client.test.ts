import { describe, expect, it } from "vitest";
import { GitHubRepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";

describe("GitHubRepositoryDiscoveryClient.readConfig", () => {
  it("returns null when the configuration file is absent", async () => {
    const client = new GitHubRepositoryDiscoveryClient({
      token: "t",
      fetch: () => Promise.resolve(new Response("", { status: 404 })),
    });

    expect(await client.readConfig("acme/api", "main")).toBeNull();
  });

  it("returns the decoded content and the blob sha", async () => {
    const body = JSON.stringify({
      sha: "4f21c9e",
      content: Buffer.from("version: 1\n").toString("base64"),
      encoding: "base64",
    });
    const client = new GitHubRepositoryDiscoveryClient({
      token: "t",
      fetch: () => Promise.resolve(new Response(body, { status: 200 })),
    });

    expect(await client.readConfig("acme/api", "main")).toEqual({ content: "version: 1\n", sha: "4f21c9e" });
  });

  it("throws on a failure that is not a missing file", async () => {
    const client = new GitHubRepositoryDiscoveryClient({
      token: "t",
      fetch: () => Promise.resolve(new Response("", { status: 500 })),
    });

    await expect(client.readConfig("acme/api", "main")).rejects.toThrow();
  });
});

describe("GitHubRepositoryDiscoveryClient.listInstallationRepositories", () => {
  it("follows pagination through the link header and returns every repository", async () => {
    const calls: string[] = [];
    const pageOne = JSON.stringify({ repositories: [{ full_name: "acme/api", default_branch: "main" }] });
    const pageTwo = JSON.stringify({ repositories: [{ full_name: "acme/web", default_branch: "trunk" }] });

    const fetchImpl = ((url: string) => {
      calls.push(url);
      if (calls.length === 1) {
        return Promise.resolve(
          new Response(pageOne, {
            status: 200,
            headers: { link: '<https://api.github.com/installation/repositories?page=2>; rel="next"' },
          }),
        );
      }
      return Promise.resolve(new Response(pageTwo, { status: 200 }));
    }) as unknown as typeof fetch;

    const client = new GitHubRepositoryDiscoveryClient({ token: "t", fetch: fetchImpl });

    const repositories = await client.listInstallationRepositories("42");

    expect(repositories).toEqual([
      { fullName: "acme/api", defaultBranch: "main" },
      { fullName: "acme/web", defaultBranch: "trunk" },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe("https://api.github.com/installation/repositories?page=2");
  });
});
