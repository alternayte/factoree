import { describe, expect, it, vi } from "vitest";
import {
  BackstageCatalogClient,
  parseBackstageEntity,
} from "~/adapters/backstage/backstage-catalog-client.js";

const ENTITY = {
  metadata: {
    uid: "uid-1",
    etag: "etag-1",
    name: "manuscript-service",
    namespace: "default",
    title: "Manuscript Service",
    description: "Stores manuscripts.",
    annotations: {
      "backstage.io/source-location": "url:https://github.com/acme/manuscript-service/tree/main/",
    },
  },
  kind: "Component",
  spec: {
    type: "service",
    owner: "team-a",
    system: "publishing",
    dependsOn: ["resource:default/manuscript-db"],
    providesApis: ["api:default/manuscript-api"],
    consumesApis: ["api:default/identity-api"],
  },
};

describe("parseBackstageEntity", () => {
  it("reads the SDD section 19 fields", () => {
    const entity = parseBackstageEntity(ENTITY);
    expect(entity).toEqual({
      ref: "component:default/manuscript-service",
      kind: "Component",
      namespace: "default",
      name: "manuscript-service",
      title: "Manuscript Service",
      description: "Stores manuscripts.",
      owner: "group:default/team-a",
      system: "system:default/publishing",
      dependsOn: ["resource:default/manuscript-db"],
      providesApis: ["api:default/manuscript-api"],
      consumesApis: ["api:default/identity-api"],
      repositorySlug: "acme/manuscript-service",
      repositoryUrl: "https://github.com/acme/manuscript-service",
      definition: null,
      sourceVersion: "etag-1",
    });
  });

  it("falls back to the uid when the catalog reports no etag", () => {
    const entity = parseBackstageEntity({ ...ENTITY, metadata: { ...ENTITY.metadata, etag: undefined } });
    expect(entity.sourceVersion).toBe("uid-1");
  });

  it("reads the definition of an API entity", () => {
    const entity = parseBackstageEntity({
      metadata: { uid: "uid-2", etag: "etag-2", name: "identity-api", namespace: "default" },
      kind: "API",
      spec: { type: "openapi", owner: "team-b", definition: "openapi: 3.0.0" },
    });
    expect(entity.definition).toBe("openapi: 3.0.0");
    expect(entity.ref).toBe("api:default/identity-api");
  });

  it("rejects a document that is not an entity", () => {
    expect(() => parseBackstageEntity({ kind: "Component" })).toThrow(/entity/);
  });
});

describe("BackstageCatalogClient", () => {
  it("asks for one entity by reference and sends the credential", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(ENTITY), { status: 200 })));
    const client = new BackstageCatalogClient({
      endpoint: "https://backstage.test/",
      token: "secret-token",
      fetch: fetchMock,
    });
    const entity = await client.getByRef("component:default/manuscript-service");
    expect(entity?.name).toBe("manuscript-service");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://backstage.test/api/catalog/entities/by-name/component/default/manuscript-service",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("reports null for an entity the catalog does not hold", async () => {
    const client = new BackstageCatalogClient({
      endpoint: "https://backstage.test",
      token: null,
      fetch: () => Promise.resolve(new Response("", { status: 404 })),
    });
    expect(await client.getByRef("component:default/missing")).toBeNull();
  });

  it("finds the entity of a repository through a filtered query, never a full listing", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items: [ENTITY] }), { status: 200 })));
    const client = new BackstageCatalogClient({
      endpoint: "https://backstage.test",
      token: null,
      fetch: fetchMock,
    });
    const entity = await client.findByRepositorySlug("acme/manuscript-service");
    expect(entity?.ref).toBe("component:default/manuscript-service");
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    // SDD section 18. The query is filtered and bounded. It is not a catalog dump.
    expect(url).toContain("filter=");
    expect(url).toContain("limit=");
  });

  it("keeps the token out of the error message", async () => {
    const client = new BackstageCatalogClient({
      endpoint: "https://backstage.test",
      token: "secret-token",
      fetch: () => Promise.resolve(new Response("denied", { status: 500 })),
    });
    await expect(client.getByRef("component:default/a")).rejects.toThrow(/500/);
    await expect(client.getByRef("component:default/a")).rejects.not.toThrow(/secret-token/);
  });
});
