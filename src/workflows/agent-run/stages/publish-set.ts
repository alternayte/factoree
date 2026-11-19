import { isCancellation } from "@temporalio/workflow";
import type { PrepareCheckSandboxActivityOutput } from "~/activities/sandbox.activities.js";
import type { PublishActivityOutput } from "~/activities/publishing.activities.js";
import type { PrSetMember } from "~/domain/pull-requests/pr-follow-up.js";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import { withCauseText } from "../../../domain/runs/failure-cause.js";
import { publishingActivities } from "../activities.js";
import { causeOf, isConfigurationFault, publicationFailureReasonOf, withCause } from "../failures.js";
import type { Run } from "../run.js";
import { defaultBranchOf, type TargetBase } from "./context.js";

/** docs/specs/change-sets.md, slice 7. One target whose pull request opened or took a commit. */
export interface PublishedTarget {
  repositoryId: string;
  slug: string;
  installationId: string;
  baseBranch: string;
  baseSha: string;
  publication: PublishActivityOutput;
}

/** The facts every set publication carries into each pull request. */
export interface SetPublicationFacts {
  draft: boolean;
  /** The set tree the review examined. */
  worktreeSha: string;
  verificationSummary: string;
  repairCount: number;
  edges: Array<{ provider: string; consumer: string }>;
}

type CheckedTarget = NonNullable<PrepareCheckSandboxActivityOutput["checkedTargets"]>[number];
interface Entry {
  fact: CheckedTarget;
  member: PrSetMember | null;
  repositoryId: string;
  slug: string;
  installationId: string;
  baseBranch: string;
}

/** The words a set publication uses for what it checked and what a failure left. */
interface SetWords {
  subject: "repository" | "pull request";
  nothing: "opened no pull request" | "pushed nothing";
  everything: string;
  done: "published" | "pushed";
}

/**
 * DI-21.151. Matches each checked target of the check sprite to its run target, and checks every
 * target before any push. A target with no verified patch, or a preflight that fails, ends the Run
 * with nothing published.
 */
const preflight = async (
  run: Run,
  checked: PrepareCheckSandboxActivityOutput,
  bases: TargetBase[],
  facts: SetPublicationFacts,
  members: PrSetMember[] | null,
  words: SetWords,
) => {
  const memberOf = (slug: string) => members?.find((member) => member.repositoryFullName.toLowerCase() === slug.toLowerCase()) ?? null;
  const entries: Entry[] = (checked.checkedTargets ?? []).map((fact) => {
    const target = bases.find((candidate) => candidate.fullName.toLowerCase() === fact.repository.toLowerCase());
    const slug = target?.fullName ?? fact.repository;
    const member = memberOf(fact.repository);
    return { fact, member, repositoryId: target?.id ?? "", slug, installationId: target?.githubInstallationId ?? "", baseBranch: member?.baseBranch ?? defaultBranchOf(run, slug) };
  });
  const missing = bases.filter((target) => !entries.some((entry) => entry.repositoryId === target.id));
  if (missing.length > 0 || entries.some((entry) => entry.repositoryId === "" || (members !== null && entry.member === null))) {
    await run.fail(
      "COMPLETION_INVARIANT_UNMET",
      `The check sandbox holds no verified patch of ${missing.map((target) => target.fullName).join(", ") || words.everything}, so Factoree ${words.done} nothing.`,
    );
  }
  const checkedEvery = `Factoree checked every ${words.subject} of the change set before any push, and`;
  try {
    const result = await publishingActivities.preflightChangeSet({
      runId: run.id,
      tenantId: run.input.tenantId,
      productId: run.input.productId,
      spriteId: checked.spriteId,
      adapter: checked.adapter,
      workspacePath: checked.workspacePath,
      repositoryBaseUrl: run.input.product.repositoryBaseUrl,
      targets: entries.map((entry) => ({
        repositorySlug: entry.slug,
        githubInstallationId: entry.installationId,
        primaryPath: entry.fact.path,
        baseBranch: entry.baseBranch,
        baseSha: entry.fact.baseSha,
        verifiedPatchSha256: entry.fact.patchSha256,
        reviewedChangedFiles: entry.fact.changedFiles,
        reviewedWorktreeSha: entry.fact.treeSha,
      })),
      verifiedSetPatchSha256: checked.patchSha256,
      reviewedSetTreeSha: facts.worktreeSha,
    });
    const changed = (entry: Entry) => result.targets.some((target) => target.repositorySlug === entry.slug && target.changed);
    return { entries, result, changed };
  } catch (error) {
    if (isCancellation(error)) throw error;
    if (run.stopped) await run.cancel();
    if (isConfigurationFault(error)) {
      await run.fail(
        "CONFIGURATION_INVALID",
        withCause(
          `${checkedEvery} the GitHub App installation cannot mint the write credential one of them needs, so it ${words.nothing}. ` +
            "Repair the installation or its permissions as the cause says.",
          error,
        ),
      );
    }
    return await run.fail(publicationFailureReasonOf(error), withCause(`${checkedEvery} one check failed, so it ${words.nothing}.`, error));
  }
};

