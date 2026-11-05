import type { RepositoryConfigFile } from "~/adapters/github/repository-discovery-client.js";
import { parseFactoreeConfig } from "~/domain/products/factoree-config.js";
import type { ProductRecord } from "~/domain/products/product-registry.js";
import type { RepositoryRecord } from "~/domain/products/repository-registry.js";
import { buildRepositoryUrl } from "~/domain/products/repository-url.js";
import type { Logger } from "~/telemetry/logger.js";
import { bootstrapAllowListOf, DEFAULT_PROJECT_DEFAULTS, toProjectRuntimeConfig, type ProjectDefaults } from "./project-runtime-config.js";
import { bootstrapKeyOf, keyFilePatternsOf, selectKeyFiles, type RepositoryFileEntry } from "./warm-snapshot.js";

/**
 * docs/specs/run-speed.md. A build-ahead builds the warm snapshot of one repository when its
 * bootstrap key changes, before a run needs it. A run that finds no snapshot for its key still
 * builds one itself, so the run path never depends on a build-ahead.
 */
export interface BuildAheadRequest {
  tenantId: string;
  productId: string;
  repositoryFullName: string;
}

/** Asks for one build-ahead. A request during a build queues one more build, not one per request. */
export type RequestBuildAhead = (request: BuildAheadRequest) => Promise<void>;

/** One build-ahead workflow per repository, so a second request joins it. */
export const buildAheadWorkflowId = (tenantId: string, repositoryFullName: string): string =>
  `build-ahead:${tenantId}:${repositoryFullName}`;

/** The id a build-ahead sandbox carries where a run sandbox carries its run id. */
export const buildAheadSandboxRunId = (request: BuildAheadRequest): string =>
  `build-ahead:${request.repositoryFullName}`;

/** The Product values a repository must not own, exactly as a run passes them to its sandbox. */
export const projectDefaultsOf = (product: Pick<ProductRecord, "allowedDomains" | "sandboxRetentionHours">): ProjectDefaults => ({
  stagingRead: DEFAULT_PROJECT_DEFAULTS.stagingRead,
  spriteRetentionHours: product.sandboxRetentionHours,
  allowedDomains: product.allowedDomains,
});

/**
 * The bootstrap key of one `.factoree/config.yaml` under the allow list of its Product, with the
 * key files of the same ref. It equals the key a run computes in its checkout, because both read
 * git blob SHAs. Null when the file list is unknown: GitHub truncated the tree.
 */
export const bootstrapKeyOfConfig = (
  file: RepositoryConfigFile,
  defaults: ProjectDefaults,
  files: readonly RepositoryFileEntry[] | null,
): string | null => {
  if (files === null) return null;
  const { runtime } = toProjectRuntimeConfig(parseFactoreeConfig(file.content), defaults);
  return bootstrapKeyOf({
    bootstrapCommand: runtime.bootstrapCommand,
    warmCommand: runtime.warmCommand ?? null,
    allowedDomains: bootstrapAllowListOf(runtime),
    services: runtime.services ?? null,
    docker: runtime.docker === true,
    files: selectKeyFiles(files, keyFilePatternsOf(runtime)),
  });
};

export interface BuildAheadTriggerDependencies {
  request: RequestBuildAhead;
  products: { findById(tenantId: string, id: string): Promise<ProductRecord | null> };
  repositories: {
    listByProduct(productId: string): Promise<RepositoryRecord[]>;
    findByFullName(tenantId: string, fullName: string): Promise<RepositoryRecord | null>;
    /** Every repository of the install that discovery still sees. */
    listPresent(): Promise<RepositoryRecord[]>;
  };
  /** The bootstrap keys of the stored warm snapshots of one repository, on every adapter. */
  snapshotKeys: (tenantId: string, repositoryUrl: string) => Promise<string[]>;
  readConfig: (fullName: string, ref: string, githubInstallationId: string) => Promise<RepositoryConfigFile | null>;
  listFiles: (fullName: string, ref: string, githubInstallationId: string) => Promise<RepositoryFileEntry[] | null>;
  repositoryBaseUrl: () => Promise<string>;
  logger: Logger;
}

/**
 * docs/specs/run-speed.md. Decides which events request a build-ahead. A trigger never fails the
 * request that caused it, because a build-ahead only saves time.
 */
export class BuildAheadTrigger {
  constructor(private readonly dependencies: BuildAheadTriggerDependencies) {}

  /**
   * A default-branch push of a registered repository. Only a changed bootstrap key requests a
   * build, so a change to `verify`, `agents`, `preview` or `identity` requests nothing, and a
   * change to a key file requests one (docs/specs/repository-setup-and-services.md).
   */
  async afterPush(tenantId: string, repositoryFullName: string): Promise<void> {
    await this.guarded("push", async () => {
      const repository = await this.dependencies.repositories.findByFullName(tenantId, repositoryFullName);
      if (repository === null || repository.absentSince !== null) return;
      const product = await this.dependencies.products.findById(tenantId, repository.productId);
      if (product === null) return;
      const file = await this.dependencies.readConfig(repository.fullName, repository.defaultBranch, repository.githubInstallationId);
      if (file === null) return;
      const files = await this.dependencies.listFiles(repository.fullName, repository.defaultBranch, repository.githubInstallationId);
      const key = bootstrapKeyOfConfig(file, projectDefaultsOf(product), files);
      const url = buildRepositoryUrl(await this.dependencies.repositoryBaseUrl(), repository.fullName);
      const stored = await this.dependencies.snapshotKeys(tenantId, url);
      // An unknown key cannot match, so a truncated tree requests a build. The build compares the
      // key in its own checkout and builds nothing when the snapshot is current.
      if (key !== null && stored.includes(key)) {
        this.dependencies.logger.info("the bootstrap key did not change, so no build-ahead starts", {
          tenant_id: tenantId,
          repository: repository.fullName,
          step: "build_ahead",
        });
        return;
      }
      await this.requestAll([repository]);
    });
  }

  /** The Product allow list changed, and it is part of the bootstrap key of each repository. */
  async afterAllowListChange(tenantId: string, productId: string): Promise<void> {
    await this.guarded("allow_list", async () => {
      const repositories = await this.dependencies.repositories.listByProduct(productId);
      await this.requestAll(repositories.filter((repository) => repository.tenantId === tenantId));
    });
  }

  /** The sandbox image or size changed, so every warm snapshot of the install holds an old template. */
  async afterTemplateChange(): Promise<void> {
    await this.guarded("template", async () => {
      await this.requestAll(await this.dependencies.repositories.listPresent());
    });
  }

  private async requestAll(repositories: RepositoryRecord[]): Promise<void> {
    for (const repository of repositories) {
      if (repository.absentSince !== null) continue;
      const request = {
        tenantId: repository.tenantId,
        productId: repository.productId,
        repositoryFullName: repository.fullName,
      };
      try {
        await this.dependencies.request(request);
        this.dependencies.logger.info("a build-ahead is requested", {
          tenant_id: request.tenantId,
          repository: request.repositoryFullName,
          step: "build_ahead",
        });
      } catch (error) {
        this.dependencies.logger.warn("the build-ahead request failed", {
          tenant_id: request.tenantId,
          repository: request.repositoryFullName,
          step: "build_ahead",
          error: String(error),
        });
      }
    }
  }

  private async guarded(trigger: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.dependencies.logger.warn("the build-ahead trigger failed", { trigger, step: "build_ahead", error: String(error) });
    }
  }
}
