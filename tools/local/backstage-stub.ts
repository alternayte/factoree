/**
 * A local stand-in for the Backstage Catalog HTTP API of `src/adapters/backstage/backstage-
 * catalog-client.ts`. It serves one fixture Component entity, so the local live acceptance
 * profile has a real HTTP endpoint to resolve topology against. It is not a mock of a live
 * dependency; SDD section 66 excludes Backstage from the local profile on purpose.
 */
import Fastify from "fastify";

const PORT = Number(process.env["BACKSTAGE_STUB_PORT"] ?? 4100);

const FIXTURE_SLUG = process.env["LIVE_GITHUB_REPOSITORY"] ?? "owner/factoree-live-fixture";

const fixtureEntity = {
  kind: "Component",
  metadata: {
    name: "factoree-live-fixture",
    namespace: "default",
    title: "Factoree Live Fixture",
    description: "The local live acceptance fixture entity.",
    etag: "local-fixture-v1",
    annotations: {
      "github.com/project-slug": FIXTURE_SLUG,
      "backstage.io/source-location": `url:https://github.com/${FIXTURE_SLUG}`,
    },
  },
  spec: {
    owner: "team-factoree",
    system: "factoree",
    dependsOn: [],
    providesApis: [],
    consumesApis: [],
  },
};

const app = Fastify({ logger: true });

// `BackstageCatalogClient.getByRef` reads a single entity by kind, namespace, and name.
app.get<{ Params: { kind: string; namespace: string; name: string } }>(
  "/api/catalog/entities/by-name/:kind/:namespace/:name",
  async (request, reply) => {
    const { kind, namespace, name } = request.params;
    if (
      kind.toLowerCase() === fixtureEntity.kind.toLowerCase() &&
      namespace === fixtureEntity.metadata.namespace &&
      name === fixtureEntity.metadata.name
    ) {
      return fixtureEntity;
    }
    return reply.code(404).send();
  },
);

// `BackstageCatalogClient.findByRepositorySlug` queries this endpoint and reads `items`.
app.get("/api/catalog/entities/by-query", () => ({ items: [fixtureEntity] }));

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`Backstage stub listens on port ${PORT}.`);
  })
  .catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });
