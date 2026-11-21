import { isCancellation } from "@temporalio/workflow";
import type { BringCurrentMergeActivityOutput, PushBringCurrentMergeActivityOutput } from "~/activities/publishing.activities.js";
import type { BringCurrentInput, BringCurrentOutcome } from "~/domain/pull-requests/bring-current.js";
import type { AgentRunProductRepositoryInput } from "~/domain/runs/product-repository.js";
import { activities, bringCurrentActivities } from "../activities.js";
import { isConfigurationFault, notify, publicationFailureReasonOf, withCause } from "../failures.js";
import { RunEnded, type Run, type RunEnding } from "../run.js";
import { checkMerge } from "../stages/merge-check.js";
import { isMember } from "../../../domain/products/membership.js";

export const bringCurrentEnding = (update: BringCurrentInput): RunEnding => ({
  failureNote: `This bring-current run pushed nothing to ${update.url}.`,
  draftOnInternalError: true,
});

export const bringCurrentGreeting = (update: BringCurrentInput): string =>
  update.reason === "conflict"
    ? `${update.url} conflicts with ${update.baseBranch}, so Factoree brings it current. It merges the base and checks the merge with no agent.`
    : `${update.baseBranch} requires ${update.url} to be up to date before the merge, so Factoree brings it current. It merges the base and checks the merge with no agent.`;

/** Ends the Run through `end`, and names what the bring-current run did. The PR workflow reads it. */
const withOutcome = async (end: Promise<never>, outcome: BringCurrentOutcome): Promise<never> => {
  try {
    return await end;
  } catch (error) {
    if (error instanceof RunEnded && error.result.bringCurrent === undefined) error.result = { ...error.result, bringCurrent: outcome };
    throw error;
  }
};

/** A merge or a push that failed. A configuration fault ends FAILED_CONFIGURATION. */
const failMergeStep = async (run: Run, error: unknown, configurationSentence: string, sentence: string): Promise<never> => {
  if (isCancellation(error)) throw error;
  if (isConfigurationFault(error)) await run.fail("CONFIGURATION_INVALID", withCause(configurationSentence, error));
  return await run.fail(publicationFailureReasonOf(error), withCause(sentence, error));
};

/** DI-21.161. The other members of a set join the check sprite, so the run records each as a target. */
const recordTargets = async (run: Run, update: BringCurrentInput, repository: AgentRunProductRepositoryInput): Promise<AgentRunProductRepositoryInput[] | null> => {
  const { input } = run;
  await activities.recordRunTarget({ tenantId: input.tenantId, runId: run.id, repositoryId: repository.id, selectionReason: `the repository of ${update.url}` });
  const members = update.changeSet?.members ?? null;
  if (members === null) return null;
  const repositories: AgentRunProductRepositoryInput[] = [];
  for (const member of members) {
    const memberRepository = input.product.repositories.find((candidate) => candidate.id === member.repositoryId);
    if (memberRepository === undefined || !isMember(memberRepository)) {
      return await run.fail(
        "TARGET_UNRESOLVED",
        `The repository ${member.repositoryFullName} of ${member.url} is no longer part of this product, so Factoree cannot check the change set of ${update.url}.`,
      );
    }
    repositories.push(memberRepository);
    if (memberRepository.id !== repository.id) {
      await activities.recordRunTarget({ tenantId: input.tenantId, runId: run.id, repositoryId: memberRepository.id, selectionReason: `the change set of ${update.url}` });
    }
  }
  return repositories;
};

/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 4, D1, DI-21.117. A bring-current run merges the
 * base into the verified head on Factoree's trusted checkout, checks the merge in a check sprite
 * against the frozen contract with no agent, and pushes the merge commit only after both pass. It
 * takes a run slot and its sandbox slots like any run. A conflict or a failed check pushes nothing,
 * and the PR workflow starts a PR follow-up run with it as a finding.
 */
export const bringCurrentRun = async (run: Run, update: BringCurrentInput): Promise<never> => {
  try {
    return await bringCurrent(run, update);
  } catch (error) {
    if (error instanceof RunEnded && error.result.bringCurrent === undefined) error.result = { ...error.result, bringCurrent: { kind: "ended" } };
    throw error;
  }
};

