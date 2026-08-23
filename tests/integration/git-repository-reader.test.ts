import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRepositoryReader, RepositoryReadError } from "~/adapters/github/git-repository-reader.js";

let root = "";
let origin = "";
let headSha = "";
const reader = new GitRepositoryReader();

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e" },
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "factoree-reader-"));
  origin = join(root, "origin");
  mkdirSync(join(origin, "docs"), { recursive: true });
  writeFileSync(join(origin, "README.md"), "# Service\n\nNotifications are owned here.\n");
  writeFileSync(join(origin, "docs", "ADR-031.md"), "# ADR 31\n\nStatus: accepted\n");
  writeFileSync(join(origin, "big.bin"), "x".repeat(300_000));
  git(origin, "init", "--initial-branch", "main");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "initial");
  headSha = git(origin, "rev-parse", "HEAD").trim();
});

afterAll(() => {
  reader.close();
  rmSync(root, { recursive: true, force: true });
});

describe("GitRepositoryReader", () => {
  it("resolves a branch to an explicit forty character SHA", async () => {
    await expect(reader.resolveRef(origin, "main")).resolves.toBe(headSha);
  });

  it("returns a SHA unchanged", async () => {
    await expect(reader.resolveRef(origin, headSha)).resolves.toBe(headSha);
  });

  it("fails with a named error for a ref that does not exist", async () => {
    await expect(reader.resolveRef(origin, "no-such-branch")).rejects.toBeInstanceOf(RepositoryReadError);
  });

  it("fails with a named error for a repository that does not exist", async () => {
    await expect(reader.resolveRef(join(root, "absent"), "main")).rejects.toBeInstanceOf(
      RepositoryReadError,
    );
  });

  it("lists every path of the tree with its size", async () => {
    const tree = await reader.listTree(origin, headSha);
    expect(tree.truncated).toBe(false);
    const paths = tree.entries.map((entry) => entry.path).sort();
    expect(paths).toEqual(["README.md", "big.bin", "docs/ADR-031.md"]);
    const readme = tree.entries.find((entry) => entry.path === "README.md");
    expect(readme?.sizeBytes).toBeGreaterThan(0);
  });

  it("reads a blob at the pinned SHA", async () => {
    await expect(reader.readBlob(origin, headSha, "docs/ADR-031.md")).resolves.toContain("Status: accepted");
  });

  it("returns null for a path that does not exist at that SHA", async () => {
    await expect(reader.readBlob(origin, headSha, "docs/absent.md")).resolves.toBeNull();
  });

  it("returns null for a blob larger than the maximum", async () => {
    await expect(reader.readBlob(origin, headSha, "big.bin")).resolves.toBeNull();
  });

  it("does not modify the source repository", async () => {
    await reader.listTree(origin, headSha);
    await reader.readBlob(origin, headSha, "README.md");
    expect(git(origin, "status", "--porcelain")).toBe("");
    expect(git(origin, "rev-parse", "HEAD").trim()).toBe(headSha);
  });

  it("keeps a repository access token out of an error message", async () => {
    await expect(
      reader.resolveRef("https://user:supersecrettoken@127.0.0.1:1/owner/repo.git", "main"),
    ).rejects.toThrow(/^(?!.*supersecrettoken).*$/s);
  });
});
