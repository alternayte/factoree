import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, chmodSync } from "node:fs";
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
  writeFileSync(join(origin, "café.txt"), "espresso\n");
  writeFileSync(join(origin, "a file with spaces.txt"), "spaced\n");
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
    expect(paths).toEqual([
      "README.md",
      "a file with spaces.txt",
      "big.bin",
      "café.txt",
      "docs/ADR-031.md",
    ]);
    const readme = tree.entries.find((entry) => entry.path === "README.md");
    expect(readme?.sizeBytes).toBeGreaterThan(0);
  });

  it("lists and reads a path holding a non-ASCII byte without quoting or escaping it", async () => {
    const tree = await reader.listTree(origin, headSha);
    const entry = tree.entries.find((candidate) => candidate.path === "café.txt");
    expect(entry).toBeDefined();
    await expect(reader.readBlob(origin, headSha, "café.txt")).resolves.toBe("espresso\n");
  });

  it("lists and reads a path holding a space without splitting it", async () => {
    const tree = await reader.listTree(origin, headSha);
    const entry = tree.entries.find((candidate) => candidate.path === "a file with spaces.txt");
    expect(entry).toBeDefined();
    await expect(reader.readBlob(origin, headSha, "a file with spaces.txt")).resolves.toBe("spaced\n");
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

  it("throws a RepositoryReadError for a genuine fault, rather than a false null", async () => {
    // A fresh reader isolates the mirror this test corrupts from the mirror the other tests
    // share. The directory a reader creates for its mirrors carries the prefix
    // "factoree-context-", so a before-and-after diff of the temporary directory finds it.
    const before = new Set(readdirSync(tmpdir()));
    const localReader = new GitRepositoryReader();
    await localReader.listTree(origin, headSha);
    const after = readdirSync(tmpdir());
    const contextDirName = after.find((name) => name.startsWith("factoree-context-") && !before.has(name));
    expect(contextDirName).toBeDefined();
    const contextDir = join(tmpdir(), contextDirName as string);
    const mirrorDirName = readdirSync(contextDir)[0];
    expect(mirrorDirName).toBeDefined();
    const mirrorDir = join(contextDir, mirrorDirName as string);

    // Corrupts the blob object of README.md inside the mirror, so a later read of it fails for a
    // reason other than "the path does not exist". Git keeps a fresh clone this small as loose
    // objects, so the object file exists on disk at a path derived from its own SHA.
    const blobSha = git(mirrorDir, "rev-parse", `${headSha}:README.md`).trim();
    const objectPath = join(mirrorDir, "objects", blobSha.slice(0, 2), blobSha.slice(2));
    expect(existsSync(objectPath)).toBe(true);
    chmodSync(objectPath, 0o644);
    writeFileSync(objectPath, "not a git object");

    await expect(localReader.readBlob(origin, headSha, "README.md")).rejects.toBeInstanceOf(
      RepositoryReadError,
    );
    localReader.close();
  });
});
