import { patched } from "@temporalio/workflow";
import type { HumanDecision, PrFollowUpInput, PrReviewFinding, TriagedFinding } from "~/domain/pull-requests/pr-follow-up.js";
import type { DecisionAnswer } from "~/domain/refinement/refiner-proposal.js";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import {
  answeredResponse,
  answersProgress,
  baseUpdateFindingLines,
  ciFindingLines,
  decisionPlace,
  findingPlace,
  followUpParts,
  keptFindingLines,
  renderPrFollowUpDescription,
} from "../../../domain/pull-requests/pr-follow-up.js";
import { activities, pullRequestReplyActivities } from "../activities.js";
import { notify } from "../failures.js";
import { PATCH } from "../patches.js";
import type { Run, RunEnding } from "../run.js";
import type { PrepareInput } from "../stages/preparation.js";
import { triageReviewerFindings } from "../stages/triage.js";
import type { HandledThreads } from "../stages/publication.js";
import { runChange, type ChangePlan } from "./change.js";
import { deployFailureFindings } from "./new-run.js";

/**
 * docs/specs/pr-review-merge-and-deploy.md. A PR follow-up run takes no Linear reply and no draft:
 * the pull request it follows is open already, and a review there starts the next one.
 */
export const prFollowUpEnding = (followUp: PrFollowUpInput): RunEnding => ({
  failureNote:
    `This PR follow-up run pushed no commit to ${followUp.url}. To start another one, mention Factoree on the pull request with what to change, ` +
    "request changes there, or reply here.",
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

/** The most source lines one greeting lists. The proof pack names the rest. */
const MAX_GREETING_LINES = 10;

const clipped = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
};

/**
 * docs/specs/pr-feedback-loop.md. The lines of the start post that name each source of the run: each
 * human decision with its place and link, each review app with its count of findings, and each
 * failed CI check with its link.
 */
const sourceLines = (followUp: PrFollowUpInput): string[] => {
  const parts = followUpParts(followUp);
  const lines = [
    ...parts.decisions.map(
      (decision) => `- ${decision.author} in ${decisionPlace(decision)}: ${clipped(decision.body, 160)}${decision.url === null ? "" : ` (${decision.url})`}`,
    ),
    ...[...new Set(parts.reviewAppFindings.map((finding) => finding.appSlug))].map((app) => {
      const count = parts.reviewAppFindings.filter((finding) => finding.appSlug === app).length;
      return `- Review app ${app}: ${String(count)} open ${count === 1 ? "finding" : "findings"} to triage.`;
    }),
    ...parts.ciFindings.map((finding) => `- CI check ${finding.name} failed (${finding.conclusion})${finding.detailsUrl === null ? "." : `: ${finding.detailsUrl}`}`),
  ];
  return lines.length <= MAX_GREETING_LINES ? lines : [...lines.slice(0, MAX_GREETING_LINES), `- ${String(lines.length - MAX_GREETING_LINES)} more.`];
};

/**
 * docs/specs/pr-feedback-loop.md. The one post in the agent session when a PR follow-up run starts:
 * what started it, who, and a link to each thread, check or reply it acts on.
 */
export const prFollowUpGreeting = (followUp: PrFollowUpInput): string => {
  if (followUp.trigger === "base") {
    return `Factoree could not bring ${followUp.url} current with ${followUp.baseBranch} on its own, so it started a PR follow-up run.`;
  }
  if (followUp.trigger === "reviewer") {
    return `The PR reviewer check failed on ${followUp.url}, so Factoree started a PR follow-up run. It triages the findings first.`;
  }
  const parts = followUpParts(followUp);
  const head =
    followUp.trigger === "human"
      ? `${deciders(followUp)} asked for a change on ${followUp.url}, so Factoree started a PR follow-up run. A human decision outranks every other request.`
      : `The reviews of ${followUp.url} settled, and ${automaticSources(followUp)} did not pass, so Factoree started a PR follow-up run.`;
  const triage = parts.reviewAppFindings.length === 0 ? [] : ["", "Factoree triages the review app findings first. It acts only on a finding that names a concrete defect, a rule and evidence."];
  return [head, "", ...sourceLines(followUp), ...triage].join("\n");
};

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

/** docs/specs/pr-feedback-loop.md. Each dropped review app finding with its place and the reason, for the proof pack. */
const droppedFindingsOf = (followUp: PrFollowUpInput, triaged: readonly TriagedFinding[]): Array<{ place: string; reason: string }> => {
  const parts = followUpParts(followUp);
  const findings = followUp.trigger === "reviewer" ? (followUp.findings ?? []) : parts.reviewAppFindings;
  const byKey = new Map(findings.map((finding) => [finding.key, finding]));
  return triaged
    .filter((finding) => !finding.kept)
    .map((finding) => {
      const source = byKey.get(finding.key);
      return { place: source === undefined ? "the pull request" : `${source.author} at ${findingPlace(source)}`, reason: finding.reason };
    });
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
  // docs/specs/pr-feedback-loop.md, DI-21.216. The threads the run handles: each kept review app
  // finding, and each human decision that asks for a change. The refiner stage drops the questions.
  const sourceFindings: Array<PrReviewFinding & { fingerprint?: string }> = followUp.trigger === "reviewer" ? (followUp.findings ?? []) : parts.reviewAppFindings;
  const findingByKey = new Map(sourceFindings.map((finding) => [finding.key, finding]));
  const keptFindings = triaged.filter((finding) => finding.kept);
  const handled: HandledThreads = {
    kept: keptFindings.flatMap((finding) => {
      const source = findingByKey.get(finding.key);
      return source === undefined ? [] : [{ finding: source, defect: finding.defect }];
    }),
    decisions: followUp.decisions ?? [],
  };
  const decisions = followUp.decisions ?? [];
  const answering = decisions.length > 0 && patched(PATCH.decisionAnswers);
  const decisionPlan: ChangePlan["decisions"] = !answering
    ? undefined
    : {
        lines: decisions.map((decision) => ({ key: decision.key, author: decision.author, place: decisionPlace(decision), body: decision.body })),
        afterRefiner: async (answers) => {
          const questions = questionsOf(decisions, answers);
          const asked = new Set(questions.map(({ decision }) => decision.key));
          handled.decisions = decisions.filter((decision) => !asked.has(decision.key));
          if (questions.length === 0) return;
          await notify(() => pullRequestReplyActivities.answerHumanDecisions({ tenantId: input.tenantId, pullRequestId: followUp.pullRequestId, answers: questions }));
          // DI-21.215. Questions only, and nothing else to repair: the run answered, and it pushes nothing.
          const nothingElse =
            handled.decisions.length === 0 && keptFindings.length === 0 && parts.ciFindings.length === 0 && followUp.baseUpdate === undefined && deployFailureFindings(input).length === 0;
          if (nothingElse) return await run.answer(answeredResponse(followUp.url, questions));
          await run.progress(answersProgress(followUp.url, questions));
        },
      };
  return await runChange(run, {
    ...(decisionPlan === undefined ? {} : { decisions: decisionPlan }),
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
      ...(patched(PATCH.handledThreadReplies) ? { handled } : {}),
      proofPack: {
        contractRevision: followUp.contractRevision,
        trigger: followUp.trigger,
        startedBy: followUp.trigger === "base" ? followUp.baseBranch : followUp.trigger === "human" ? deciders(followUp) : automaticSources(followUp),
        kept: triaged.filter((finding) => finding.kept).map((finding) => ({ evidence: finding.evidence, defect: finding.defect, rule: finding.rule })),
        dropped: triaged.filter((finding) => !finding.kept).length,
        droppedFindings: droppedFindingsOf(followUp, triaged),
        ...(parts.ciFindings.length === 0 ? {} : { ciFailures: parts.ciFindings.map((finding) => finding.name) }),
      },
    },
  });
};

/**
 * DI-21.215. The human decisions the refiner read as questions, each with its answer, in the order of
 * the decisions. A decision with no answer, or a change request, is not a question.
 */
export const questionsOf = (decisions: readonly HumanDecision[], answers: readonly DecisionAnswer[]): Array<{ decision: HumanDecision; answer: string }> => {
  const byKey = new Map(answers.map((answer) => [answer.key, answer]));
  return decisions.flatMap((decision) => {
    const answer = byKey.get(decision.key);
    return answer === undefined || answer.changeRequested || answer.answer.trim() === "" ? [] : [{ decision, answer: answer.answer }];
  });
};
