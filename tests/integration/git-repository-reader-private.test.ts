import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";

/**
 * GitHub issue 38. The reader mirrors with `--filter=blob:none`, so a size read or a blob read
 * fetches a missing blob from the remote later. A private repository refuses that fetch without
 * the credential. This server is `git http-backend` behind a check that refuses any request
 * without the expected Authorization header, as GitHub does for a private repository.
 */
const TOKEN = "test-installation-token";
const EXPECTED = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;

let root = "";
let server: Server;
let url = "";
let headSha = "";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e" },
  });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "factoree-private-"));
  const work = join(root, "work");
  mkdirSync(join(work, "docs"), { recursive: true });
  writeFileSync(join(work, "README.md"), "# Private\n");
  writeFileSync(join(work, "docs", "ADR-1.md"), "# ADR 1\n");
  git(work, "init", "--initial-branch", "main");
  git(work, "add", ".");
  git(work, "commit", "-m", "initial");
  headSha = git(work, "rev-parse", "HEAD").trim();
  const repositories = join(root, "repositories");
  mkdirSync(join(repositories, "owner"), { recursive: true });
  git(root, "clone", "--bare", "-q", work, join(repositories, "owner", "repo.git"));
  const bare = join(repositories, "owner", "repo.git");
  git(bare, "config", "uploadpack.allowFilter", "true");
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(bare, "config", "http.uploadpack", "true");

  server = createServer((request, response) => {
    if (request.headers.authorization !== EXPECTED) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="private"' });
      response.end();
      return;
    }
    const parsed = new URL(request.url ?? "/", "http://localhost");
    const backend = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_PROJECT_ROOT: repositories,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: parsed.pathname,
        QUERY_STRING: parsed.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
        HTTP_CONTENT_ENCODING: String(request.headers["content-encoding"] ?? ""),
        REMOTE_USER: "x-access-token",
      },
    });
    request.pipe(backend.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    backend.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) {
        response.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      headersDone = true;
      let status = 200;
      for (const line of head.subarray(0, end).toString("utf8").split("\r\n")) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else response.setHeader(name, value);
      }
      response.writeHead(status);
      response.write(head.subarray(end + 4));
    });
    backend.on("close", () => response.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/owner/repo.git`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

const tokens: GitHubTokenProvider = { tokenForInstallation: () => Promise.resolve(TOKEN) };

describe("GitRepositoryReader on a private repository", () => {
  it("lists the tree with sizes and reads a blob under the credential", async () => {
    const reader = new GitRepositoryReader();
    const credential = { origin: new URL(url).origin, tokens, githubInstallationId: "1" };
    const listing = await reader.withCredential(credential, () => reader.listTree(url, headSha));
    expect(listing.entries.map((entry) => entry.path).sort()).toEqual(["README.md", "docs/ADR-1.md"]);
    expect(listing.entries.find((entry) => entry.path === "README.md")?.sizeBytes).toBe(10);
    const blob = await reader.withCredential(credential, () => reader.readBlob(url, headSha, "docs/ADR-1.md"));
    expect(blob).toBe("# ADR 1\n");
    reader.close();
  });
});