const bringCurrent = async (run: Run, update: BringCurrentInput): Promise<never> => {
  const { input } = run;
  const short = (sha: string) => sha.slice(0, 12);
  await run.ensureTime();
  await run.waitForRunSlot();
  await run.enter("PREPARING");
  const repository = input.product.repositories.find((candidate) => candidate.id === update.repositoryId);
  if (repository === undefined) {
    return await run.fail(
      "TARGET_UNRESOLVED",
      `The repository ${update.repositoryFullName} of ${update.url} is no longer part of this product, so Factoree cannot bring it current.`,
    );
  }
  const setRepositories = await recordTargets(run, update, repository);
  const mergeInput = {
    runId: run.id,
    tenantId: input.tenantId,
    productId: input.productId,
    repositorySlug: repository.fullName,
    repositoryBaseUrl: input.product.repositoryBaseUrl,
    githubInstallationId: repository.githubInstallationId,
    branch: update.headBranch,
    pullRequestNumber: update.number,
    pullRequestUrl: update.url,
    headSha: update.headSha,
    baseBranch: update.baseBranch,
    contractRevision: update.contractRevision,
  };
  let merge: BringCurrentMergeActivityOutput;
  try {
    merge = await bringCurrentActivities.mergeBaseIntoPullRequest(mergeInput);
  } catch (error) {
    return await failMergeStep(
      run,
      error,
      `Factoree could not merge ${update.baseBranch} into ${update.url}.`,
      `Factoree could not merge ${update.baseBranch} into ${update.url} on its trusted checkout.`,
    );
  }
  if (merge.kind === "current") {
    return await withOutcome(run.report(`${update.url} holds ${update.baseBranch} at ${short(merge.baseSha)} already, so Factoree changed nothing.`), { kind: "current" });
  }
  const moved = (when: string, did: string) =>
    withOutcome(run.report(`The branch of ${update.url} moved ${when}, so Factoree ${did}. The new head gets its own checks.`), { kind: "moved" });
  if (merge.kind === "moved") return await moved("since Factoree read it", "did not bring it current");
  if (merge.kind === "conflict") {
    const files = merge.conflicts;
    return await withOutcome(
      run.report(
        [
          "## Bring current",
          "",
          `The merge of ${update.baseBranch} at ${short(merge.baseSha)} into ${update.url} conflicts in ` +
            `${String(files.length)} ${files.length === 1 ? "file" : "files"}, so Factoree pushed nothing. ` +
            "It starts a PR follow-up run that resolves the conflict.",
          "",
          ...files.slice(0, 20).map((file) => `- ${file}`),
          ...(files.length > 20 ? [`- ${String(files.length - 20)} more files`] : []),
        ].join("\n"),
      ),
      { kind: "conflict", baseSha: merge.baseSha, conflicts: files },
    );
  }
  const merged = merge;
  const members = update.changeSet?.members ?? null;
  const { adopted, sprite, verification, replayed } = await checkMerge(
    run,
    { url: update.url, baseBranch: update.baseBranch, contractRunId: update.contractRunId, edges: (update.changeSet?.edges ?? []).map((edge) => ({ provider: edge.provider, consumer: edge.consumer })) },
    repository,
    members === null || setRepositories === null ? null : { members, repositories: setRepositories },
    merged,
    (reason, message, failure) =>
      withOutcome(run.fail(reason, `${message} Factoree starts a PR follow-up run that repairs it.`), { kind: "failed", baseSha: merged.baseSha, failure }),
  );

  await run.enter("PUBLISHING");
  if (run.stopped) await run.cancel();
  let pushed: PushBringCurrentMergeActivityOutput;
  try {
    // DI-21.161. The check sprite of a set proved the merge patch of its target, and names the set by the set patch hash.
    pushed = await bringCurrentActivities.pushBringCurrentMerge({
      ...mergeInput,
      baseSha: merged.baseSha,
      verifiedPatchSha256: setRepositories === null ? sprite.patchSha256 : merged.patchSha256,
    });
  } catch (error) {
    const sentence = `Factoree could not push the merge commit to ${update.url}.`;
    return await failMergeStep(run, error, sentence, sentence);
  }
  if (pushed.kind === "moved") return await moved("while Factoree checked the merge", "pushed nothing");
  run.publishedPullRequestUrls.push(update.url);
  await activities.recordRunTargetFacts({
    tenantId: input.tenantId,
    runId: run.id,
    repositoryId: repository.id,
    baseSha: merged.baseSha,
    patchSha256: pushed.patchSha256,
    commitSha: pushed.commitSha,
    pullRequestUrl: update.url,
  });
  // DI-21.104, D2. The merge commit is the verified head, and the new base is its base. The level
  // and the contract revision of the head stay, because the contract did not change.
  await activities.recordPullRequest({
    tenantId: input.tenantId,
    runId: run.id,
    repositoryId: repository.id,
    number: update.number,
    url: update.url,
    headBranch: update.headBranch,
    headSha: pushed.commitSha,
    baseBranch: update.baseBranch,
    autonomyLevel: update.autonomyLevel,
    baseSha: merged.baseSha,
    contractRevision: update.contractRevision,
  });
  // docs/specs/change-sets.md, slice 9. The merge commit is a head Factoree pushed after a set check,
  // so each consumer status of the set is set again from it.
  if (members !== null) await notify(() => activities.setChangeSetStatuses({ tenantId: input.tenantId, pullRequestId: update.pullRequestId }));
  return await withOutcome(
    run.report(
      [
        "## Bring current",
        "",
        `Factoree merged ${update.baseBranch} at ${short(merged.baseSha)} into ${update.url} and pushed the merge commit ` +
          `${short(pushed.commitSha)}. It did not force-push.`,
        "",
        `- Verified patch: ${pushed.patchSha256}, the diff from the new base to the merge.`,
        `- Verification: ${verification.summary}`,
        `- Validation Contract ${short(adopted.sha256)} (contract revision ${String(update.contractRevision)}), replayed with no agent: ${replayed.summary}`,
      ].join("\n"),
    ),
    { kind: "pushed", commitSha: pushed.commitSha, baseSha: merged.baseSha },
  );
};
