import type { ContextConflictRecord, SelectedContextItem } from "./conflicts.js";
import type { ContextContract } from "./context-contract.js";

export interface StoredContextContract {
  id: string;
  tenantId: string;
  runId: string;
  version: number;
  sha256: string;
  document: string;
  items: SelectedContextItem[];
  conflicts: ContextConflictRecord[];
  createdAt: Date;
}

export interface SaveContextContractInput {
  tenantId: string;
  runId: string;
  contract: ContextContract;
  sha256: string;
  document: string;
  /**
   * docs/specs/change-sets.md, DI-21.143. The hash of the contract this one replaces, after the
   * refiner added a target. Absent for the first freeze of a Run.
   */
  supersedes?: string;
}

/**
 * SDD section 21 requires an immutable Context Contract. The port therefore offers no update.
 * `save` is idempotent. A second call for the same Run returns the contract already stored, so a
 * Temporal activity retry can never write a second version.
 *
 * docs/specs/change-sets.md, DI-21.143. A save that names the contract it supersedes adds a new
 * revision, once: while the newest contract is still the one it names. A retry finds the new
 * revision and returns it. The rows of earlier revisions stay.
 */
export interface ContextContractStore {
  save(input: SaveContextContractInput): Promise<StoredContextContract>;
  /** The newest revision of the Run's contract, which is the contract of the Run. */
  findByRun(tenantId: string, runId: string): Promise<StoredContextContract | null>;
}
