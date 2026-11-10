import { repositoryNamesOf } from "~/activities/repository-credential.js";
import type { RepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";
import { parseFactoreeConfig } from "~/domain/products/factoree-config.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import { projectDefaultsOf } from "~/domain/runs/build-ahead.js";
import { toProjectRuntimeConfig } from "~/domain/runs/project-runtime-config.js";
import type { SandboxProviderSelector } from "~/domain/runs/provider-selection.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { Logger } from "~/telemetry/logger.js";

export interface ProviderSelectionActivityDependencies {
  /** Absent in a worker with one bare sandbox: every sandbox then goes to the default provider. */
  selector?: SandboxProviderSelector | undefined;
  runs: Pick<RunRepository, "setSandboxProvider">;
  products: Pick<ProductRegistry, "findById">;
  repositories: Pick<RepositoryRegistry, "findByFullName">;
  discoveryClient: Pick<RepositoryDiscoveryClient, "readConfig">;
  logger: Logger;
}

export interface SelectSandboxProviderInput {
  runId: string;
  tenantId: string;
  productId: string;
  /** The primary repository of the run. */
  repositoryUrl: string;
}

/**
 * docs/specs/sandbox-provider-spillover.md. True when the config of the repository at its default
 * branch starts Docker or compose services. A config that cannot be read asks for nothing: the
 * preparation still refuses Docker on a provider without it.
 */
export const needsDockerOf = async (
  dependencies: Pick<ProviderSelectionActivityDependencies, "products" | "repositories" | "discoveryClient" | "logger">,
  input: { tenantId: string; productId: string; repositoryUrl: string },
): Promise<boolean> => {
  const fullName = repositoryNamesOf([input.repositoryUrl])?.[0];
  if (fullName === undefined) return false;
  try {
    const repository = await dependencies.repositories.findByFullName(input.tenantId, fullName);
    const product = await dependencies.products.findById(input.tenantId, input.productId);
    if (repository === null || product === null) return false;
    const file = await dependencies.discoveryClient.readConfig(
      repository.fullName,
      repository.defaultBranch,
      repository.githubInstallationId,
    );
    if (file === null) return false;
    return toProjectRuntimeConfig(parseFactoreeConfig(file.content), projectDefaultsOf(product)).runtime.docker === true;
  } catch (error) {
    dependencies.logger.warn("the config of the repository was not read for the provider selection", {
      tenant_id: input.tenantId,
      repository: fullName,
      error: String(error),
      step: "select_provider",
    });
    return false;
  }
};

export const createProviderSelectionActivities = (dependencies: ProviderSelectionActivityDependencies) => ({
  /**
   * docs/specs/sandbox-provider-spillover.md. Pins the run to a sandbox provider and holds its slots
   * there. A run that already holds slots keeps its provider. Throws `SandboxSlotUnavailableError`
   * when no provider the run may use has room, and the workflow asks again.
   */
  async selectSandboxProvider(input: SelectSandboxProviderInput): Promise<{ providerId: string | null }> {
    if (dependencies.selector === undefined) return { providerId: null };
    const product = await dependencies.products.findById(input.tenantId, input.productId);
    const providerId = await dependencies.selector.selectForRun({
      runId: input.runId,
      tenantId: input.tenantId,
      allowedProviderIds: product?.sandboxProviderIds ?? [],
      repositoryUrl: input.repositoryUrl,
      needsDocker: await needsDockerOf(dependencies, input),
    });
    await dependencies.runs.setSandboxProvider(input.tenantId, input.runId, providerId);
    dependencies.logger.info("the run is pinned to a sandbox provider", {
      tenant_id: input.tenantId,
      run_id: input.runId,
      provider: providerId,
      step: "select_provider",
    });
    return { providerId };
  },
});
