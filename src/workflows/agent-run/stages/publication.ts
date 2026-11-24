import { ApplicationFailure, deprecatePatch, isCancellation, ParentClosePolicy, startChild } from "@temporalio/workflow";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import type { PublishActivityOutput } from "~/activities/publishing.activities.js";
import type { HumanDecision, PrReviewFinding, PrSetMember } from "~/domain/pull-requests/pr-follow-up.js";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import { completionInvariantFailures, prePublicationFailures } from "../../../domain/runs/completion-invariant.js";
import { pullRequestWorkflow } from "../../pr.workflow.js";
import { activities, publishingActivities, pullRequestReplyActivities } from "../activities.js";
import { isConfigurationFault, notify, publicationFailureReasonOf, withCause } from "../failures.js";
import { PATCH } from "../patches.js";
import type { Run } from "../run.js";
import type { Verified } from "./attempts.js";
import { defaultBranchOf, type ResolvedContext } from "./context.js";
import type { Workspace } from "./preparation.js";
import { publishChangeSet, publishSetFollowUp, type PublishedTarget, type SetPublication } from "./publish-set.js";
import { publishProofPack, type PullRequestFollowUpFacts } from "./proof-pack.js";
import type { Refined } from "./refinement.js";
import { reportL1 } from "./reports.js";
import type { ValidationContract } from "./validation-contract.js";

/**
 * D2. The open pull request a run on it publishes to: one new verified commit on its branch with
 * the head the run read as its parent. No new pull request opens, and the push never forces.
 */
export interface ExistingPullRequest {
  pullRequestId: string;
  url: string;
  number: number;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  baseSha: string;
  contractRevision: number;
  /** Slice 4, DI-21.119. The commit merges the new base into the branch. */
  mergesBase: boolean;
  /** Slice 9. The members of the change set the pull request belongs to, or null. */
  setMembers: PrSetMember[] | null;
  proofPack: PullRequestFollowUpFacts;
  /**
   * docs/specs/pr-feedback-loop.md, DI-21.216. The threads the run handled, which get a reply after
   * the commit is published. Absent in a history from before the replies.
   */
  handled?: HandledThreads;
}

/** DI-21.216. The kept review app findings and the human decisions a PR follow-up run carries out. */
export interface HandledThreads {
  kept: Array<{ finding: PrReviewFinding & { fingerprint?: string }; defect: string }>;
  decisions: HumanDecision[];
}

export interface PublicationPlan {
  refined: Refined;
  context: ResolvedContext;
  validation: ValidationContract;
  workspace: Workspace;
  verified: Verified;
  edges: Array<{ provider: string; consumer: string }>;
  forYourEye: Parameters<typeof publishProofPack>[1]["forYourEye"];
  visualEvidenceGap: string | null;
  /** Null publishes new pull requests. */
  pullRequest: ExistingPullRequest | null;
}

/** The facts of the completion invariant, SDD section 68, before and after publication. */
const invariantFacts = (run: Run, plan: PublicationPlan, draft: boolean) => ({
  workItemReady: plan.refined.status === "ready",
  contextContractVersion: run.control.contextContractVersion,
  unresolvedConflict: plan.context.unresolvedConflict !== null,
  validationContractVersion: run.control.validationContractVersion,
  validationContractFrozenAt: plan.validation.frozenAt,
  implementationStartedAt: plan.verified.implementationStartedAt,
  validationPassed: plan.verified.validationPassed,
  validationUnstableOnly: plan.verified.validationUnstableOnly,
  draft,
  verificationPassed: plan.verified.verificationPassed,
  blockingFindingCount: plan.verified.blockingCount,
  repairCount: plan.verified.repairCount,
  repairLimit: plan.verified.repairLimit,
});

