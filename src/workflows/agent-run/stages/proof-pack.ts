import { deprecatePatch, isCancellation } from "@temporalio/workflow";
import type { PrepareCheckSandboxActivityOutput, PrepareSandboxActivityOutput } from "~/activities/sandbox.activities.js";
import type { PublishProofPackActivityOutput } from "~/activities/evidence.activities.js";
import type { ForYourEyeCriterion } from "~/domain/validation/for-your-eye.js";
import type { PrFollowUpTrigger } from "~/domain/pull-requests/pr-follow-up.js";
import { proofPackActivities } from "../activities.js";
import { notify } from "../failures.js";
import { PATCH } from "../patches.js";
import type { Run } from "../run.js";
import type { Verified } from "./attempts.js";
import type { PublishedTarget, SetPublication } from "./publish-set.js";
import type { Refined } from "./refinement.js";

/** docs/specs/pr-review-merge-and-deploy.md. What the proof pack of a run on an open pull request names. */
export interface PullRequestFollowUpFacts {
  contractRevision: number;
  trigger: PrFollowUpTrigger;
  startedBy: string;
  kept: Array<{ evidence: string; defect: string; rule: string }>;
  dropped: number;
  plainComments: string[];
}

/**
 * SDD section 47. One Proof Pack, built from persisted state and posted as the Linear final
 * response. The skill proposal leaves first, because the proof pack lists it. A change set names
 * its set patch hash and the result of each target (DI-21.154).
 */
export const publishProofPack = async (
  run: Run,
  facts: {
    published: PublishedTarget[];
    set: SetPublication | null;
    checked: PrepareCheckSandboxActivityOutput;
    pullRequest: PullRequestFollowUpFacts | null;
    linked: boolean;
    baseSha: string;
    baseBranch: string;
    refined: Refined;
    verified: Verified;
    forYourEye: ForYourEyeCriterion[];
    visualEvidenceGap: string | null;
    work: PrepareSandboxActivityOutput;
  },
): Promise<string> => {
  const { input } = run;
  const { published, set, checked, verified } = facts;
  const sources = run.skillSources;
  if (sources !== null) {
    deprecatePatch(PATCH.skillRegistry);
    await notify(() => run.sendSkillProposals(sources, facts.work));
    run.skillProposalsSent = true;
  }
  const first = published[0]?.publication;
  if (first === undefined) throw new Error("the publication published nothing");
  const sameSlug = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  let proofPack: PublishProofPackActivityOutput;
  try {
    proofPack = await proofPackActivities.publishProofPack({
      waitedMs: run.waitedMs,
      runId: run.id,
      tenantId: input.tenantId,
      productId: input.productId,
      sessionId: input.agentSessionId,
      workItem: { title: input.workItem.title, url: input.workItem.url },
      pullRequestUrl: first.pullRequestUrl,
      pullRequestLinked: facts.linked,
      commitSha: first.commitSha,
      patchSha256: set !== null ? checked.patchSha256 : first.patchSha256,
      baseSha: set !== null ? (published[0]?.baseSha ?? facts.baseSha) : facts.baseSha,
      changedFiles: verified.changedFiles,
      patchByteLength: published.reduce((total, target) => total + target.publication.patchByteLength, 0),
      previewUrl: verified.previewUrl,
      fakes: verified.fakes,
      ...(verified.setCheckNotes.length === 0 ? {} : { setCheckNotes: verified.setCheckNotes }),
      repairCount: verified.repairCount,
      repairLimit: verified.repairLimit,
      reviewVerdict: verified.reviewVerdict,
      reviewPasses: verified.reviewPasses,
      reviewAttempt: verified.reviewAttempt,
      changeDescription: verified.changeDescription,
      visualEvidenceGap: facts.visualEvidenceGap,
      ...(facts.forYourEye.length === 0 ? {} : { forYourEye: facts.forYourEye }),
      decisions: run.factoreeDecisions,
      baseMove: set !== null || first.baseMove === null ? null : { baseBranch: facts.baseBranch, ...first.baseMove },
      ...(set === null
        ? {}
        : {
            targetResults: (checked.checkedTargets ?? []).map((fact) => {
              const target = published.find((candidate) => sameSlug(candidate.slug, fact.repository));
              const unchanged = set.unchanged.find((candidate) => sameSlug(candidate.slug, fact.repository));
              return target === undefined
                ? { repository: unchanged?.slug ?? fact.repository, baseSha: fact.baseSha, result: "unchanged" as const, pullRequestUrl: null, baseMove: null }
                : {
                    repository: target.slug,
                    baseSha: target.baseSha,
                    result: "published" as const,
                    pullRequestUrl: target.publication.pullRequestUrl,
                    baseMove: target.publication.baseMove === null ? null : { baseBranch: target.baseBranch, ...target.publication.baseMove },
                  };
            }),
          }),
      autonomyLevel: facts.refined.autonomyLevel,
      autonomyReasons: facts.refined.autonomyReasons,
      checkDefiningFiles: checked.checkDefiningFiles,
      ...(facts.pullRequest === null ? {} : { pullRequestFollowUp: facts.pullRequest }),
    });
  } catch (error) {
    if (isCancellation(error)) throw error;
    if (run.stopped) await run.cancel();
    // SDD section 68. The change is published, and Factoree cannot prove it to a human, so the Run
    // fails and names the pull request a human must now read by hand.
    const urls = published.map((target) => target.publication.pullRequestUrl);
    return await run.fail(
      "COMPLETION_INVARIANT_UNMET",
      "Factoree published the verified change and could not post the Proof Pack. Review the " +
        `pull request by hand. ${urls.length === 1 ? "Pull request" : "Pull requests"}: ${urls.join(", ")}.`,
    );
  }
  return proofPack.sha256;
};
