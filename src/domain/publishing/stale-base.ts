import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { safeUrlForMessage } from "~/domain/runs/checkout.js";

const SHA = /^[0-9a-f]{40}$/;

export interface BaseCheck {
  /** True only when `current_target_sha == run_base_sha`. SDD section 45. */
  fresh: boolean;
  runBaseSha: string;
  currentTargetSha: string;
}

/**
 * SDD section 45. Version 1 must not rebase automatically, so a moved target branch ends the Run
 * in `STALE_BASE` and publishes nothing. The comparison happens before publication, never after.
 */
export const checkBase = async (
  reader: RepositoryReader,
  input: { url: string; branch: string; runBaseSha: string },
): Promise<BaseCheck> => {
  if (!SHA.test(input.runBaseSha)) {
    throw new Error(`the Run base SHA is not forty hexadecimal characters: "${input.runBaseSha}"`);
  }
  const currentTargetSha = await reader.resolveRef(input.url, input.branch);
  if (!SHA.test(currentTargetSha)) {
    throw new Error(
      `the branch "${input.branch}" of ${safeUrlForMessage(input.url)} resolved to no commit SHA`,
    );
  }
  return { fresh: currentTargetSha === input.runBaseSha, runBaseSha: input.runBaseSha, currentTargetSha };
};
