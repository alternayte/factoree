import { randomUUID } from "node:crypto";
import type { ObjectStore } from "~/adapters/s3/s3-object-store.js";
import { artifactLinkOf, evidenceObjectKey } from "~/domain/evidence/artifact-links.js";
import { hashArtifactBytes, type EvidenceStorage, type PutArtifactInput, type StoredArtifact } from "~/domain/evidence/evidence-storage.js";
import type { PrismaStoredArtifactStore } from "~/persistence/prisma/stored-artifact.prisma.js";

export interface S3EvidenceStorageOptions {
  /** The object store, read for each upload, or null when it is not complete. */
  objectStore: () => Promise<ObjectStore | null>;
  artifacts: Pick<PrismaStoredArtifactStore, "findSame" | "create">;
  publicUrl: string;
  masterKey: string;
}

/**
 * docs/specs/s3-object-store.md. Evidence in the object store. The storage reference is a stable
 * Factoree URL: the open link of a screenshot or video, the sign-in link of any other kind. A
 * presigned URL would expire after at most 7 days, and the proof pack keeps its links.
 */
export class S3EvidenceStorage implements EvidenceStorage {
  readonly name = "s3";

  constructor(private readonly options: S3EvidenceStorageOptions) {}

  async put(input: PutArtifactInput): Promise<StoredArtifact> {
    const sha256 = hashArtifactBytes(input.bytes);
    const linkOf = (artifact: { id: string; kind: string }) => artifactLinkOf(this.options.publicUrl, this.options.masterKey, artifact);
    const same = await this.options.artifacts.findSame(input.runId, input.name, sha256);
    if (same !== null) return { storageRef: linkOf(same), sha256, byteLength: same.bytes };
    const store = await this.options.objectStore();
    if (store === null) throw new Error("the evidence store is S3, and the object store in Install settings is not complete");
    const id = randomUUID();
    const objectKey = evidenceObjectKey(input.tenantId, input.runId, id, input.name);
    await store.put(objectKey, Buffer.from(input.bytes), input.contentType);
    await this.options.artifacts.create({
      id,
      tenantId: input.tenantId,
      runId: input.runId,
      kind: input.kind,
      name: input.name,
      contentType: input.contentType,
      objectKey,
      bytes: input.bytes.byteLength,
      sha256,
    });
    return { storageRef: linkOf({ id, kind: input.kind }), sha256, byteLength: input.bytes.byteLength };
  }
}
