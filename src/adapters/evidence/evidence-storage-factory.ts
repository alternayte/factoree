import type { EvidenceStorage } from "~/domain/evidence/evidence-storage.js";
import { FilesystemEvidenceStorage } from "./filesystem-evidence-storage.js";
import { LinearEvidenceStorage } from "~/adapters/linear/linear-evidence-storage.js";
import type { LinearFileUploadApi } from "~/adapters/linear/linear-evidence-storage.js";

/** The adapter names `EVIDENCE_STORAGE` accepts. */
export type EvidenceStorageName = "filesystem" | "linear";

export interface EvidenceStorageOptions {
  /** The selected adapter. `EVIDENCE_STORAGE` holds it. */
  storage: EvidenceStorageName;
  /** The root directory of the filesystem adapter. `EVIDENCE_LOCAL_ROOT` holds it. */
  localRoot: string;
  /**
   * Builds the Linear upload port for one tenant. A Linear access token belongs to one
   * workspace, so the Linear adapter resolves it for every artifact.
   */
  linearApiForTenant: (tenantId: string) => Promise<LinearFileUploadApi>;
}

/**
 * SDD section 39. Version 1 SHOULD store user-facing evidence through Linear private file
 * storage where practical. This function makes that choice a deployment setting. The filesystem
 * adapter stays the default, so no existing deployment changes behavior.
 */
export const createEvidenceStorage = (options: EvidenceStorageOptions): EvidenceStorage => {
  if (options.storage !== "linear") {
    return new FilesystemEvidenceStorage({ rootDirectory: options.localRoot });
  }
  return {
    name: "linear",
    put: async (input) => {
      const api = await options.linearApiForTenant(input.tenantId);
      return await new LinearEvidenceStorage(api).put(input);
    },
  };
};
