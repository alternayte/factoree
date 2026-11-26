import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ObjectStore } from "~/adapters/s3/s3-object-store.js";
import { ARTIFACT_REDIRECT_SECONDS, dispositionOf, isOpenLinkToken, OPEN_LINK_KINDS } from "~/domain/evidence/artifact-links.js";
import type { PrismaStoredArtifactStore, StoredArtifactRecord } from "~/persistence/prisma/stored-artifact.prisma.js";
import type { Principal } from "./auth/membership.js";

export interface ArtifactRouteDependencies {
  artifacts: Pick<PrismaStoredArtifactStore, "byId">;
  /** The object store, read for each request, or null when it is not complete. */
  objectStore: () => Promise<Pick<ObjectStore, "presignGet"> | null>;
  /** The signed-in person or API key of a request, or null. */
  principal: (request: FastifyRequest) => Promise<Principal | null>;
  masterKey: string;
}

const ID = /^[0-9a-f-]{36}$/;

/**
 * docs/specs/s3-object-store.md. The stable links of object store evidence. `/artifacts/<id>`
 * needs a Factoree sign-in as a member of the artifact's tenant; `/artifacts/<id>/<token>` is the
 * open link of a screenshot or video. Both answer 302 to a presigned GET that lasts 5 minutes, so
 * no link Factoree writes ever expires. An unknown, foreign or deleted artifact answers 404.
 */
export const registerArtifactRoutes = (app: FastifyInstance, dependencies: ArtifactRouteDependencies): void => {
  const redirect = async (artifact: StoredArtifactRecord, reply: FastifyReply) => {
    const store = await dependencies.objectStore();
    if (store === null || store.presignGet === undefined) return reply.code(503).type("text/plain").send("The object store in Install settings is not complete.");
    const url = store.presignGet(artifact.objectKey, ARTIFACT_REDIRECT_SECONDS, { contentType: artifact.contentType, disposition: dispositionOf(artifact) });
    return reply.header("cache-control", "no-store").redirect(url, 302);
  };

  app.get<{ Params: { id: string } }>("/artifacts/:id", { schema: { hide: true } }, async (request, reply) => {
    const principal = await dependencies.principal(request);
    if (principal === null) return reply.redirect(`/sign-in?next=${encodeURIComponent(`/artifacts/${request.params.id}`)}`, 302);
    const artifact = ID.test(request.params.id) ? await dependencies.artifacts.byId(request.params.id) : null;
    // §52. An artifact of another tenant answers as if it did not exist.
    if (artifact === null || !principal.memberships.some((membership) => membership.tenantId === artifact.tenantId)) {
      return reply.code(404).type("text/plain").send("No such artifact.");
    }
    if (artifact.deletedAt !== null) return reply.code(404).type("text/plain").send("The product's Evidence retention deleted this artifact.");
    return redirect(artifact, reply);
  });

  app.get<{ Params: { id: string; token: string } }>("/artifacts/:id/:token", { schema: { hide: true } }, async (request, reply) => {
    const artifact = ID.test(request.params.id) ? await dependencies.artifacts.byId(request.params.id) : null;
    if (
      artifact === null ||
      artifact.deletedAt !== null ||
      !OPEN_LINK_KINDS.has(artifact.kind) ||
      !isOpenLinkToken(dependencies.masterKey, artifact.id, request.params.token)
    ) {
      return reply.code(404).type("text/plain").send("No such artifact.");
    }
    return redirect(artifact, reply);
  });
};
