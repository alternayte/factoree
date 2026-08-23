import { describe, expect, it } from "vitest";
import type { BackstageCatalogPort, BackstageEntity } from "~/adapters/backstage/backstage-catalog-client.js";
import { BackstageContextSource } from "~/domain/context/backstage-source.js";
import { DISCOVERY_PRIORITY } from "~/domain/context/context-source.js";
import { DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION } from "~/domain/context/repository-context-configuration.js";

const entity = (over: Partial<BackstageEntity>): BackstageEntity => ({
  ref: "component:default/manuscript-service",
  kind: "Component",
  namespace: "default",
  name: "manuscript-service",
  title: null,
  description: null,
  owner: null,
  system: null,
  dependsOn: [],
  providesApis: [],
  consumesApis: [],
  repositorySlug: null,
  repositoryUrl: null,
  definition: null,
  sourceVersion: "etag-1",
  ...over,
});

const ROOT = entity({
  repositorySlug: "acme/manuscript-service",
  repositoryUrl: "https://github.com/acme/manuscript-service",
  owner: "group:default/team-a",
  system: "system:default/publishing",
  dependsOn: ["resource:default/manuscript-db"],
  consumesApis: ["api:default/identity-api"],
});

const IDENTITY_API = entity({
  ref: "api:default/identity-api",
  kind: "API",
  name: "identity-api",
  description: "The identity API.",
  definition: "openapi: 3.0.0",
  sourceVersion: "etag-api",
  repositorySlug: "acme/identity-service",
  repositoryUrl: "https://github.com/acme/identity-service",
});

const catalog = (entities: BackstageEntity[]): BackstageCatalogPort => ({
  getByRef: (ref) => Promise.resolve(entities.find((candidate) => candidate.ref === ref) ?? null),
  findByRepositorySlug: (slug) =>
    Promise.resolve(entities.find((candidate) => candidate.repositorySlug === slug) ?? null),
});

const request = (over: Partial<Parameters<BackstageContextSource["discover"]>[0]> = {}) => ({
  runId: "run-1",
  goal: "Retry a failed manuscript upload.",
  topics: ["manuscript", "identity"],
  primaryRepository: { slug: "acme/manuscript-service", url: "https://github.com/acme/manuscript-service.git", ref: "main" },
  referenceRepositories: [],
  workItemReferences: [],
  decisions: [],
  contextConfiguration: DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION,
  ...over,
});

const sourceOf = (entities: BackstageEntity[], over: Partial<{ maxEntities: number; includeOwnership: boolean; primaryComponent: string | null }> = {}) =>
  new BackstageContextSource({
    sourceId: "backstage",
    catalog: catalog(entities),
    settings: { kind: "backstage", primaryComponent: null, maxEntities: 50, includeOwnership: true, ...over },
  });

