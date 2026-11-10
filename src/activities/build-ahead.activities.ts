import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import type { RepositorySetupMarks } from "~/domain/setup/repository-setup.js";
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
  type BuildAheadFailureStore,
  type BuildAheadRequest,
} from "~/domain/runs/build-ahead.js";
import { SandboxSlotUnavailableError } from "~/domain/runs/sandbox-slot-error.js";
import type { BuildAheadOutcome, SandboxManager } from "~/domain/runs/sandbox-manager.js";
import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";

export interface BuildAheadActivityDependencies {
  sandboxManager: SandboxManager;
  /** docs/specs/sandbox-provider-spillover.md. The enabled providers. Absent means the default one. */
  providerIds?: (() => Promise<string[]>) | undefined;
  failures?: BuildAheadFailureStore | undefined;
  products: ProductRegistry;
  repositories: RepositoryRegistry;
  discoveryClient: RepositoryDiscoveryClient;
  secrets: SecretStore;
  tokens: GitHubTokenProvider;
  redactor: Redactor;
  repositoryBaseUrl: () => Promise<string>;
  logger: Logger;
  /** docs/specs/repository-setup-and-services.md. A failed build-ahead marks the repository for setup. */
  setupMarks?: RepositorySetupMarks | undefined;
}

export const createBuildAheadActivities = (dependencies: BuildAheadActivityDependencies) => ({
  /**
   * docs/specs/run-speed.md. Builds the warm snapshot of one repository at the head of its default
   * branch, unless the stored snapshot already holds the current template and bootstrap key.
   */
  async buildWarmSnapshotAhead(request: BuildAheadRequest): Promise<BuildAheadOutcome[]> {
    const fields = { tenant_id: request.tenantId, repository: request.repositoryFullName, step: "build_ahead" };
    const repository = await dependencies.repositories.findByFullName(request.tenantId, request.repositoryFullName);
    if (repository === null || repository.absentSince !== null) {
      return [{ kind: "skipped", reason: "discovery no longer sees the repository" }];
    }
    const product = await dependencies.products.findById(request.tenantId, repository.productId);
    if (product === null) return [{ kind: "skipped", reason: "the Product of the repository is gone" }];

    const file = await dependencies.discoveryClient.readConfig(
      repository.fullName,
      repository.defaultBranch,
      repository.githubInstallationId,
    );
    if (file === null) return [{ kind: "skipped", reason: "the repository carries no .factoree/config.yaml" }];
    const defaults = projectDefaultsOf(product);
    const url = buildRepositoryUrl(await dependencies.repositoryBaseUrl(), repository.fullName);
    const files = await dependencies.discoveryClient.listFiles(
      repository.fullName,
      repository.defaultBranch,
      repository.githubInstallationId,
    );
    const bootstrapKey = bootstrapKeyOfConfig(file, defaults, files);

    // docs/specs/sandbox-provider-spillover.md. A warm snapshot on every enabled provider the product
    // allows, so a spillover run starts warm. A worker with one bare sandbox builds on it alone.
    const providers: Array<string | undefined> =
      dependencies.providerIds === undefined
        ? [undefined]
        : (await dependencies.providerIds()).filter(
            (id) => product.sandboxProviderIds.length === 0 || product.sandboxProviderIds.includes(id),
          );

    const outcomes: BuildAheadOutcome[] = [];
    let prepared: { environment: Record<string, string>; credential: string | null } | null = null;
    let firstError: Error | null = null;
    for (const provider of providers) {
      const providerFields = provider === undefined ? fields : { ...fields, provider };
      if (
        bootstrapKey !== null &&
        (await dependencies.sandboxManager.hasCurrentWarmSnapshot({
          tenantId: request.tenantId,
          repositoryUrl: url,
          bootstrapKey,
          ...(provider === undefined ? {} : { provider }),
        }))
      ) {
        dependencies.logger.info("the warm snapshot is current, so the build-ahead builds nothing", providerFields);
        if (provider !== undefined) await dependencies.failures?.clear(request.tenantId, provider, url);
        outcomes.push({ kind: "skipped", reason: "the warm snapshot is current" });
        continue;
      }

      // The bootstrap of a build-ahead must see what the bootstrap of a run sees: the same secrets
      // reach the redactor, and the same runner environment reaches the sandbox.
      if (prepared === null) {
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
        prepared = { environment, credential };
      }

      dependencies.logger.info("the build-ahead builds a new warm snapshot", providerFields);
      try {
        const outcome = await dependencies.sandboxManager.buildAhead({
          runId: buildAheadSandboxRunId(request),
          tenantId: request.tenantId,
          productId: repository.productId,
          primary: { url, ref: repository.defaultBranch },
          references: [],
          defaults,
          environment: prepared.environment,
          ...(prepared.credential === null ? {} : { repositoryCredential: prepared.credential }),
          ...(provider === undefined ? {} : { provider }),
        });
        dependencies.logger.info("the build-ahead ended", { ...providerFields, outcome: outcome.kind });
        if (provider !== undefined) await dependencies.failures?.clear(request.tenantId, provider, url);
        outcomes.push(outcome);
      } catch (error) {
        // SDD section 60. An activity error becomes Temporal history.
        if (error instanceof Error) {
          error.message = dependencies.redactor.redactText(error.message);
          if (error.stack !== undefined) error.stack = dependencies.redactor.redactText(error.stack);
        }
        // docs/specs/repository-setup-and-services.md. A configuration fault is drift a setup can
        // repair, so the product page offers "Run setup again". An infrastructure fault is not.
        if (error instanceof RunConfigurationError) {
          await dependencies.setupMarks
            ?.markNeedsSetup(request.tenantId, request.repositoryFullName, error.message, new Date())
            .catch(() => undefined);
        }
        // docs/specs/sandbox-provider-spillover.md. A full provider says nothing about the
        // repository. Any other failure makes selection prefer another provider for it.
        if (provider !== undefined && !(error instanceof SandboxSlotUnavailableError)) {
          await dependencies.failures
            ?.record({
              tenantId: request.tenantId,
              providerId: provider,
              repositoryUrl: url,
              reason: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
              failedAt: new Date(),
            })
            .catch(() => undefined);
        }
        dependencies.logger.warn("the build-ahead failed on the sandbox provider", { ...providerFields, error: String(error) });
        firstError ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    // A retry builds again only where the snapshot is not current.
    if (firstError !== null) throw firstError;
    await dependencies.setupMarks?.clearNeedsSetup(request.tenantId, request.repositoryFullName);
    return outcomes;
  },
});
