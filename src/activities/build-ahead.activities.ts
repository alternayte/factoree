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
  buildAheadRepositoriesOf,
  buildAheadSandboxRunId,
  projectDefaultsOf,
  type BuildAheadFailureStore,
  type BuildAheadRequest,
} from "~/domain/runs/build-ahead.js";
import type { ProductRecord } from "~/domain/products/product-registry.js";
import type { RepositoryRecord } from "~/domain/products/repository-registry.js";
import { setBootstrapKeyOf, snapshotSubjectOf } from "~/domain/runs/warm-snapshot.js";
import { SandboxSlotUnavailableError } from "~/domain/runs/sandbox-slot-error.js";
import type { BuildAheadOutcome, SandboxManager } from "~/domain/runs/sandbox-manager.js";
import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { isMember } from "~/domain/products/membership.js";

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
  /** docs/specs/host-credentials.md. The credential part of the bootstrap key of a product. */
  credentialKey?: ((tenantId: string, productId: string) => Promise<string[]>) | undefined;
}

/** One repository a build-ahead builds, with the bootstrap key of its default-branch head. */
interface BuildAheadMember {
  repository: RepositoryRecord;
  product: ProductRecord;
  url: string;
  /** Null when GitHub truncated the tree, so the key is unknown. */
  bootstrapKey: string | null;
}

