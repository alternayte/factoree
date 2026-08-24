import { LinearClient } from "@linear/sdk";
import type {
  EvidenceStorage,
  PutArtifactInput,
  StoredArtifact,
} from "~/domain/evidence/evidence-storage.js";
import { hashArtifactBytes } from "~/domain/evidence/evidence-storage.js";

/** The store throws this error when an upload to Linear private file storage fails. */
export class EvidenceStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceStorageError";
  }
}

/** The narrow Linear file upload port, in the style of `LinearApi` in `linear-agent-client.ts`. */
export interface LinearFileUploadApi {
  fileUpload(
    contentType: string,
    filename: string,
    size: number,
  ): Promise<{
    success: boolean;
    uploadFile: {
      uploadUrl: string;
      assetUrl: string;
      headers: Array<{ key: string; value: string }>;
    } | null;
  }>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * SDD section 39. Version 1 SHOULD store user-facing evidence through Linear private file
 * storage where practical. This adapter requests an upload slot, sends the bytes through an
 * injected `fetch`, and returns the asset URL as the storage reference.
 */
export class LinearEvidenceStorage implements EvidenceStorage {
  readonly name = "linear";

  constructor(
    private readonly api: LinearFileUploadApi,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async put(input: PutArtifactInput): Promise<StoredArtifact> {
    const response = await this.api.fileUpload(input.contentType, input.name, input.bytes.byteLength);
    if (!response.success || response.uploadFile === null) {
      throw new EvidenceStorageError("Linear did not grant an upload slot for the artifact.");
    }
    const { uploadUrl, assetUrl, headers } = response.uploadFile;

    const putResponse = await this.fetchImpl(uploadUrl, {
      method: "PUT",
      headers: Object.fromEntries(headers.map((header) => [header.key, header.value])),
      body: input.bytes,
    });
    if (!putResponse.ok) {
      throw new EvidenceStorageError(
        `The upload of the artifact to Linear private file storage failed with status ${putResponse.status}.`,
      );
    }

    return {
      storageRef: assetUrl,
      sha256: hashArtifactBytes(input.bytes),
      byteLength: input.bytes.byteLength,
    };
  }
}

/**
 * Builds the narrow upload port over the Linear SDK, in the style of `createLinearAgentClient`.
 * The access token belongs to one Linear workspace, so the caller resolves it per tenant.
 */
export const createLinearFileUploadApi = (accessToken: string): LinearFileUploadApi => {
  const client = new LinearClient({ accessToken });
  return {
    async fileUpload(contentType, filename, size) {
      const payload = await client.fileUpload(contentType, filename, size);
      return { success: payload.success, uploadFile: payload.uploadFile ?? null };
    },
  };
};
