import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isDeterministicRemoteFailure } from "~/adapters/github/git-repository-reader.js";
import { withoutUrlCredentials } from "~/domain/runs/checkout.js";
import { PATCH_DIFF_ARGS, PATCH_GIT_OPTIONS, sha256OfBase64 } from "./patch.js";
// The one copy of the credential environment builder. See the module comment for why it lives
// in `src/domain/security` rather than here.
import { credentialEnvironment } from "~/domain/security/git-credential-environment.js";

export { credentialEnvironment };

const run = promisify(execFile);

/** One publication must not hang a Run. */
const PUBLISH_GIT_TIMEOUT_MS = 300_000;

/** The largest output one git command of the publication can produce. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const SHA = /^[0-9a-f]{40}$/;

export class PatchHashMismatchError extends Error {
  constructor(
    readonly verified: string,
    readonly published: string,
    /** The git version of the sandbox that captured the verified patch. SDD section 46. */
    readonly verifiedGitVersion: string,
    /** The git version of the trusted checkout that recomputed the hash. SDD section 46. */
    readonly appliedGitVersion: string,
  ) {
    super(
      "the patch hash of the trusted checkout does not equal the verified patch hash. " +
        `Verified: ${verified}. Published: ${published}. ` +
        `Verified git: ${verifiedGitVersion}. Publishing git: ${appliedGitVersion}. ` +
        "Factoree published nothing.",
    );
    this.name = "PatchHashMismatchError";
  }
}

/**
 * Recognizes a git failure of the trusted checkout that repeats on every attempt. The remote
 * phrases come from the repository reader, so one list serves both callers. The local phrases
 * cover a patch that does not apply and a base object the clone does not hold. SDD section 49
 * makes such a failure semantic, so the caller must not retry it. A timeout, a reset connection,
 * and a temporary DNS failure carry none of these phrases, so they stay retryable.
 */
export const isDeterministicCheckoutFailure = (text: string): boolean =>
  isDeterministicRemoteFailure(text) ||
  /patch does not apply/i.test(text) ||
  /error: patch failed/i.test(text) ||
  /corrupt patch/i.test(text) ||
  /reference is not a tree/i.test(text) ||
  /unable to read tree/i.test(text) ||
  /did not match any file\(s\) known to git/i.test(text) ||
  /unknown revision or path not in the working tree/i.test(text) ||
  /invalid credentials/i.test(text) ||
  /bad credentials/i.test(text);

export class TrustedCheckoutError extends Error {
  /**
   * True when the same trusted checkout fails the same way on every attempt. SDD section 49
   * forbids such a failure to consume the infrastructure retry policy.
   */
  readonly deterministic: boolean;

  constructor(message: string, options?: { deterministic?: boolean }) {
    super(message);
    this.name = "TrustedCheckoutError";
    this.deterministic = options?.deterministic ?? false;
  }
}

export interface TrustedPublication {
  commitSha: string;
  publishedPatchSha256: string;
  treeSha: string;
  branch: string;
  /** The git version of the trusted checkout. SDD section 46 names it beside the patch hash. */
  gitVersion: string;
}

