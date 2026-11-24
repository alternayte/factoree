import { CancellationScope } from "@temporalio/workflow";
import type { TriageActivityOutput } from "~/activities/review.activities.js";
import type { PrReviewFinding, TriagedFinding } from "~/domain/pull-requests/pr-follow-up.js";
import { activities, buildSessionActivities, cancelActivities, pullRequestReplyActivities } from "../activities.js";
import { notify } from "../failures.js";
import type { Run } from "../run.js";
import { failHung, failProviderUnreachable, hangOf, providerUnreachableOf, runSession, spriteOf } from "../sessions.js";
import { oneOffSpriteInput, prepareOneOffSprite } from "./one-off-sprite.js";

/** The review app findings a triage reads (a failed PR reviewer check in a history from before the review apps). */
export interface ReviewerCheck {
  pullRequestId: string;
  url: string;
  repositoryId: string;
  repositoryFullName: string;
  baseSha: string;
  headSha: string;
  reviewerName: string;
  findings: PrReviewFinding[];
}

/**
 * docs/specs/pr-review-merge-and-deploy.md, DI-21.110. A fresh reviewer session in a check sprite of
 * the pull request head keeps only the findings with a concrete defect, a rule and evidence.
 * Factoree replies on the pull request to each dropped finding. A triage that keeps nothing ends the
 * Run with no change, and it does not count toward the limit. It answers every triaged finding.
 */
export interface TriageOptions {
  /**
   * docs/specs/pr-feedback-loop.md, DI-21.210. A triage that keeps nothing ends the run with no
   * change. A run that also carries failed CI checks or human decisions goes on.
   */
  endWhenNothingKept: boolean;
  /** Only an automatic run counts toward the product limit of automatic follow-up runs. */
  count: boolean;
}

export const triageReviewerFindings = async (
  run: Run,
  check: ReviewerCheck,
  options: TriageOptions = { endWhenNothingKept: true, count: true },
): Promise<TriagedFinding[]> => {
  const { input } = run;
  await run.ensureTime();
  await run.waitForRunSlot();
  await run.enter("REVIEWING");
  const repository = input.product.repositories.find((candidate) => candidate.id === check.repositoryId);
  if (repository === undefined) {
    return await run.fail(
      "TARGET_UNRESOLVED",
      `The repository ${check.repositoryFullName} of ${check.url} is no longer part of this product, so Factoree cannot triage its review.`,
    );
  }
  const spriteInput = { ...oneOffSpriteInput(run, repository, check.baseSha), pullRequestHead: check.headSha };
  const sprite = await prepareOneOffSprite(
    run,
    { repositoryUrl: spriteInput.primary.url },
    (sandbox) => sandbox.prepareTriageSandbox(spriteInput),
    `Factoree could not prepare the check sandbox of the pull request head of ${check.url}.`,
  );
  let triage: TriageActivityOutput | null = null;
  try {
    triage = await runSession(run, "reviewer", (afterHang, unreachableRetry) =>
      run.agentActivity(() =>
        buildSessionActivities(run.remainingMs()).triagePullRequestFindings({
          runId: run.id,
          tenantId: input.tenantId,
          productId: input.productId,
          runnerName: sprite.runtime.reviewerRunner,
          ...spriteOf(sprite),
          baseSha: sprite.baseSha,
          pullRequestUrl: check.url,
          reviewerName: check.reviewerName,
          findings: check.findings,
          repositoryInstructions: sprite.repositoryInstructions,
          timeoutMs: run.remainingMs(),
          ...(afterHang ? { afterHang: true } : {}),
          ...(unreachableRetry > 0 ? { unreachableRetry } : {}),
        }),
      ),
    );
  } catch (error) {
    await run.failFrom(error, "Factoree could not start the triage session. Repair the reviewer runner on the product page.");
  } finally {
    // The triage sprite serves the triage only. A failed delete is logged by the activity.
    await CancellationScope.nonCancellable(() =>
      notify(() => cancelActivities.releaseCheckSandbox({ runId: run.id, spriteId: sprite.spriteId, adapter: sprite.adapter, workspacePath: sprite.workspacePath })),
    );
  }
  if (run.stopped) await run.cancel();
  if (triage === null) {
    await run.ensureTime();
    return await run.fail("REVIEW_UNAVAILABLE", `The triage of the review app findings on ${check.url} did not finish.`);
  }
  const unreachable = providerUnreachableOf(triage);
  if (unreachable !== null) await failProviderUnreachable(run, "reviewer", unreachable);
  const hang = hangOf(triage);
  if (hang !== null) await failHung(run, "reviewer", hang);
  if (!triage.reportUsable) {
    return await run.fail("REVIEW_UNAVAILABLE", `Factoree could not triage the review app findings on ${check.url}. ${triage.reportProblem ?? ""}`.trim());
  }
  const kept = triage.decisions.filter((decision) => decision.kept);
  const dropped = triage.decisions.filter((decision) => !decision.kept);
  if (dropped.length > 0) {
    await notify(() => pullRequestReplyActivities.answerDroppedFindings({ tenantId: input.tenantId, pullRequestId: check.pullRequestId, findings: check.findings, dropped }));
  }
  const triageLine =
    `Factoree triaged ${String(triage.decisions.length)} ${triage.decisions.length === 1 ? "finding" : "findings"} of ${check.reviewerName} on ${check.url}: ` +
    `it kept ${String(kept.length)} and dropped ${String(dropped.length)}.` +
    (dropped.length === 0 ? "" : " It answered each dropped finding on the pull request with the reason.");
  if (kept.length === 0 && options.endWhenNothingKept) {
    await run.report(
      [
        "## Factoree triage",
        "",
        triageLine,
        "",
        "No finding names a concrete defect, a rule and evidence, so Factoree changed nothing. This triage does not count toward the automatic follow-up limit.",
      ].join("\n"),
    );
  }
  await run.progress(triageLine);
  if (options.count) await activities.countReviewerFollowUp({ tenantId: input.tenantId, pullRequestId: check.pullRequestId, runId: run.id });
  return triage.decisions;
};
