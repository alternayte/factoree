import type {
  BackstageCatalogPort,
  BackstageEntity,
} from "~/adapters/backstage/backstage-catalog-client.js";
import { parseBackstageEntity } from "~/adapters/backstage/backstage-catalog-client.js";
import type { BackstageSourceSettings } from "~/domain/context/context-source-configuration.js";
import { parseContextSourceSettings } from "~/domain/context/context-source-configuration.js";
import { DISCOVERED_SLUG, PRIMARY_SLUG, REFERENCE_SLUG } from "./context-fixture-repository.js";

/** The default Backstage source settings, typed narrowly so a test needs no cast. */
export const backstageFixtureSettings = (): BackstageSourceSettings =>
  parseContextSourceSettings("backstage", {}) as BackstageSourceSettings;

/**
 * The raw Backstage entity documents of AT-04 and the Phase 5 exit test. Every document goes
 * through the real `parseBackstageEntity`, so the fixture proves the real parser, not a
 * hand-built `BackstageEntity`.
 *
 * `component:default/webhook-service` names the primary fixture repository as its source
 * location, consumes `api:default/notification-api`, and depends on
 * `resource:default/webhook-queue`. `api:default/notification-api` names the reference fixture
 * repository as its source location, and its `spec.definition` mentions notification retry.
 */
const RAW_ENTITIES: unknown[] = [
  {
    kind: "Component",
    metadata: {
      name: "webhook-service",
      namespace: "default",
      etag: "etag-webhook-service",
      annotations: {
        "backstage.io/source-location": `url:https://github.com/${PRIMARY_SLUG}/tree/main/`,
      },
    },
    spec: {
      type: "service",
      dependsOn: ["resource:default/webhook-queue"],
      consumesApis: ["api:default/notification-api"],
    },
  },
  {
    kind: "API",
    metadata: {
      name: "notification-api",
      namespace: "default",
      etag: "etag-notification-api",
      annotations: {
        "backstage.io/source-location": `url:https://github.com/${REFERENCE_SLUG}/tree/main/`,
      },
    },
    spec: {
      type: "openapi",
      definition: "openapi: 3.0.0\ninfo:\n  title: Notification retry API\n  version: 1.0.0\n",
    },
  },
  {
    kind: "Resource",
    metadata: {
      name: "webhook-queue",
      namespace: "default",
      etag: "etag-webhook-queue",
    },
    spec: {
      type: "queue",
    },
  },
];

/**
 * A `BackstageCatalogPort` over the fixed set of entities above, parsed once through the real
 * `parseBackstageEntity`. It answers `findByRepositorySlug` and `getByRef` from that parsed set,
 * with no network involved.
 */
/**
 * The entity of the repository the Project does not configure. The Phase 5 exit test turns it
 * on, so every other test keeps the three entities above.
 */
const RAW_DISCOVERED_ENTITY: unknown = {
  kind: "Component",
  metadata: {
    name: "audit-service",
    namespace: "default",
    etag: "etag-audit-service",
    annotations: {
      "backstage.io/source-location": `url:https://github.com/${DISCOVERED_SLUG}/tree/main/`,
    },
  },
  spec: { type: "service" },
};

export interface BackstageFixtureCatalogOptions {
  /**
   * The clone URL of the fixture repository the catalog names. The parser derives a repository
   * URL from `backstage.io/source-location`, and that annotation cannot express a temporary
   * directory as an `owner/repo` URL. The fixture therefore parses the entity for real and then
   * replaces the two location fields with the real fixture repository. A trailing `.git` is
   * removed, because a catalog carries the browse URL and the resolver appends `.git` itself.
   */
  discoveredRepositoryUrl?: string;
}

export const buildBackstageFixtureCatalog = (
  options: BackstageFixtureCatalogOptions = {},
): BackstageCatalogPort => {
  const entities = RAW_ENTITIES.map((document) => parseBackstageEntity(document));
  if (options.discoveredRepositoryUrl !== undefined) {
    const url = options.discoveredRepositoryUrl.replace(/\.git$/, "");
    entities.push({
      ...parseBackstageEntity(RAW_DISCOVERED_ENTITY),
      repositorySlug: DISCOVERED_SLUG,
      repositoryUrl: url,
    });
    const root = entities[0];
    if (root === undefined) throw new Error("the fixture catalog has no root entity");
    entities[0] = { ...root, dependsOn: [...root.dependsOn, "component:default/audit-service"] };
  }
  const byRef = new Map(entities.map((entity) => [entity.ref, entity]));

  return {
    getByRef: (ref: string): Promise<BackstageEntity | null> =>
      Promise.resolve(byRef.get(ref.trim().toLowerCase()) ?? null),
    findByRepositorySlug: (slug: string): Promise<BackstageEntity | null> =>
      Promise.resolve(entities.find((entity) => entity.repositorySlug === slug) ?? null),
  };
};
