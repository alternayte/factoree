import type { AgentRunProductInput } from "~/workflows/agent-run.workflow.js";
import type { ProductRecord } from "~/domain/products/product-registry.js";
import type { RepositoryRecord } from "~/domain/products/repository-registry.js";
import { DEFAULT_PROJECT_DEFAULTS } from "~/domain/runs/project-runtime-config.js";

/**
 * SDD section 15 and section 16. The product facts a run takes as its input, read at its start.
 * The delegation of a work item and the start of a PR follow-up run both build it here. Every other
 * runtime value comes from `.factoree/config.yaml` inside the target repository.
 */
export const agentRunProductInput = (input: {
  product: ProductRecord;
  /** docs/specs/autonomy-levels.md. L0 for a pending product, whatever its row holds. */
  defaultAutonomy: string;
  repositories: readonly RepositoryRecord[];
  repositoryBaseUrl: string;
  productPageUrl: string | null;
}): AgentRunProductInput => {
  const product = input.product;
  return {
    productId: product.id,
    productSlug: product.slug,
    defaultAutonomy: input.defaultAutonomy,
    riskCaps: product.riskCaps,
    allowedDomains: product.allowedDomains,
    repositories: input.repositories.map((repository) => ({
      id: repository.id,
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      absentSince: repository.absentSince === null ? null : repository.absentSince.toISOString(),
      githubInstallationId: repository.githubInstallationId,
      linearProjects: repository.linearProjects,
    })),
    repositoryBaseUrl: input.repositoryBaseUrl,
    stagingRead: DEFAULT_PROJECT_DEFAULTS.stagingRead,
    // docs/specs/release-0-1-0.md. Retention is a Product setting.
    spriteRetentionHours: product.sandboxRetentionHours,
    organizationSkillsRepository: product.organizationSkillsRepository,
    // docs/specs/skill-registry.md. The key stays in the secret store. Only the settings travel.
    skillRegistry: product.skillRegistry,
    // Issue #39, DI-21.66. The criteria cap of the refiner proposal is a Product setting.
    refinerCriteriaLimit: product.refinerCriteriaLimit,
    // docs/specs/egress-honesty-and-issue-status.md. A missing-host post names the product page.
    ...(input.productPageUrl === null ? {} : { productPageUrl: input.productPageUrl }),
  };
};
