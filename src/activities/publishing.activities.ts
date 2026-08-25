import { ApplicationFailure } from "@temporalio/activity";
import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { registerProjectSecrets } from "~/domain/projects/redaction-loader.js";
import { buildRepositoryUrl } from "~/domain/projects/repository-url.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";
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
import { checkBase as checkBaseFreshness } from "~/domain/publishing/stale-base.js";
import {
  PatchHashMismatchError,
  publishToBranch as publishToBranchDefault,
} from "~/domain/publishing/trusted-checkout.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import type { Logger } from "~/telemetry/logger.js";
import { metrics } from "~/telemetry/metrics.js";
import type { Redactor } from "~/telemetry/redaction.js";

/** The Project secret that carries the GitHub write credential. SDD section 30. */
export const GITHUB_TOKEN_SECRET = "GITHUB_TOKEN";

/** The head branch of one Run. AT-35 requires a stable name, so a retry finds the same branch. */
export const publishBranchName = (runId: string): string => `factoree/run-${runId}`;

export interface CapturePatchActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  baseSha: string;
  /** The changed-file list the independent review examined. Controller decision 2. */
  reviewedChangedFiles: string[];
}

export interface CapturePatchActivityOutput {
  patchSha256: string;
  changedFiles: string[];
  byteLength: number;
  treeSha: string;
}

export interface CheckBaseActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  repositorySlug: string;
  repositoryBaseUrl: string;
  branch: string;
  baseSha: string;
}

export interface CheckBaseActivityOutput {
  fresh: boolean;
  currentTargetSha: string;
}

export interface PublishActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  repositorySlug: string;
  repositoryBaseUrl: string;
  baseBranch: string;
  baseSha: string;
  reviewedChangedFiles: string[];
  workItemTitle: string;
  workItemUrl: string | null;
  verificationSummary: string;
  repairCount: number;
}

export interface PublishActivityOutput {
  patchSha256: string;
  commitSha: string;
  pullRequestUrl: string;
  pullRequestNumber: number;
  branch: string;
  /** False when a pull request for this head branch already existed. Controller decision 8. */
  created: boolean;
}

export interface PublishingActivityDependencies {
  sandbox: Sandbox;
  secrets: SecretStore;
  redactor: Redactor;
  runs: RunRepository;
  repositoryReader: RepositoryReader;
  pullRequests: (token: string) => PullRequestPort;
  gitAuthor: { name: string; email: string };
  logger: Logger;
  /**
   * The trusted checkout. The default is the real function. A unit test injects a double, so it
   * needs no network. The integration test keeps the real path.
   */
  publishToBranch?: typeof publishToBranchDefault;
}

/**
 * Builds the authenticated clone URL. The scheme must be exactly `https:`. A `git clone` of an
 * `ext::` URL or a `file:` URL reaches command execution on the control plane. The `--`
 * separator does not stop a remote helper, so the scheme check is the only defence.
 *
 * The result carries the credential in its userinfo. No caller logs it. No caller returns it.
 */
const buildAuthenticatedUrl = (plainUrl: string, token: string): string => {
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
  parsed.username = "x-access-token";
  parsed.password = token;
  return parsed.toString();
};

/**
 * Reads the GitHub write credential of the Project. SDD section 30 forbids that credential in
 * every agent session, so an injection mark on it is a fault an operator must repair.
 */
const readGitHubToken = async (
  dependencies: PublishingActivityDependencies,
  tenantId: string,
  projectId: string,
): Promise<string> => {
  const descriptors = await dependencies.secrets.list(tenantId, projectId);
  const descriptor = descriptors.find((entry) => entry.name === GITHUB_TOKEN_SECRET);
  if (descriptor === undefined) {
    throw new RunConfigurationError(
      `The Project holds no secret named "${GITHUB_TOKEN_SECRET}". Factoree needs it to push the ` +
        "branch and to open the pull request. Add it to the Project secrets.",
    );
  }
  if (descriptor.injectIntoImplementer) {
    throw new RunConfigurationError(
      `The Project secret "${GITHUB_TOKEN_SECRET}" carries the injection mark, so the credential ` +
        "already reached an agent session. SDD section 30 forbids that. Rotate the credential. " +
        "Then add it again without the injection mark.",
    );
  }
  const token = await dependencies.secrets.get(tenantId, projectId, GITHUB_TOKEN_SECRET);
  if (token === null || token.length === 0) {
    throw new RunConfigurationError(
      `The Project secret "${GITHUB_TOKEN_SECRET}" holds no value. Add the GitHub write credential.`,
    );
  }
  return token;
};

