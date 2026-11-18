import { ApplicationFailure } from "@temporalio/activity";
import { GitHubApiError } from "~/adapters/github/github-pull-requests.js";
import { registerProjectSecrets } from "~/domain/products/redaction-loader.js";
import { buildRepositoryUrl } from "~/domain/products/repository-url.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { GitHubTokenProvider, GitHubTokenScope } from "~/domain/products/github-token-provider.js";
import {
  assertSameChangedFiles,
  capturePatch as captureVerifiedPatch,
  changedFilesOfPatch,
  EmptyPatchError,
  PatchError,
  setPatchSha256,
  sha256OfBase64,
  type VerifiedPatch,
} from "~/domain/publishing/patch.js";
import {
  buildPullRequestBody,
  buildPullRequestTitle,
  type PullRequestPort,
} from "~/domain/publishing/pull-request.js";
import {
  bringCurrentOnTrustedCheckout,
  PatchHashMismatchError,
  publishToBranch as publishToBranchDefault,
  TrustedCheckoutError,
  type BaseMove,
} from "~/domain/publishing/trusted-checkout.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import { changeSetPendingSection, changeSetSection, rollbackComment, type SetPullRequest } from "~/domain/publishing/change-set.js";
import { GitHubAppAuthError } from "~/adapters/github/app-token-provider.js";
import { asRunConfigurationErrorIfDeterministic } from "~/domain/runs/github-app-auth-fault.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import type { Logger } from "~/telemetry/logger.js";
import { metrics } from "~/telemetry/metrics.js";
import { recordStage, type RunStageStore } from "~/domain/runs/run-stage.js";
import type { Redactor } from "~/telemetry/redaction.js";

/**
 * The scope a publish mints. SDD section 46 pushes a branch and opens a pull request, and
 * nothing else, so the token carries no permission beyond those two calls.
 */
export const PUBLISH_TOKEN_SCOPE: GitHubTokenScope = { contents: "write", pull_requests: "write" };

const WORKFLOW_DIRECTORY = ".github/workflows/";

/** The files of a patch that GitHub lets an App push only with the `workflows` permission. */
export const workflowFilesOf = (changedFiles: readonly string[]): string[] =>
  changedFiles.filter((file) => file.startsWith(WORKFLOW_DIRECTORY));

/**
 * DI-21.33. A patch that changes a GitHub Actions workflow also needs `workflows: write`, or GitHub
 * refuses the push. Only such a patch asks for it, so an installation without the permission still
 * publishes every other patch.
 */
export const publishTokenScope = (changedFiles: readonly string[]): GitHubTokenScope =>
  workflowFilesOf(changedFiles).length === 0 ? PUBLISH_TOKEN_SCOPE : { ...PUBLISH_TOKEN_SCOPE, workflows: "write" };

/**
 * The author date and the committer date of every Factoree publication commit. The value is a
 * fixed constant, so two attempts of one Run build the identical commit object. The real
 * publication time stays visible in the pull request and in the Run row.
 */
export const PUBLICATION_COMMIT_TIMESTAMP = "1970-01-01T00:00:00Z";

/** The head branch of one Run. AT-35 requires a stable name, so a retry finds the same branch. */
export const publishBranchName = (runId: string): string => `factoree/run-${runId}`;

export interface PublishActivityInput {
  runId: string;
  tenantId: string;
  productId: string;
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  repositorySlug: string;
  repositoryBaseUrl: string;
  baseBranch: string;
  baseSha: string;
  reviewedChangedFiles: string[];
  /**
   * The git tree object the independent review examined. The publication compares it with the
   * tree it captures itself. An empty value is a mismatch, so this check fails closed.
   */
  reviewedWorktreeSha: string;
  /**
   * docs/specs/check-isolation.md. The hash of the patch the check sprite received, captured
   * before any project code ran there. Publication must capture exactly this patch.
   */
  verifiedPatchSha256: string;
  /** docs/specs/autonomy-levels.md. True for L2, and for a patch that changes a check-defining file. */
  draft: boolean;
  workItemTitle: string;
  workItemUrl: string | null;
  verificationSummary: string;
  repairCount: number;
  /** The GitHub App installation that grants the target repository. */
  githubInstallationId: string;
  /**
   * docs/specs/change-sets.md, DI-21.152. Every repository of the change set this pull request
   * belongs to. The first body names them, and `writeChangeSetBody` adds the links. Absent for one target.
   */
  changeSetRepositories?: string[];
}

export interface PublishActivityOutput {
  patchSha256: string;
  commitSha: string;
  pullRequestUrl: string;
  pullRequestNumber: number;
  branch: string;
  /** False when a pull request for this head branch already existed. DI-9.8. */
  created: boolean;
  /** SDD section 47. The size of the verified patch, for the human change summary. */
  patchByteLength: number;
  /**
   * docs/specs/own-proposals-and-parallel-runs.md. How far the base branch moved past the verified
   * base, with any conflict, or null when it did not move or the pull request already existed.
   */
  baseMove: BaseMove | null;
}

export interface PublishingActivityDependencies {
  sandbox: Sandbox;
  secrets: SecretStore;
  redactor: Redactor;
  runs: RunRepository;
  /** Mints the write credential of one publish. SDD section 30 keeps it off every agent session. */
  tokens: GitHubTokenProvider;
  pullRequests: (token: string) => PullRequestPort;
  gitAuthor: () => Promise<{ name: string; email: string }>;
  logger: Logger;
  /** docs/specs/run-speed.md. The stage rows of each run. */
  stages?: RunStageStore | undefined;
  /**
   * The trusted checkout. The default is the real function. A unit test injects a double, so it
   * needs no network. The integration test keeps the real path.
   */
  publishToBranch?: typeof publishToBranchDefault;
  /** docs/specs/pr-review-merge-and-deploy.md, slice 4. The trusted merge of the base. A unit test injects a double. */
  bringCurrent?: typeof bringCurrentOnTrustedCheckout;
}

/** Slice 4. The message of a bring-current merge commit. The compute and the push build the same one. */
const bringCurrentMessage = (input: BringCurrentMergeActivityInput) => (baseSha: string): string =>
  [
    `Merge ${input.baseBranch} into ${input.branch}`,
    "",
    `Factoree brought pull request #${String(input.pullRequestNumber)} current with ${input.baseBranch}.`,
    "",
    `Run ID: ${input.runId}`,
    `Base SHA: ${baseSha}`,
    `Contract revision: ${String(input.contractRevision)}`,
  ].join("\n");

