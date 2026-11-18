import type { RepositoryConfigFile } from "~/adapters/github/repository-discovery-client.js";
import { parseFactoreeConfig } from "~/domain/products/factoree-config.js";
import type { ProductRecord } from "~/domain/products/product-registry.js";
import type { RepositoryRecord } from "~/domain/products/repository-registry.js";
import { buildRepositoryUrl, repositorySlugOfUrl } from "~/domain/products/repository-url.js";
import type { Logger } from "~/telemetry/logger.js";
import { bootstrapAllowListOf, DEFAULT_PROJECT_DEFAULTS, toProjectRuntimeConfig, type ProjectDefaults } from "./project-runtime-config.js";
import {
  bootstrapKeyOf,
  keyFilePatternsOf,
  selectKeyFiles,
  setBootstrapKeyOf,
  type RepositoryFileEntry,
  type SetMemberKey,
} from "./warm-snapshot.js";

/**
 * docs/specs/run-speed.md. A build-ahead builds the warm snapshot of one repository when its
 * bootstrap key changes, before a run needs it. A run that finds no snapshot for its key still
 * builds one itself, so the run path never depends on a build-ahead.
 */
export interface BuildAheadRequest {
  tenantId: string;
  productId: string;
  /** The repository, or for a set the first repository of `repositoryFullNames`. */
  repositoryFullName: string;
  /**
   * docs/specs/change-sets.md, DI-21.137. The repositories of a set, two or more, sorted. The
   * build-ahead then builds the set snapshot. Absent for the snapshot of one repository.
   */
  repositoryFullNames?: string[];
}

/** docs/specs/change-sets.md. The request of the build-ahead of a set, with its repositories sorted. */
export const setBuildAheadRequest = (input: { tenantId: string; productId: string; repositoryFullNames: readonly string[] }): BuildAheadRequest => {
  const names = [...new Set(input.repositoryFullNames)].sort();
  return { tenantId: input.tenantId, productId: input.productId, repositoryFullName: names[0] ?? "", repositoryFullNames: names };
};

/** The repositories one build-ahead builds: the set, or the one repository. */
export const buildAheadRepositoriesOf = (request: BuildAheadRequest): string[] =>
  request.repositoryFullNames !== undefined && request.repositoryFullNames.length > 1 ? request.repositoryFullNames : [request.repositoryFullName];

/** Asks for one build-ahead. A request during a build queues one more build, not one per request. */
export type RequestBuildAhead = (request: BuildAheadRequest) => Promise<void>;

/**
 * One build-ahead workflow per repository, so a second request joins it. docs/specs/change-sets.md,
 * DI-21.137: one per set, named by its sorted repositories joined by `+`.
 */
export const buildAheadWorkflowId = (tenantId: string, repositoryFullName: string | readonly string[]): string =>
  `build-ahead:${tenantId}:${typeof repositoryFullName === "string" ? repositoryFullName : [...repositoryFullName].join("+")}`;

/** The id a build-ahead sandbox carries where a run sandbox carries its run id. */
export const buildAheadSandboxRunId = (request: BuildAheadRequest): string =>
  `build-ahead:${buildAheadRepositoriesOf(request).join("+")}`;

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
  credentials: readonly string[] = [],
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
    credentials,
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
  /** docs/specs/host-credentials.md. The credential part of the bootstrap key of a product. */
  credentialKey?: (tenantId: string, productId: string) => Promise<string[]>;
  /**
   * docs/specs/change-sets.md, DI-21.137. Every stored set snapshot: its tenant, its repository URLs
   * and its keys on every adapter. Absent means no set is kept current.
   */
  setSnapshots?: () => Promise<StoredSetSnapshot[]>;
  logger: Logger;
}

