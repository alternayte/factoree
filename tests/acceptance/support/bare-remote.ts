import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A real bare git repository on local disk. It stands in for the GitHub remote of a Project.
 * The Phase 9 acceptance tests never reach the network, so the remote is local. A test reads a
 * ref of it to prove that a branch reached the remote, or that no branch reached the remote.
 */
export interface BareRemote {
  /** The path a clone reads. `publishToBranch` accepts it, because it is not a URL scheme. */
  cloneUrl: string;
  /** The commit the default branch held when the remote was created. */
  baseSha: string;
  /** The commit SHA of one ref, or null when the remote holds no such ref. */
  refSha: (ref: string) => string | null;
  /** Every ref the remote holds, sorted. A test proves that no new branch appeared. */
  listRefs: () => string[];
  /** Adds one commit to the default branch and returns the new head SHA. */
  advanceHead: (content: string) => string;
  destroy: () => Promise<void>;
}

/** The identity every fixture commit carries. A test machine needs no global git identity. */
const IDENTITY = ["-c", "user.email=fixture@factoree.test", "-c", "user.name=fixture"];

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

/**
 * Creates a bare repository whose default branch `main` holds `files`, and returns the handle a
 * test drives it through. The caller must call `destroy` to remove every directory.
 */
export const createBareRemote = (options: {
  files: Record<string, string>;
}): Promise<BareRemote> => {
  const root = mkdtempSync(join(tmpdir(), "factoree-remote-"));
  const bare = join(root, "remote.git");
  const work = join(root, "seed");

  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare]);
  execFileSync("git", ["-C", bare, "config", "protocol.file.allow", "always"]);
  execFileSync("git", ["clone", bare, work]);
  git(work, ["config", "protocol.file.allow", "always"]);

  for (const [path, content] of Object.entries(options.files)) {
    writeFileSync(join(work, path), content, "utf8");
  }
  git(work, ["add", "-A"]);
  git(work, [...IDENTITY, "commit", "-m", "base"]);
  git(work, ["push", "origin", "main"]);
  const baseSha = git(work, ["rev-parse", "HEAD"]).trim();

  let upstreamCommits = 0;

  const remote: BareRemote = {
    cloneUrl: bare,
    baseSha,
    refSha: (ref: string): string | null => {
      try {
        return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
          cwd: bare,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return null;
      }
    },
    listRefs: (): string[] =>
      git(bare, ["for-each-ref", "--format=%(refname)"])
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .sort(),
    advanceHead: (content: string): string => {
      upstreamCommits += 1;
      writeFileSync(join(work, `upstream-${String(upstreamCommits)}.txt`), content, "utf8");
      git(work, ["add", "-A"]);
      git(work, [...IDENTITY, "commit", "-m", `upstream change ${String(upstreamCommits)}`]);
      git(work, ["push", "origin", "main"]);
      return git(work, ["rev-parse", "HEAD"]).trim();
    },
    destroy: (): Promise<void> => {
      rmSync(root, { recursive: true, force: true });
      return Promise.resolve();
    },
  };
  return Promise.resolve(remote);
};