/**
 * Proves the clone URL scheme is exactly `https:`. A `git clone` of an `ext::` URL or a `file:`
 * URL reaches command execution on the control plane. The `--` separator does not stop a remote
 * helper, so this scheme check is the only defence.
 *
 * The URL stays plain. SDD section 30 forbids the credential on the process argument list, so the
 * trusted checkout receives the credential through the git environment instead.
 */
const assertHttpsRepositoryUrl = (plainUrl: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(plainUrl);
  } catch {
    throw new RunConfigurationError(
      "The repository base URL of the Project does not parse as a URL. Repair " +
        "`GITHUB_BASE_URL` for this deployment.",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new RunConfigurationError(
      `The repository URL uses the scheme "${parsed.protocol}". Factoree publishes over ` +
        "`https:` only. Repair the repository base URL of the Project.",
    );
  }
};

/**
 * SDD section 49. A semantic publication failure must not consume the Temporal retry policy. A
 * retry repeats the same fault. A network failure and a GitHub 500 stay retryable, so this
 * function converts a deterministic failure only. The message passes through the redactor first.
 */
const asNonRetryable = (redactor: Redactor, error: unknown): unknown => {
  if (error instanceof PatchHashMismatchError) {
    return ApplicationFailure.nonRetryable(redactor.redactText(error.message), "PATCH_HASH_MISMATCH");
  }
  if (error instanceof EmptyPatchError) {
    return ApplicationFailure.nonRetryable(redactor.redactText(error.message), "EMPTY_PATCH");
  }
  if (error instanceof PatchError) {
    return ApplicationFailure.nonRetryable(redactor.redactText(error.message), "PUBLICATION_FAILED");
  }
  // A rejected credential, a missing repository, a missing ref, and a patch that does not apply
  // repeat for ever. A network failure and a timeout carry no such phrase, so they stay
  // retryable.
  if (error instanceof TrustedCheckoutError && error.deterministic) {
    return ApplicationFailure.nonRetryable(redactor.redactText(error.message), "PUBLICATION_FAILED");
  }
  // A GitHub 4xx names a fault of the request itself. A 408, a 429, and every 5xx stay retryable.
  if (error instanceof GitHubApiError && error.deterministic) {
    return ApplicationFailure.nonRetryable(redactor.redactText(error.message), "PUBLICATION_FAILED");
  }
  // A rejected mint of the write credential is a configuration fault, not an infrastructure
  // fault: an operator must repair the GitHub App installation, not wait for a retry. The class
  // is `RunConfigurationError`, so the workflow recognises it the same way it recognises every
  // other configuration fault. The message names the installation, never the key. The shared
  // module of `~/domain/runs/github-app-auth-fault.js` holds this conversion, so every mint site
  // applies the identical rule.
  return asRunConfigurationErrorIfDeterministic(redactor, error);
};

/**
 * The write credential of one publish. DI-21.33: a patch that changes a GitHub Actions workflow
 * also asks for `workflows: write`, and a refusal of that permission names the repair.
 */
const mintPublishToken = async (
  dependencies: PublishingActivityDependencies,
  input: { githubInstallationId: string; repositorySlug: string },
  changedFiles: readonly string[],
): Promise<string> => {
  const workflowFiles = workflowFilesOf(changedFiles);
  try {
    return await dependencies.tokens.tokenForInstallation(input.githubInstallationId, publishTokenScope(changedFiles), [
      input.repositorySlug,
    ]);
  } catch (error) {
    if (workflowFiles.length > 0 && error instanceof GitHubAppAuthError && error.status === 422) {
      throw new RunConfigurationError(
        `The change edits ${workflowFiles.join(", ")}, and GitHub lets an App push a workflow file ` +
          "only with the Workflows permission. In the Factoree GitHub App, set Repository " +
          "permissions, Workflows, to Read and write, accept the new permission on the " +
          "installation, then reply here.",
      );
    }
    throw error;
  }
};

/** An empty installation id names no installation to mint against. */
const assertInstallation = (githubInstallationId: string): void => {
  if (githubInstallationId === "") {
    throw new RunConfigurationError(
      "The target repository carries no GitHub App installation. Factoree needs one to push " +
        "the branch and to open the pull request. Install the Factoree GitHub App on the " +
        "repository.",
    );
  }
};

/**
 * docs/specs/pr-review-merge-and-deploy.md, D2. The publication of a PR follow-up run: the verified
 * patch, still a diff from the verified base, as one new commit on the branch of the pull request.
 */
export interface PublishFollowUpActivityInput extends Omit<PublishActivityInput, "draft"> {
  /** The head branch of the pull request. */
  branch: string;
  /** The head the run read. The new commit's parent. */
  parentSha: string;
  /** Slice 4, DI-21.119. The new base, as the second parent, for a run that finishes a bring-current update. */
  mergeParentSha?: string;
  pullRequestUrl: string;
  pullRequestNumber: number;
  /** The contract revision of the new head. The commit message names it. */
  contractRevision: number;
  /**
   * docs/specs/change-sets.md, slice 9, DI-21.162. A target of a set PR follow-up run whose verified
   * tree equals its head pushes nothing and answers `unchanged`.
   */
  allowUnchanged?: boolean;
}

export interface PublishFollowUpActivityOutput {
  patchSha256: string;
  commitSha: string;
  patchByteLength: number;
  baseMove: BaseMove | null;
  /** DI-21.162. True when the target changed nothing on its pull request, so nothing was pushed. */
  unchanged?: boolean;
}

/** docs/specs/pr-review-merge-and-deploy.md, slice 4. The trusted merge of the base into a pull request branch. */
export interface BringCurrentMergeActivityInput {
  runId: string;
  tenantId: string;
  productId: string;
  repositorySlug: string;
  repositoryBaseUrl: string;
  githubInstallationId: string;
  branch: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  /** The verified head of the pull request. */
  headSha: string;
  baseBranch: string;
  contractRevision: number;
}

