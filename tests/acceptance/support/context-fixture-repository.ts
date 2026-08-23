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
 * The repository the Backstage catalog names, and the Project does not configure. The Phase 5
 * exit test proves that automatic discovery pins it. It is deliberately absent from the
 * configured reference list of `resolveFixtureContext`.
 */
export const DISCOVERED_SLUG = "acme/audit-service";

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

/**
 * The `.factoree/config.yaml` of AT-04. It turns Backstage topology discovery and automatic
 * reference repository discovery on, so the Backstage source and the discovered-repository path
 * of the resolver are both exercised end to end.
 */
export const CONTEXT_FIXTURE_CONFIG_WITH_TOPOLOGY = `version: 1

verify:
  commands:
    - name: check
      run: "true"

context:
  backstage:
    enabled: true
  referenceRepositories:
    automaticDiscovery: true
`;

export interface ContextFixtureOptions {
  /**
   * Extra files the primary repository carries, by path. AT-08 adds a second accepted ADR this
   * way. The builder writes each file before the single commit.
   */
  extraPrimaryFiles?: Record<string, string>;
  /**
   * The `.factoree/config.yaml` the primary repository carries. AT-04 turns the `context` block
   * on. The default is `CONTEXT_FIXTURE_CONFIG`, so every Phase 4 acceptance test is unchanged.
   */
  primaryConfig?: string;
  /**
   * Builds a third repository, the one the Backstage catalog names and the Project does not
   * configure. The Phase 5 exit test needs a real repository behind the discovered reference,
   * because the resolver reads it and pins its SHA.
   */
  withDiscoveredRepository?: boolean;
  /**
   * The form of every repository URL of the fixture. `"file"` gives a `file://` URL, which
   * `new URL(...)` parses. The resolver compares the host of the primary URL with the host of a
   * discovered URL, and a bare filesystem path parses as no URL at all, so automatic discovery
   * needs this form. `git` reads a `file://` URL over its real transport.
   */
  urlStyle?: "path" | "file";
}

export interface ContextFixture {
  root: string;
  primaryPath: string;
  primaryUrl: string;
  primarySha: string;
  referencePath: string;
  referenceUrl: string;
  referenceSha: string;
  /** Present only when `withDiscoveredRepository` was asked for. */
  discoveredPath: string | null;
  discoveredUrl: string | null;
  discoveredSha: string | null;
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
 * The files of the repository the catalog names. The README states no Work Item topic, so the
 * discovered repository adds no conflict pair to the tests that assert on one.
 */
const DISCOVERED_FILES: Record<string, string> = {
  "README.md": "# Audit\n\nThis repository records an audit trail.\n",
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
      ".factoree/config.yaml": options.primaryConfig ?? CONTEXT_FIXTURE_CONFIG,
      ...(options.extraPrimaryFiles ?? {}),
    });
    const reference = await createRepository(root, REFERENCE_SLUG, REFERENCE_FILES);
    const discovered =
      options.withDiscoveredRepository === true
        ? await createRepository(root, DISCOVERED_SLUG, DISCOVERED_FILES)
        : null;

    const urlOf = (path: string): string =>
      options.urlStyle === "file" ? `file://${path}` : path;

    return {
      root,
      primaryPath: primary.path,
      primaryUrl: urlOf(primary.path),
      primarySha: primary.sha,
      referencePath: reference.path,
      referenceUrl: urlOf(reference.path),
      referenceSha: reference.sha,
      discoveredPath: discovered === null ? null : discovered.path,
      discoveredUrl: discovered === null ? null : urlOf(discovered.path),
      discoveredSha: discovered === null ? null : discovered.sha,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};