export interface SetPublication {
  published: PublishedTarget[];
  unchanged: Array<{ slug: string; baseSha: string }>;
  /** DI-21.162. The open pull requests a set PR follow-up run checked and changed nothing on. */
  checkedHeads: Array<{ member: PrSetMember; baseSha: string }>;
}

/**
 * docs/specs/change-sets.md, slice 7. A change set publishes all or nothing: the preflight of every
 * target, then each push and pull request in set order, then each body with the sibling links
 * (DI-21.152). A permanent failure after the preflight undoes every pull request that opened
 * (DI-21.153). A moved base never stops a target: its three-way apply check reports the move.
 */
export const publishChangeSet = async (
  run: Run,
  checked: PrepareCheckSandboxActivityOutput,
  bases: TargetBase[],
  facts: SetPublicationFacts,
): Promise<SetPublication> => {
  const { input } = run;
  const words: SetWords = { subject: "repository", nothing: "opened no pull request", everything: "every target", done: "published" };
  const set = await preflight(run, checked, bases, facts, null, words);
  const changed = set.entries.filter(set.changed);
  const unchanged = set.entries.filter((entry) => !changed.includes(entry)).map((entry) => ({ slug: entry.slug, baseSha: entry.fact.baseSha }));
  if (changed.length === 0) {
    return await run.fail("EMPTY_PATCH", "Every check passed and no repository of the change set holds a change, so Factoree had nothing to publish.");
  }
  const names = changed.map((entry) => entry.slug);
  // DI-21.153. The rollback looks up the run's own branch in each target, so it also finds a pull
  // request that a failed attempt opened before it could answer.
  const undo = async (failed: string, error: unknown): Promise<never> => {
    if (isCancellation(error)) throw error;
    const cause = causeOf(error);
    let undone: string;
    try {
      const rolled = await publishingActivities.rollbackChangeSet({
        runId: run.id,
        tenantId: input.tenantId,
        productId: input.productId,
        targets: changed.map((entry) => ({ repositorySlug: entry.slug, githubInstallationId: entry.installationId })),
        failedRepository: failed,
        cause: cause === "" ? "an unknown error" : cause,
      });
      undone =
        rolled.closed.length === 0
          ? "No pull request had opened."
          : `Factoree closed ${rolled.closed.map((entry) => entry.url).join(", ")} with a comment that names ${failed}, and deleted the branches.`;
    } catch (rollbackError) {
      if (isCancellation(rollbackError)) throw rollbackError;
      undone = withCause("Factoree could not close every pull request it had opened. Close them by hand.", rollbackError);
    }
    return await run.fail(
      "PUBLICATION_FAILED",
      withCauseText(`The publication of ${failed} failed, so Factoree published no part of the change set ${names.join(", ")}. ${undone}`, cause),
    );
  };
  const published: PublishedTarget[] = [];
  for (const entry of changed) {
    let publication: PublishActivityOutput;
    try {
      publication = await publishingActivities.publish({
        runId: run.id,
        tenantId: input.tenantId,
        productId: input.productId,
        spriteId: checked.spriteId,
        adapter: checked.adapter,
        workspacePath: checked.workspacePath,
        primaryPath: entry.fact.path,
        verifiedPatchSha256: entry.fact.patchSha256,
        draft: facts.draft,
        repositorySlug: entry.slug,
        repositoryBaseUrl: input.product.repositoryBaseUrl,
        baseBranch: entry.baseBranch,
        baseSha: entry.fact.baseSha,
        reviewedChangedFiles: entry.fact.changedFiles,
        reviewedWorktreeSha: entry.fact.treeSha,
        workItemTitle: input.workItem.title,
        workItemUrl: input.workItem.url,
        verificationSummary: facts.verificationSummary,
        repairCount: facts.repairCount,
        githubInstallationId: entry.installationId,
        changeSetRepositories: names,
      });
    } catch (error) {
      return await undo(entry.slug, error);
    }
    published.push({ repositoryId: entry.repositoryId, slug: entry.slug, installationId: entry.installationId, baseBranch: entry.baseBranch, baseSha: entry.fact.baseSha, publication });
  }
  const pullRequests = published.map((target) => ({ repository: target.slug, url: target.publication.pullRequestUrl }));
  for (const target of published) {
    try {
      await publishingActivities.writeChangeSetBody({
        runId: run.id,
        tenantId: input.tenantId,
        productId: input.productId,
        repositorySlug: target.slug,
        githubInstallationId: target.installationId,
        pullRequestNumber: target.publication.pullRequestNumber,
        baseSha: target.baseSha,
        patchSha256: target.publication.patchSha256,
        changedFileCount: set.result.targets.find((entry) => entry.repositorySlug === target.slug)?.changedFiles.length ?? 0,
        workItemTitle: input.workItem.title,
        workItemUrl: input.workItem.url,
        verificationSummary: facts.verificationSummary,
        repairCount: facts.repairCount,
        pullRequests,
        edges: facts.edges,
      });
    } catch (error) {
      return await undo(target.slug, error);
    }
  }
  return { published, unchanged, checkedHeads: [] };
};

