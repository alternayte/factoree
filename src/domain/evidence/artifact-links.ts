import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * docs/specs/s3-object-store.md. The evidence kinds that get an open link: Linear and GitHub fetch
 * an image through their own servers with no Factoree session, so only an open link renders it.
 * A trace holds request data, so it never gets one.
 */
export const OPEN_LINK_KINDS: ReadonlySet<string> = new Set(["screenshot", "video"]);

/** The kinds that the product's Evidence retention deletes from the object store. */
export const RETAINED_KINDS: readonly string[] = ["video", "trace"];

/** The presigned GET behind /artifacts lasts this long. */
export const ARTIFACT_REDIRECT_SECONDS = 300;

/** The token of an open link: HMAC-SHA256 of the artifact id under the master key, in base64url. */
export const openLinkToken = (masterKey: string, artifactId: string): string =>
  createHmac("sha256", masterKey).update(`factoree:artifact:${artifactId}`).digest("base64url");

/** True when the token is the open link token of the artifact. The compare takes constant time. */
export const isOpenLinkToken = (masterKey: string, artifactId: string, token: string): boolean => {
  const expected = Buffer.from(openLinkToken(masterKey, artifactId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

const base = (publicUrl: string): string => publicUrl.replace(/\/+$/, "");

/** The link Factoree writes for one artifact: the open link for a screenshot or video, the sign-in link otherwise. */
export const artifactLinkOf = (publicUrl: string, masterKey: string, artifact: { id: string; kind: string }): string =>
  OPEN_LINK_KINDS.has(artifact.kind)
    ? `${base(publicUrl)}/artifacts/${artifact.id}/${openLinkToken(masterKey, artifact.id)}`
    : `${base(publicUrl)}/artifacts/${artifact.id}`;

/** A log, a trace or a document downloads; an image or a video shows. */
export const dispositionOf = (artifact: { kind: string; name: string; contentType: string }): string | null => {
  if (/^(image|video)\//.test(artifact.contentType) && OPEN_LINK_KINDS.has(artifact.kind)) return null;
  return `attachment; filename="${artifact.name.replace(/[^A-Za-z0-9._-]/g, "_")}"`;
};

/** The object key of one evidence artifact: a prefix per tenant and run. */
export const evidenceObjectKey = (tenantId: string, runId: string, id: string, name: string): string =>
  `evidence/${tenantId}/${runId}/${id}-${name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}`;
