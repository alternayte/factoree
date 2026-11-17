import type { ValidationAssertion, ValidationContract } from "./validation-contract.js";

/**
 * `Evidence.validationAssertionId` and `ValidationAssertionResult.validationAssertionId` are
 * foreign keys onto the `ValidationAssertion` row identifier, not onto the contract-level
 * identifier such as `VAL-UI-001`. `rowId` carries the row identifier beside the existing `id`,
 * which stays the contract-level identifier.
 */
export interface StoredValidationAssertion extends ValidationAssertion {
  /** The database identifier of this assertion row. */
  rowId: string;
}

export interface StoredValidationContract {
  id: string;
  tenantId: string;
  runId: string;
  version: number;
  sha256: string;
  workItem: string;
  goal: string;
  document: string;
  assertions: StoredValidationAssertion[];
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
 * stored, so a Temporal activity retry can never write a second version. See DI-6.7.
 */
export interface ValidationContractStore {
  save(input: SaveValidationContractInput): Promise<StoredValidationContract>;
  findByRun(tenantId: string, runId: string): Promise<StoredValidationContract | null>;
}

/**
 * docs/specs/pr-review-merge-and-deploy.md, D1, DI-21.116. The passing Validation Plan of a run, and
 * the frozen contract a bring-current run adopts from the run of the verified head.
 */
export interface ValidationPlanStore {
  /** Stores the plan of the last passing user validation pass of the run. A later pass replaces it. */
  savePassingPlan(tenantId: string, runId: string, plan: unknown): Promise<void>;
  /** The stored passing plan of the run, or null when no pass of it passed. */
  passingPlan(tenantId: string, runId: string): Promise<unknown>;
  /**
   * Freezes the contract of `fromRunId`, with its passing plan, as the contract of `toRunId`: the same
   * document, hash and assertions, and new assertion rows. A second call returns the stored copy.
   * Null when `fromRunId` holds no contract.
   */
  adopt(tenantId: string, fromRunId: string, toRunId: string): Promise<{ contract: StoredValidationContract; hasPlan: boolean } | null>;
}