/** One target: a new pull request, or one verified commit on the open pull request. */
const publishOne = async (
  run: Run,
  plan: PublicationPlan,
  publishInput: Parameters<typeof publishingActivities.publish>[0],
): Promise<PublishActivityOutput> => {
  const pullRequest = plan.pullRequest;
  try {
    if (pullRequest === null) return await publishingActivities.publish(publishInput);
    const pushed = await publishingActivities.publishFollowUp({
      ...publishInput,
      branch: pullRequest.headBranch,
      parentSha: pullRequest.headSha,
      ...(pullRequest.mergesBase ? { mergeParentSha: pullRequest.baseSha } : {}),
      pullRequestUrl: pullRequest.url,
      pullRequestNumber: pullRequest.number,
      contractRevision: pullRequest.contractRevision,
    });
    return { ...pushed, pullRequestUrl: pullRequest.url, pullRequestNumber: pullRequest.number, branch: pullRequest.headBranch, created: false };
  } catch (error) {
    if (isCancellation(error)) throw error;
    // SDD section 50. A human stop is never a configuration fault or a publication failure.
    if (run.stopped) await run.cancel();
    if (isConfigurationFault(error)) {
      await run.fail(
        "CONFIGURATION_INVALID",
        withCause(
          "Factoree could not publish, because the GitHub App installation cannot mint the write credential this change needs. " +
            "Repair the installation or its permissions as the cause says. No agent session ever receives that credential.",
          error,
        ),
      );
    }
    const reason = publicationFailureReasonOf(error);
    return await run.fail(
      reason,
      reason === "PATCH_HASH_MISMATCH"
        ? "The patch of the trusted checkout did not equal the verified patch, so Factoree published nothing. SDD section 46 blocks publication on a hash mismatch."
        : reason === "EMPTY_PATCH"
          ? "Every check passed and the change holds no file, so Factoree had nothing to publish."
          : withCause("Factoree could not publish the verified change. Factoree created no pull request for it.", error),
    );
  }
};

/** The Linear line that names what the publication did. */
const publishedLine = (published: PublishedTarget[], set: SetPublication | null, pullRequest: ExistingPullRequest | null): string => {
  const first = published[0]?.publication;
  if (set !== null && pullRequest === null) {
    return `Factoree opened the pull requests of the change set: ${published.map((target) => `${target.slug} ${target.publication.pullRequestUrl}`).join(", ")}.`;
  }
  if (set !== null && pullRequest !== null) {
    return (
      `Factoree pushed a verified commit to ${published.map((target) => `${target.publication.pullRequestUrl} (${target.publication.commitSha.slice(0, 12)})`).join(", ")} ` +
      `(contract revision ${String(pullRequest.contractRevision)}).` +
      (set.unchanged.length === 0 ? "" : ` It changed nothing on ${set.unchanged.map((target) => target.slug).join(", ")}.`)
    );
  }
  if (pullRequest === null) return `Factoree opened the pull request: ${first?.pullRequestUrl ?? ""}.`;
  return `Factoree pushed the verified commit ${first?.commitSha.slice(0, 12) ?? ""} to the pull request ${first?.pullRequestUrl ?? ""} (contract revision ${String(pullRequest.contractRevision)}).`;
};

/**
 * DI-21.52 and D3. Each new pull request links to the issue and records the run as its origin, and
 * its PR workflow takes the events after the run ends (ABANDON keeps it open). A commit on an open
 * pull request records its new verified head; its PR workflow already runs.
 */
const recordPullRequests = async (
  run: Run,
  plan: PublicationPlan,
  published: PublishedTarget[],
  set: SetPublication | null,
  draft: boolean,
): Promise<boolean> => {
  const { input } = run;
  const pullRequest = plan.pullRequest;
  let linkedAll = pullRequest !== null;
  if (pullRequest === null) {
    deprecatePatch(PATCH.pullRequestLink);
    let linked = 0;
    for (const target of published) {
      await notify(async () => {
        await activities.linkPullRequest({
          tenantId: input.tenantId,
          sessionId: input.agentSessionId,
          issueId: input.workItem.issueId,
          pullRequestUrl: target.publication.pullRequestUrl,
          repositorySlug: target.slug,
          ...(set !== null ? { label: `Pull request ${target.slug}` } : {}),
        });
        linked += 1;
      });
    }
    linkedAll = linked === published.length;
  }
  // Specification section 14. The patch hash, the commit and the pull request describe one moment.
  for (const target of published) {
    await activities.recordRunTargetFacts({
      tenantId: input.tenantId,
      runId: run.id,
      repositoryId: target.repositoryId,
      patchSha256: target.publication.patchSha256,
      commitSha: target.publication.commitSha,
      pullRequestUrl: target.publication.pullRequestUrl,
    });
  }
  const level = draft ? "L2" : plan.refined.autonomyLevel;
  if (set !== null && pullRequest !== null) {
    // DI-21.162. Each pull request that took a commit records it as its verified head with its own
    // base and contract revision. Each open one that changed nothing records its head as checked.
    for (const target of published) {
      const member = pullRequest.setMembers?.find((candidate) => candidate.repositoryFullName.toLowerCase() === target.slug.toLowerCase());
      if (member === undefined) continue;
      await notify(() =>
        activities.recordPullRequest({
          tenantId: input.tenantId,
          runId: run.id,
          repositoryId: target.repositoryId,
          number: member.number,
          url: member.url,
          headBranch: member.headBranch,
          headSha: target.publication.commitSha,
          baseBranch: member.baseBranch,
          autonomyLevel: level,
          baseSha: target.baseSha,
          contractRevision: member.contractRevision + 1,
        }),
      );
    }
    for (const checked of set.checkedHeads) {
      await notify(() =>
        activities.recordCheckedHead({
          tenantId: input.tenantId,
          pullRequestId: checked.member.pullRequestId,
          headSha: checked.member.headSha,
          baseSha: checked.baseSha,
          runId: run.id,
          autonomyLevel: level,
        }),
      );
    }
    return linkedAll;
  }
  for (const target of published) {
    deprecatePatch(PATCH.prWorkflow);
    await notify(async () => {
      const recorded = await activities.recordPullRequest({
        tenantId: input.tenantId,
        runId: run.id,
        repositoryId: target.repositoryId,
        number: target.publication.pullRequestNumber,
        url: target.publication.pullRequestUrl,
        headBranch: target.publication.branch,
        headSha: target.publication.commitSha,
        baseBranch: target.baseBranch,
        // DI-21.104 and DI-21.112. Auto-merge follows only the head of an L4 run, and a commit that a
        // first run would publish as a draft records L2.
        autonomyLevel: pullRequest !== null && draft ? "L2" : plan.refined.autonomyLevel,
        // D2. The next PR follow-up run starts from this base.
        baseSha: target.baseSha,
        ...(pullRequest === null ? {} : { contractRevision: pullRequest.contractRevision }),
      });
      if (pullRequest !== null) return;
      try {
        await startChild(pullRequestWorkflow, {
          workflowId: recorded.workflowId,
          args: [{ tenantId: input.tenantId, pullRequestId: recorded.pullRequestId }],
          parentClosePolicy: ParentClosePolicy.ABANDON,
        });
      } catch (error) {
        // A webhook event already started it with signal-with-start.
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      }
    });
  }
  return linkedAll;
};

