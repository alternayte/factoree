import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  EvidenceStorage,
  PutArtifactInput,
  StoredArtifact,
} from "~/domain/evidence/evidence-storage.js";
import { hashArtifactBytes } from "~/domain/evidence/evidence-storage.js";

export interface FilesystemEvidenceStorageOptions {
  rootDirectory: string;
}

/**
 * Stores an artifact on the local filesystem, under one directory per tenant and per Run. This
 * adapter is a fallback for a deployment that does not use Linear private file storage. SDD
 * section 39 requires a storage reference, and this adapter returns a `file://` URL for it.
 */
export class FilesystemEvidenceStorage implements EvidenceStorage {
  readonly name = "filesystem";

  constructor(private readonly options: FilesystemEvidenceStorageOptions) {}

  async put(input: PutArtifactInput): Promise<StoredArtifact> {
    const directory = join(this.options.rootDirectory, input.tenantId, input.runId);
    await mkdir(directory, { recursive: true });
    const fileName = `${randomUUID()}-${input.name}`;
    const path = join(directory, fileName);
    await writeFile(path, input.bytes);
    return {
      storageRef: `file://${path}`,
      sha256: hashArtifactBytes(input.bytes),
      byteLength: input.bytes.byteLength,
    };
  }
}
