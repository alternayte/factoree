import type { ValidationAssertion, ValidationContract } from "./validation-contract.js";

export interface StoredValidationContract {
  id: string;
  tenantId: string;
  runId: string;
  version: number;
  sha256: string;
  workItem: string;
  goal: string;
  document: string;
  assertions: ValidationAssertion[];
  createdAt: Date;
}

export interface SaveValidationContractInput {
  tenantId: string;
  runId: string;
  contract: ValidationContract;
  sha256: string;
  document: string;
}

/**
 * SDD section 25 forbids a change to the active Validation Contract, so the port offers no update
 * and no delete. `save` is idempotent. A second call for the same Run returns the contract already
 * stored, so a Temporal activity retry can never write a second version. See controller decision 7.
 */
export interface ValidationContractStore {
  save(input: SaveValidationContractInput): Promise<StoredValidationContract>;
  findByRun(tenantId: string, runId: string): Promise<StoredValidationContract | null>;
}