export type BringCurrentMergeActivityOutput =
  | { kind: "current"; baseSha: string }
  | { kind: "moved" }
  | { kind: "conflict"; baseSha: string; conflicts: string[] }
  | { kind: "merged"; baseSha: string; patchSha256: string; changedFiles: string[]; byteLength: number };

export interface PushBringCurrentMergeActivityInput extends BringCurrentMergeActivityInput {
  /** The base the check sprite verified. */
  baseSha: string;
  /** The patch from that base to the merge tree that the check sprite verified. */
  verifiedPatchSha256: string;
}

export type PushBringCurrentMergeActivityOutput = { kind: "pushed"; commitSha: string; patchSha256: string } | { kind: "moved" };

/** docs/specs/draft-of-failed-run.md. The input of the draft publication of one failed run. */
export interface PublishDraftActivityInput {
  runId: string;
  tenantId: string;
  productId: string;
  repositorySlug: string;
  repositoryBaseUrl: string;
  baseBranch: string;
  baseSha: string;
  githubInstallationId: string;
  workItemTitle: string;
  workItemUrl: string | null;
  repairCount: number;
  /** The warning block that starts the pull request body. */
  warning: string;
}

export interface PublishDraftActivityOutput {
  patchSha256: string;
  commitSha: string;
  pullRequestUrl: string;
  pullRequestNumber: number;
  branch: string;
  /** False when a pull request for this head branch already existed. */
  created: boolean;
  patchByteLength: number;
  changedFiles: string[];
}

/** docs/specs/change-sets.md, slice 7. One target of a change set as its check sprite verified it. */
export interface ChangeSetTargetInput {
  repositorySlug: string;
  githubInstallationId: string;
  /** The checkout of the target in the check sprite. */
  primaryPath: string;
  baseBranch: string;
  baseSha: string;
  /** DI-21.133. The patch hash of the target that the check sprite received. */
  verifiedPatchSha256: string;
  /** The changed files of the target, relative to its checkout. */
  reviewedChangedFiles: string[];
  /** The tree of the target in the check sprite before any project code ran. */
  reviewedWorktreeSha: string;
}

/** DI-21.151. The preflight of every target of a change set, before any push. */
export interface PreflightChangeSetActivityInput {
  runId: string;
  tenantId: string;
  productId: string;
  spriteId: string;
  adapter: string;
  workspacePath: string;
  repositoryBaseUrl: string;
  targets: ChangeSetTargetInput[];
  /** DI-21.133. The set patch hash the check sprite received. */
  verifiedSetPatchSha256: string;
  /** DI-21.133. The set tree hash the independent review examined. */
  reviewedSetTreeSha: string;
}

export interface PreflightChangeSetActivityOutput {
  targets: Array<{
    repositorySlug: string;
    patchSha256: string;
    /** False for a target whose patch changes no file: it opens no pull request. */
    changed: boolean;
    changedFiles: string[];
    patchByteLength: number;
  }>;
}

/** DI-21.152. Writes the final body of one pull request of a change set, with every sibling link. */
export interface WriteChangeSetBodyActivityInput {
  runId: string;
  tenantId: string;
  productId: string;
  repositorySlug: string;
  githubInstallationId: string;
  pullRequestNumber: number;
  baseSha: string;
  patchSha256: string;
  changedFileCount: number;
  workItemTitle: string;
  workItemUrl: string | null;
  verificationSummary: string;
  repairCount: number;
  /** Every pull request of the set that opened, in set order. */
  pullRequests: SetPullRequest[];
  /** DI-21.141. The cited provider-to-consumer edges of the run. */
  edges: Array<{ provider: string; consumer: string }>;
}

/** DI-21.153. Undoes the part of a change set that opened. */
export interface RollbackChangeSetActivityInput {
  runId: string;
  tenantId: string;
  productId: string;
  /** Every target the publication may have pushed to. */
  targets: Array<{ repositorySlug: string; githubInstallationId: string }>;
  /** The target whose publication failed, and why. */
  failedRepository: string;
  cause: string;
}

export interface RollbackChangeSetActivityOutput {
  /** Each pull request Factoree closed. */
  closed: SetPullRequest[];
}

/** DI-21.151. A failure of one target names it, and keeps its type and its retry rule. */
const namingTarget = (redactor: Redactor, repository: string, error: unknown): unknown => {
  const converted = asNonRetryable(redactor, error);
  if (converted instanceof ApplicationFailure) {
    return ApplicationFailure.create({
      message: `${repository}: ${converted.message}`,
      ...(converted.type === null || converted.type === undefined ? {} : { type: converted.type }),
      nonRetryable: converted.nonRetryable === true,
    });
  }
  if (converted instanceof RunConfigurationError) return new RunConfigurationError(`${repository}: ${converted.message}`);
  if (converted instanceof Error) return new Error(`${repository}: ${redactor.redactText(converted.message)}`, { cause: converted });
  return converted;
};

/**
 * SDD section 46 steps 1 to 7. Mints the write credential, captures the patch from the check sprite
 * itself, and proves that it is the reviewed and verified patch, before any network write. `publish`
 * and `publishFollowUp` share it.
 */
