import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type { Activities } from "~/activities/index.js";
import type { PublishDraftActivityOutput } from "~/activities/publishing.activities.js";
// The workflow bundler resolves a relative path only. Both modules import nothing at run time.
import { RUN_CONFIGURATION_ERROR_TYPE } from "../domain/runs/run-configuration-error.js";
import { withCauseText } from "../domain/runs/failure-cause.js";

const activities = proxyActivities<Activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3, initialInterval: "1 second", backoffCoefficient: 2 },
});

// The same bounds as the publication of a run: one trusted checkout must not hang the workflow,
// and a deterministic fault must not consume the retry policy.
const publishingActivities = proxyActivities<Activities>({
  startToCloseTimeout: "15 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [RUN_CONFIGURATION_ERROR_TYPE, "PATCH_HASH_MISMATCH", "EMPTY_PATCH", "PUBLICATION_FAILED"],
  },
});

const proofPackActivities = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1 second",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [RUN_CONFIGURATION_ERROR_TYPE, "PROOF_PACK_INPUT_MISSING"],
  },
});

export interface DraftRunWorkflowInput {
  tenantId: string;
  runId: string;
}

export type DraftRunWorkflowResult =
  | { outcome: "published"; pullRequestUrl: string }
  | { outcome: "refused"; reason: string };

/** The innermost message of an activity failure. Temporal wraps it in an outer failure. */
const causeOf = (error: unknown): string => {
  let innermost = "";
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.message.trim() !== "") innermost = current.message;
  }
  return innermost;
};

// A Linear post is best effort: the durable facts are already written.
const notify = async (send: () => Promise<void>): Promise<void> => {
  try {
    await send();
  } catch {
    // The run row holds the facts. The Linear post is not one of them.
  }
};

/**
 * docs/specs/draft-of-failed-run.md, issue #41. Publishes the last patch of one failed run as a
 * draft pull request. The workflow id is `draft-<runId>`, so a second request while it runs finds
 * it, and a request after it finds DRAFT_PUBLISHED and its pull request. No sandbox takes part.
 */
export const draftRunWorkflow = async (input: DraftRunWorkflowInput): Promise<DraftRunWorkflowResult> => {
  const plan = await activities.prepareDraft(input);
  if (plan.kind === "refused") {
    const sessionId = plan.sessionId;
    if (sessionId !== null) await notify(() => activities.postFinalResponse({ sessionId, body: plan.reason }));
    return { outcome: "refused", reason: plan.reason };
  }
  if (plan.kind === "published") return { outcome: "published", pullRequestUrl: plan.pullRequestUrl };

  let publication: PublishDraftActivityOutput;
  try {
    publication = await publishingActivities.publishDraft({
      runId: input.runId,
      tenantId: input.tenantId,
      productId: plan.productId,
      repositorySlug: plan.repositorySlug,
      repositoryBaseUrl: plan.repositoryBaseUrl,
      baseBranch: plan.baseBranch,
      baseSha: plan.baseSha,
      githubInstallationId: plan.githubInstallationId,
      workItemTitle: plan.workItemTitle,
      workItemUrl: plan.workItemUrl,
      repairCount: plan.repairCount,
      warning: plan.warning,
    });
  } catch (error) {
    // DI-21.82. The run stays failed and opens nothing. The human reads why, and can ask again.
    const message = withCauseText(
      "Factoree could not publish the draft pull request, so the run stays failed. Ask again to retry.",
      causeOf(error),
    );
    await notify(() => activities.postError({ sessionId: plan.sessionId, message }));
    throw ApplicationFailure.nonRetryable(message, "DRAFT_PUBLICATION_FAILED");
  }

  // Specification section 14. The run target holds the facts of its pull request, as after a
  // normal publication.
  await activities.recordRunTargetFacts({
    tenantId: input.tenantId,
    runId: input.runId,
    repositoryId: plan.repositoryId,
    patchSha256: publication.patchSha256,
    commitSha: publication.commitSha,
    pullRequestUrl: publication.pullRequestUrl,
  });
  // The pull request exists, so the status says so before any Linear post. The issue state stays.
  await activities.completeDraft({ tenantId: input.tenantId, runId: input.runId, productId: plan.productId });

  // DI-21.52. The issue shows the pull request as an attachment, and the session as a link.
  let pullRequestLinked = false;
  await notify(async () => {
    await activities.linkPullRequest({
      tenantId: input.tenantId,
      sessionId: plan.sessionId,
      issueId: plan.issueId,
      pullRequestUrl: publication.pullRequestUrl,
      repositorySlug: plan.repositorySlug,
    });
    pullRequestLinked = true;
  });

  // The proof pack is the delivery record: each unmet assertion is not proven, and it links the draft.
  try {
    await proofPackActivities.publishProofPack({
      runId: input.runId,
      tenantId: input.tenantId,
      productId: plan.productId,
      sessionId: plan.sessionId,
      workItem: { title: plan.workItemTitle, url: plan.workItemUrl },
      pullRequestUrl: publication.pullRequestUrl,
      pullRequestLinked,
      commitSha: publication.commitSha,
      patchSha256: publication.patchSha256,
      baseSha: plan.baseSha,
      changedFiles: publication.changedFiles,
      patchByteLength: publication.patchByteLength,
      previewUrl: null,
      repairCount: plan.repairCount,
      repairLimit: plan.repairLimit,
      reviewVerdict: plan.reviewVerdict,
      reviewPasses: plan.reviewPasses,
      reviewAttempt: plan.patchAttempt,
      decisions: plan.decisions,
      waitedMs: plan.waitedMs,
      autonomyLevel: plan.autonomyLevel,
      autonomyReasons: [],
      checkDefiningFiles: [],
      draft: { attempt: plan.patchAttempt, reviewed: plan.reviewed },
    });
  } catch {
    // The draft is open and the run says DRAFT_PUBLISHED. The human still gets its link.
    await notify(() =>
      activities.postFinalResponse({
        sessionId: plan.sessionId,
        body: `Factoree opened the draft pull request and could not post its proof pack. Pull request: ${publication.pullRequestUrl}.`,
      }),
    );
  }
  return { outcome: "published", pullRequestUrl: publication.pullRequestUrl };
};
