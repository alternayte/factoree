import { ApplicationFailure } from "@temporalio/workflow";
import type { Activities } from "~/activities/index.js";
import type { PrepareCheckSandboxActivityOutput } from "~/activities/sandbox.activities.js";
import type { BringCurrentMergeActivityOutput } from "~/activities/publishing.activities.js";
import type { UserValidateActivityOutput } from "~/activities/validation.activities.js";
import type { VerifyActivityOutput } from "~/activities/verification.activities.js";
import type { AgentRunProductRepositoryInput } from "~/domain/runs/product-repository.js";
import type { PrSetMember } from "~/domain/pull-requests/pr-follow-up.js";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import { buildRepositoryUrl } from "../../../domain/products/repository-url.js";
import { inSetOrder } from "../../../domain/routing/select-targets.js";
import { validationActivities } from "../activities.js";
import type { Run } from "../run.js";
import { runUserValidate } from "../sessions.js";
import { verify } from "./checks.js";
import { oneOffSpriteInput, prepareOneOffSprite } from "./one-off-sprite.js";

type Merged = Extract<BringCurrentMergeActivityOutput, { kind: "merged" }>;
type Adopted = NonNullable<Awaited<ReturnType<Activities["adoptValidationContract"]>>>;

/** A failed check of the clean merge. The story ends the Run with it, and the PR workflow starts a repair. */
export type CheckFailed = (reason: "VERIFICATION_FAILED" | "VALIDATION_FAILED" | "VALIDATION_UNRESOLVED", message: string, failure: string) => Promise<never>;

export interface MergeChecked {
  adopted: Adopted;
  sprite: PrepareCheckSandboxActivityOutput;
  verification: VerifyActivityOutput;
  replayed: UserValidateActivityOutput;
}

/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 4, D1, DI-21.117. Checks a clean merge of the base
 * with no agent: the run adopts the frozen contract of the verified head, verifies the merge in a
 * check sprite, and replays the passing Validation Plan. DI-21.161: the check sprite of a set holds
 * the merged target at the new base with the merge patch, each other open member at its verified
 * base with the diff to its head, and each merged one at its merge commit.
 */
export const checkMerge = async (
  run: Run,
  pullRequest: { url: string; baseBranch: string; contractRunId: string; edges: Array<{ provider: string; consumer: string }> },
  repository: AgentRunProductRepositoryInput,
  set: { members: PrSetMember[]; repositories: AgentRunProductRepositoryInput[] } | null,
  merged: Merged,
  checkFailed: CheckFailed,
): Promise<MergeChecked> => {
  const { input } = run;
  const { url, baseBranch } = pullRequest;
  const adopted = await validationActivities.adoptValidationContract({ tenantId: input.tenantId, runId: run.id, fromRunId: pullRequest.contractRunId });
  if (adopted === null) {
    return await checkFailed(
      "VALIDATION_UNRESOLVED",
      `The run of the verified head of ${url} holds no frozen Validation Contract, so Factoree cannot check the merge with no agent.`,
      "Factoree holds no frozen Validation Contract for the verified head, so it could not check the merge with no agent. Run every check on the merge.",
    );
  }
  run.control.validationContractVersion = adopted.sha256;
  if (adopted.automatedAssertions > 0 && !adopted.hasPlan) {
    await checkFailed(
      "VALIDATION_UNRESOLVED",
      `The run of the verified head of ${url} stored no passing Validation Plan, so Factoree cannot replay the contract with no agent.`,
      "Factoree holds no passing Validation Plan for the verified head, so it could not check the merge with no agent. Run every check on the merge.",
    );
  }

  const checkInput = { ...oneOffSpriteInput(run, repository, merged.baseSha), patchSha256: merged.patchSha256 };
  const setTargets =
    set === null
      ? null
      : inSetOrder(set.repositories).map((memberRepository) => {
          const member = set.members.find((candidate) => candidate.repositoryId === memberRepository.id);
          const merging = memberRepository.id === repository.id;
          return {
            repository: memberRepository.fullName,
            url: buildRepositoryUrl(input.product.repositoryBaseUrl, memberRepository.fullName),
            ref: merging ? merged.baseSha : (member?.baseSha ?? ""),
            githubInstallationId: memberRepository.githubInstallationId,
            ...(!merging && member?.state === "open" ? { pullRequestHead: member.headSha } : {}),
          };
        });
  const first = setTargets?.[0];
  const spriteInput =
    setTargets === null || first === undefined
      ? checkInput
      : { ...checkInput, primary: { url: first.url, ref: first.ref }, targets: setTargets, mergeRepository: repository.fullName };
  const sprite = await prepareOneOffSprite(
    run,
    { repositoryUrl: spriteInput.primary.url, ...(setTargets === null ? {} : { targetRepositoryUrls: setTargets.slice(1).map((target) => target.url) }) },
    (sandbox) => sandbox.prepareBringCurrentSandbox(spriteInput),
    `Factoree could not prepare the check sandbox of the merge of ${baseBranch} into ${url}.`,
  );
  run.checkSprite = sprite;
  if (run.stopped) await run.cancel();

  await run.enter("VERIFYING");
  const verification = await verify(run, sprite, 1);
  if (run.stopped) await run.cancel();
  if (!verification.passed) {
    await checkFailed(
      "VERIFICATION_FAILED",
      `Deterministic verification did not pass on the merge of ${baseBranch} into ${url}. ${verification.summary}`,
      [verification.summary, ...verification.failures].join("\n"),
    );
  }

  await run.enter("USER_VALIDATING");
  let replayed: UserValidateActivityOutput | null = null;
  try {
    replayed = await runUserValidate(run, { prepared: sprite, goal: adopted.goal, attempt: 1, forYourEye: [], edges: pullRequest.edges, replay: true });
  } catch (error) {
    await run.failFrom(error, "Factoree could not replay the Validation Plan on the merge.");
  }
  if (run.stopped) await run.cancel();
  if (replayed === null) {
    await run.ensureTime();
    throw ApplicationFailure.nonRetryable("the userValidate activity returned no result");
  }
  if (!replayed.passed) {
    await checkFailed(
      "VALIDATION_FAILED",
      `The replay of the frozen Validation Contract did not pass on the merge of ${baseBranch} into ${url}. ${replayed.summary}`,
      [replayed.summary, ...replayed.failures].join("\n"),
    );
  }
  return { adopted, sprite, verification, replayed };
};
