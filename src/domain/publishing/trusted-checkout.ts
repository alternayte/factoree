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
import { credentialEnvironment, isolatedGitEnvironment } from "~/domain/security/git-credential-environment.js";

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
  // D2. A PR follow-up push that the branch refuses, because it moved since the run read it, and a
  // parent that no branch reaches any more. Both repeat on every attempt.
  /\[rejected\]/i.test(text) ||
  /non-fast-forward/i.test(text) ||
  /not a valid object name/i.test(text) ||
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
  /**
   * docs/specs/own-proposals-and-parallel-runs.md. How far the base branch moved past the verified
   * base, and the files the patch conflicts in there, or null when the branch did not move.
   */
  baseMove: BaseMove | null;
  /** DI-21.162. True when the verified tree equals the tree of the pull request head, so nothing was pushed. */
  unchanged?: boolean;
}

export interface BaseMove {
  /** The head of the base branch at publication. */
  headSha: string;
  /** The number of commits the base branch holds past the verified base. */
  ahead: number;
  /** The files where the verified commit conflicts with the head of the base branch. */
  conflicts: string[];
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
  /** The branch the pull request targets. Publication compares the verified base with its head. */
  baseBranch: string;
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
   * docs/specs/pr-review-merge-and-deploy.md, D2. The head of the pull request a PR follow-up run
   * read. The commit then takes the verified tree with this commit as its parent, and the push
   * fast-forwards the existing branch. A push never forces, so a branch that moved since the run
   * read it refuses the commit. Absent, the commit sits on the base SHA on a new branch.
   */
  parentSha?: string;
  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.119. The second parent of a PR follow-up
   * commit that finishes a bring-current update: the new base. The commit is then the merge of the
   * base into the branch, so the pull request diff stays the change from the new base. It needs
   * `parentSha`.
   */
  mergeParentSha?: string;
  /**
   * docs/specs/change-sets.md, slice 9, DI-21.162. With `parentSha`: a verified tree equal to the tree
   * of the pull request head is no failure. The publication then pushes nothing, and answers
   * `unchanged` with the head as its commit, once the branch still names that head.
   */
  allowUnchanged?: boolean;
  /**
   * docs/specs/pr-review-merge-and-deploy.md, DI-21.125. With `parentSha`: mints the credential of
   * the push from the files the new commit changes against the pull request head, the remote branch
   * head the push moves. The base side of a merge can change a GitHub Actions workflow that the
   * verified patch does not name, and GitHub refuses that push without the Workflows permission.
   * Absent, the push uses `token`.
   */
  pushToken?: (pushedFiles: string[]) => Promise<string>;
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
        env: { ...isolatedGitEnvironment(tmpdir()), ...extraEnv },
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
        env: isolatedGitEnvironment(tmpdir()),
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

    const messageFile = join(directory, "commit-message.txt");
    await writeFile(messageFile, input.commitMessage, "utf8");
    if (input.parentSha !== undefined) {
      return await commitOnPullRequestBranch({ ...input, parentSha: input.parentSha }, git, checkout, treeSha, messageFile, remoteEnv, {
        publishedPatchSha256,
        gitVersion,
      });
    }

    // Step 6, step 7, and step 8.
    await git(checkout, ["checkout", "-b", input.branch]);
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
    // docs/specs/own-proposals-and-parallel-runs.md. A moved base branch no longer stops the
    // publication. The commit stays on the verified base, and the proof pack states the gap and
    // any conflict. The merge below writes objects only, never a ref or the worktree.
    const baseMove = await measureBaseMove(git, checkout, input.baseSha, input.baseBranch, commitSha);

    await git(
      checkout,
      ["push", "origin", `${input.branch}:refs/heads/${input.branch}`],
      remoteEnv,
    );

