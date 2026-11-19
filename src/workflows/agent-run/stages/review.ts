import { CancellationScope, deprecatePatch } from "@temporalio/workflow";
import type { ReviewActivityOutput } from "~/activities/review.activities.js";
import type { ForYourEyeCriterion } from "~/domain/validation/for-your-eye.js";
import { PATCH } from "../patches.js";
import type { Run } from "../run.js";
import { hangOf, PROVIDER_UNREACHABLE_ATTEMPTS, reportHang, retryWhileUnreachable, runReview } from "../sessions.js";
import type { ReviewSpriteBuild } from "./checks.js";

/** docs/specs/run-speed.md. How the reviewer that runs beside user validation ended. */
export type ReviewOutcome =
  | { kind: "review"; review: ReviewActivityOutput }
  /** The sandbox slot wait or the session ended without a result: a stop or the Run deadline. */
  | { kind: "unavailable" }
  | { kind: "error"; error: unknown };

/** What the reviewer and the validator of one attempt read. */
export interface CheckBrief {
  goal: string;
  attempt: number;
  contextContract: string;
  constraints: string[];
  forYourEye: ForYourEyeCriterion[];
  edges: Array<{ provider: string; consumer: string }>;
}

/**
 * docs/specs/run-speed.md, amending SDD section 40. Verification passed, so the reviewer starts
 * now in its own check sprite, beside user validation. A preview build in the same sprite can
 * rewrite tracked files, which the reviewer guard would read as a reviewer write. The reviewer
 * reads the verification summary and no validation evidence. The end of the Run cancels it.
 *
 * The branch runs beside the main path, so its awaits keep the shape they had when the open runs
 * of this release were recorded: a changed number of microtask turns reorders the commands.
 */
export const startReview = (
  run: Run,
  brief: CheckBrief,
  sprite: Promise<ReviewSpriteBuild>,
  verificationSummary: string,
): Promise<ReviewOutcome> => {
  deprecatePatch(PATCH.parallelReview);
  const scope = new CancellationScope({ cancellable: true });
  const branch = scope.run(async (): Promise<ReviewOutcome> => {
    try {
      const built = await sprite;
      if (built.kind === "error") return { kind: "error", error: built.error };
      if (built.kind === "unavailable") return { kind: "unavailable" };
      run.reviewSprite = built.sprite;
      const pass = {
        prepared: built.sprite,
        goal: brief.goal,
        attempt: brief.attempt,
        contextContract: brief.contextContract,
        constraints: brief.constraints,
        verificationSummary,
      };
      let result = await runReview(run, pass);
      result = await retryWhileUnreachable(run, "reviewer", result, (retry) => runReview(run, { ...pass, unreachableRetry: retry }), 0);
      // docs/specs/agent-session-usage-and-hangs.md. A hung Reviewer gets one fresh session in the same pass.
      const hang = hangOf(result);
      if (hang !== null && !run.stopped && run.remainingMs() > 0) {
        await reportHang(run, "reviewer", hang, "starts one fresh session");
        result = await runReview(run, { ...pass, afterHang: true });
        result = await retryWhileUnreachable(
          run,
          "reviewer",
          result,
          (retry) => runReview(run, { ...pass, afterHang: true, unreachableRetry: retry }),
          PROVIDER_UNREACHABLE_ATTEMPTS - 1,
        );
      }
      return result === null ? { kind: "unavailable" } : { kind: "review", review: result };
    } catch (error) {
      return { kind: "error", error };
    }
  });
  run.liveReview = { scope, branch };
  return branch;
};

/** The reviewer beside user validation, once it ended. */
export const awaitReview = async (run: Run, branch: Promise<ReviewOutcome>): Promise<ReviewOutcome> => {
  const outcome = await branch;
  run.liveReview = null;
  return outcome;
};
