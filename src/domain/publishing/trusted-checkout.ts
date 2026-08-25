import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { withoutUrlCredentials } from "~/domain/runs/checkout.js";
import { PATCH_DIFF_ARGS, PATCH_GIT_OPTIONS, sha256OfBase64 } from "./patch.js";

const run = promisify(execFile);

/** One publication must not hang a Run. */
export const PUBLISH_GIT_TIMEOUT_MS = 300_000;

/** The largest output one git command of the publication can produce. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const SHA = /^[0-9a-f]{40}$/;

export class PatchHashMismatchError extends Error {
  constructor(
    readonly verified: string,
    readonly published: string,
  ) {
    super(
      "the patch hash of the trusted checkout does not equal the verified patch hash. " +
        `Verified: ${verified}. Published: ${published}. Factoree published nothing.`,
    );
    this.name = "PatchHashMismatchError";
  }
}

export class TrustedCheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustedCheckoutError";
  }
}

export interface TrustedPublication {
  commitSha: string;
  publishedPatchSha256: string;
  treeSha: string;
  branch: string;
}

export interface TrustedCheckoutInput {
  /** The clone URL. It can carry a credential in its userinfo, so no message quotes it raw. */
  cloneUrl: string;
  baseSha: string;
  branch: string;
  patchBase64: string;
  verifiedPatchSha256: string;
  commitMessage: string;
  authorName: string;
  authorEmail: string;
  /**
   * Called when the temporary directory removal fails. The failure must never replace the
   * original error, so this callback is the only way to observe it. It is optional, so every
   * existing caller stays unchanged.
   */
  onCleanupFailure?: (error: unknown) => void;
}

/**
 * SDD section 46 steps 1 to 8 and step 10. The clean trusted checkout runs on the control plane,
 * outside the sandbox and outside every agent session. SDD section 29 denies git remote write
 * from an agent, so only this function pushes.
 *
 * Step 5 is the gate. A hash mismatch throws before any branch, any commit, and any push, so a
 * patch that is not the verified patch can never reach GitHub.
 */
export const publishToBranch = async (input: TrustedCheckoutInput): Promise<TrustedPublication> => {
  if (!SHA.test(input.baseSha)) {
    throw new TrustedCheckoutError(
      `the base SHA is not forty hexadecimal characters: "${input.baseSha}"`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.verifiedPatchSha256)) {
    throw new TrustedCheckoutError("the verified patch hash is not sixty-four hexadecimal characters");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.branch) || input.branch.includes("..")) {
    throw new TrustedCheckoutError(`the branch name "${input.branch}" is not usable`);
  }
  if (input.cloneUrl.startsWith("-")) {
    throw new TrustedCheckoutError(
      "the clone URL starts with a hyphen, so git can read it as an option. Factoree refuses it.",
    );
  }

  const directory = await mkdtemp(join(tmpdir(), "factoree-publish-"));
  const checkout = join(directory, "checkout");
  const patchFile = join(directory, "verified.patch");

  const git = async (cwd: string, args: string[]): Promise<string> => {
    try {
      const result = await run("git", args, {
        cwd,
        timeout: PUBLISH_GIT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return result.stdout;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TrustedCheckoutError(
        `a git command of the trusted checkout failed: ${withoutUrlCredentials(detail)}`,
      );
    }
  };

  // The buffer-encoding counterpart of `git` above. It keeps the uniform error type and the
  // credential redaction for the one command that must read raw bytes instead of UTF-8 text.
  const gitBuffer = async (cwd: string, args: string[]): Promise<Buffer> => {
    try {
      const result = await run("git", args, {
        cwd,
        timeout: PUBLISH_GIT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "buffer",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return Buffer.from(result.stdout);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TrustedCheckoutError(
        `a git command of the trusted checkout failed: ${withoutUrlCredentials(detail)}`,
      );
    }
  };

  try {
    await writeFile(patchFile, Buffer.from(input.patchBase64, "base64"));

    // Step 1 and step 2. A clean trusted checkout at the original base SHA. The `--` separator
    // stops a clone URL that starts with a hyphen from being read as a git option.
    await git(directory, ["clone", "--no-hardlinks", "--", input.cloneUrl, checkout]);
    await git(checkout, ["checkout", "--detach", input.baseSha]);

    // Step 3. Apply the verified patch. `--index` stages exactly what the patch carries, so the
    // recomputation below reads the same staged tree the sandbox produced. The `--` separator
    // stops the patch file path from being read as a git option.
    await git(checkout, ["apply", "--binary", "--index", "--whitespace=nowarn", "--", patchFile]);

    // Step 4. Recalculate the patch hash from the applied tree. Controller decision 3 pins every
    // option, so a git configuration cannot change the bytes.
    const recomputed = await gitBuffer(checkout, [...PATCH_GIT_OPTIONS, ...PATCH_DIFF_ARGS, input.baseSha]);
    const publishedPatchSha256 = sha256OfBase64(recomputed.toString("base64"));

    // Step 5. The gate. Nothing below runs when the two hashes differ.
    if (publishedPatchSha256 !== input.verifiedPatchSha256) {
      throw new PatchHashMismatchError(input.verifiedPatchSha256, publishedPatchSha256);
    }

    const treeSha = (await git(checkout, ["write-tree"])).trim();

    // Step 6, step 7, and step 8.
    await git(checkout, ["checkout", "-b", input.branch]);
    const messageFile = join(directory, "commit-message.txt");
    await writeFile(messageFile, input.commitMessage, "utf8");
    await git(checkout, [
      "-c", `user.name=${input.authorName}`,
      "-c", `user.email=${input.authorEmail}`,
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "-F", messageFile,
    ]);
    const commitSha = (await git(checkout, ["rev-parse", "HEAD"])).trim();
    if (!SHA.test(commitSha)) {
      throw new TrustedCheckoutError("the trusted commit produced no commit SHA");
    }
    await git(checkout, ["push", "origin", `${input.branch}:refs/heads/${input.branch}`]);

    return { commitSha, publishedPatchSha256, treeSha, branch: input.branch };
  } finally {
    // Step 10. The temporary files hold a clone and a credentialed remote. Factoree removes them
    // on every path. The failure paths above are included.
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      // A cleanup failure must never replace an error already in flight, so it does not throw
      // here. The caller learns about it only through this optional callback.
      input.onCleanupFailure?.(cleanupError);
    }
  }
};
