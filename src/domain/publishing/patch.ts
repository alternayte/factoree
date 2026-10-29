import { createHash } from "node:crypto";
import type { Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import type { Redactor } from "~/telemetry/redaction.js";

/**
 * Every git configuration value that can change the bytes of a diff. DI-9.3. The
 * sandbox capture and the control-plane recomputation both use this list. A git configuration on
 * either machine therefore cannot break the SDD section 46 hash assertion for the wrong reason.
 */
export const PATCH_GIT_OPTIONS = [
  "-c", "core.abbrev=40",
  "-c", "core.quotePath=true",
  "-c", "core.autocrlf=false",
  "-c", "core.fileMode=true",
  "-c", "core.eol=lf",
  "-c", "core.attributesFile=",
  "-c", "diff.algorithm=myers",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.noprefix=false",
  "-c", "diff.renames=false",
  "-c", "diff.external=",
  "-c", "diff.orderFile=/dev/null",
];

/** SDD section 44. The diff of the staged tree against the base SHA, in an applicable form. */
export const PATCH_DIFF_ARGS = [
  "diff",
  "--cached",
  "--binary",
  "--no-renames",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--unified=3",
];

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

/**
 * SDD section 44. Every check passed and the primary worktree holds no change against the base
 * SHA, so there is no verified artifact to publish. A later task maps this to the `EMPTY_PATCH`
 * Run failure reason.
 */
export class EmptyPatchError extends Error {
  constructor() {
    super(
      "the primary worktree holds no change against the base SHA, so Factoree has nothing to " +
        "publish",
    );
    this.name = "EmptyPatchError";
  }
}

const SHA = /^[0-9a-f]{40}$/;

export interface VerifiedPatch {
  /** The patch bytes, base64 encoded. DI-9.4 explains the encoding. */
  patchBase64: string;
  /** The SHA-256 of the decoded patch bytes. SDD section 44 names this value `patch_sha256`. */
  patchSha256: string;
  changedFiles: string[];
  /** The git tree object of the staged worktree. DI-9.12. */
  treeSha: string;
  byteLength: number;
  /**
   * The git version of the sandbox that captured this patch. SDD section 46 compares the
   * captured diff text with the diff text of the trusted checkout. Two git versions can
   * produce two texts from one tree, and the mismatch message must be able to say so.
   */
  gitVersion: string;
}

export const sha256OfBase64 = (base64: string): string =>
  createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");

export interface PatchDependencies {
  sandbox: Sandbox;
  redactor: Redactor;
}

export interface PatchInput {
  ref: SandboxRef;
  primaryPath: string;
  baseSha: string;
}

const git = async (
  dependencies: PatchDependencies,
  input: PatchInput,
  args: string[],
): Promise<string> => {
  const result = await dependencies.sandbox.exec(input.ref, { file: "git", args });
  if (result.exitCode !== 0) {
    throw new PatchError(
      `git ${args.join(" ")} failed with exit code ${result.exitCode}: ` +
        dependencies.redactor.redactText(result.stderr.trim()),
    );
  }
  return result.stdout;
};

/**
 * SDD section 44. Captures the verified implementation artifact of one Run.
 *
 * The patch is never redacted. DI-9.5. A redacted patch does not apply and its
 * hash does not match, so redaction here would break the SDD section 46 assertion.
 */
export const capturePatch = async (
  dependencies: PatchDependencies,
  input: PatchInput,
): Promise<VerifiedPatch> => {
  if (!SHA.test(input.baseSha)) {
    throw new PatchError(`the base SHA is not forty hexadecimal characters: "${input.baseSha}"`);
  }
  const at = ["-C", input.primaryPath];

  // SDD section 44 step 1. Staging changes no source file. It records what the worktree holds,
  // so a new file reaches the patch as well as a changed file.
  await git(dependencies, input, [...at, "add", "-A"]);

  const names = await git(dependencies, input, [
    ...at,
    ...PATCH_GIT_OPTIONS,
    ...PATCH_DIFF_ARGS,
    "--name-only",
    input.baseSha,
  ]);
  const changedFiles = names
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .sort();

  // DI-9.12. The tree object of the staged worktree. It is recorded beside the
  // patch hash, and it never replaces the SDD section 46 assertion.
  const treeSha = (await git(dependencies, input, [...at, "write-tree"])).trim();

  // Records the git version of the sandbox, beside the tree object. SDD section 46 compares two
  // diff texts, and a mismatch message needs the version of each git binary that produced one.
  const gitVersion = (await git(dependencies, input, [...at, "--version"])).trim();

  // DI-9.4. `Sandbox.exec` decodes stdout as UTF-8, so a binary hunk cannot
  // travel through stdout. The patch goes to a file, and `base64` carries it back intact.
  const patchPath = `${input.ref.workspacePath}/patch.diff`;
  const written = await dependencies.sandbox.exec(input.ref, {
    file: "sh",
    args: [
      "-c",
      `git "$@" > "$0"`,
      patchPath,
      ...at,
      ...PATCH_GIT_OPTIONS,
      ...PATCH_DIFF_ARGS,
      input.baseSha,
    ],
  });
  if (written.exitCode !== 0) {
    throw new PatchError(
      `the patch capture failed with exit code ${written.exitCode}: ` +
        dependencies.redactor.redactText(written.stderr.trim()),
    );
  }

  // The command reads the file through standard input. The GNU form and the BSD form both accept
  // that, so a host with either coreutils runs the same capture.
  const encoded = await dependencies.sandbox.exec(input.ref, {
    file: "sh",
    args: ["-c", 'base64 < "$0"', patchPath],
  });
  if (encoded.exitCode !== 0) {
    throw new PatchError(
      `the patch could not be read with exit code ${encoded.exitCode}: ` +
        dependencies.redactor.redactText(encoded.stderr.trim()),
    );
  }
  const patchBase64 = encoded.stdout.replace(/\s+/g, "");

  return {
    patchBase64,
    patchSha256: sha256OfBase64(patchBase64),
    changedFiles,
    treeSha,
    byteLength: Buffer.from(patchBase64, "base64").byteLength,
    gitVersion,
  };
};

/**
 * DI-9.2. The change under review and the change under publication must name the
 * same files. This check fails closed. An extra file stops the publication, and a missing file
 * stops it too.
 */
export const assertSameChangedFiles = (reviewed: string[], published: string[]): void => {
  const left = [...new Set(reviewed)].sort();
  const right = [...new Set(published)].sort();
  if (left.length === right.length && left.every((value, index) => value === right[index])) return;
  const added = right.filter((value) => !left.includes(value));
  const removed = left.filter((value) => !right.includes(value));
  throw new PatchError(
    "the verified patch does not name the files the independent review examined. " +
      `Files only in the patch: ${added.join(", ") || "none"}. ` +
      `Files only in the review: ${removed.join(", ") || "none"}.`,
  );
};