    return { commitSha, publishedPatchSha256, treeSha, branch: input.branch, gitVersion, baseMove };
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

/**
 * docs/specs/pr-review-merge-and-deploy.md, D2. The commit of a PR follow-up run: the verified tree
 * of base plus patch, with the pull request head the run read as its parent. The commit holds the
 * same tree whatever the head held, so the patch hash still describes the whole pull request from
 * the base. The push names the branch without a force, so GitHub refuses it when the branch moved.
 */
const commitOnPullRequestBranch = async (
  input: TrustedCheckoutInput & { parentSha: string },
  git: (cwd: string, args: string[], extraEnv?: Record<string, string>) => Promise<string>,
  checkout: string,
  treeSha: string,
  messageFile: string,
  remoteEnv: Record<string, string>,
  facts: { publishedPatchSha256: string; gitVersion: string },
): Promise<TrustedPublication> => {
  if (!SHA.test(input.parentSha)) {
    throw new TrustedCheckoutError(`the pull request head is not forty hexadecimal characters: "${input.parentSha}"`, { deterministic: true });
  }
  if (input.mergeParentSha !== undefined && !SHA.test(input.mergeParentSha)) {
    throw new TrustedCheckoutError(`the merge parent is not forty hexadecimal characters: "${input.mergeParentSha}"`, { deterministic: true });
  }
  // The clone holds every branch, and so the head of the pull request branch. The fetch names the
  // branch again, so a head that moved after the clone is in the store too.
  await git(checkout, ["fetch", "--no-tags", "origin", `+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`], remoteEnv);
  const parentTree = (await git(checkout, ["rev-parse", `${input.parentSha}^{tree}`])).trim();
  // The run verified the change of the pull request and added nothing to it. A commit with the
  // tree of its parent would change nothing on the pull request.
  if (parentTree === treeSha && input.allowUnchanged === true) {
    // DI-21.162. The head is checked as it is. A branch that moved since the run read it holds a head
    // that no check saw.
    const branchHead = (await git(checkout, ["rev-parse", `refs/remotes/origin/${input.branch}`])).trim();
    if (branchHead !== input.parentSha) {
      throw new TrustedCheckoutError(
        `the branch ${input.branch} moved to ${branchHead.slice(0, 12)} since the run read ${input.parentSha.slice(0, 12)}, so Factoree pushed nothing.`,
        { deterministic: true },
      );
    }
    return { commitSha: input.parentSha, publishedPatchSha256: facts.publishedPatchSha256, treeSha, branch: input.branch, gitVersion: facts.gitVersion, baseMove: null, unchanged: true };
  }
  if (parentTree === treeSha) {
    throw new TrustedCheckoutError(
      "the verified tree equals the tree of the pull request head, so this run changed nothing on the pull request. Factoree pushed nothing.",
      { deterministic: true },
    );
  }
  const commitSha = (
    await git(
      checkout,
      ["commit-tree", treeSha, "-p", input.parentSha, ...(input.mergeParentSha === undefined ? [] : ["-p", input.mergeParentSha]), "-F", messageFile],
      {
        GIT_AUTHOR_NAME: input.authorName,
        GIT_AUTHOR_EMAIL: input.authorEmail,
        GIT_COMMITTER_NAME: input.authorName,
        GIT_COMMITTER_EMAIL: input.authorEmail,
        GIT_AUTHOR_DATE: input.commitTimestamp,
        GIT_COMMITTER_DATE: input.commitTimestamp,
      },
    )
  ).trim();
  if (!SHA.test(commitSha)) throw new TrustedCheckoutError("the trusted commit produced no commit SHA", { deterministic: true });
  const baseMove = await measureBaseMove(git, checkout, input.baseSha, input.baseBranch, commitSha);
  // DI-21.125. The files the push changes on the branch decide the scope of its credential.
  let pushEnv = remoteEnv;
  if (input.pushToken !== undefined) {
    const pushed = await git(checkout, ["diff", "--name-only", "--no-renames", input.parentSha, treeSha]);
    const pushedFiles = pushed.split("\n").map((line) => line.trim()).filter((line) => line !== "").sort();
    pushEnv = credentialEnvironment(input.cloneUrl, await input.pushToken(pushedFiles));
  }
  // No force: a branch head other than the parent refuses the push. A retry pushes the identical
  // commit, which the branch already holds, and git reports it up to date.
  await git(checkout, ["push", "origin", `${commitSha}:refs/heads/${input.branch}`], pushEnv);
  return { commitSha, publishedPatchSha256: facts.publishedPatchSha256, treeSha, branch: input.branch, gitVersion: facts.gitVersion, baseMove };
};

/**
 * Compares the verified base with the head of the base branch in the clone. When the branch
 * moved, `git merge-tree --write-tree` merges the verified commit into that head in the object
 * store and names each conflicting file. It exits 1 on a conflict, and the clone stays as it is.
 */
const measureBaseMove = async (
  git: (cwd: string, args: string[]) => Promise<string>,
  checkout: string,
  baseSha: string,
  baseBranch: string,
  commitSha: string,
): Promise<BaseMove | null> => {
  const headSha = (await git(checkout, ["rev-parse", `refs/remotes/origin/${baseBranch}`])).trim();
  if (!SHA.test(headSha)) {
    throw new TrustedCheckoutError(`the base branch "${baseBranch}" resolved to no commit SHA`, { deterministic: true });
  }
  if (headSha === baseSha) return null;
  const ahead = Number.parseInt((await git(checkout, ["rev-list", "--count", `${baseSha}..${headSha}`])).trim(), 10);
  let conflicts: string[] = [];
  try {
    await run("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", headSha, commitSha], {
      cwd: checkout,
      timeout: PUBLISH_GIT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: isolatedGitEnvironment(tmpdir()),
    });
  } catch (error) {
    // Exit code 1 is a conflict. The first line is the tree, and each further line names a file.
    const candidate = error as { code?: unknown; stdout?: unknown };
    if (candidate.code !== 1 || typeof candidate.stdout !== "string") {
      throw new TrustedCheckoutError(
        `the conflict check of the trusted checkout failed: ${withoutUrlCredentials(String(error))}`,
      );
    }
    conflicts = [...new Set(candidate.stdout.split("\n").slice(1).map((line) => line.trim()).filter((line) => line !== ""))];
  }
  return { headSha, ahead: Number.isNaN(ahead) ? 0 : ahead, conflicts };
};

