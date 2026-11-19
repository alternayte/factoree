import { CancellationScope, deprecatePatch } from "@temporalio/workflow";
import type { PrepareCheckSandboxActivityOutput, PrepareSandboxActivityOutput } from "~/activities/sandbox.activities.js";
import type { VerifyActivityOutput } from "~/activities/verification.activities.js";
import { buildSandboxActivities, buildVerifyActivities, cancelActivities } from "../activities.js";
import { PATCH } from "../patches.js";
import type { Run } from "../run.js";
import { setTargetsInput, spriteOf } from "../sessions.js";
import type { Workspace } from "./preparation.js";

/** docs/specs/early-review-sprite.md. The build of the reviewer's check sprite of one attempt. */
export type ReviewSpriteBuild =
  | { kind: "sprite"; sprite: PrepareCheckSandboxActivityOutput }
  /** The sandbox slot wait ended without a sprite: a stop or the Run deadline. */
  | { kind: "unavailable" }
  | { kind: "error"; error: unknown };

/**
 * docs/specs/check-isolation.md. A check sprite of one attempt: a new sprite from the base SHA plus
 * the patch captured from the work sprite. It deletes the sprite of the same role of the attempt
 * before, and the reviewer's sprite must hold the patch of the first one.
 */
export const prepareCheckSprite = (
  run: Run,
  workspace: Workspace,
  previous: PrepareCheckSandboxActivityOutput | null,
  attempt: number,
  expectedPatchSha256?: string,
): Promise<PrepareCheckSandboxActivityOutput | null> => {
  const work = workspace.work;
  return run.withSandboxSlot((budgetMs) =>
    buildSandboxActivities(budgetMs).prepareCheckSandbox({
      ...workspace.prepareInput,
      work: { ...spriteOf(work), baseSha: work.baseSha, ...setTargetsInput(work) },
      previous: previous === null ? null : { spriteId: previous.spriteId, adapter: previous.adapter, workspacePath: previous.workspacePath },
      attempt,
      ...(expectedPatchSha256 === undefined ? {} : { expectedPatchSha256 }),
    }),
  );
};

/**
 * docs/specs/early-review-sprite.md. The reviewer's check sprite builds while verify runs. The
 * build runs outside every cancellable scope: the activity sends no heartbeat, so a cancel never
 * reaches it, and the sprite it builds would belong to no Run. A stop or the end of the Run waits
 * for it instead.
 */
export const startReviewSpriteBuild = async (
  run: Run,
  workspace: Workspace,
  attempt: number,
  checked: PrepareCheckSandboxActivityOutput,
): Promise<{ build: Promise<ReviewSpriteBuild> }> => {
  deprecatePatch(PATCH.earlyReviewSprite);
  deprecatePatch(PATCH.parallelReview);
  const earlier = run.reviewBuild;
  run.reviewBuild = null;
  if (earlier !== null) await earlier;
  const previous = run.reviewSprite;
  const build = CancellationScope.nonCancellable(async (): Promise<ReviewSpriteBuild> => {
    try {
      const sprite = await prepareCheckSprite(run, workspace, previous, attempt, checked.patchSha256);
      if (sprite === null) return { kind: "unavailable" };
      run.reviewSprite = sprite;
      return { kind: "sprite", sprite };
    } catch (error) {
      return { kind: "error", error };
    }
  });
  run.reviewBuild = build;
  return { build };
};

/**
 * A failed verify ends the attempt, so its reviewer's sprite holds a patch the repair replaces.
 * The build ends in the background and the sprite goes at once, so the repair does not wait.
 */
export const dropReviewSpriteBuild = (run: Run, build: Promise<ReviewSpriteBuild>): void => {
  run.reviewBuild = CancellationScope.nonCancellable(async () => {
    const outcome = await build;
    if (outcome.kind !== "sprite") return;
    const sprite = outcome.sprite;
    try {
      await cancelActivities.releaseCheckSandbox({ runId: run.id, spriteId: sprite.spriteId, adapter: sprite.adapter, workspacePath: sprite.workspacePath });
      if (run.reviewSprite === sprite) run.reviewSprite = null;
    } catch {
      // The sprite stays the reviewer's sprite of the Run, so the next build or the end of the Run deletes it.
    }
  });
};

/**
 * SDD section 35. Deterministic verification in a check sprite, bounded by the remaining budget.
 * Each target of a change set verifies with its own stack (DI-21.146). The summary reaches Linear.
 */
export const verify = async (run: Run, sprite: PrepareSandboxActivityOutput, attempt: number): Promise<VerifyActivityOutput> => {
  let verification: VerifyActivityOutput;
  try {
    verification = await buildVerifyActivities(run.remainingMs()).verify({
      runId: run.id,
      tenantId: run.input.tenantId,
      productId: run.input.productId,
      ...spriteOf(sprite),
      commands: sprite.verifyCommands,
      timeoutMs: run.remainingMs(),
      attempt,
      ...(sprite.setCheck === undefined
        ? {}
        : { stacks: sprite.setCheck.targets.map((target) => ({ repository: target.repository, path: target.path, services: target.services })) }),
    });
  } catch (error) {
    return await run.timeoutFrom(error);
  }
  await run.progress(verification.summary);
  return verification;
};
