import { ApplicationFailure } from "@temporalio/activity";
import { GitHubApiError } from "~/adapters/github/github-pull-requests.js";
import { registerProjectSecrets } from "~/domain/products/redaction-loader.js";
import { buildRepositoryUrl } from "~/domain/products/repository-url.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { GitHubTokenProvider, GitHubTokenScope } from "~/domain/products/github-token-provider.js";
import {
  assertSameChangedFiles,
  capturePatch as captureVerifiedPatch,
  EmptyPatchError,
  PatchError,
} from "~/domain/publishing/patch.js";
import {
  buildPullRequestBody,
  buildPullRequestTitle,
  type PullRequestPort,
} from "~/domain/publishing/pull-request.js";
import {
  PatchHashMismatchError,
  publishToBranch as publishToBranchDefault,
  TrustedCheckoutError,
  type BaseMove,
} from "~/domain/publishing/trusted-checkout.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
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
}

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
      if (input.githubInstallationId === "") {
        throw new RunConfigurationError(
          "The target repository carries no GitHub App installation. Factoree needs one to push " +
            "the branch and to open the pull request. Install the Factoree GitHub App on the " +
            "repository.",
        );
      }

      // Ruling 2 requires the token to carry a scope no wider than this publish needs. This
      // publish pushes one branch. It opens one pull request. The token carries exactly those
      // two permissions, plus `workflows` only for a patch that changes a workflow (DI-21.33).
      // Step 6 proves later that the captured patch changes exactly the reviewed files.
      const workflowFiles = workflowFilesOf(input.reviewedChangedFiles);
      let token: string;
      try {
        token = await dependencies.tokens.tokenForInstallation(
          input.githubInstallationId,
          publishTokenScope(input.reviewedChangedFiles),
          [input.repositorySlug],
        );
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
        await dependencies.runs.setPublication(input.tenantId, input.runId, {
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
          }),
        },
        input.githubInstallationId,
      );

      // Step 11. The publication facts of the Run.
      await dependencies.runs.setPublication(input.tenantId, input.runId, {
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
});
