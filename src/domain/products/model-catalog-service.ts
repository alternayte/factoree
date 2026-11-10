import type { Logger } from "~/telemetry/logger.js";
import type { AgentRunnerName } from "./agent-settings.js";
import { catalogFor, type CatalogProvider, type RawCatalog } from "./model-catalog.js";

/** docs/specs/model-picker.md. The last good copy of the catalog, in Postgres. */
export interface ModelCatalogStore {
  read(): Promise<StoredCatalog | null>;
  write(catalog: StoredCatalog): Promise<void>;
  /** Marks the stored copy as current after the source answered that nothing changed. */
  touch(fetchedAt: Date): Promise<void>;
}

export interface StoredCatalog {
  etag: string | null;
  data: RawCatalog;
  fetchedAt: Date;
}

/** The models.dev endpoint. A test passes a fake, so no test reaches the network. */
export interface ModelCatalogSource {
  fetch(etag: string | null): Promise<{ kind: "not-modified" } | { kind: "fetched"; etag: string | null; data: RawCatalog }>;
}

/** The catalog opencode itself reads. It also keys the stored row. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CurrentCatalog {
  raw: RawCatalog;
  fetchedAt: Date;
}

/**
 * The catalog the picker shows and the worker writes into a sandbox. A copy older than a day is
 * refreshed with its ETag. A stale copy answers at once and refreshes in the background, so a
 * slow models.dev never slows the product page. Only an empty store waits for the fetch. A failed
 * fetch keeps the old copy.
 */
export class ModelCatalogService {
  private cached: CurrentCatalog | null = null;
  private trimmed = new Map<AgentRunnerName, CatalogProvider[]>();
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly options: {
      store: ModelCatalogStore;
      source: ModelCatalogSource;
      logger?: Logger;
      clock?: () => number;
      maxAgeMs?: number;
    },
  ) {}

  private now(): number {
    return (this.options.clock ?? Date.now)();
  }

  private stale(catalog: CurrentCatalog): boolean {
    return this.now() - catalog.fetchedAt.getTime() > (this.options.maxAgeMs ?? CATALOG_MAX_AGE_MS);
  }

  private remember(catalog: CurrentCatalog): void {
    this.cached = catalog;
    this.trimmed.clear();
  }

  /** The current catalog, or null when none was ever fetched and models.dev cannot be reached. */
  async current(): Promise<CurrentCatalog | null> {
    if (this.cached === null) {
      const stored = await this.options.store.read();
      if (stored !== null) this.remember({ raw: stored.data, fetchedAt: stored.fetchedAt });
    }
    if (this.cached === null) {
      await this.refresh();
      return this.cached;
    }
    if (this.stale(this.cached)) void this.refresh();
    return this.cached;
  }

  /** The trimmed catalog of one runner, or null when no catalog is available. */
  async providers(runner: AgentRunnerName): Promise<{ providers: CatalogProvider[]; fetchedAt: Date } | null> {
    const catalog = await this.current();
    if (catalog === null) return null;
    let providers = this.trimmed.get(runner);
    if (providers === undefined) {
      providers = catalogFor(catalog.raw, runner);
      this.trimmed.set(runner, providers);
    }
    return { providers, fetchedAt: catalog.fetchedAt };
  }

  /** One refresh at a time per process. */
  private refresh(): Promise<void> {
    this.refreshing ??= this.fetchOnce().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async fetchOnce(): Promise<void> {
    try {
      const stored = await this.options.store.read();
      const result = await this.options.source.fetch(stored?.etag ?? null);
      const fetchedAt = new Date(this.now());
      if (result.kind === "not-modified" && stored !== null) {
        await this.options.store.touch(fetchedAt);
        this.remember({ raw: stored.data, fetchedAt });
        return;
      }
      if (result.kind === "fetched") {
        await this.options.store.write({ etag: result.etag, data: result.data, fetchedAt });
        this.remember({ raw: result.data, fetchedAt });
      }
    } catch (error) {
      this.options.logger?.warn("the model catalog did not refresh, so the last good copy stays", { error: String(error).slice(0, 300) });
    }
  }
}