/** docs/specs/change-sets.md. One set that holds a warm snapshot on at least one adapter. */
export interface StoredSetSnapshot {
  tenantId: string;
  repositoryUrls: string[];
  bootstrapKeys: string[];
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
      const credentials = (await this.dependencies.credentialKey?.(tenantId, product.id)) ?? [];
      const key = bootstrapKeyOfConfig(file, projectDefaultsOf(product), files, credentials);
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
      } else {
        await this.requestAll([repository]);
      }
      // docs/specs/change-sets.md, DI-21.137. A set that holds the repository builds again when the
      // key of the set changed.
      const sets = await this.storedSets((set) => set.tenantId === tenantId && set.repositoryUrls.includes(url));
      for (const set of sets) {
        const setKey = await this.setKeyOf(tenantId, set.repositoryUrls);
        if (setKey !== null && set.bootstrapKeys.includes(setKey)) continue;
        await this.requestSet(tenantId, set.repositoryUrls);
      }
    });
  }

  /**
   * The Product allow list or its host credentials changed. Both are part of the bootstrap key of
   * each repository (docs/specs/host-credentials.md).
   */
  async afterAllowListChange(tenantId: string, productId: string): Promise<void> {
    await this.guarded("allow_list", async () => {
      const repositories = (await this.dependencies.repositories.listByProduct(productId)).filter((repository) => repository.tenantId === tenantId);
      await this.requestAll(repositories);
      const base = await this.dependencies.repositoryBaseUrl();
      const urls = new Set(repositories.map((repository) => buildRepositoryUrl(base, repository.fullName)));
      for (const set of await this.storedSets((candidate) => candidate.tenantId === tenantId && candidate.repositoryUrls.some((url) => urls.has(url)))) {
        await this.requestSet(tenantId, set.repositoryUrls);
      }
    });
  }

  /** The sandbox image or size changed, so every warm snapshot of the install holds an old template. */
  async afterTemplateChange(): Promise<void> {
    await this.guarded("template", async () => {
      await this.requestAll(await this.dependencies.repositories.listPresent());
      for (const set of await this.storedSets(() => true)) await this.requestSet(set.tenantId, set.repositoryUrls);
    });
  }

  private async storedSets(keep: (set: StoredSetSnapshot) => boolean): Promise<StoredSetSnapshot[]> {
    return ((await this.dependencies.setSnapshots?.()) ?? []).filter(keep);
  }

  /**
   * docs/specs/change-sets.md, DI-21.135. The key of a set at the default-branch head of each
   * repository, or null when one key is unknown: a repository is gone, holds no config, or GitHub
   * truncated its tree. The build-ahead then decides in its own checkout.
   */
  private async setKeyOf(tenantId: string, repositoryUrls: readonly string[]): Promise<string | null> {
    const members: SetMemberKey[] = [];
    for (const url of repositoryUrls) {
      const repository = await this.dependencies.repositories.findByFullName(tenantId, repositorySlugOfUrl(url));
      if (repository === null || repository.absentSince !== null) return null;
      const product = await this.dependencies.products.findById(tenantId, repository.productId);
      if (product === null) return null;
      const file = await this.dependencies.readConfig(repository.fullName, repository.defaultBranch, repository.githubInstallationId);
      if (file === null) return null;
      const files = await this.dependencies.listFiles(repository.fullName, repository.defaultBranch, repository.githubInstallationId);
      const credentials = (await this.dependencies.credentialKey?.(tenantId, product.id)) ?? [];
      const key = bootstrapKeyOfConfig(file, projectDefaultsOf(product), files, credentials);
      if (key === null) return null;
      members.push({ repositoryUrl: url, bootstrapKey: key });
    }
    return setBootstrapKeyOf(members);
  }

  /** Requests the build-ahead of one stored set. The product is the product of its first repository. */
  private async requestSet(tenantId: string, repositoryUrls: readonly string[]): Promise<void> {
    const names = repositoryUrls.map((url) => repositorySlugOfUrl(url));
    try {
      const first = await this.dependencies.repositories.findByFullName(tenantId, names[0] ?? "");
      if (first === null || first.absentSince !== null) return;
      await this.dependencies.request(setBuildAheadRequest({ tenantId, productId: first.productId, repositoryFullNames: names }));
      this.dependencies.logger.info("a build-ahead of a set is requested", {
        tenant_id: tenantId,
        repository: names.join(", "),
        step: "build_ahead",
      });
    } catch (error) {
      this.dependencies.logger.warn("the build-ahead request of a set failed", {
        tenant_id: tenantId,
        repository: names.join(", "),
        step: "build_ahead",
        error: String(error),
      });
    }
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

/**
 * docs/specs/sandbox-provider-spillover.md. The last failed build-ahead of one repository on one
 * sandbox provider. Selection prefers another provider for the repository while it exists.
 */
export interface BuildAheadFailureRecord {
  tenantId: string;
  providerId: string;
  repositoryUrl: string;
  reason: string;
  failedAt: Date;
}

export interface BuildAheadFailureStore {
  record(failure: BuildAheadFailureRecord): Promise<void>;
  /** A build-ahead on the provider succeeded, so the failure ends. */
  clear(tenantId: string, providerId: string, repositoryUrl: string): Promise<void>;
  failedProviders(tenantId: string, repositoryUrl: string): Promise<string[]>;
  listFor(tenantId: string, repositoryUrls: readonly string[]): Promise<BuildAheadFailureRecord[]>;
}
