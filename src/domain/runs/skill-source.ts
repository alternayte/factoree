import type { Sandbox, SandboxRef } from "./sandbox.js";
import type { DiscoveredSkill, SkillScope, SkillSet } from "./skill-discovery.js";
import { parseSkillDocument, resolveSkills, SKILL_DIRECTORIES, SKILL_FILE_NAME } from "./skill-discovery.js";

/**
 * SDD section 16. The only honest source of a skill is the checkout inside the sandbox. Every
 * read goes through `Sandbox.exec`, so no adapter needs a file API and both adapters behave
 * alike. This mirrors `repository-config-source.ts`.
 */

/** The largest number of entries this reader opens in one skill directory. */
export const MAX_SKILL_ENTRIES_PER_DIRECTORY = 200;

/**
 * The largest number of bytes this reader loads from one `SKILL.md`. `parseSkillDocument` reads
 * only the YAML frontmatter, which sits at the top of the document, so a bound this size never
 * loses a real frontmatter. It stops an oversized file from exhausting memory.
 */
export const SKILL_FILE_READ_CAP_BYTES = 65536;

/** A line the reader emits when a directory listing fails for a reason other than "missing". */
export interface SkillSourceLogger {
  warn: (message: string, detail: { path: string; exitCode: number; stderr: string }) => void;
}

const NO_LOGGER: SkillSourceLogger = { warn: () => {} };

/**
 * True when `stderr` names an ordinary missing path. `ls` and `head` both write this message for
 * a path that simply does not exist, on every platform this project targets. Any other failure,
 * for example a permission error, is unexpected and is worth one log line.
 */
const namesAMissingPath = (stderr: string): boolean => /no such file or directory/i.test(stderr);

export interface SkillRoot {
  scope: SkillScope;
  /** The absolute checkout path inside the sandbox. */
  path: string;
}

const join = (...parts: string[]): string =>
  parts.map((part, index) => (index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, ""))).join("/");

/**
 * A usable skill directory entry. A name with a slash, a leading hyphen, or a dot segment can
 * change the meaning of a command line or escape the directory. It is refused rather than read.
 */
const USABLE_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const listDirectory = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  path: string,
  logger: SkillSourceLogger,
): Promise<string[]> => {
  const result = await sandbox.exec(ref, { file: "ls", args: ["-1", "--", path] });
  if (result.exitCode !== 0) {
    if (!namesAMissingPath(result.stderr)) {
      logger.warn("skill directory listing failed", { path, exitCode: result.exitCode, stderr: result.stderr });
    }
    return [];
  }
  return result.stdout
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

const readFile = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  path: string,
  logger: SkillSourceLogger,
): Promise<string | null> => {
  // Only the YAML frontmatter of a SKILL.md is ever used, and it sits at the top of the file, so
  // a bounded read is enough. `head -c` also protects the sandbox from an oversized committed file.
  const result = await sandbox.exec(ref, {
    file: "head",
    args: ["-c", String(SKILL_FILE_READ_CAP_BYTES), "--", path],
  });
  if (result.exitCode !== 0) {
    if (!namesAMissingPath(result.stderr)) {
      logger.warn("skill file read failed", { path, exitCode: result.exitCode, stderr: result.stderr });
    }
    return null;
  }
  return result.stdout;
};

/**
 * Discovers every skill of every root, in precedence order. The caller supplies the roots in
 * that order, and the repository root always precedes the organization root. Inside one root the
 * order of `SKILL_DIRECTORIES` applies, and inside one directory the entry name orders the
 * candidates. `resolveSkills` then applies the first candidate of each name and reports the rest.
 */
export const discoverSkills = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  roots: SkillRoot[],
  logger: SkillSourceLogger = NO_LOGGER,
): Promise<SkillSet> => {
  const candidates: DiscoveredSkill[] = [];

  for (const root of roots) {
    for (const directory of SKILL_DIRECTORIES) {
      const base = join(root.path, directory);
      const entries = (await listDirectory(sandbox, ref, base, logger))
        .filter((entry) => USABLE_ENTRY.test(entry))
        .sort((left, right) => left.localeCompare(right))
        .slice(0, MAX_SKILL_ENTRIES_PER_DIRECTORY);

      for (const entry of entries) {
        const path = join(base, entry, SKILL_FILE_NAME);
        const text = await readFile(sandbox, ref, path, logger);
        // An entry without a SKILL.md is not a skill. A README file lives beside a skill.
        if (text === null) continue;
        candidates.push(
          parseSkillDocument(text, { scope: root.scope, root: root.path, directory, name: entry, path }),
        );
      }
    }
  }

  return resolveSkills(candidates);
};
