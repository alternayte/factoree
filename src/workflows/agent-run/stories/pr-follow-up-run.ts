import type { PrFollowUpInput, TriagedFinding } from "~/domain/pull-requests/pr-follow-up.js";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import {
  baseUpdateFindingLines,
  findingPlace,
  keptFindingLines,
  renderPrFollowUpDescription,
} from "../../../domain/pull-requests/pr-follow-up.js";
import type { Run, RunEnding } from "../run.js";
import type { PrepareInput } from "../stages/preparation.js";
import { triageReviewerFindings } from "../stages/triage.js";
import { runChange } from "./change.js";
import { deployFailureFindings } from "./new-run.js";

/**
 * docs/specs/pr-review-merge-and-deploy.md. A PR follow-up run takes no Linear reply and no draft:
 * the pull request it follows is open already, and a review there starts the next one.
 */
export const prFollowUpEnding = (followUp: PrFollowUpInput): RunEnding => ({
  failureNote:
    `This PR follow-up run pushed nothing to ${followUp.url}. Request changes on the pull request, ` +
    "or run the PR reviewer check again, to start another PR follow-up run.",
  draftOnInternalError: false,
});

export const prFollowUpGreeting = (followUp: PrFollowUpInput): string =>
  followUp.trigger === "human"
    ? `${followUp.reviewerLogin ?? "A human"} requested changes on ${followUp.url}, so Factoree started a PR follow-up run.`
    : followUp.trigger === "base"
      ? `Factoree could not bring ${followUp.url} current with ${followUp.baseBranch} on its own, so it started a PR follow-up run.`
      : `The PR reviewer check failed on ${followUp.url}, so Factoree started a PR follow-up run. It triages the findings first.`;

/** DI-19.04. A human review is a decision, as a Linear reply is, so the implementer follows it. */
export const humanReviewInput = (followUp: PrFollowUpInput): string | null =>
  followUp.trigger !== "human"
    ? null
    : [
        `${followUp.reviewerLogin ?? "A human"} requested changes on the pull request ${followUp.url}:`,
        ...followUp.findings.map((finding) => `- ${findingPlace(finding)}: ${finding.body}`),
      ].join("\n");

const reviewerName = (followUp: PrFollowUpInput): string =>
  followUp.reviewer === null ? "PR reviewer" : `${followUp.reviewer.appSlug} (${followUp.reviewer.checkName})`;

/**
 * D2 and slice 4. The work sprite holds the full change of the pull request: the verified base,
 * with the diff to the head the run read. A base update merges the head into the new base,
 * conflict markers and all. DI-21.159: a set applies each open pull request to its own target, and
 * leaves each merged one at its merge commit.
 */
const pullRequestStartPoint =
  (followUp: PrFollowUpInput) =>
  (base: PrepareInput): PrepareInput => {
    const members = followUp.changeSet?.members;
    if (members !== undefined && base.targets !== undefined) {
      return {
        ...base,
        targets: base.targets.map((target) => {
          const member = members.find((candidate) => candidate.repositoryFullName.toLowerCase() === target.repository.toLowerCase());
          if (member === undefined || member.state !== "open") return target;
          const merges = followUp.baseUpdate !== undefined && member.pullRequestId === followUp.pullRequestId;
          return { ...target, pullRequestHead: member.headSha, ...(merges ? { pullRequestMerge: true } : {}) };
        }),
      };
    }
    return { ...base, pullRequestHead: followUp.headSha, ...(followUp.baseUpdate === undefined ? {} : { pullRequestMerge: true }) };
  };

/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 3. A PR follow-up run changes the open pull
 * request that a failed PR reviewer check, a human request-changes review or a base conflict
 * started it on, and pushes one new verified commit there. A failed reviewer check is triaged
 * first. The run keeps the repository, or the change set, of its pull request.
 */
export const prFollowUpRun = async (run: Run, followUp: PrFollowUpInput): Promise<never> => {
  const { input } = run;
  const members = followUp.changeSet?.members ?? null;
  const memberOf = (slug: string) => members?.find((member) => member.repositoryFullName.toLowerCase() === slug.toLowerCase()) ?? null;
  let triaged: TriagedFinding[] = [];
  let description = followUp.trigger === "reviewer" ? input.workItem.description : renderPrFollowUpDescription({ description: input.workItem.description, followUp, kept: [] });
  let initialFindings = [...(followUp.baseUpdate === undefined ? [] : baseUpdateFindingLines(followUp.baseUpdate)), ...deployFailureFindings(input)];
  if (followUp.trigger === "reviewer") {
    triaged = await triageReviewerFindings(run, {
      pullRequestId: followUp.pullRequestId,
      url: followUp.url,
      repositoryId: followUp.repositoryId,
      repositoryFullName: followUp.repositoryFullName,
      baseSha: followUp.baseSha,
      headSha: followUp.headSha,
      reviewerName: reviewerName(followUp),
      findings: followUp.findings,
    });
    const kept = triaged.filter((finding) => finding.kept);
    description = renderPrFollowUpDescription({ description: input.workItem.description, followUp, kept });
    initialFindings = keptFindingLines(kept);
  }
  return await runChange(run, {
    description,
    primaryRepository: followUp.repositoryFullName,
    targets: () => ({
      kind: "pullRequest",
      repositoryId: followUp.repositoryId,
      repositoryFullName: followUp.repositoryFullName,
      url: followUp.url,
      setMembers: members,
    }),
    pinnedBaseOf: (slug, primary) => memberOf(slug)?.baseSha ?? (primary ? followUp.baseSha : null),
    startPoint: pullRequestStartPoint(followUp),
    targetsOpen: false,
    initialFindings,
    edges: (followUp.changeSet?.edges ?? []).map((edge) => ({ provider: edge.provider, consumer: edge.consumer })),
    pullRequest: {
      pullRequestId: followUp.pullRequestId,
      url: followUp.url,
      number: followUp.number,
      headBranch: followUp.headBranch,
      headSha: followUp.headSha,
      baseBranch: followUp.baseBranch,
      baseSha: followUp.baseSha,
      contractRevision: followUp.contractRevision,
      mergesBase: followUp.baseUpdate !== undefined,
      setMembers: members,
      proofPack: {
        contractRevision: followUp.contractRevision,
        trigger: followUp.trigger,
        startedBy: followUp.trigger === "base" ? followUp.baseBranch : followUp.trigger === "human" ? (followUp.reviewerLogin ?? "A human") : reviewerName(followUp),
        kept: triaged.filter((finding) => finding.kept).map((finding) => ({ evidence: finding.evidence, defect: finding.defect, rule: finding.rule })),
        dropped: triaged.filter((finding) => !finding.kept).length,
        plainComments: followUp.plainComments,
      },
    },
  });
};