const captureForPublication = async (
  dependencies: PublishingActivityDependencies,
  input: Omit<PublishActivityInput, "draft" | "workItemTitle" | "workItemUrl" | "verificationSummary" | "repairCount" | "baseBranch">,
  /**
   * DI-21.125. `clone` mints a token that only reads, for a publication whose push mints its own
   * credential from the files it changes on the branch.
   */
  tokenUse: "push" | "clone" = "push",
): Promise<{ token: string; plainUrl: string; patch: VerifiedPatch }> => {
  // Step 1. SDD section 60. Every Project secret reaches the redactor first.
  await registerProjectSecrets(
    dependencies.redactor,
    dependencies.secrets,
    input.tenantId,
    input.productId,
    dependencies.logger,
  );

  // Step 2. The GitHub write credential. An empty installation id names no installation to
  // mint against, and a mint request against an empty id would reach GitHub as a malformed
  // URL rather than a clear refusal, so this activity refuses it here instead.
  assertInstallation(input.githubInstallationId);

  // Ruling 2 requires the token to carry a scope no wider than this publish needs. This
  // publish pushes one branch. It opens one pull request. The token carries exactly those
  // two permissions, plus `workflows` only for a patch that changes a workflow (DI-21.33).
  // Step 6 proves later that the captured patch changes exactly the reviewed files.
  const token =
    tokenUse === "clone"
      ? await dependencies.tokens.tokenForInstallation(input.githubInstallationId, { contents: "read" }, [input.repositorySlug])
      : await mintPublishToken(dependencies, input, input.reviewedChangedFiles);

  // Step 3. The credential reaches the redactor at once, so no later message can echo it.
  dependencies.redactor.addSecret(token);

  // Step 4. The plain URL goes to git and into every message. The credential travels apart
  // from it, so no process argument list ever holds it.
  const plainUrl = buildRepositoryUrl(input.repositoryBaseUrl, input.repositorySlug);
  assertHttpsRepositoryUrl(plainUrl);

  const ref = { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath };

  // Step 5. This activity captures the patch itself. It never trusts an earlier capture. A
  // Temporal retry therefore recaptures and rehashes, which keeps the activity
  // self-contained.
  const patch = await captureVerifiedPatch(
    { sandbox: dependencies.sandbox, redactor: dependencies.redactor },
    { ref, primaryPath: input.primaryPath, baseSha: input.baseSha },
  );

  // Step 6. DI-9.2. This check runs before any network call, so a mismatch
  // costs no remote work.
  assertSameChangedFiles(input.reviewedChangedFiles, patch.changedFiles);

  // Step 6b. The file names alone prove too little. A background process of the Implementer
  // can rewrite the body of a file the review already saw. The tree object is the identity
  // of the content. An empty reviewed tree means the review produced no fingerprint, so it
  // is a mismatch too. This check fails closed.
  if (patch.treeSha !== input.reviewedWorktreeSha) {
    throw new PatchError(
      "the primary worktree changed after the independent review examined it. Reviewed " +
        `tree: ${input.reviewedWorktreeSha || "none"}. Captured tree: ${patch.treeSha}. ` +
        "Factoree published nothing.",
    );
  }

  // Step 7. An empty patch publishes nothing.
  if (patch.changedFiles.length === 0 || patch.byteLength === 0) throw new EmptyPatchError();

  // Step 7b. The bootstrap and the checks ran project code in the check sprite. The patch that
  // leaves it must be the patch that entered it, before that code ran.
  if (patch.patchSha256 !== input.verifiedPatchSha256) {
    throw new PatchHashMismatchError(
      input.verifiedPatchSha256,
      patch.patchSha256,
      patch.gitVersion,
      patch.gitVersion,
    );
  }
  return { token, plainUrl, patch };
};

