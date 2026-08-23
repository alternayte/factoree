import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { commitAll } from "./fixture-repository.js";

const run = promisify(execFile);

/** The primary repository of every Phase 4 acceptance test. */
export const PRIMARY_SLUG = "acme/webhook-service";

/** The reference repository of every Phase 4 acceptance test. */
export const REFERENCE_SLUG = "acme/notification-service";

/**
 * A distinctive string inside the large file. AT-09 proves that the initial agent prompt never
 * holds it, so the marker must appear nowhere else in the fixture.
 */
export const LARGE_FILE_MARKER = "FACTOREE-AT09-LARGE-BLOB-MARKER";

/** The path of the large file inside the primary repository. */
export const LARGE_FILE_PATH = "src/retry-catalog.ts";

/** The size of the large file. It is far above `CONTEXT_REQUIRED_MAX_BYTES`. */
export const LARGE_FILE_BYTES = 200 * 1024;

/**
 * The minimal valid `.factoree/config.yaml` of the primary repository. It declares exactly one
 * verification command, so a sandbox preparation over this fixture is valid.
 */
export const CONTEXT_FIXTURE_CONFIG = `version: 1

verify:
  commands:
    - name: check
      run: "true"
`;

export interface ContextFixtureOptions {
  /**
   * Extra files the primary repository carries, by path. AT-08 adds a second accepted ADR this
   * way. The builder writes each file before the single commit.
   */
  extraPrimaryFiles?: Record<string, string>;
}

export interface ContextFixture {
  root: string;
  primaryPath: string;
  primaryUrl: string;
  primarySha: string;
  referencePath: string;
  referenceUrl: string;
  referenceSha: string;
  cleanup(): void;
}

/**
 * The primary repository files. The README and the accepted ADR disagree about the same subject,
 * and both name that subject in their text rather than in their path. AT-07 needs that, because
 * the resolver derives a topic from the content of a preloaded item.
 *
 * Every other file avoids the Work Item topics on purpose. A file that shares a topic with the
 * README adds a second conflict pair, and the acceptance tests then assert on an accident.
 */
const PRIMARY_FILES: Record<string, string> = {
  ".factoree/config.yaml": CONTEXT_FIXTURE_CONFIG,
  "README.md": "# Webhook service\n\nThis service owns notification retry.\n",
  "docs/ADR-031.md":
    "# ADR-031\n\nStatus: accepted\n\nThe sibling service owns notification retry.\n",
  "src/retry.ts":
    "export const retryOnce = (attempt: number): number => attempt + 1;\n",
  "tests/retry.test.ts":
    'import { retryOnce } from "../src/retry.js";\n\nexport const check = () => retryOnce(1);\n',
};

/**
 * The reference repository files. The README states no Work Item topic, so it competes with no
 * primary file and the AT-07 conflict stays the single pair the tests assert on.
 */
const REFERENCE_FILES: Record<string, string> = {
  "openapi.yaml":
    'openapi: "3.1.0"\ninfo:\n  title: Sibling API\n  version: "1.0.0"\npaths: {}\n',
  "README.md": "# Reference\n\nThis repository holds the public API contract.\n",
};

/** A file of `LARGE_FILE_BYTES`. It carries the marker once and no Work Item topic. */
const largeFileContent = (): string => {
  const line = `// ${LARGE_FILE_MARKER} padding padding padding padding padding padding\n`;
  const filler = "// 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n";
  let body = line;
  while (body.length < LARGE_FILE_BYTES) body += filler;
  return body;
};

const writeFiles = async (path: string, files: Record<string, string>): Promise<void> => {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(path, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
};

/**
 * Creates one git repository whose directory name ends in `.git`, so that
 * `buildRepositoryUrl(root, slug)` names it exactly. A workflow test can then use the fixture
 * root as the repository base URL of the Project.
 */
const createRepository = async (
  root: string,
  slug: string,
  files: Record<string, string>,
): Promise<{ path: string; sha: string }> => {
  const path = join(root, `${slug}.git`);
  await mkdir(path, { recursive: true });
  await run("git", ["init", "--initial-branch=main", path]);
  await run("git", ["-C", path, "config", "protocol.file.allow", "always"]);
  // A partial clone of this repository reads only the blobs it needs. The reader asks for that
  // filter, so the fixture must permit it.
  await run("git", ["-C", path, "config", "uploadpack.allowFilter", "true"]);
  await writeFiles(path, files);
  const sha = await commitAll(path, "initial");
  return { path, sha };
};

/**
 * Builds the two local git repositories every Phase 4 acceptance test reads. Both are real
 * repositories on disk, so `GitRepositoryReader` and `SandboxManager` reach them through git and
 * never through the network.
 */
export const buildContextFixture = async (
  options: ContextFixtureOptions = {},
): Promise<ContextFixture> => {
  const root = await mkdtemp(join(tmpdir(), "factoree-context-fixture-"));
  try {
    const primary = await createRepository(root, PRIMARY_SLUG, {
      ...PRIMARY_FILES,
      [LARGE_FILE_PATH]: largeFileContent(),
      ...(options.extraPrimaryFiles ?? {}),
    });
    const reference = await createRepository(root, REFERENCE_SLUG, REFERENCE_FILES);

    return {
      root,
      primaryPath: primary.path,
      primaryUrl: primary.path,
      primarySha: primary.sha,
      referencePath: reference.path,
      referenceUrl: reference.path,
      referenceSha: reference.sha,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};