/** docs/specs/pr-review-merge-and-deploy.md, slice 4. The trusted merge of the base into the branch. */
export interface BringCurrentCheckoutInput {
  /** The plain clone URL. It carries no credential. */
  cloneUrl: string;
  /** The GitHub credential. It travels through the git environment, never through argv. */
  token?: string;
  /** The branch of the pull request. */
  branch: string;
  /** The verified head the update starts from. A branch at another commit moved. */
  headSha: string;
  baseBranch: string;
  /**
   * The base commit to merge in. Absent, the merge takes the head of the base branch. The push
   * names the base the check verified, so a base that moved again changes nothing.
   */
  baseSha?: string;
  /** The message of the merge commit, from the base it merges in. */
  commitMessage: (baseSha: string) => string;
  /** Fixed dates and author, so a retry builds the identical merge commit. */
  commitTimestamp: string;
  authorName: string;
  authorEmail: string;
  /**
   * Set to push the merge commit. The patch from the base to the merge tree must hash to this
   * value, the patch the check sprite verified, or nothing is pushed.
   */
  pushVerifiedPatchSha256?: string;
  onCleanupFailure?: (error: unknown) => void;
}

export type BringCurrentCheckoutResult =
  | { kind: "current"; baseSha: string }
  | { kind: "moved"; branchHeadSha: string | null }
  | { kind: "conflict"; baseSha: string; conflicts: string[] }
  | {
      kind: "merged";
      baseSha: string;
      treeSha: string;
      /** The merge commit, with the head and the base as its parents. */
      commitSha: string;
      /** The verified patch of the merge: the diff from the base to the merge tree. */
      patchBase64: string;
      patchSha256: string;
      changedFiles: string[];
      /** The files the merge commit changes against the head: what the push changes on the branch. */
      pushedFiles: string[];
      gitVersion: string;
      /** True when this call pushed the merge commit to the branch. */
      pushed: boolean;
    };

