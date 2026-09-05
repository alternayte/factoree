import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The identity every fixture commit carries. A test machine needs no global git identity. */
const IDENTITY = ["-c", "user.email=fixture@factoree.test", "-c", "user.name=fixture"];

/**
 * The fixture configuration. The single check passes only when the Implementer really replaced
 * the contents of `target.txt`, so a false success claim fails it.
 */
export const FIXTURE_CONFIG = `version: 1

identity:
  product: fixture-product
  linear:
    teamKey: FIX

verify:
  commands:
    - name: check
      run: test "$(cat target.txt)" != "original"
`;

/** Runs one git command against the fixture repository at `path` and returns standard output. */
export const git = async (path: string, args: string[]): Promise<string> => {
  const result = await run("git", ["-C", path, ...args]);
  return result.stdout;
};

/**
 * Stages every file of the fixture repository at `path` and commits it. The commit carries the
 * fixture identity, so a test machine needs no global git identity. Every fixture builder calls
 * this helper, so the suite holds one commit rule only.
 */
export const commitAll = async (path: string, message: string): Promise<string> => {
  await run("git", ["-C", path, "add", "-A"]);
  await run("git", ["-C", path, ...IDENTITY, "commit", "-m", message]);
  const head = await run("git", ["-C", path, "rev-parse", "HEAD"]);
  return head.stdout.trim();
};

/**
 * Creates an empty git repository at `path`, with the file transport allowed for itself. Every
 * fixture builder starts from this call, so the suite holds one initialization rule only. A
 * host with a stricter `protocol.file.allow` value must not break a fixture, and production
 * code must not carry a test setting.
 */
export const initRepository = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true });
  await run("git", ["init", "--initial-branch=main", path]);
  await run("git", ["-C", path, "config", "protocol.file.allow", "always"]);
};

/**
 * Creates a git repository on disk that a clone can reach through a plain path. The Phase 2
 * acceptance tests never reach the network, so the fixture is local.
 *
 * The repository also allows the file transport for itself. A host with a stricter
 * `protocol.file.allow` value must not break the fixture, and production code must not carry a
 * test setting.
 */
export const createFixtureRepository = async (
  root: string,
  name: string,
  configYaml: string = FIXTURE_CONFIG,
): Promise<string> => {
  const path = join(root, name);
  await initRepository(path);
  await writeFile(join(path, "target.txt"), "original\n", "utf8");
  await writeFile(join(path, "CONTRIBUTING.md"), "Keep the change small.\n", "utf8");
  await mkdir(join(path, ".factoree"), { recursive: true });
  await writeFile(join(path, ".factoree", "config.yaml"), configYaml, "utf8");
  await commitAll(path, "initial");
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