/**
 * docs/specs/change-sets.md, slice 9, DI-21.162. A set PR follow-up run pushes one new verified
 * commit to each open pull request of the set that changed, with the head the run read as its
 * parent. A merged pull request takes no commit, so a change to it fails the run. A push cannot be
 * undone without a force, so a later failure names the pull requests that took a commit.
 */
export const publishSetFollowUp = async (
  run: Run,
  checked: PrepareCheckSandboxActivityOutput,
  bases: TargetBase[],
  facts: SetPublicationFacts,
  pullRequest: { pullRequestId: string; mergesBase: boolean; members: PrSetMember[] },
): Promise<SetPublication> => {
  const words: SetWords = { subject: "pull request", nothing: "pushed nothing", everything: "every pull request of the change set", done: "pushed" };
  const set = await preflight(run, checked, bases, facts, pullRequest.members, words);
  const changedMerged = set.entries.filter((entry) => entry.member?.state === "merged" && set.changed(entry));
  if (changedMerged.length > 0) {
    return await run.fail(
      "PUBLICATION_FAILED",
      `The change touches ${changedMerged.map((entry) => `${entry.slug} (${entry.member?.url ?? ""})`).join(", ")}, whose pull request merged already. ` +
        "A merged pull request takes no new commit, so Factoree pushed nothing. A change to it needs a new issue.",
    );
  }
  const outcome: SetPublication = { published: [], unchanged: [], checkedHeads: [] };
  for (const entry of set.entries) {
    const member = entry.member;
    if (member === null) continue;
    if (member.state === "merged") {
      outcome.unchanged.push({ slug: entry.slug, baseSha: entry.fact.baseSha });
      continue;
    }
    const merges = pullRequest.mergesBase && member.pullRequestId === pullRequest.pullRequestId;
    try {
      const pushed = await publishingActivities.publishFollowUp({
        runId: run.id,
        tenantId: run.input.tenantId,
        productId: run.input.productId,
        spriteId: checked.spriteId,
        adapter: checked.adapter,
        workspacePath: checked.workspacePath,
        primaryPath: entry.fact.path,
        verifiedPatchSha256: entry.fact.patchSha256,
        repositorySlug: entry.slug,
        repositoryBaseUrl: run.input.product.repositoryBaseUrl,
        baseBranch: member.baseBranch,
        baseSha: entry.fact.baseSha,
        reviewedChangedFiles: entry.fact.changedFiles,
        reviewedWorktreeSha: entry.fact.treeSha,
        workItemTitle: run.input.workItem.title,
        workItemUrl: run.input.workItem.url,
        verificationSummary: facts.verificationSummary,
        repairCount: facts.repairCount,
        githubInstallationId: entry.installationId,
        branch: member.headBranch,
        parentSha: member.headSha,
        // Slice 4, DI-21.119. The commit merges the new base into the branch it brings current.
        ...(merges ? { mergeParentSha: member.baseSha } : {}),
        pullRequestUrl: member.url,
        pullRequestNumber: member.number,
        contractRevision: member.contractRevision + 1,
        allowUnchanged: true,
      });
      if (pushed.unchanged === true) {
        outcome.unchanged.push({ slug: entry.slug, baseSha: entry.fact.baseSha });
        outcome.checkedHeads.push({ member, baseSha: entry.fact.baseSha });
        continue;
      }
      outcome.published.push({
        repositoryId: entry.repositoryId,
        slug: entry.slug,
        installationId: entry.installationId,
        baseBranch: member.baseBranch,
        baseSha: entry.fact.baseSha,
        publication: { ...pushed, pullRequestUrl: member.url, pullRequestNumber: member.number, branch: member.headBranch, created: false },
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
      const pushedLine =
        outcome.published.length === 0
          ? "No pull request of the set took a commit."
          : `${outcome.published.map((target) => target.publication.pullRequestUrl).join(", ")} took a new commit that no verified head records, so its merge-order status turns to failure until a new set run.`;
      return await run.fail(
        isConfigurationFault(error) ? "CONFIGURATION_INVALID" : publicationFailureReasonOf(error),
        withCause(`The push to ${member.url} failed. ${pushedLine}`, error),
      );
    }
  }
  if (outcome.published.length === 0) {
    return await run.fail(
      "PUBLICATION_FAILED",
      `Every check passed and the run changed no pull request of the change set ${pullRequest.members.map((member) => member.url).join(", ")}, so Factoree pushed nothing.`,
    );
  }
  return outcome;
};