describe("BackstageContextSource", () => {
  it("offers the entity of the primary repository with full provenance", async () => {
    const [root] = await sourceOf([ROOT]).discover(request());
    expect(root?.reference).toEqual({
      sourceId: "backstage",
      ref: "backstage:component:default/manuscript-service",
      repository: null,
      sha: null,
      path: null,
    });
    expect(root?.sourceVersion).toBe("etag-1");
    // SDD section 19 and controller decision 5. The catalog never outranks code or an ADR.
    expect(root?.authority).toBe("declarative_catalog");
    expect(root?.reason).toBe(
      'the Backstage catalog entity of the primary repository "acme/manuscript-service"',
    );
    expect(root?.priority).toBe(DISCOVERY_PRIORITY.backstage_relation);
    expect(root?.suggestedClassification).toBe("reference");
  });

  it("offers a consumed API with the API relation priority and a topology reason", async () => {
    const candidates = await sourceOf([ROOT, IDENTITY_API]).discover(request());
    const api = candidates.find((candidate) => candidate.reference.ref === "backstage:api:default/identity-api");
    expect(api?.priority).toBe(DISCOVERY_PRIORITY.backstage_api_relation);
    expect(api?.reason).toBe(
      'the Backstage catalog records that "manuscript-service" consumes the API "identity-api"',
    );
    expect(api?.sourceVersion).toBe("etag-api");
    expect(api?.authority).toBe("declarative_catalog");
    expect(api?.topics).toContain("identity");
  });

  it("offers a dependency with the relation priority", async () => {
    const database = entity({ ref: "resource:default/manuscript-db", kind: "Resource", name: "manuscript-db", sourceVersion: "etag-db" });
    const candidates = await sourceOf([ROOT, database]).discover(request());
    const found = candidates.find((candidate) => candidate.reference.ref === "backstage:resource:default/manuscript-db");
    expect(found?.priority).toBe(DISCOVERY_PRIORITY.backstage_relation);
    expect(found?.reason).toBe(
      'the Backstage catalog records that "manuscript-service" depends on "manuscript-db"',
    );
  });

  it("leaves ownership out when the configuration turns it off", async () => {
    const team = entity({ ref: "group:default/team-a", kind: "Group", name: "team-a", sourceVersion: "etag-team" });
    const candidates = await sourceOf([ROOT, team], { includeOwnership: false }).discover(request());
    expect(candidates.map((candidate) => candidate.reference.ref)).not.toContain("backstage:group:default/team-a");
  });

  it("reports no candidate and no failure when the catalog holds no entity for the repository", async () => {
    expect(await sourceOf([]).discover(request())).toEqual([]);
  });

  it("stops at the entity cap", async () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      entity({ ref: `api:default/api-${index}`, kind: "API", name: `api-${index}`, sourceVersion: `etag-${index}` }),
    );
    const root = entity({ ...ROOT, consumesApis: many.map((candidate) => candidate.ref) });
    const candidates = await sourceOf([root, ...many], { maxEntities: 3 }).discover(request());
    expect(candidates).toHaveLength(3);
  });

  it("never asks the catalog for a listing when a primary component is configured", async () => {
    const calls: string[] = [];
    const source = new BackstageContextSource({
      sourceId: "backstage",
      catalog: {
        getByRef: (ref) => {
          calls.push(`getByRef ${ref}`);
          return Promise.resolve(ref === ROOT.ref ? ROOT : null);
        },
        findByRepositorySlug: () => {
          calls.push("findByRepositorySlug");
          return Promise.resolve(null);
        },
      },
      settings: { kind: "backstage", primaryComponent: "component:default/manuscript-service", maxEntities: 50, includeOwnership: true },
    });
    await source.discover(request());
    expect(calls).not.toContain("findByRepositorySlug");
  });

  it("reports a repository location only when the repository asked for automatic discovery", async () => {
    const off = await sourceOf([ROOT, IDENTITY_API]).discover(request());
    expect(off.every((candidate) => candidate.discoveredRepository === undefined)).toBe(true);

    const on = await sourceOf([ROOT, IDENTITY_API]).discover(
      request({ contextConfiguration: { backstageEnabled: true, automaticReferenceDiscovery: true } }),
    );
    const api = on.find((candidate) => candidate.reference.ref === "backstage:api:default/identity-api");
    expect(api?.discoveredRepository).toEqual({
      slug: "acme/identity-service",
      url: "https://github.com/acme/identity-service",
    });
  });

  it("keeps the Run alive when the catalog fails", async () => {
    const source = new BackstageContextSource({
      sourceId: "backstage",
      catalog: {
        getByRef: () => Promise.reject(new Error("catalog down")),
        findByRepositorySlug: () => Promise.reject(new Error("catalog down")),
      },
      settings: { kind: "backstage", primaryComponent: null, maxEntities: 50, includeOwnership: true },
    });
    expect(await source.discover(request())).toEqual([]);
  });

  it("serves the fetched document of an entity it offered", async () => {
    const source = sourceOf([ROOT, IDENTITY_API]);
    await source.discover(request());
    const document = await source.fetch({
      sourceId: "backstage",
      ref: "backstage:api:default/identity-api",
      repository: null,
      sha: null,
      path: null,
    });
    expect(document.content).toContain("identity-api");
    expect(document.content).toContain("openapi: 3.0.0");
    expect(document.sourceVersion).toBe("etag-api");
  });
});
