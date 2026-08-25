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
 * publication can never differ. See controller decision 12.
 *
 * `--binary` is deliberately absent. A binary file appears in the changed-file list by name, and
 * binary bytes help no Reviewer. See controller decision 14.
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

  const names = await git(dependencies, input, [
    "diff",
    "--cached",
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
 */
export const worktreeFingerprint = async (
  dependencies: SourceDiffDependencies,
  input: { ref: SandboxRef; primaryPath: string },
): Promise<string> => {
  await git(dependencies, input, ["add", "-A"]);
  return (await git(dependencies, input, ["write-tree"])).trim();
};