/**
 * SDD section 49. A semantic publication failure must not consume the Temporal retry policy. A
 * retry repeats the same fault. A network failure and a GitHub 500 stay retryable, so this
 * function converts three error types only. The message passes through the redactor first.
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
  return error;
};

/** SDD section 44, section 45, and section 46. */
export const createPublishingActivities = (dependencies: PublishingActivityDependencies) => ({
  /**
   * SDD section 44. Captures the verified implementation artifact of the Run and proves that it
   * names the files the independent review examined. The patch bytes never leave this activity,
   * because a Temporal payload must not carry a whole patch.
   */
  async capturePatch(input: CapturePatchActivityInput): Promise<CapturePatchActivityOutput> {
    const started = Date.now();
    const labels = { tenant_id: input.tenantId, project_id: input.projectId };

    try {
      // Step 1. SDD section 60. Every Project secret reaches the redactor before any output is
      // captured.
      await registerProjectSecrets(
        dependencies.redactor,
        dependencies.secrets,
        input.tenantId,
        input.projectId,
        dependencies.logger,
      );

      // Step 2. The staged diff of the primary worktree against the base SHA.
      const patch = await captureVerifiedPatch(
        { sandbox: dependencies.sandbox, redactor: dependencies.redactor },
        {
          ref: { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath },
          primaryPath: input.primaryPath,
          baseSha: input.baseSha,
        },
      );

      // Step 3. Controller decision 2. The reviewed change and the captured change must name the
      // same files.
      assertSameChangedFiles(input.reviewedChangedFiles, patch.changedFiles);

      // Step 4. An empty patch means every check passed over no change, so there is nothing to
      // publish.
      if (patch.changedFiles.length === 0 && patch.byteLength === 0) throw new EmptyPatchError();

      dependencies.logger.info("patch captured", {
        tenant_id: input.tenantId,
        project_id: input.projectId,
        run_id: input.runId,
        step: "publish",
        changed_files: patch.changedFiles.length,
        patch_bytes: patch.byteLength,
      });

      return {
        patchSha256: patch.patchSha256,
        changedFiles: patch.changedFiles,
        byteLength: patch.byteLength,
        treeSha: patch.treeSha,
      };
    } finally {
      metrics.publishDuration.observe(labels, (Date.now() - started) / 1000);
    }
  },

  /**
   * SDD section 45. Version 1 never rebases. A target branch that moved after the Run started
   * ends the Run in `STALE_BASE`, so this activity reports the fact and publishes nothing.
   */
  async checkBase(input: CheckBaseActivityInput): Promise<CheckBaseActivityOutput> {
    const started = Date.now();
    const labels = { tenant_id: input.tenantId, project_id: input.projectId };

    try {
      const url = buildRepositoryUrl(input.repositoryBaseUrl, input.repositorySlug);
      const result = await checkBaseFreshness(dependencies.repositoryReader, {
        url,
        branch: input.branch,
        runBaseSha: input.baseSha,
      });

      dependencies.logger.info("base freshness checked", {
        tenant_id: input.tenantId,
        project_id: input.projectId,
        run_id: input.runId,
        step: "publish",
        fresh: result.fresh,
      });

      return { fresh: result.fresh, currentTargetSha: result.currentTargetSha };
    } finally {
      metrics.publishDuration.observe(labels, (Date.now() - started) / 1000);
    }
  },

  /**
   * SDD section 46. Applies the verified patch to a clean trusted checkout, proves the patch
   * hash again, pushes the branch, and opens the pull request. No agent session reaches this
   * code path and no agent session holds the credential it uses.
   */
  async publish(input: PublishActivityInput): Promise<PublishActivityOutput> {
    const started = Date.now();
    const labels = { tenant_id: input.tenantId, project_id: input.projectId };

    try {
      // Step 1. SDD section 60. Every Project secret reaches the redactor first.
      await registerProjectSecrets(
        dependencies.redactor,
        dependencies.secrets,
        input.tenantId,
        input.projectId,
        dependencies.logger,
      );

      // Step 2. The GitHub write credential. Controller decision 7 owns both refusals.
      const token = await readGitHubToken(dependencies, input.tenantId, input.projectId);

      // Step 3. The credential reaches the redactor at once, so no later message can echo it.
      dependencies.redactor.addSecret(token);

      // Step 4. The plain URL goes into every message. The authenticated URL goes to git only.
      const plainUrl = buildRepositoryUrl(input.repositoryBaseUrl, input.repositorySlug);
      const authenticatedUrl = buildAuthenticatedUrl(plainUrl, token);

      const ref = { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath };

      // Step 5. This activity captures the patch itself. It never trusts an earlier capture. A
      // Temporal retry therefore recaptures and rehashes, which keeps the activity
      // self-contained.
      const patch = await captureVerifiedPatch(
        { sandbox: dependencies.sandbox, redactor: dependencies.redactor },
        { ref, primaryPath: input.primaryPath, baseSha: input.baseSha },
      );

      // Step 6. Controller decision 2. This check runs before any network call, so a mismatch
      // costs no remote work.
      assertSameChangedFiles(input.reviewedChangedFiles, patch.changedFiles);

      // Step 7. An empty patch publishes nothing.
      if (patch.changedFiles.length === 0 && patch.byteLength === 0) throw new EmptyPatchError();

      const branch = publishBranchName(input.runId);
      const port = dependencies.pullRequests(token);

      // Step 8. AT-35. A worker restart must not create a second pull request. This lookup runs
      // before the trusted checkout, so an existing pull request stops the push too.
      const existing = await port.findByHead(input.repositorySlug, branch);
      if (existing !== null) {
        const commitSha = await dependencies.repositoryReader.resolveRef(authenticatedUrl, branch);
        await dependencies.runs.setPublication(input.tenantId, input.runId, {
          patchSha256: patch.patchSha256,
          commitSha,
          pullRequestUrl: existing.url,
        });
        dependencies.logger.info("the pull request of this Run already exists", {
          tenant_id: input.tenantId,
          project_id: input.projectId,
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
      const publication = await publish({
        cloneUrl: authenticatedUrl,
        baseSha: input.baseSha,
        branch,
        patchBase64: patch.patchBase64,
        verifiedPatchSha256: patch.patchSha256,
        commitMessage,
        authorName: dependencies.gitAuthor.name,
        authorEmail: dependencies.gitAuthor.email,
        // The temporary directory holds a clone and a credentialed remote. A removal failure
        // must never replace the original error, so the logger is the only way to observe it.
        onCleanupFailure: (error: unknown) => {
          dependencies.logger.error("the trusted checkout directory was not removed", {
            tenant_id: input.tenantId,
            project_id: input.projectId,
            run_id: input.runId,
            step: "publish",
            error: dependencies.redactor.redactText(String(error)),
          });
        },
      });

      // Step 10. SDD section 46 step 9.
      const created = await port.create({
        slug: input.repositorySlug,
        headBranch: branch,
        baseBranch: input.baseBranch,
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
      });

      // Step 11. The publication facts of the Run.
      await dependencies.runs.setPublication(input.tenantId, input.runId, {
        patchSha256: patch.patchSha256,
        commitSha: publication.commitSha,
        pullRequestUrl: created.url,
      });

      dependencies.logger.info("the pull request was created", {
        tenant_id: input.tenantId,
        project_id: input.projectId,
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
      };
    } catch (error) {
      throw asNonRetryable(dependencies.redactor, error);
    } finally {
      metrics.publishDuration.observe(labels, (Date.now() - started) / 1000);
    }
  },
});
