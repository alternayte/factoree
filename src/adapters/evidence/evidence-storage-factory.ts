import type { EvidenceStorage } from "~/domain/evidence/evidence-storage.js";
import type { EvidenceStoreName } from "~/domain/settings/install-settings.js";
import { FilesystemEvidenceStorage } from "./filesystem-evidence-storage.js";
import { LinearEvidenceStorage } from "~/adapters/linear/linear-evidence-storage.js";
import type { LinearFileUploadApi } from "~/adapters/linear/linear-evidence-storage.js";

export interface EvidenceStorageOptions {
  /**
   * docs/specs/s3-object-store.md. The effective evidence store, read for each upload, so a change
   * in Install settings applies to the next artifact. FACTOREE_EVIDENCE_STORAGE wins over it.
   */
  store: () => Promise<EvidenceStoreName>;
  /** The root directory of the filesystem adapter. `EVIDENCE_LOCAL_ROOT` holds it. */
  localRoot: string;
  /**
   * Builds the Linear upload port for one tenant. A Linear access token belongs to one
   * workspace, so the Linear adapter resolves it for every artifact.
   */
  linearApiForTenant: (tenantId: string) => Promise<LinearFileUploadApi>;
  /** The object store adapter, or absent where no object store is wired. */
  s3?: EvidenceStorage;
}

/**
 * SDD section 39. Version 1 SHOULD store user-facing evidence through Linear private file
 * storage where practical. docs/specs/s3-object-store.md adds the object store. Each artifact goes
 * to the store chosen at the time of its upload; an artifact already stored stays where it is.
 */
export const createEvidenceStorage = (options: EvidenceStorageOptions): EvidenceStorage => {
  const filesystem = new FilesystemEvidenceStorage({ rootDirectory: options.localRoot });
  return {
    name: "configured",
    put: async (input) => {
      const store = await options.store();
      if (store === "filesystem") return filesystem.put(input);
      if (store === "s3") {
        if (options.s3 === undefined) throw new Error("the evidence store is S3, and this process has no object store");
        return options.s3.put(input);
      }
      const api = await options.linearApiForTenant(input.tenantId);
      return await new LinearEvidenceStorage(api).put(input);
    },
  };
};