export const createBuildAheadActivities = (dependencies: BuildAheadActivityDependencies) => {
  /** The member of one repository, or the reason the build-ahead builds nothing. */
  const memberOf = async (tenantId: string, fullName: string): Promise<BuildAheadMember | { skipped: string }> => {
    const repository = await dependencies.repositories.findByFullName(tenantId, fullName);
    if (repository === null || repository.absentSince !== null) return { skipped: "discovery no longer sees the repository" };
    if (!isMember(repository)) return { skipped: "no admin accepted the repository as a member of its product" };
    const product = await dependencies.products.findById(tenantId, repository.productId);
    if (product === null) return { skipped: "the Product of the repository is gone" };
    const file = await dependencies.discoveryClient.readConfig(repository.fullName, repository.defaultBranch, repository.githubInstallationId);
    if (file === null) return { skipped: "the repository carries no .factoree/config.yaml" };
    const url = buildRepositoryUrl(await dependencies.repositoryBaseUrl(), repository.fullName);
    const files = await dependencies.discoveryClient.listFiles(repository.fullName, repository.defaultBranch, repository.githubInstallationId);
    const credentials = (await dependencies.credentialKey?.(tenantId, repository.productId)) ?? [];
    return { repository, product, url, bootstrapKey: bootstrapKeyOfConfig(file, projectDefaultsOf(product), files, credentials) };
  };

  return {
  /**
   * docs/specs/run-speed.md. Builds the warm snapshot of one repository at the head of its default
   * branch, unless the stored snapshot already holds the current template and bootstrap key.
   * docs/specs/change-sets.md, DI-21.137. A request that names a set builds the snapshot of the set:
   * every repository at the head of its default branch, keyed by the key of the set.
   */
  async buildWarmSnapshotAhead(request: BuildAheadRequest): Promise<BuildAheadOutcome[]> {
    const names = buildAheadRepositoriesOf(request);
    const isSet = names.length > 1;
    const fields = { tenant_id: request.tenantId, repository: names.join(", "), step: "build_ahead" };
    const members: BuildAheadMember[] = [];
    for (const name of names) {
      const member = await memberOf(request.tenantId, name);
      if ("skipped" in member) return [{ kind: "skipped", reason: isSet ? `${name}: ${member.skipped}` : member.skipped }];
      members.push(member);
    }
    const first = members[0];
    if (first === undefined) return [{ kind: "skipped", reason: "the request names no repository" }];
    // A set belongs to one product. A repository that moved to another product ends the set.
    if (members.some((member) => member.product.id !== first.product.id)) {
      return [{ kind: "skipped", reason: "the repositories of the set belong to more than one Product" }];
    }
    const { repository, product } = first;
    const defaults = projectDefaultsOf(product);
    const subject = snapshotSubjectOf(members.map((member) => member.url));
    const bootstrapKey = members.some((member) => member.bootstrapKey === null)
      ? null
      : setBootstrapKeyOf(members.map((member) => ({ repositoryUrl: member.url, bootstrapKey: member.bootstrapKey ?? "" })));

    // docs/specs/sandbox-provider-spillover.md. A warm snapshot on every enabled provider the product
    // allows, so a spillover run starts warm. A worker with one bare sandbox builds on it alone.
    const providers: Array<string | undefined> =
      dependencies.providerIds === undefined
        ? [undefined]
        : (await dependencies.providerIds()).filter(
            (id) => product.sandboxProviderIds.length === 0 || product.sandboxProviderIds.includes(id),
          );

    const outcomes: BuildAheadOutcome[] = [];
    let prepared: { environment: Record<string, string>; credentials: Map<string, string | null> } | null = null;
    let firstError: Error | null = null;
    for (const provider of providers) {
      const providerFields = provider === undefined ? fields : { ...fields, provider };
      if (
        bootstrapKey !== null &&
        (await dependencies.sandboxManager.hasCurrentWarmSnapshot({
          tenantId: request.tenantId,
          repositoryUrl: subject,
          bootstrapKey,
          ...(provider === undefined ? {} : { provider }),
        }))
      ) {
        dependencies.logger.info("the warm snapshot is current, so the build-ahead builds nothing", providerFields);
        if (provider !== undefined && !isSet) await dependencies.failures?.clear(request.tenantId, provider, subject);
        outcomes.push({ kind: "skipped", reason: "the warm snapshot is current" });
        continue;
      }

      // The bootstrap of a build-ahead must see what the bootstrap of a run sees: the same secrets
      // reach the redactor, and the same runner environment reaches the sandbox.
      // docs/specs/change-sets.md. Each installation mints one credential that reads its own members.
      if (prepared === null) {
        await registerProjectSecrets(dependencies.redactor, dependencies.secrets, request.tenantId, product.id, dependencies.logger);
        const environment = await loadRunnerEnvironment(dependencies.secrets, request.tenantId, product.id);
        const credentials = new Map<string, string | null>();
        for (const member of members) {
          const installation = member.repository.githubInstallationId;
          if (credentials.has(installation)) continue;
          const credential =
            installation === ""
              ? null
              : await dependencies.tokens.tokenForInstallation(
                  installation,
                  { contents: "read" },
                  repositoryNamesOf(members.filter((other) => other.repository.githubInstallationId === installation).map((other) => other.url)),
                );
          if (credential !== null) dependencies.redactor.addSecret(credential);
          credentials.set(installation, credential);
        }
        prepared = { environment, credentials };
      }
      const credentialOf = (member: BuildAheadMember): string | null => prepared?.credentials.get(member.repository.githubInstallationId) ?? null;
      const primaryCredential = credentialOf(first);

      dependencies.logger.info("the build-ahead builds a new warm snapshot", providerFields);
      try {
        const outcome = await dependencies.sandboxManager.buildAhead({
          runId: buildAheadSandboxRunId(request),
          tenantId: request.tenantId,
          productId: product.id,
          primary: { url: first.url, ref: repository.defaultBranch },
          ...(isSet
            ? {
                targets: members.map((member) => {
                  const credential = credentialOf(member);
                  return {
                    repository: member.repository.fullName,
                    url: member.url,
                    ref: member.repository.defaultBranch,
                    ...(credential === null ? {} : { credential }),
                  };
                }),
              }
            : {}),
          references: [],
          defaults,
          environment: prepared.environment,
          ...(primaryCredential === null ? {} : { repositoryCredential: primaryCredential }),
          ...(provider === undefined ? {} : { provider }),
        });
        dependencies.logger.info("the build-ahead ended", { ...providerFields, outcome: outcome.kind });
        if (provider !== undefined && !isSet) await dependencies.failures?.clear(request.tenantId, provider, subject);
        outcomes.push(outcome);
      } catch (error) {
        // SDD section 60. An activity error becomes Temporal history.
        if (error instanceof Error) {
          error.message = dependencies.redactor.redactText(error.message);
          if (error.stack !== undefined) error.stack = dependencies.redactor.redactText(error.stack);
        }
        // docs/specs/repository-setup-and-services.md. A configuration fault is drift a setup can
        // repair, so the product page offers "Run setup again". An infrastructure fault is not.
        // DI-21.137. The build-ahead of each repository of a set marks its own drift.
        if (error instanceof RunConfigurationError && !isSet) {
          await dependencies.setupMarks
            ?.markNeedsSetup(request.tenantId, request.repositoryFullName, error.message, new Date())
            .catch(() => undefined);
        }
        // docs/specs/sandbox-provider-spillover.md. A full provider says nothing about the
        // repository. Any other failure makes selection prefer another provider for it.
        // DI-21.137. Selection reads the failures of one repository, so a set records none.
        if (provider !== undefined && !isSet && !(error instanceof SandboxSlotUnavailableError)) {
          await dependencies.failures
            ?.record({
              tenantId: request.tenantId,
              providerId: provider,
              repositoryUrl: subject,
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
    if (!isSet) await dependencies.setupMarks?.clearNeedsSetup(request.tenantId, request.repositoryFullName);
    return outcomes;
  },
  };
};
