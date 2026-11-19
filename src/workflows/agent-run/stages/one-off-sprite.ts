// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import { buildRepositoryUrl } from "../../../domain/products/repository-url.js";
import { buildSandboxActivities } from "../activities.js";
import type { Run } from "../run.js";

/**
 * The input of a sprite that serves one check outside the attempt loop: the triage of a PR reviewer
 * check, or the check of a bring-current merge. It holds the repository at one ref, with no
 * reference repository, no skill and no registry.
 */
export const oneOffSpriteInput = (run: Run, repository: { fullName: string; githubInstallationId: string }, ref: string) => ({
  runId: run.id,
  tenantId: run.input.tenantId,
  productId: run.input.productId,
  primary: { url: buildRepositoryUrl(run.input.product.repositoryBaseUrl, repository.fullName), ref },
  references: [],
  defaults: {
    stagingRead: run.input.product.stagingRead,
    spriteRetentionHours: run.input.product.spriteRetentionHours,
    allowedDomains: run.input.product.allowedDomains,
  },
  environment: {},
  organizationSkills: null,
  githubInstallationId: repository.githubInstallationId,
  skillRegistry: null,
});

/**
 * docs/specs/sandbox-provider-spillover.md. Selects the sandbox provider, then prepares the sprite
 * there, inside the wait for a sandbox slot. A configuration fault ends FAILED_CONFIGURATION with the
 * sentence, and a stop or the deadline ends the Run.
 */
export const prepareOneOffSprite = async <T>(
  run: Run,
  urls: { repositoryUrl: string; targetRepositoryUrls?: string[] },
  prepare: (sandbox: ReturnType<typeof buildSandboxActivities>) => Promise<T>,
  configurationSentence: string,
): Promise<T> => {
  try {
    return await run.required(
      await run.withSandboxSlot(async (budgetMs) => {
        await buildSandboxActivities(budgetMs).selectSandboxProvider({
          runId: run.id,
          tenantId: run.input.tenantId,
          productId: run.input.productId,
          ...urls,
        });
        return await prepare(buildSandboxActivities(Math.max(1, Math.min(budgetMs, run.remainingMs()))));
      }),
    );
  } catch (error) {
    return await run.failFrom(error, configurationSentence);
  }
};
