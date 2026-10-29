import type { ContextSource } from "./context-source.js";
import { ContextSourceRegistry } from "./context-source-registry.js";
import type {
  ContextSourceConfigurationRecord,
  ContextSourceConfigurationStore,
  ContextSourceKind,
} from "./context-source-configuration.js";
import type { RepositoryContextConfiguration } from "./repository-context-configuration.js";

export interface ContextSourceScope {
  tenantId: string;
  productId: string;
  contextConfiguration: RepositoryContextConfiguration;
}

/**
 * SDD section 17 fixes the source interface, so nothing here names a concrete source. The worker
 * supplies one factory per kind, and a factory lives beside its adapter.
 */
export type ContextSourceFactory = (
  record: ContextSourceConfigurationRecord,
  credential: string | null,
) => ContextSource;

export interface ContextSourceProvider {
  sourcesFor(scope: ContextSourceScope): Promise<ContextSourceRegistry>;
}

/** SDD section 30. A credential is read at the moment a source is built, and never stored. */
export interface ContextSourceSecretReader {
  read(tenantId: string, productId: string, name: string): Promise<string | null>;
}

export interface ConfiguredContextSourceProviderOptions {
  configurations: ContextSourceConfigurationStore;
  secrets: ContextSourceSecretReader;
  /** The sources every Run has: Linear and the GitHub repositories of SDD section 17. */
  fixedSources: () => ContextSource[];
  factories: Record<ContextSourceKind, ContextSourceFactory>;
}

/**
 * Builds the context sources of one Run. SDD section 53 makes a source a per-Project record, so
 * the registry cannot be built once per worker. See DI-5.1.
 */
export class ConfiguredContextSourceProvider implements ContextSourceProvider {
  constructor(private readonly options: ConfiguredContextSourceProviderOptions) {}

  async sourcesFor(scope: ContextSourceScope): Promise<ContextSourceRegistry> {
    const registry = new ContextSourceRegistry(this.options.fixedSources());
    const records = await this.options.configurations.list(scope.tenantId, scope.productId);

    for (const record of records) {
      if (!record.enabled) continue;
      // SDD section 19. Backstage needs the administrator endpoint and the repository opt in.
      // See DI-5.4.
      if (record.kind === "backstage" && !scope.contextConfiguration.backstageEnabled) continue;

      let credential: string | null = null;
      if (record.secretName !== null) {
        credential = await this.options.secrets.read(
          scope.tenantId,
          scope.productId,
          record.secretName,
        );
        // A source that needs a credential and has none must not run without one. Leaving it out
        // degrades the Run, which DI-5.13 permits, and it never sends an
        // unauthenticated request in its place.
        if (credential === null) continue;
      }

      registry.register(this.options.factories[record.kind](record, credential));
    }

    return registry;
  }
}