/** SDD section 44, section 45, and section 46. */
export const createPublishingActivities = (dependencies: PublishingActivityDependencies) => ({
  /**
   * SDD section 46. Applies the verified patch to a clean trusted checkout, proves the patch
   * hash again, pushes the branch, and opens the pull request. No agent session reaches this
   * code path and no agent session holds the credential it uses.
   */
  async publish(input: PublishActivityInput): Promise<PublishActivityOutput> {
    const started = Date.now();
    const startedAt = new Date(started);
    const labels = { tenant_id: input.tenantId, product_id: input.productId };

    try {
      const { token, plainUrl, patch } = await captureForPublication(dependencies, input);

      const branch = publishBranchName(input.runId);
      const port = dependencies.pullRequests(token);

      // Step 8. AT-35. A worker restart must not create a second pull request. This lookup runs
      // before the trusted checkout, so an existing pull request stops the push too.
      const existing = await port.findByHead(input.repositorySlug, branch, input.githubInstallationId);
      if (existing !== null) {
        // GitHub already answered the tip commit of the head branch. Factoree therefore runs no
        // second git read here. A `git ls-remote` puts its URL on the process argument list, so
        // an authenticated URL there exposes the credential to any local process. SDD
        // section 30 forbids that.
        const commitSha = existing.headSha;
        await dependencies.runs.setPublication(input.tenantId, input.runId, input.repositorySlug, {
          patchSha256: patch.patchSha256,
          commitSha,
          pullRequestUrl: existing.url,
        });
        dependencies.logger.info("the pull request of this Run already exists", {
          tenant_id: input.tenantId,
          product_id: input.productId,
          run_id: input.runId,
          step: "publish",
          branch,
          pull_request: existing.number,
        });
        return {
          patchSha256: patch.patchSha256,
          commitSha,
          pullRequestUrl: existing.url,
          pullRequestNumber: existing.number,
          branch,
          created: false,
          patchByteLength: patch.byteLength,
          baseMove: null,
        };
      }

      // Step 9. SDD section 46 steps 1 to 8. The trusted checkout runs on the control plane.
      const title = buildPullRequestTitle({ workItemTitle: input.workItemTitle });
      const commitMessage = [
        title,
        "",
        `Run ID: ${input.runId}`,
        `Base SHA: ${input.baseSha}`,
        `Patch SHA-256: ${patch.patchSha256}`,
      ].join("\n");

      const publish = dependencies.publishToBranch ?? publishToBranchDefault;
      // docs/specs/release-0-1-0.md. The git author is an install setting, read for each publish.
      const author = await dependencies.gitAuthor();
      const publication = await publish({
        cloneUrl: plainUrl,
        token,
        baseSha: input.baseSha,
        branch,
        baseBranch: input.baseBranch,
        patchBase64: patch.patchBase64,
        verifiedPatchSha256: patch.patchSha256,
        verifiedGitVersion: patch.gitVersion,
        commitMessage,
        // AT-35. The commit must be deterministic. A retry that repeats the push must produce
        // the identical commit SHA, so the second push is a fast-forward no-op. A wall clock
        // value produces a new commit SHA on every attempt, and git then refuses the push.
        commitTimestamp: PUBLICATION_COMMIT_TIMESTAMP,
        authorName: author.name,
        authorEmail: author.email,
        // The temporary directory holds a clone and a credentialed remote. A removal failure
        // must never replace the original error, so the logger is the only way to observe it.
        onCleanupFailure: (error: unknown) => {
          dependencies.logger.error("the trusted checkout directory was not removed", {
            tenant_id: input.tenantId,
            product_id: input.productId,
            run_id: input.runId,
            step: "publish",
            error: dependencies.redactor.redactText(String(error)),
          });
        },
      });

      // Step 10. SDD section 46 step 9.
      const created = await port.create(
        {
          slug: input.repositorySlug,
          headBranch: branch,
          baseBranch: input.baseBranch,
          draft: input.draft,
          title,
          body: buildPullRequestBody({
            workItemTitle: input.workItemTitle,
            workItemUrl: input.workItemUrl,
            runId: input.runId,
            baseSha: input.baseSha,
            patchSha256: patch.patchSha256,
            verificationSummary: input.verificationSummary,
            changedFileCount: patch.changedFiles.length,
            repairCount: input.repairCount,
            ...(input.changeSetRepositories === undefined ? {} : { changeSet: changeSetPendingSection(input.changeSetRepositories) }),
          }),
        },
        input.githubInstallationId,
      );

      // Step 11. The publication facts of the Run.
      await dependencies.runs.setPublication(input.tenantId, input.runId, input.repositorySlug, {
        patchSha256: patch.patchSha256,
        commitSha: publication.commitSha,
        pullRequestUrl: created.url,
      });

      dependencies.logger.info("the pull request was created", {
        tenant_id: input.tenantId,
        product_id: input.productId,
        run_id: input.runId,
        step: "publish",
        branch,
        pull_request: created.number,
      });

      return {
        patchSha256: patch.patchSha256,
        commitSha: publication.commitSha,
        pullRequestUrl: created.url,
        pullRequestNumber: created.number,
        branch,
        created: true,
        patchByteLength: patch.byteLength,
        baseMove: publication.baseMove,
      };
    } catch (error) {
      throw asNonRetryable(dependencies.redactor, error);
    } finally {
      metrics.publishDuration.observe(labels, (Date.now() - started) / 1000);
      // Each repair adds one attempt, so the attempt that passed is the repair count plus one.
      await recordStage(dependencies.stages, dependencies.logger, {
        tenantId: input.tenantId,
        runId: input.runId,
        stage: "publish",
        attempt: input.repairCount + 1,
        sandboxId: input.spriteId,
        startedAt,
        endedAt: new Date(),
      });
    }
  },
  /**
   * docs/specs/pr-review-merge-and-deploy.md, D2. Publishes the verified patch of a PR follow-up run
   * as one commit on the existing pull request branch. The commit holds base plus the verified patch,
   * its parent is the head the run read, and the push never forces. No new pull request opens.
   */
  async publishFollowUp(input: PublishFollowUpActivityInput): Promise<PublishFollowUpActivityOutput> {
    const started = Date.now();
    const startedAt = new Date(started);
    const labels = { tenant_id: input.tenantId, product_id: input.productId };
    try {
      // DI-21.125. The clone only reads. The push mints its credential from the files it changes on the
      // branch, which for a merge holds the base side too.
      const { token, plainUrl, patch } = await captureForPublication(dependencies, input, "clone");
      const title = buildPullRequestTitle({ workItemTitle: input.workItemTitle });
      const commitMessage = [
        `${title} (contract revision ${String(input.contractRevision)})`,
        "",
        `Run ID: ${input.runId}`,
        `Base SHA: ${input.baseSha}`,
        `Patch SHA-256: ${patch.patchSha256}`,
        `Contract revision: ${String(input.contractRevision)}`,
      ].join("\n");
      const publish = dependencies.publishToBranch ?? publishToBranchDefault;
      const author = await dependencies.gitAuthor();
      const publication = await publish({
        cloneUrl: plainUrl,
        token,
        baseSha: input.baseSha,
        branch: input.branch,
        baseBranch: input.baseBranch,
        patchBase64: patch.patchBase64,
        verifiedPatchSha256: patch.patchSha256,
        verifiedGitVersion: patch.gitVersion,
        commitMessage,
        // AT-35. A retry builds the identical commit, so its push changes nothing.
        commitTimestamp: PUBLICATION_COMMIT_TIMESTAMP,
        authorName: author.name,
        authorEmail: author.email,
        parentSha: input.parentSha,
        ...(input.mergeParentSha === undefined ? {} : { mergeParentSha: input.mergeParentSha }),
        ...(input.allowUnchanged === true ? { allowUnchanged: true } : {}),
        pushToken: async (pushedFiles: string[]) => {
          const pushToken = await mintPublishToken(dependencies, input, pushedFiles);
          dependencies.redactor.addSecret(pushToken);
          return pushToken;
        },
        onCleanupFailure: (error: unknown) => {
          dependencies.logger.error("the trusted checkout directory was not removed", {
            tenant_id: input.tenantId,
            product_id: input.productId,
            run_id: input.runId,
            step: "publish",
            error: dependencies.redactor.redactText(String(error)),
          });
        },
      });
      if (publication.unchanged === true) {
        dependencies.logger.info("the target changed nothing on its pull request, so Factoree pushed nothing to it", {
          tenant_id: input.tenantId,
          product_id: input.productId,
          run_id: input.runId,
          step: "publish",
          branch: input.branch,
          pull_request: input.pullRequestNumber,
        });
        return { patchSha256: patch.patchSha256, commitSha: publication.commitSha, patchByteLength: patch.byteLength, baseMove: null, unchanged: true };
      }
      await dependencies.runs.setPublication(input.tenantId, input.runId, input.repositorySlug, {
        patchSha256: patch.patchSha256,
        commitSha: publication.commitSha,
        pullRequestUrl: input.pullRequestUrl,
      });
      dependencies.logger.info("the PR follow-up commit was pushed", {
        tenant_id: input.tenantId,
        product_id: input.productId,
        run_id: input.runId,
        step: "publish",
        branch: input.branch,
        pull_request: input.pullRequestNumber,
        commit_sha: publication.commitSha,
      });
      return {
        patchSha256: patch.patchSha256,
        commitSha: publication.commitSha,
        patchByteLength: patch.byteLength,
        baseMove: publication.baseMove,
      };
    } catch (error) {
      throw asNonRetryable(dependencies.redactor, error);
    } finally {
      metrics.publishDuration.observe(labels, (Date.now() - started) / 1000);
      await recordStage(dependencies.stages, dependencies.logger, {
        tenantId: input.tenantId,
        runId: input.runId,
        stage: "publish",
        attempt: input.repairCount + 1,
        sandboxId: input.spriteId,
        startedAt,
        endedAt: new Date(),
      });
    }
  },
  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.117. Merges the head of the base branch
   * into the verified head of the pull request on a trusted checkout, and pushes nothing. A clean
   * merge records its patch, from the base to the merge tree, as the last patch of the run, so the
   * check sprite applies it. A retry merges again and records the same patch while the base stays.
   */
  async mergeBaseIntoPullRequest(input: BringCurrentMergeActivityInput): Promise<BringCurrentMergeActivityOutput> {
    try {
      await registerProjectSecrets(dependencies.redactor, dependencies.secrets, input.tenantId, input.productId, dependencies.logger);
      assertInstallation(input.githubInstallationId);
      const plainUrl = buildRepositoryUrl(input.repositoryBaseUrl, input.repositorySlug);
      assertHttpsRepositoryUrl(plainUrl);
      const token = await dependencies.tokens.tokenForInstallation(input.githubInstallationId, { contents: "read" }, [input.repositorySlug]);
      const author = await dependencies.gitAuthor();
      const merge = dependencies.bringCurrent ?? bringCurrentOnTrustedCheckout;
      const result = await merge({
        cloneUrl: plainUrl,
        token,
        branch: input.branch,
        headSha: input.headSha,
        baseBranch: input.baseBranch,
        commitMessage: bringCurrentMessage(input),
        commitTimestamp: PUBLICATION_COMMIT_TIMESTAMP,
        authorName: author.name,
        authorEmail: author.email,
      });
      const log = { tenant_id: input.tenantId, run_id: input.runId, step: "bring_current", outcome: result.kind };
      dependencies.logger.info("the trusted merge of the base finished", log);
      switch (result.kind) {
        case "current":
          return { kind: "current", baseSha: result.baseSha };
        case "moved":
          return { kind: "moved" };
        case "conflict":
          return { kind: "conflict", baseSha: result.baseSha, conflicts: result.conflicts };
        case "merged":
          if (result.changedFiles.length === 0) {
            throw new EmptyPatchError();
          }
          await dependencies.runs.recordLastPatch(input.tenantId, input.runId, input.repositorySlug, result.patchBase64, 1);
          return {
            kind: "merged",
            baseSha: result.baseSha,
            patchSha256: result.patchSha256,
            changedFiles: result.changedFiles,
            byteLength: Buffer.from(result.patchBase64, "base64").byteLength,
          };
      }
    } catch (error) {
      throw asNonRetryable(dependencies.redactor, error);
    }
  },

  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.117. Builds the merge of the verified
   * base again on a trusted checkout, proves its patch hash equals the patch the check sprite
   * verified, and pushes the merge commit to the branch with no force. A branch that moved since
   * the check answers `moved`, and nothing is pushed.
   */
  async pushBringCurrentMerge(input: PushBringCurrentMergeActivityInput): Promise<PushBringCurrentMergeActivityOutput> {
    try {
      await registerProjectSecrets(dependencies.redactor, dependencies.secrets, input.tenantId, input.productId, dependencies.logger);
      assertInstallation(input.githubInstallationId);
      const plainUrl = buildRepositoryUrl(input.repositoryBaseUrl, input.repositorySlug);
      assertHttpsRepositoryUrl(plainUrl);
      const author = await dependencies.gitAuthor();
      const merge = dependencies.bringCurrent ?? bringCurrentOnTrustedCheckout;
      const shared = {
        cloneUrl: plainUrl,
        branch: input.branch,
        headSha: input.headSha,
        baseBranch: input.baseBranch,
        baseSha: input.baseSha,
        commitMessage: bringCurrentMessage(input),
        commitTimestamp: PUBLICATION_COMMIT_TIMESTAMP,
        authorName: author.name,
        authorEmail: author.email,
      };
      // The files the merge commit changes on the branch decide the scope of the write credential.
      const readToken = await dependencies.tokens.tokenForInstallation(input.githubInstallationId, { contents: "read" }, [input.repositorySlug]);
      const planned = await merge({ ...shared, token: readToken });
      if (planned.kind === "moved") return { kind: "moved" };
      if (planned.kind !== "merged") {
        throw new PatchError(`the merge of the verified base ${input.baseSha.slice(0, 12)} is no longer clean, so Factoree pushed nothing.`);
      }
      const token = await mintPublishToken(dependencies, input, planned.pushedFiles);
      const result = await merge({ ...shared, token, pushVerifiedPatchSha256: input.verifiedPatchSha256 });
      if (result.kind === "moved") return { kind: "moved" };
      if (result.kind !== "merged" || !result.pushed) {
        throw new PatchError(`the merge of the verified base ${input.baseSha.slice(0, 12)} is no longer clean, so Factoree pushed nothing.`);
      }
      await dependencies.runs.setPublication(input.tenantId, input.runId, input.repositorySlug, {
        patchSha256: result.patchSha256,
        commitSha: result.commitSha,
        pullRequestUrl: input.pullRequestUrl,
      });
      dependencies.logger.info("the bring-current merge commit was pushed", {
        tenant_id: input.tenantId,
        run_id: input.runId,
        step: "bring_current",
        commit_sha: result.commitSha,
        pull_request: input.pullRequestNumber,
      });
      return { kind: "pushed", commitSha: result.commitSha, patchSha256: result.patchSha256 };
    } catch (error) {
      throw asNonRetryable(dependencies.redactor, error);
    }
  },

  /**
   * docs/specs/draft-of-failed-run.md. Publishes the last patch a check sprite of a failed run
   * received, as a draft pull request, through the same trusted checkout as `publish`. The patch
   * comes from the run row, so no sandbox takes part and the reaper cannot block it. Its SHA-256 is
   * the hash the commit message names, and the trusted checkout proves it again before the push.
   */
  async publishDraft(input: PublishDraftActivityInput): Promise<PublishDraftActivityOutput> {
    try {
      await registerProjectSecrets(
        dependencies.redactor,
        dependencies.secrets,
        input.tenantId,
        input.productId,
        dependencies.logger,
      );
      assertInstallation(input.githubInstallationId);

      const patchBase64 = await dependencies.runs.lastPatch(input.tenantId, input.runId, input.repositorySlug);
      if (patchBase64 === null) throw new PatchError("the run holds no patch, so Factoree published nothing.");
      const patchSha256 = sha256OfBase64(patchBase64);
      const patchBytes = Buffer.from(patchBase64, "base64");
      // DI-21.33 still applies: the changed files of the stored patch decide the token scope.
      const changedFiles = changedFilesOfPatch(patchBytes.toString("utf8"));
      if (changedFiles.length === 0 || patchBytes.byteLength === 0) throw new EmptyPatchError();

      const token = await mintPublishToken(dependencies, input, changedFiles);
      dependencies.redactor.addSecret(token);
      const plainUrl = buildRepositoryUrl(input.repositoryBaseUrl, input.repositorySlug);
      assertHttpsRepositoryUrl(plainUrl);

      const branch = publishBranchName(input.runId);
      const port = dependencies.pullRequests(token);

      // AT-35. A second request, or a retry, finds the pull request of this branch.
      const existing = await port.findByHead(input.repositorySlug, branch, input.githubInstallationId);
      if (existing !== null) {
        await dependencies.runs.setPublication(input.tenantId, input.runId, input.repositorySlug, {
          patchSha256,
          commitSha: existing.headSha,
          pullRequestUrl: existing.url,
        });
        return {
          patchSha256,
          commitSha: existing.headSha,
          pullRequestUrl: existing.url,
          pullRequestNumber: existing.number,
          branch,
          created: false,
          patchByteLength: patchBytes.byteLength,
          changedFiles,
        };
      }

      const title = buildPullRequestTitle({ workItemTitle: input.workItemTitle });
      const commitMessage = [
        title,
        "",
        "Draft of a failed run. Factoree did not prove this change.",
        "",
        `Run ID: ${input.runId}`,
        `Base SHA: ${input.baseSha}`,
        `Patch SHA-256: ${patchSha256}`,
      ].join("\n");
      const publish = dependencies.publishToBranch ?? publishToBranchDefault;
      const author = await dependencies.gitAuthor();
      const publication = await publish({
        cloneUrl: plainUrl,
        token,
        baseSha: input.baseSha,
        branch,
        baseBranch: input.baseBranch,
        patchBase64,
        verifiedPatchSha256: patchSha256,
        verifiedGitVersion: "the git of the work sprite that captured the stored patch",
        commitMessage,
        commitTimestamp: PUBLICATION_COMMIT_TIMESTAMP,
        authorName: author.name,
        authorEmail: author.email,
        onCleanupFailure: (error: unknown) => {
          dependencies.logger.error("the trusted checkout directory was not removed", {
            tenant_id: input.tenantId,
            product_id: input.productId,
            run_id: input.runId,
            step: "publish_draft",
            error: dependencies.redactor.redactText(String(error)),
          });
        },
      });

      // The pull request is always a draft, at every autonomy level. Only a human marks it ready.
      const created = await port.create(
        {
          slug: input.repositorySlug,
          headBranch: branch,
          baseBranch: input.baseBranch,
          draft: true,
          title,
          body: dependencies.redactor.redactText(
            buildPullRequestBody({
              workItemTitle: input.workItemTitle,
              workItemUrl: input.workItemUrl,
              runId: input.runId,
              baseSha: input.baseSha,
              patchSha256,
              verificationSummary: "The checks of this patch did not pass. The warning above lists what did not pass.",
              changedFileCount: changedFiles.length,
              repairCount: input.repairCount,
              draftWarning: input.warning,
            }),
          ),
        },
        input.githubInstallationId,
      );
      await dependencies.runs.setPublication(input.tenantId, input.runId, input.repositorySlug, {
        patchSha256,
        commitSha: publication.commitSha,
        pullRequestUrl: created.url,
      });
      dependencies.logger.info("the draft pull request was created", {
        tenant_id: input.tenantId,
        product_id: input.productId,
        run_id: input.runId,
        step: "publish_draft",
        branch,
        pull_request: created.number,
      });
      return {
        patchSha256,
        commitSha: publication.commitSha,
        pullRequestUrl: created.url,
        pullRequestNumber: created.number,
        branch,
        created: true,
        patchByteLength: patchBytes.byteLength,
        changedFiles,
      };
    } catch (error) {
      throw asNonRetryable(dependencies.redactor, error);
    }
  },
  /**
   * docs/specs/change-sets.md, DI-21.151. The preflight of a change set: for each target the
   * installation, a write credential minted with the scope that target's patch needs (Workflows only
   * when it changes a workflow file), the patch captured from the check sprite, the hash and the tree
   * checks, and no foreign pull request on the branch. It pushes nothing, so a known permanent cause
   * stops the set before GitHub sees any of it. A failure names its target.
   */
  async preflightChangeSet(input: PreflightChangeSetActivityInput): Promise<PreflightChangeSetActivityOutput> {
    const output: PreflightChangeSetActivityOutput["targets"] = [];
    const captured: Array<{ repository: string; patchSha256: string; treeSha: string }> = [];
    const ref = { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath };
    const branch = publishBranchName(input.runId);
    for (const target of input.targets) {
      try {
        if (target.reviewedChangedFiles.length === 0) {
          // A target the implementer left unchanged must still be unchanged, with the tree the review saw.
          assertInstallation(target.githubInstallationId);
          const patch = await captureVerifiedPatch(
            { sandbox: dependencies.sandbox, redactor: dependencies.redactor },
            { ref, primaryPath: target.primaryPath, baseSha: target.baseSha },
          );
          assertSameChangedFiles([], patch.changedFiles);
          if (patch.treeSha !== target.reviewedWorktreeSha || patch.patchSha256 !== target.verifiedPatchSha256) {
            throw new PatchError(`the worktree changed after the independent review examined it. Factoree published nothing.`);
          }
          captured.push({ repository: target.repositorySlug, patchSha256: patch.patchSha256, treeSha: patch.treeSha });
          output.push({ repositorySlug: target.repositorySlug, patchSha256: patch.patchSha256, changed: false, changedFiles: [], patchByteLength: 0 });
          continue;
        }
        const { token, patch } = await captureForPublication(dependencies, {
          runId: input.runId,
          tenantId: input.tenantId,
          productId: input.productId,
          spriteId: input.spriteId,
          adapter: input.adapter,
          workspacePath: input.workspacePath,
          primaryPath: target.primaryPath,
          repositorySlug: target.repositorySlug,
          repositoryBaseUrl: input.repositoryBaseUrl,
          baseSha: target.baseSha,
          reviewedChangedFiles: target.reviewedChangedFiles,
          reviewedWorktreeSha: target.reviewedWorktreeSha,
          verifiedPatchSha256: target.verifiedPatchSha256,
          githubInstallationId: target.githubInstallationId,
        });
        // AT-35. An open pull request of this run's branch is the one a retry finds again. A closed
        // one, a merged one, or one into another base is foreign, and the push would land under it.
        const existing = await dependencies.pullRequests(token).findByHead(target.repositorySlug, branch, target.githubInstallationId);
        if (existing !== null && (existing.state !== "open" || (existing.baseBranch !== undefined && existing.baseBranch !== target.baseBranch))) {
          throw ApplicationFailure.nonRetryable(
            `the branch ${branch} already holds the pull request ${existing.url}, which is ` +
              `${existing.state === "open" ? `open into ${existing.baseBranch ?? "another base"}` : (existing.state ?? "not open")} and is not this run's pull request.`,
            "PUBLICATION_FAILED",
          );
        }
        captured.push({ repository: target.repositorySlug, patchSha256: patch.patchSha256, treeSha: patch.treeSha });
        output.push({
          repositorySlug: target.repositorySlug,
          patchSha256: patch.patchSha256,
          changed: true,
          changedFiles: patch.changedFiles,
          patchByteLength: patch.byteLength,
        });
      } catch (error) {
        throw namingTarget(dependencies.redactor, target.repositorySlug, error);
      }
    }
    // DI-21.133. The set the review examined and the check sprite received is the set that leaves it.
    const setPatch = setPatchSha256(captured);
    const setTree = setPatchSha256(captured.map((target) => ({ repository: target.repository, patchSha256: target.treeSha })));
    if (setPatch !== input.verifiedSetPatchSha256) {
      throw ApplicationFailure.nonRetryable(
        `the check sprite now holds the set patch ${setPatch}, and the checks verified the set patch ${input.verifiedSetPatchSha256}.`,
        "PATCH_HASH_MISMATCH",
      );
    }
    if (setTree !== input.reviewedSetTreeSha) {
      throw ApplicationFailure.nonRetryable(
        `the trees of the change set changed after the independent review examined them. Reviewed: ${input.reviewedSetTreeSha || "none"}. Captured: ${setTree}.`,
        "PUBLICATION_FAILED",
      );
    }
    dependencies.logger.info("the change set passed its preflight", {
      tenant_id: input.tenantId,
      product_id: input.productId,
      run_id: input.runId,
      step: "publish_preflight",
      targets: output.length,
      changed: output.filter((target) => target.changed).length,
    });
    return { targets: output };
  },

  /**
   * docs/specs/change-sets.md, DI-21.152. Writes the final body of one pull request of a change set:
   * the body of one target, then the link to every sibling pull request and the merge order. A
   * retry writes the same body.
   */
  async writeChangeSetBody(input: WriteChangeSetBodyActivityInput): Promise<void> {
    try {
      assertInstallation(input.githubInstallationId);
      const token = await dependencies.tokens.tokenForInstallation(input.githubInstallationId, { pull_requests: "write" }, [input.repositorySlug]);
      dependencies.redactor.addSecret(token);
      const body = buildPullRequestBody({
        workItemTitle: input.workItemTitle,
        workItemUrl: input.workItemUrl,
        runId: input.runId,
        baseSha: input.baseSha,
        patchSha256: input.patchSha256,
        verificationSummary: input.verificationSummary,
        changedFileCount: input.changedFileCount,
        repairCount: input.repairCount,
        changeSet: changeSetSection(input.repositorySlug, input.pullRequests, input.edges),
      });
      await dependencies.pullRequests(token).updateBody(input.repositorySlug, input.pullRequestNumber, body, input.githubInstallationId);
    } catch (error) {
      throw namingTarget(dependencies.redactor, input.repositorySlug, error);
    }
  },

  /**
   * docs/specs/change-sets.md, DI-21.153. Undoes a change set whose publication failed: for each
   * target, the open pull request of this run's branch gets a comment that names the failed target
   * and closes, its run target loses the pull request, and the branch goes. The lookup is by the
   * run's own branch, so a retry closes no other pull request and finds one that a failed attempt
   * opened. A pull request already closed gets no second comment. A failure of one target does not
   * stop the others, and the activity then fails so that Temporal retries it.
   */
  async rollbackChangeSet(input: RollbackChangeSetActivityInput): Promise<RollbackChangeSetActivityOutput> {
    const branch = publishBranchName(input.runId);
    const closed: SetPullRequest[] = [];
    const problems: string[] = [];
    for (const target of input.targets) {
      if (target.githubInstallationId === "") continue;
      try {
        const token = await dependencies.tokens.tokenForInstallation(target.githubInstallationId, PUBLISH_TOKEN_SCOPE, [target.repositorySlug]);
        dependencies.redactor.addSecret(token);
        const port = dependencies.pullRequests(token);
        const existing = await port.findByHead(target.repositorySlug, branch, target.githubInstallationId);
        if (existing !== null && existing.headBranch === branch && existing.state !== "merged") {
          if (existing.state === "open") {
            await port.comment(target.repositorySlug, existing.number, rollbackComment(input.failedRepository, input.cause), target.githubInstallationId);
            await port.close(target.repositorySlug, existing.number, target.githubInstallationId);
          }
          await dependencies.runs.clearPublication(input.tenantId, input.runId, target.repositorySlug);
          closed.push({ repository: target.repositorySlug, url: existing.url });
        }
        if (existing?.state !== "merged") await port.deleteBranch(target.repositorySlug, branch, target.githubInstallationId);
      } catch (error) {
        problems.push(`${target.repositorySlug}: ${dependencies.redactor.redactText(error instanceof Error ? error.message : String(error))}`);
      }
    }
    dependencies.logger.warn("the change set publication was undone", {
      tenant_id: input.tenantId,
      product_id: input.productId,
      run_id: input.runId,
      step: "publish_rollback",
      failed: input.failedRepository,
      closed: closed.length,
      problems: problems.length,
    });
    if (problems.length > 0) throw new Error(`Factoree could not undo every pull request of the change set: ${problems.join("; ")}`);
    return { closed };
  },
});