/**
 * SDD sections 46 to 49 and 68. Captures the verified patch from the check sprite and publishes it:
 * a new pull request, a change set all or nothing, or a verified commit on the open pull request.
 * Every clause that can hold before publication is checked before, and the whole invariant after
 * the Proof Pack, immediately before the one success state.
 */
export const publish = async (run: Run, plan: PublicationPlan): Promise<never> => {
  const { input } = run;
  const { refined, context, workspace, verified } = plan;
  const pullRequest = plan.pullRequest;
  await run.ensureTime();
  if (run.stopped) await run.cancel();
  // docs/specs/autonomy-levels.md, check-isolation.md and run-recovery.md. L2 opens a draft, and so
  // does a patch that changes a file that defines a check, and a run with an unstable assertion.
  const draft =
    (refined.autonomyLevel !== "L3" && refined.autonomyLevel !== "L4") ||
    (run.checkSprite?.checkDefiningFiles.length ?? 0) > 0 ||
    verified.validationUnstableOnly;
  const unmetBefore = prePublicationFailures(invariantFacts(run, plan, draft));
  if (unmetBefore.length > 0) {
    await run.fail("COMPLETION_INVARIANT_UNMET", `Factoree cannot prove this change, so it published nothing. ${unmetBefore.join(" ")}`);
  }
  if (refined.autonomyLevel === "L1") await reportL1(run, refined, verified);
  const bases = workspace.bases;
  const changeSet = bases.length > 1 && pullRequest === null;
  if (changeSet) deprecatePatch(PATCH.changeSetPublication);
  const setMembers = bases.length > 1 ? (pullRequest?.setMembers ?? null) : null;
  if (bases.length > 1 && !changeSet && setMembers === null) {
    await run.fail(
      "PUBLICATION_FAILED",
      `Every check of the change set ${bases.map((target) => target.fullName).join(", ")} passed, and this Factoree ` +
        "release cannot publish a change set as one step, so it opened no pull request. The last patch of each target is kept for a follow-up run.",
    );
  }
  await run.enter("PUBLISHING");
  // docs/specs/check-isolation.md. The patch publication captures must be the patch that entered the check sprite.
  const checked = run.checkSprite;
  if (checked === null) return await run.fail("COMPLETION_INVARIANT_UNMET", "Factoree has no check sandbox for this change, so it published nothing.");
  const primary = bases[0];
  if (primary === undefined) throw ApplicationFailure.nonRetryable("the Run has no target");
  const publishInput = {
    runId: run.id,
    tenantId: input.tenantId,
    productId: input.productId,
    spriteId: checked.spriteId,
    adapter: checked.adapter,
    workspacePath: checked.workspacePath,
    primaryPath: checked.primaryPath,
    verifiedPatchSha256: checked.patchSha256,
    draft,
    repositorySlug: context.primary.slug,
    repositoryBaseUrl: input.product.repositoryBaseUrl,
    baseBranch: pullRequest?.baseBranch ?? defaultBranchOf(run, context.primary.slug),
    baseSha: workspace.work.baseSha,
    reviewedChangedFiles: verified.changedFiles,
    reviewedWorktreeSha: verified.worktreeSha,
    workItemTitle: input.workItem.title,
    workItemUrl: input.workItem.url,
    verificationSummary: verified.verificationSummary,
    repairCount: verified.repairCount,
    githubInstallationId: primary.githubInstallationId,
  };
  // docs/specs/own-proposals-and-parallel-runs.md. A moved base branch no longer stops the Run.
  if (run.stopped) await run.cancel();

  const setFacts = { draft, worktreeSha: verified.worktreeSha, verificationSummary: verified.verificationSummary, repairCount: verified.repairCount, edges: plan.edges };
  let set: SetPublication | null = null;
  let published: PublishedTarget[];
  if (changeSet) set = await publishChangeSet(run, checked, bases, setFacts);
  else if (setMembers !== null && pullRequest !== null) {
    set = await publishSetFollowUp(run, checked, bases, setFacts, { pullRequestId: pullRequest.pullRequestId, mergesBase: pullRequest.mergesBase, members: setMembers });
  }
  if (set !== null) {
    published = set.published;
    if (published[0] === undefined) throw ApplicationFailure.nonRetryable("the set publication published no pull request");
  } else {
    const publication = await publishOne(run, plan, publishInput);
    published = [
      { repositoryId: primary.id, slug: context.primary.slug, installationId: primary.githubInstallationId, baseBranch: publishInput.baseBranch, baseSha: publishInput.baseSha, publication },
    ];
  }
  const urls = published.map((target) => target.publication.pullRequestUrl);
  await run.progress(publishedLine(published, set, pullRequest));
  // A later stop message and a later timeout message read this, so neither claims nothing was published.
  run.publishedPullRequestUrls.push(...urls);
  const linked = await recordPullRequests(run, plan, published, set, draft);

  // docs/specs/change-sets.md, slices 8 and 9, DI-21.155. Each consumer pull request of the set gets
  // its `factoree/change-set` status. A failure costs only the status.
  if (changeSet) {
    deprecatePatch(PATCH.changeSetStatus);
    await notify(() => activities.setChangeSetStatuses({ tenantId: input.tenantId, originRunId: run.id }));
  }
  if (set !== null && pullRequest !== null) {
    await notify(() => activities.setChangeSetStatuses({ tenantId: input.tenantId, pullRequestId: pullRequest.pullRequestId }));
  }
  if (run.stopped) await run.cancel();

  const proofPackSha256 = await publishProofPack(run, {
    published,
    set,
    checked,
    pullRequest: pullRequest?.proofPack ?? null,
    linked,
    baseSha: publishInput.baseSha,
    baseBranch: publishInput.baseBranch,
    refined,
    verified,
    forYourEye: plan.forYourEye,
    visualEvidenceGap: plan.visualEvidenceGap,
    work: workspace.work,
  });
  if (run.stopped) await run.cancel();
  // docs/specs/pr-feedback-loop.md, DI-21.216. Each handled thread gets its reply once the commit is
  // on the pull request. A failure costs only the replies.
  const handled = pullRequest?.handled;
  if (pullRequest !== null && handled !== undefined && (handled.kept.length > 0 || handled.decisions.length > 0)) {
    const own = published.find((target) => target.publication.pullRequestUrl === pullRequest.url) ?? published[0];
    if (own !== undefined) {
      await notify(() =>
        pullRequestReplyActivities.answerHandledThreads({
          tenantId: input.tenantId,
          pullRequestId: pullRequest.pullRequestId,
          commitSha: own.publication.commitSha,
          kept: handled.kept,
          decisions: handled.decisions,
        }),
      );
    }
  }
  // SDD section 68. Every clause is checked from recorded facts. No agent claim reaches this check.
  const unmet = completionInvariantFailures({
    ...invariantFacts(run, plan, draft),
    targets: published.map((target) => ({
      repositoryFullName: set !== null ? target.slug : primary.fullName,
      patchSha256: target.publication.patchSha256,
      pullRequestUrl: target.publication.pullRequestUrl,
    })),
    proofPackSha256,
  });
  if (unmet.length > 0) {
    await run.fail(
      "COMPLETION_INVARIANT_UNMET",
      `Factoree published the verified change and cannot report it complete. ${unmet.join(" ")} ${urls.length === 1 ? "Pull request" : "Pull requests"}: ${urls.join(", ")}.`,
    );
  }
  return await run.succeed();
};
