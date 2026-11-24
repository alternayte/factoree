import type { PrFollowUpInput, TriagedFinding } from "~/domain/pull-requests/pr-follow-up.js";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import {
  baseUpdateFindingLines,
  ciFindingLines,
  decisionPlace,
  findingPlace,
  followUpParts,
  keptFindingLines,
  renderPrFollowUpDescription,
} from "../../../domain/pull-requests/pr-follow-up.js";
import { activities } from "../activities.js";
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
    `This PR follow-up run pushed nothing to ${followUp.url}. Mention Factoree on the pull request with what to change, ` +
    "request changes there, or reply here, to start another PR follow-up run.",
  draftOnInternalError: false,
});

/** The names of the review apps and the CI checks of an automatic run, for the greeting and the proof pack. */
const automaticSources = (followUp: PrFollowUpInput): string => {
  if (followUp.trigger === "reviewer") return reviewerName(followUp);
  const parts = followUpParts(followUp);
  const names = [...new Set(parts.reviewAppFindings.map((finding) => finding.appSlug)), ...parts.ciFindings.map((finding) => finding.name)];
  return names.length === 0 ? "The review apps" : names.join(", ");
};

/** The humans whose decisions started a run. */
const deciders = (followUp: PrFollowUpInput): string => {
  const names = [...new Set(followUpParts(followUp).decisions.map((decision) => decision.author))];
  return names.length === 0 ? (followUp.reviewerLogin ?? "A human") : names.join(", ");
};

export const prFollowUpGreeting = (followUp: PrFollowUpInput): string =>
  followUp.trigger === "human"
    ? `${deciders(followUp)} asked for changes on ${followUp.url}, so Factoree started a PR follow-up run.`
    : followUp.trigger === "base"
      ? `Factoree could not bring ${followUp.url} current with ${followUp.baseBranch} on its own, so it started a PR follow-up run.`
      : followUp.trigger === "reviewer"
        ? `The PR reviewer check failed on ${followUp.url}, so Factoree started a PR follow-up run. It triages the findings first.`
        : `${automaticSources(followUp)} found problems on ${followUp.url}, so Factoree started a PR follow-up run.` +
          (followUpParts(followUp).reviewAppFindings.length === 0 ? "" : " It triages the review app findings first.");

/**
 * DI-19.04. A human review is a decision, as a Linear reply is, so the implementer follows it.
 * docs/specs/pr-feedback-loop.md: every human decision of the run is one.
 */
export const humanReviewInput = (followUp: PrFollowUpInput): string | null => {
  if (followUp.trigger !== "human") return null;
  if (followUp.decisions === undefined) {
    return [
      `${followUp.reviewerLogin ?? "A human"} requested changes on the pull request ${followUp.url}:`,
      ...(followUp.findings ?? []).map((finding) => `- ${findingPlace(finding)}: ${finding.body}`),
    ].join("\n");
  }
  return [
    `Humans decided on the pull request ${followUp.url}:`,
    ...followUp.decisions.map((decision) => `- ${decision.author} (${decisionPlace(decision)}): ${decision.body}`),
  ].join("\n");
};

const reviewerName = (followUp: PrFollowUpInput): string =>
  followUp.reviewer === undefined || followUp.reviewer === null ? "PR reviewer" : `${followUp.reviewer.appSlug} (${followUp.reviewer.checkName})`;

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
  const parts = followUpParts(followUp);
  let triaged: TriagedFinding[] = [];
  let description = followUp.trigger === "reviewer" ? input.workItem.description : renderPrFollowUpDescription({ description: input.workItem.description, followUp, kept: [] });
  let initialFindings = [
    ...(followUp.baseUpdate === undefined ? [] : baseUpdateFindingLines(followUp.baseUpdate)),
    ...deployFailureFindings(input),
    ...ciFindingLines(parts.ciFindings),
  ];
  // A reviewer run of an open history triages always, as it did before the review apps.
  if (followUp.trigger === "reviewer" || parts.reviewAppFindings.length > 0) {
    // docs/specs/pr-feedback-loop.md, DI-21.210. A run with failed CI checks or human decisions goes
    // on when the triage keeps nothing. Only an automatic run counts toward the limit.
    const legacy = followUp.trigger === "reviewer";
    triaged = await triageReviewerFindings(
      run,
      {
        pullRequestId: followUp.pullRequestId,
        url: followUp.url,
        repositoryId: followUp.repositoryId,
        repositoryFullName: followUp.repositoryFullName,
        baseSha: followUp.baseSha,
        headSha: followUp.headSha,
        reviewerName: legacy ? reviewerName(followUp) : [...new Set(parts.reviewAppFindings.map((finding) => finding.appSlug))].join(", "),
        findings: legacy ? (followUp.findings ?? []) : parts.reviewAppFindings,
      },
      legacy ? undefined : { endWhenNothingKept: followUp.trigger === "automatic" && parts.ciFindings.length === 0, count: followUp.trigger === "automatic" },
    );
    const kept = triaged.filter((finding) => finding.kept);
    description = renderPrFollowUpDescription({ description: input.workItem.description, followUp, kept });
    initialFindings = [...initialFindings, ...keptFindingLines(kept)];
  }
  // DI-21.210. An automatic run with failed CI checks counts once, by its run id, whatever the triage kept.
  if (followUp.trigger === "automatic" && parts.ciFindings.length > 0) {
    await activities.countReviewerFollowUp({ tenantId: input.tenantId, pullRequestId: followUp.pullRequestId, runId: run.id });
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
        startedBy: followUp.trigger === "base" ? followUp.baseBranch : followUp.trigger === "human" ? deciders(followUp) : automaticSources(followUp),
        kept: triaged.filter((finding) => finding.kept).map((finding) => ({ evidence: finding.evidence, defect: finding.defect, rule: finding.rule })),
        dropped: triaged.filter((finding) => !finding.kept).length,
        plainComments: followUp.plainComments ?? [],
        ...(parts.ciFindings.length === 0 ? {} : { ciFailures: parts.ciFindings.map((finding) => finding.name) }),
      },
    },
  });
};
