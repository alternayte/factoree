import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The identity every fixture commit carries. A test machine needs no global git identity. */
const IDENTITY = ["-c", "user.email=fixture@factoree.test", "-c", "user.name=fixture"];

/** Runs one git command against the fixture repository at `path` and returns standard output. */
export const git = async (path: string, args: string[]): Promise<string> => {
  const result = await run("git", ["-C", path, ...args]);
  return result.stdout;
};

/**
 * Creates a git repository on disk that a clone can reach through a plain path. The Phase 2
 * acceptance tests never reach the network, so the fixture is local.
 *
 * The repository also allows the file transport for itself. A host with a stricter
 * `protocol.file.allow` value must not break the fixture, and production code must not carry a
 * test setting.
 */
export const createFixtureRepository = async (root: string, name: string): Promise<string> => {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await run("git", ["init", "--initial-branch=main", path]);
  await run("git", ["-C", path, "config", "protocol.file.allow", "always"]);
  await writeFile(join(path, "target.txt"), "original\n", "utf8");
  await writeFile(join(path, "CONTRIBUTING.md"), "Keep the change small.\n", "utf8");
  await run("git", ["-C", path, "add", "."]);
  await run("git", ["-C", path, ...IDENTITY, "commit", "-m", "initial"]);
  return path;
};

/**
 * Lists every ref the repository holds, sorted, so a test can prove nothing was added and
 * nothing moved. Each line carries the ref name and the object name it points at. A name alone
 * would miss a force push that rewrote an existing branch.
 */
export const listRefs = async (path: string): Promise<string[]> => {
  const output = await git(path, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
};
