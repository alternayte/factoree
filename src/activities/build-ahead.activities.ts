import { repositoryNamesOf } from "~/activities/repository-credential.js";
import type { RepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";
import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import { buildRepositoryUrl } from "~/domain/products/repository-url.js";
import { loadRunnerEnvironment } from "~/domain/products/runner-credentials.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import { registerProjectSecrets } from "~/domain/products/redaction-loader.js";
import {
  bootstrapKeyOfConfig,
  buildAheadSandboxRunId,
  projectDefaultsOf,
  type BuildAheadRequest,
} from "~/domain/runs/build-ahead.js";
import type { BuildAheadOutcome, SandboxManager } from "~/domain/runs/sandbox-manager.js";
import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";

export interface BuildAheadActivityDependencies {
  sandboxManager: SandboxManager;
  products: ProductRegistry;
  repositories: RepositoryRegistry;
  discoveryClient: RepositoryDiscoveryClient;
  secrets: SecretStore;
  tokens: GitHubTokenProvider;
  redactor: Redactor;
  repositoryBaseUrl: () => Promise<string>;
  logger: Logger;
}

export const createBuildAheadActivities = (dependencies: BuildAheadActivityDependencies) => ({
  /**
   * docs/specs/run-speed.md. Builds the warm snapshot of one repository at the head of its default
   * branch, unless the stored snapshot already holds the current template and bootstrap key.
   */
  async buildWarmSnapshotAhead(request: BuildAheadRequest): Promise<BuildAheadOutcome> {
    const fields = { tenant_id: request.tenantId, repository: request.repositoryFullName, step: "build_ahead" };
    const repository = await dependencies.repositories.findByFullName(request.tenantId, request.repositoryFullName);
    if (repository === null || repository.absentSince !== null) {
      return { kind: "skipped", reason: "discovery no longer sees the repository" };
    }
    const product = await dependencies.products.findById(request.tenantId, repository.productId);
    if (product === null) return { kind: "skipped", reason: "the Product of the repository is gone" };

    const file = await dependencies.discoveryClient.readConfig(
      repository.fullName,
      repository.defaultBranch,
      repository.githubInstallationId,
    );
    if (file === null) return { kind: "skipped", reason: "the repository carries no .factoree/config.yaml" };
    const defaults = projectDefaultsOf(product);
    const url = buildRepositoryUrl(await dependencies.repositoryBaseUrl(), repository.fullName);
    const bootstrapKey = bootstrapKeyOfConfig(file, defaults);
    if (await dependencies.sandboxManager.hasCurrentWarmSnapshot({ tenantId: request.tenantId, repositoryUrl: url, bootstrapKey })) {
      dependencies.logger.info("the warm snapshot is current, so the build-ahead builds nothing", fields);
      return { kind: "skipped", reason: "the warm snapshot is current" };
    }

    // The bootstrap of a build-ahead must see what the bootstrap of a run sees: the same secrets
    // reach the redactor, and the same runner environment reaches the sandbox.
    await registerProjectSecrets(dependencies.redactor, dependencies.secrets, request.tenantId, repository.productId, dependencies.logger);
    const environment = await loadRunnerEnvironment(dependencies.secrets, request.tenantId, repository.productId);
    const credential =
      repository.githubInstallationId === ""
        ? null
        : await dependencies.tokens.tokenForInstallation(
            repository.githubInstallationId,
            { contents: "read" },
            repositoryNamesOf([url]),
          );
    if (credential !== null) dependencies.redactor.addSecret(credential);

    dependencies.logger.info("the build-ahead builds a new warm snapshot", fields);
    try {
      const outcome = await dependencies.sandboxManager.buildAhead({
        runId: buildAheadSandboxRunId(request),
        tenantId: request.tenantId,
        productId: repository.productId,
        primary: { url, ref: repository.defaultBranch },
        references: [],
        defaults,
        environment,
        ...(credential === null ? {} : { repositoryCredential: credential }),
      });
      dependencies.logger.info("the build-ahead ended", { ...fields, outcome: outcome.kind });
      return outcome;
    } catch (error) {
      // SDD section 60. An activity error becomes Temporal history.
      if (error instanceof Error) {
        error.message = dependencies.redactor.redactText(error.message);
        if (error.stack !== undefined) error.stack = dependencies.redactor.redactText(error.stack);
      }
      throw error;
    }
  },
});
