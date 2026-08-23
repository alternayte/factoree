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
}

/**
 * SDD section 21 requires an immutable Context Contract. The port therefore offers no update.
 * `save` is idempotent. A second call for the same Run returns the contract already stored, so a
 * Temporal activity retry can never write a second version.
 */
export interface ContextContractStore {
  save(input: SaveContextContractInput): Promise<StoredContextContract>;
  findByRun(tenantId: string, runId: string): Promise<StoredContextContract | null>;
}