/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.117. Merges the base branch into the
 * branch of a pull request on a clean trusted checkout, on the control plane. `git merge-tree`
 * writes the merge in the object store, and `git commit-tree` builds the merge commit with the head
 * and the base as parents. Without `pushVerifiedPatchSha256` nothing leaves the checkout. With it,
 * the patch hash is the gate, and the push names the branch without a force, so a branch that moved
 * since the check refuses the commit and the answer is `moved`.
 */
export const bringCurrentOnTrustedCheckout = async (input: BringCurrentCheckoutInput): Promise<BringCurrentCheckoutResult> => {
  for (const [name, value] of [["head", input.headSha], ["base", input.baseSha ?? "0".repeat(40)]] as const) {
    if (!SHA.test(value)) throw new TrustedCheckoutError(`the ${name} SHA is not forty hexadecimal characters: "${value}"`, { deterministic: true });
  }
  for (const branch of [input.branch, input.baseBranch]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..")) {
      throw new TrustedCheckoutError(`the branch name "${branch}" is not usable`, { deterministic: true });
    }
  }
  if (input.cloneUrl.startsWith("-")) {
    throw new TrustedCheckoutError("the clone URL starts with a hyphen, so git can read it as an option. Factoree refuses it.", { deterministic: true });
  }
  const directory = await mkdtemp(join(tmpdir(), "factoree-bring-current-"));
  const checkout = join(directory, "checkout");
  const remoteEnv = credentialEnvironment(input.cloneUrl, input.token);
  const failed = (error: unknown): TrustedCheckoutError => {
    const detail = error instanceof Error ? error.message : String(error);
    return new TrustedCheckoutError(`a git command of the trusted checkout failed: ${withoutUrlCredentials(detail)}`, {
      deterministic: isDeterministicCheckoutFailure(detail),
    });
  };
  const options = (extraEnv: Record<string, string>) => ({
    timeout: PUBLISH_GIT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: { ...isolatedGitEnvironment(tmpdir()), ...extraEnv },
  });
  const git = async (cwd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> => {
    try {
      return (await run("git", args, { cwd, ...options(extraEnv) })).stdout;
    } catch (error) {
      throw failed(error);
    }
  };
  try {
    await git(directory, ["clone", "--no-hardlinks", "--", input.cloneUrl, checkout], remoteEnv);
    const branchHead = (await git(checkout, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${input.branch}`]).catch(() => "")).trim();
    if (branchHead !== input.headSha) return { kind: "moved", branchHeadSha: SHA.test(branchHead) ? branchHead : null };
    const baseSha = input.baseSha ?? (await git(checkout, ["rev-parse", `refs/remotes/origin/${input.baseBranch}`])).trim();
    if (!SHA.test(baseSha)) throw new TrustedCheckoutError(`the base branch "${input.baseBranch}" resolved to no commit SHA`, { deterministic: true });

    // The base is in the history of the head already: nothing to merge.
    try {
      await run("git", ["merge-base", "--is-ancestor", baseSha, input.headSha], { cwd: checkout, ...options({}) });
      return { kind: "current", baseSha };
    } catch (error) {
      const candidate = error as { code?: unknown };
      if (candidate.code !== 1) throw failed(error);
    }

    // Exit code 1 is a conflict: the first line is the tree, and each further line names a file.
    let treeSha: string;
    try {
      const merged = await run("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", input.headSha, baseSha], {
        cwd: checkout,
        ...options({}),
      });
      treeSha = merged.stdout.split("\n")[0]?.trim() ?? "";
    } catch (error) {
      const candidate = error as { code?: unknown; stdout?: unknown };
      if (candidate.code !== 1 || typeof candidate.stdout !== "string") throw failed(error);
      const conflicts = [...new Set(candidate.stdout.split("\n").slice(1).map((line) => line.trim()).filter((line) => line !== ""))].sort();
      return { kind: "conflict", baseSha, conflicts };
    }
    if (!SHA.test(treeSha)) throw new TrustedCheckoutError("the merge of the base wrote no tree", { deterministic: true });

    // The verified patch of the merge, computed as the publication computes it (SDD section 46): the
    // index holds the merge tree, and the diff runs against the base.
    await git(checkout, ["checkout", "--detach", baseSha]);
    await git(checkout, ["read-tree", treeSha]);
    let patch: Buffer;
    try {
      const diff = await run("git", [...PATCH_GIT_OPTIONS, ...PATCH_DIFF_ARGS, baseSha], { cwd: checkout, ...options({}), encoding: "buffer" });
      patch = Buffer.from(diff.stdout);
    } catch (error) {
      throw failed(error);
    }
    const names = await git(checkout, [...PATCH_GIT_OPTIONS, ...PATCH_DIFF_ARGS, "--name-only", baseSha]);
    const changedFiles = names.split("\n").map((line) => line.trim()).filter((line) => line !== "").sort();
    const patchBase64 = patch.toString("base64");
    const patchSha256 = sha256OfBase64(patchBase64);
    const gitVersion = (await git(checkout, ["--version"])).trim();
    const pushed = await git(checkout, [...PATCH_GIT_OPTIONS, "diff", "--name-only", "--no-renames", input.headSha, treeSha]);
    const pushedFiles = pushed.split("\n").map((line) => line.trim()).filter((line) => line !== "").sort();

    const messageFile = join(directory, "commit-message.txt");
    await writeFile(messageFile, input.commitMessage(baseSha), "utf8");
    const commitSha = (
      await git(checkout, ["commit-tree", treeSha, "-p", input.headSha, "-p", baseSha, "-F", messageFile], {
        GIT_AUTHOR_NAME: input.authorName,
        GIT_AUTHOR_EMAIL: input.authorEmail,
        GIT_COMMITTER_NAME: input.authorName,
        GIT_COMMITTER_EMAIL: input.authorEmail,
        GIT_AUTHOR_DATE: input.commitTimestamp,
        GIT_COMMITTER_DATE: input.commitTimestamp,
      })
    ).trim();
    if (!SHA.test(commitSha)) throw new TrustedCheckoutError("the trusted merge commit produced no commit SHA", { deterministic: true });

    const result = { kind: "merged" as const, baseSha, treeSha, commitSha, patchBase64, patchSha256, changedFiles, pushedFiles, gitVersion, pushed: false };
    if (input.pushVerifiedPatchSha256 === undefined) return result;
    // The gate: only the merge the check sprite verified leaves the checkout.
    if (patchSha256 !== input.pushVerifiedPatchSha256) {
      throw new PatchHashMismatchError(input.pushVerifiedPatchSha256, patchSha256, gitVersion, gitVersion);
    }
    try {
      // No force: a branch head other than the verified head refuses the merge commit. A retry
      // pushes the identical commit, which the branch already holds.
      await run("git", ["push", "origin", `${commitSha}:refs/heads/${input.branch}`], { cwd: checkout, ...options(remoteEnv) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (/\[rejected\]|non-fast-forward|fetch first/i.test(detail)) return { kind: "moved", branchHeadSha: null };
      throw failed(error);
    }
    return { ...result, pushed: true };
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      input.onCleanupFailure?.(cleanupError);
    }
  }
};
