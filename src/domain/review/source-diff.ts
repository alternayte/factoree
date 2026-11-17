import { createHash } from "node:crypto";
import { PATCH_GIT_OPTIONS } from "~/domain/publishing/patch.js";
import type { Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import type { Redactor } from "~/telemetry/redaction.js";

/**
 * The byte ceiling of the diff text the Reviewer prompt carries. A diff above it is truncated,
 * and the prompt states that plainly. The changed-file list is never truncated. See controller
 * decision 13.
 */
export const MAX_REVIEW_DIFF_BYTES = 200_000;

const SHA = /^[0-9a-f]{40}$/;

export interface SourceDiff {
  /** The redacted diff text, truncated when it passed the ceiling. */
  text: string;
  truncated: boolean;
  /** Every path the change touched, relative to the primary worktree. */
  changedFiles: string[];
}

export class SourceDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceDiffError";
  }
}

export interface SourceDiffDependencies {
  sandbox: Sandbox;
  redactor: Redactor;
}

export interface SourceDiffInput {
  ref: SandboxRef;
  primaryPath: string;
  baseSha: string;
  maxBytes?: number;
}

interface GitTarget {
  ref: SandboxRef;
  primaryPath: string;
}

const git = async (
  dependencies: SourceDiffDependencies,
  target: GitTarget,
  args: string[],
): Promise<string> => {
  const result = await dependencies.sandbox.exec(target.ref, {
    file: "git",
    args: ["-C", target.primaryPath, ...args],
  });
  if (result.exitCode !== 0) {
    throw new SourceDiffError(
      `git ${args.join(" ")} failed with exit code ${result.exitCode}: ` +
        dependencies.redactor.redactText(result.stderr.trim()),
    );
  }
  return result.stdout;
};

/**
 * SDD section 44 fixes this command pair for the verified patch. Phase 8 reads it for the
 * Reviewer, and Phase 9 hashes the same output, so the change under review and the change under
 * publication can never differ. See DI-8.12.
 *
 * `--binary` is deliberately absent. A binary file appears in the changed-file list by name, and
 * binary bytes help no Reviewer. See DI-8.14.
 */
export const captureSourceDiff = async (
  dependencies: SourceDiffDependencies,
  input: SourceDiffInput,
): Promise<SourceDiff> => {
  if (!SHA.test(input.baseSha)) {
    throw new SourceDiffError(
      `the base SHA is not forty hexadecimal characters: "${input.baseSha}"`,
    );
  }

  // Staging changes no source file. It records what the worktree already holds, so the diff
  // covers a new file as well as a changed file.
  await git(dependencies, input, ["add", "-A"]);

  // The name query uses the same rename pinning as the publication capture. Git defaults
  // `diff.renames` to true, so an unpinned query names only the destination of a rename. The
  // publication names both paths. The two lists must agree, or the publication refuses the
  // change for a defect that does not exist.
  const names = await git(dependencies, input, [
    ...PATCH_GIT_OPTIONS,
    "diff",
    "--cached",
    "--no-renames",
    "--name-only",
    input.baseSha,
  ]);
  const changedFiles = names
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const raw = await git(dependencies, input, ["diff", "--cached", input.baseSha]);
  const redacted = dependencies.redactor.redactText(raw);

  if (changedFiles.length === 0 && redacted.trim() === "") {
    return {
      text: "The primary worktree holds no change against the base SHA.",
      truncated: false,
      changedFiles: [],
    };
  }

  const ceiling = input.maxBytes ?? MAX_REVIEW_DIFF_BYTES;
  if (redacted.length <= ceiling) {
    return { text: redacted, truncated: false, changedFiles };
  }

  return {
    text:
      `${redacted.slice(0, ceiling)}\n\n` +
      `[Factoree truncated this diff at ${ceiling} characters. The changed-file list is complete.]`,
    truncated: true,
    changedFiles,
  };
};

/**
 * The git tree object of the primary worktree, staged. Two equal fingerprints prove the tracked
 * content did not change between two moments.
 *
 * SDD section 29 denies `writePrimaryWorktree` to every role except the Implementer. The review
 * activity takes this value before and after the Reviewer session, so a Reviewer write is a fact
 * on disk that Factoree can see, and not a promise in a prompt.
 *
 * The value covers the tracked content only. A path that `.gitignore` matches stays outside it.
 * Anything under `.git/` stays outside it as well. A Reviewer write to such a path is invisible
 * here. The published patch is not affected, because the patch capture skips the same paths.
 */
export const worktreeFingerprint = async (
  dependencies: SourceDiffDependencies,
  input: { ref: SandboxRef; primaryPath: string },
): Promise<string> => {
  await git(dependencies, input, ["add", "-A"]);
  return (await git(dependencies, input, ["write-tree"])).trim();
};

/**
 * The git state of the primary worktree, outside the tracked content.
 *
 * `worktreeFingerprint` returns the tree object of the staged worktree. `publishing.activities`
 * compares that exact value to the captured patch tree, so its return value must not change.
 * This second fingerprint therefore stands beside it and covers what a tree object cannot see:
 * the commit `HEAD` points at, and every ref the repository holds.
 *
 * An ignored path is deliberately out of scope. `git add -A` honours `.gitignore`, and SDD
 * section 44 publishes tracked content only, so an ignored file can never reach GitHub.
 */
export const worktreeGitStateFingerprint = async (
  dependencies: SourceDiffDependencies,
  input: { ref: SandboxRef; primaryPath: string },
): Promise<string> => {
  const head = (await git(dependencies, input, ["rev-parse", "HEAD"])).trim();
  const refs = (
    await git(dependencies, input, ["for-each-ref", "--format=%(objectname) %(refname)"])
  ).trim();
  return createHash("sha256").update(`${head}\n${refs}\n`).digest("hex");
};

/** docs/specs/change-sets.md. One target of a change set, at its base SHA. */
export interface DiffTarget {
  repository: string;
  path: string;
  baseSha: string;
}

/**
 * docs/specs/change-sets.md. The diff of every target of a change set, one section per target in
 * set order. Each target gets an equal share of the ceiling. A changed file is named
 * `<owner/repo>/<path>`, so two targets never share a name.
 */
export const captureSetDiff = async (
  dependencies: SourceDiffDependencies,
  input: { ref: SandboxRef; targets: DiffTarget[]; maxBytes?: number },
): Promise<SourceDiff> => {
  const share = Math.floor((input.maxBytes ?? MAX_REVIEW_DIFF_BYTES) / Math.max(1, input.targets.length));
  const sections: string[] = [];
  const changedFiles: string[] = [];
  let truncated = false;
  for (const target of input.targets) {
    const diff = await captureSourceDiff(dependencies, { ref: input.ref, primaryPath: target.path, baseSha: target.baseSha, maxBytes: share });
    sections.push(`## ${target.repository} at ${target.path}\n\n${diff.text}`);
    changedFiles.push(...diff.changedFiles.map((file) => `${target.repository}/${file}`));
    truncated = truncated || diff.truncated;
  }
  return { text: sections.join("\n\n"), truncated, changedFiles };
};

/**
 * docs/specs/change-sets.md. The fingerprint of every target of a change set: the SHA-256 of one
 * line `<owner/repo> <value>` per target, in set order. `read` takes the value of one checkout.
 */
export const setFingerprintOf = async (
  targets: ReadonlyArray<{ repository: string; path: string }>,
  read: (path: string) => Promise<string>,
): Promise<string> => {
  const lines: string[] = [];
  for (const target of targets) lines.push(`${target.repository} ${await read(target.path)}\n`);
  return createHash("sha256").update(lines.join("")).digest("hex");
};