export interface TrustedCheckoutInput {
  /**
   * The plain clone URL. It carries no credential, so a message can quote it. A local path is
   * allowed too, because the acceptance fixtures publish to a bare repository on disk.
   */
  cloneUrl: string;
  /**
   * The GitHub write credential. It travels through the git environment, never through the
   * process argument list. SDD section 30 forbids a credential in argv. A local path remote
   * needs none, so this field is optional.
   */
  token?: string;
  baseSha: string;
  branch: string;
  patchBase64: string;
  verifiedPatchSha256: string;
  /**
   * The git version of the sandbox that captured the verified patch. SDD section 46 compares
   * two diff texts. This value lets a hash mismatch name the version that produced each text.
   */
  verifiedGitVersion: string;
  commitMessage: string;
  /**
   * The author date and the committer date of the commit, in the git ISO form such as
   * `1970-01-01T00:00:00Z`. The caller supplies a stable value. Two calls with the same input
   * then build the identical commit object, so a retry pushes the same commit SHA.
   */
  commitTimestamp: string;
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
      { deterministic: true },
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.verifiedPatchSha256)) {
    throw new TrustedCheckoutError("the verified patch hash is not sixty-four hexadecimal characters", {
      deterministic: true,
    });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.branch) || input.branch.includes("..")) {
    throw new TrustedCheckoutError(`the branch name "${input.branch}" is not usable`, {
      deterministic: true,
    });
  }
  if (input.cloneUrl.startsWith("-")) {
    throw new TrustedCheckoutError(
      "the clone URL starts with a hyphen, so git can read it as an option. Factoree refuses it.",
      { deterministic: true },
    );
  }

  const directory = await mkdtemp(join(tmpdir(), "factoree-publish-"));
  const checkout = join(directory, "checkout");
  const patchFile = join(directory, "verified.patch");

  // The credential of every git command that reaches the remote. The clone and the push use it.
  const remoteEnv = credentialEnvironment(input.cloneUrl, input.token);

  // The uniform failure of one git command. It redacts a credential in a URL. It also marks a
  // failure that repeats for ever, so the caller can refuse a pointless retry.
  const failed = (error: unknown): TrustedCheckoutError => {
    const detail = error instanceof Error ? error.message : String(error);
    return new TrustedCheckoutError(
      `a git command of the trusted checkout failed: ${withoutUrlCredentials(detail)}`,
      { deterministic: isDeterministicCheckoutFailure(detail) },
    );
  };

  const git = async (
    cwd: string,
    args: string[],
    extraEnv: Record<string, string> = {},
  ): Promise<string> => {
    try {
      const result = await run("git", args, {
        cwd,
        timeout: PUBLISH_GIT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
      });
      return result.stdout;
    } catch (error) {
      throw failed(error);
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
      throw failed(error);
    }
  };

  try {
    await writeFile(patchFile, Buffer.from(input.patchBase64, "base64"));

    // Step 1 and step 2. A clean trusted checkout at the original base SHA. The `--` separator
    // stops a clone URL that starts with a hyphen from being read as a git option.
    await git(directory, ["clone", "--no-hardlinks", "--", input.cloneUrl, checkout], remoteEnv);
    await git(checkout, ["checkout", "--detach", input.baseSha]);

    // Step 3. Apply the verified patch. `--index` stages exactly what the patch carries, so the
    // recomputation below reads the same staged tree the sandbox produced. The `--` separator
    // stops the patch file path from being read as a git option.
    await git(checkout, ["apply", "--binary", "--index", "--whitespace=nowarn", "--", patchFile]);

    // Step 4. Recalculate the patch hash from the applied tree. DI-9.3 pins every
    // option, so a git configuration cannot change the bytes.
    const recomputed = await gitBuffer(checkout, [...PATCH_GIT_OPTIONS, ...PATCH_DIFF_ARGS, input.baseSha]);
    const publishedPatchSha256 = sha256OfBase64(recomputed.toString("base64"));

    // The git version of the trusted checkout. SDD section 46 compares two diff texts, and two
    // git versions can produce two texts from one tree. This value turns a silent mismatch into
    // a readable cause.
    const gitVersion = (await git(checkout, ["--version"])).trim();

    // Step 5. The gate. Nothing below runs when the two hashes differ.
    if (publishedPatchSha256 !== input.verifiedPatchSha256) {
      throw new PatchHashMismatchError(
        input.verifiedPatchSha256,
        publishedPatchSha256,
        input.verifiedGitVersion,
        gitVersion,
      );
    }

    const treeSha = (await git(checkout, ["write-tree"])).trim();

    // Step 6, step 7, and step 8.
    await git(checkout, ["checkout", "-b", input.branch]);
    const messageFile = join(directory, "commit-message.txt");
    await writeFile(messageFile, input.commitMessage, "utf8");
    // The author date and the committer date come from the caller. A retry of the same Run
    // therefore builds the identical commit object. The second push is then a no-op
    // fast-forward instead of a rejected non-fast-forward.
    await git(
      checkout,
      [
        "-c", `user.name=${input.authorName}`,
        "-c", `user.email=${input.authorEmail}`,
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        "-F", messageFile,
      ],
      {
        GIT_AUTHOR_DATE: input.commitTimestamp,
        GIT_COMMITTER_DATE: input.commitTimestamp,
      },
    );
    const commitSha = (await git(checkout, ["rev-parse", "HEAD"])).trim();
    if (!SHA.test(commitSha)) {
      throw new TrustedCheckoutError("the trusted commit produced no commit SHA", {
        deterministic: true,
      });
    }
    await git(
      checkout,
      ["push", "origin", `${input.branch}:refs/heads/${input.branch}`],
      remoteEnv,
    );

    return { commitSha, publishedPatchSha256, treeSha, branch: input.branch, gitVersion };
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
